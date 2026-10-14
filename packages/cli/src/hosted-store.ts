import { DEFAULT_IDLE_TTL_MS } from './service-config.js';
import type { SQLInputValue } from 'node:sqlite';
import type { HostedIdentity, HostedSubscription, QuotaOptions } from './hosted-types.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

const DAY = 86_400_000;
const MAX_GRANT_MS = 90 * DAY;
const MAX_RECORD_BYTES = 64 * 1024;

export class HostedStoreError extends Error {
  status: number; statusCode: number; code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HostedStoreError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}
function fail(status: number, code: string, message: string): never { throw new HostedStoreError(status, code, message); }
const digest = (value) => createHash('sha256').update(value).digest('hex');
const opaqueId = (prefix) => `${prefix}_${randomBytes(18).toString('base64url')}`;
function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, 'INVALID_ARGUMENT', `${label} is out of range`);
  return value;
}
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) fail(400, 'INVALID_ARGUMENT', `${label} is invalid`);
  return value;
}
function retrySecret(value) {
  text(value, 'requestId', 256);
  if (!/^[a-zA-Z0-9_-]{24,256}$/.test(value)) fail(400, 'INVALID_ARGUMENT', 'requestId must be a random secret of at least 24 URL-safe characters');
  return value;
}
function canonicalRealm(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { fail(400, 'INVALID_REALM', 'realm must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail(400, 'INVALID_REALM', 'realm must be an HTTP(S) origin');
  }
  return url.origin;
}
function privateFile(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(500, 'INVALID_STORE', 'Control store files must be regular files');
    chmodSync(path, 0o600);
  }
}
function keyFile(path, mustExist) {
  if (!existsSync(path)) {
    if (mustExist) fail(500, 'MISSING_STORE_KEY', 'A control store key is missing; restore its original key file');
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  privateFile(path);
  const key = readFileSync(path);
  if (key.length !== 32) fail(500, 'INVALID_STORE_KEY', 'Control store key has an invalid length');
  return key;
}

/** Synchronous persistent control state. Chat bodies and contact directories never belong here. */
export function openHostedStore(options: HostedStoreOptions) { return new HostedStore(options); }
export interface HostedStoreOptions {
  dataDir?: string; realm?: string; maxAccounts?: number; maxAgentsPerAccount?: number; now?: () => number;
}
interface StoreRow {
  id: string; value: string; active: number; n: number; account_id: string;
  expires_at: number; claimant: string; accepted_at: number;
  window_start: number; count: number; encrypted: string;
}
interface SignedCapability {
  kind: string; realm: string; id: string; issuer: string; scope: string; exp: number;
  subject?: string; recipient?: string;
}
export class HostedStore {
  realm: string;
  maxAccounts: number;
  maxAgentsPerAccount: number;
  maxAgentRecords: number;
  now: () => number;
  dataDir: string;
  signingKey: Buffer;
  encryptionKey: Buffer;
  db: DatabaseSync;
  constructor({ dataDir, realm, maxAccounts = 1000, maxAgentsPerAccount = 2, now = Date.now }: HostedStoreOptions = {}) {
    this.realm = canonicalRealm(text(realm, 'realm', 4096));
    this.maxAccounts = boundedInteger(maxAccounts, 'maxAccounts', 1, 10_000);
    this.maxAgentsPerAccount = boundedInteger(maxAgentsPerAccount, 'maxAgentsPerAccount', 1, 100);
    this.maxAgentRecords = Math.min(100_000, maxAccounts * maxAgentsPerAccount * 8);
    if (typeof now !== 'function') fail(400, 'INVALID_ARGUMENT', 'now must be a function');
    this.now = now;
    this.dataDir = resolve(text(dataDir, 'dataDir', 4096));
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail(500, 'INVALID_STORE', 'Control store directory must not be a symbolic link');
    chmodSync(this.dataDir, 0o700);
    const databasePath = join(this.dataDir, 'control.sqlite');
    const existing = existsSync(databasePath);
    privateFile(databasePath);
    this.signingKey = keyFile(join(this.dataDir, 'signing.key'), existing);
    this.encryptionKey = keyFile(join(this.dataDir, 'subscriptions.key'), existing);
    this.db = new DatabaseSync(databasePath);
    privateFile(databasePath);
    try {
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(account_id, request_hash));
        CREATE TABLE IF NOT EXISTS offer_claims (id TEXT PRIMARY KEY, claimant TEXT NOT NULL REFERENCES agents(id), accepted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS revocations (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS quotas (owner TEXT NOT NULL, bucket TEXT NOT NULL, window_start INTEGER NOT NULL, expires_at INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(owner,bucket));
        CREATE TABLE IF NOT EXISTS subscriptions (agent_id TEXT NOT NULL REFERENCES agents(id), subscription_id TEXT NOT NULL, encrypted TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(agent_id,subscription_id));
      `);
      this._transaction(() => {
        for (const [name, value] of [['realm', this.realm], ['signing_key', digest(this.signingKey)], ['subscription_key', digest(this.encryptionKey)]]) {
          const saved = this._row('SELECT value FROM meta WHERE name=?', name);
          if (saved && saved.value !== value) fail(500, 'STORE_CONFIGURATION_MISMATCH', 'Control store realm, schema, or keys do not match the saved configuration');
          this.db.prepare('INSERT OR IGNORE INTO meta(name,value) VALUES (?,?)').run(name, value);
        }
      });
      this.upgradeSchema();
      this.cleanup();
    } catch (error) { this.db.close(); throw error; }
  }
  private upgradeSchema() {
    const version = this._row('SELECT value FROM meta WHERE name=?', 'schema_version')?.value;
    if (version && !['1', '2', '3'].includes(version)) fail(500, 'STORE_CONFIGURATION_MISMATCH', 'Unsupported control store schema');
    if (version === '1') {
      // Preserve existing identities and their keys while removing admission data.
      // Rebuild without renaming the old table so agents' foreign keys stay valid.
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this._transaction(() => {
          this.db.exec(`CREATE TABLE accounts_next (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
            INSERT INTO accounts_next SELECT id,token_hash,'previous:' || code_hash || ':' || request_hash,active FROM accounts;
            DROP TABLE accounts;
            ALTER TABLE accounts_next RENAME TO accounts;
            DROP TABLE IF EXISTS codes;
          `);
          if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail(500, 'INVALID_STORE', 'Identity schema upgrade failed its reference check');
          this.db.prepare('UPDATE meta SET value=? WHERE name=?').run('2', 'schema_version');
        });
      } finally { this.db.exec('PRAGMA foreign_keys=ON'); }
    }
    if (version === '1' || version === '2') {
      this._transaction(() => {
        // Retain encrypted callback records and their identity-bound AAD. A new
        // destination is an additional subscription, never an implicit replace.
        this.db.exec(`CREATE TABLE subscriptions_next (agent_id TEXT NOT NULL REFERENCES agents(id), subscription_id TEXT NOT NULL, encrypted TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(agent_id,subscription_id));
          INSERT INTO subscriptions_next SELECT agent_id,subscription_id,encrypted,expires_at FROM subscriptions;
          DROP TABLE subscriptions;
          ALTER TABLE subscriptions_next RENAME TO subscriptions;`);
        this.db.prepare('UPDATE meta SET value=? WHERE name=?').run('3', 'schema_version');
      });
    } else {
      this.db.prepare('INSERT OR IGNORE INTO meta(name,value) VALUES (?,?)').run('schema_version', '3');
    }
  }
  private _row(sql: string, ...values: SQLInputValue[]): StoreRow | undefined {
    return this.db.prepare(sql).get(...values) as StoreRow | undefined;
  }
  private _requiredRow(sql: string, ...values: SQLInputValue[]): StoreRow {
    const row = this._row(sql, ...values);
    if (!row) fail(500, 'INVALID_STORE', 'Expected database aggregate row');
    return row;
  }
  close() { this.db.close(); }
  _transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  _derive(...parts: unknown[]): string { return createHmac('sha256', this.signingKey).update(JSON.stringify([this.realm, ...parts])).digest('base64url'); }
  _credential(kind, id, secret) { return `nk_${kind}_${this._derive('credential', kind, id, secret)}`; }
  _account(token) {
    if (typeof token !== 'string' || token.length > 256) fail(401, 'UNAUTHENTICATED', 'Invalid account credential');
    const account = this._row('SELECT id FROM accounts WHERE token_hash=? AND active=1', digest(token));
    if (!account) fail(401, 'UNAUTHENTICATED', 'Invalid account credential');
    return account;
  }
  accountForAgent(agentId: string): string {
    const row = this._row('SELECT a.account_id FROM agents a JOIN accounts u ON u.id=a.account_id WHERE a.id=? AND a.active=1 AND u.active=1', text(agentId, 'agentId'));
    if (!row) fail(403, 'AGENT_UNAVAILABLE', 'Agent is not active');
    return row.account_id;
  }
  isAgentActive(agentId) {
    try { this.accountForAgent(agentId); return true; } catch { return false; }
  }
  authenticate(token: unknown): HostedIdentity {
    if (typeof token !== 'string' || token.length > 256) fail(401, 'UNAUTHENTICATED', 'Invalid agent credential');
    const row = this._row('SELECT a.id, a.account_id FROM agents a JOIN accounts u ON u.id=a.account_id WHERE a.token_hash=? AND a.active=1 AND u.active=1', digest(token));
    if (!row) fail(401, 'UNAUTHENTICATED', 'Invalid agent credential');
    return { agentId: row.id, accountId: row.account_id };
  }
  registerAccount(requestId: string, registrationSource?: string) {
    retrySecret(requestId);
    const requestHash = digest(requestId);
    return this._transaction(() => {
      const previous = this._row('SELECT id,active FROM accounts WHERE request_hash=?', requestHash);
      if (previous) {
        if (!previous.active) fail(403, 'ACCOUNT_REVOKED', 'Account has been revoked');
        return { accountId: previous.id, accountToken: this._credential('account', previous.id, requestId) };
      }
      if (this._requiredRow('SELECT COUNT(*) n FROM accounts').n >= this.maxAccounts) fail(429, 'ACCOUNT_CAPACITY', 'The service account limit has been reached');
      if (registrationSource !== undefined) {
        // Count only new accounts, atomically with the insert. Quota rows
        // retain a keyed hash, never the client address itself.
        const owner = `registration:${this._derive('registration-source', text(registrationSource, 'registrationSource'))}`;
        this._consumeQuotaInTransaction(owner, 'accounts.hour', { limit: 10, windowMs: 3_600_000 });
        this._consumeQuotaInTransaction(owner, 'accounts.day', { limit: 20, windowMs: DAY });
        this._consumeQuotaInTransaction('service', 'accounts.day', { limit: 100, windowMs: DAY, service: true });
      }
      const accountId = opaqueId('account');
      const accountToken = this._credential('account', accountId, requestId);
      this.db.prepare('INSERT INTO accounts(id,token_hash,request_hash) VALUES (?,?,?)').run(accountId, digest(accountToken), requestHash);
      return { accountId, accountToken };
    });
  }
  registerAgent(accountToken: string | undefined, { requestId }: { requestId?: string } = {}) {
    const account = this._account(accountToken); retrySecret(requestId);
    return this._transaction(() => {
      const existing = this._row('SELECT id,active FROM agents WHERE account_id=? AND request_hash=?', account.id, digest(requestId));
      if (existing) {
        if (!existing.active) fail(403, 'AGENT_REVOKED', 'Agent has been revoked; use a new registration request');
        return { agentId: existing.id, agentToken: this._credential('agent', existing.id, requestId) };
      }
      if (this._requiredRow('SELECT COUNT(*) n FROM agents WHERE account_id=? AND active=1', account.id).n >= this.maxAgentsPerAccount) fail(429, 'AGENT_CAPACITY', 'The account agent limit has been reached');
      if (this._requiredRow('SELECT COUNT(*) n FROM agents').n >= this.maxAgentRecords) fail(429, 'IDENTITY_CAPACITY', 'The service identity history limit has been reached');
      const agentId = opaqueId('agent');
      const agentToken = this._credential('agent', agentId, requestId);
      this.db.prepare('INSERT INTO agents(id,account_id,token_hash,request_hash) VALUES (?,?,?,?)').run(agentId, account.id, digest(agentToken), digest(requestId));
      return { agentId, agentToken };
    });
  }
  revokeAgent(agentId) {
    // Administrative method: callers must authenticate the owner before exposing it remotely.
    this.db.prepare('UPDATE agents SET active=0 WHERE id=?').run(text(agentId, 'agentId'));
    this.db.prepare('DELETE FROM subscriptions WHERE agent_id=?').run(agentId);
  }
  _sign(payload: SignedCapability): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `nk1.${body}.${this._derive('signed-token', body)}`;
  }
  _verify(token: string, kind: string, { allowExpired = false } = {}): SignedCapability {
    if (typeof token !== 'string' || token.length > 4096) fail(403, 'INVALID_CAPABILITY', 'Contact credential is invalid');
    const [version, body, signature, extra] = token.split('.');
    const expected = this._derive('signed-token', body);
    if (version !== 'nk1' || extra !== undefined || typeof signature !== 'string' || Buffer.byteLength(signature) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail(403, 'INVALID_CAPABILITY', 'Contact credential is invalid');
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { fail(403, 'INVALID_CAPABILITY', 'Contact credential is invalid'); }
    if (!payload || payload.kind !== kind || payload.realm !== this.realm || typeof payload.id !== 'string' || !Number.isSafeInteger(payload.exp) || (!allowExpired && payload.exp <= this.now())) fail(403, 'INVALID_CAPABILITY', 'Contact credential is invalid or expired');
    return payload;
  }
  issueOffer(agentId, { ttlMs = DEFAULT_IDLE_TTL_MS } = {}) {
    this.accountForAgent(agentId);
    boundedInteger(ttlMs, 'ttlMs', 1000, 7 * DAY);
    return this._sign({ kind: 'offer', realm: this.realm, id: opaqueId('offer'), issuer: agentId, scope: 'reciprocal-contact', exp: this.now() + ttlMs });
  }
  _exchange(offer: SignedCapability, claim: Pick<StoreRow, 'claimant' | 'expires_at'>) {
    const grant = (issuer, subject) => this._sign({ kind: 'contact', realm: this.realm, id: this._derive('grant', offer.id, issuer, subject), issuer, subject, recipient: issuer, scope: 'meeting:invite', exp: claim.expires_at });
    return { exchangeId: offer.id, contact: { peerId: offer.issuer, capability: grant(offer.issuer, claim.claimant) }, reciprocal: { peerId: claim.claimant, capability: grant(claim.claimant, offer.issuer) }, issuedCapability: grant(claim.claimant, offer.issuer), expiresAt: claim.expires_at };
  }
  acceptOffer(agentId, token) {
    this.accountForAgent(agentId);
    const offer = this._verify(token, 'offer', { allowExpired: true });
    this.cleanup();
    this.accountForAgent(offer.issuer);
    if (offer.issuer === agentId || offer.scope !== 'reciprocal-contact') fail(403, 'INVALID_OFFER', 'Cannot accept this contact offer');
    return this._transaction(() => {
      let claim: Pick<StoreRow, 'claimant' | 'accepted_at' | 'expires_at'> | undefined = this._row('SELECT claimant,accepted_at,expires_at FROM offer_claims WHERE id=?', offer.id);
      if (claim) {
        if (claim.claimant !== agentId) fail(409, 'OFFER_CONSUMED', 'Contact offer has already been accepted');
        if (claim.expires_at <= this.now()) fail(403, 'INVALID_OFFER', 'Contact exchange has expired');
      } else {
        if (offer.exp <= this.now()) fail(403, 'INVALID_OFFER', 'Contact offer has expired');
        if (this._requiredRow('SELECT COUNT(*) n FROM offer_claims').n >= 10_000) fail(429, 'EXCHANGE_CAPACITY', 'The contact exchange limit has been reached');
        claim = { claimant: agentId, accepted_at: this.now(), expires_at: this.now() + MAX_GRANT_MS };
        this.db.prepare('INSERT INTO offer_claims(id,claimant,accepted_at,expires_at) VALUES (?,?,?,?)').run(offer.id, claim.claimant, claim.accepted_at, claim.expires_at);
      }
      return this._exchange(offer, claim);
    });
  }
  claimOffer(agentId, token) {
    this.accountForAgent(agentId);
    const offer = this._verify(token, 'offer', { allowExpired: true });
    if (offer.issuer !== agentId) fail(403, 'FORBIDDEN', 'Only the offer issuer can collect the reciprocal contact');
    const claim = this._row('SELECT claimant,accepted_at,expires_at FROM offer_claims WHERE id=?', offer.id);
    if (!claim || claim.expires_at <= this.now()) return { accepted: false, expired: offer.exp <= this.now(), exchangeId: offer.id };
    this.accountForAgent(claim.claimant);
    const exchange = this._exchange(offer, claim);
    return { accepted: true, exchangeId: offer.id, contact: exchange.reciprocal, issuedCapability: exchange.contact.capability, expiresAt: exchange.expiresAt };
  }
  verifyCapability(callerId, recipientId, token) {
    this.accountForAgent(callerId); this.accountForAgent(recipientId);
    const grant = this._verify(token, 'contact');
    if (grant.subject !== callerId || grant.issuer !== recipientId || grant.recipient !== recipientId || grant.scope !== 'meeting:invite') fail(403, 'FORBIDDEN', 'Contact credential does not authorize this caller and recipient');
    if (this._row('SELECT 1 FROM revocations WHERE id=?', grant.id)) fail(403, 'CAPABILITY_REVOKED', 'Contact permission has been revoked');
    return { id: grant.id, issuer: grant.issuer, subject: grant.subject, recipient: grant.recipient, expiresAt: grant.exp };
  }
  revokeCapability(agentId, token) {
    this.accountForAgent(agentId);
    const grant = this._verify(token, 'contact', { allowExpired: true });
    if (grant.issuer !== agentId) fail(403, 'FORBIDDEN', 'Only the granting agent can revoke contact permission');
    this.cleanup();
    if (grant.exp <= this.now()) return { revoked: true };
    if (this._requiredRow('SELECT COUNT(*) n FROM revocations').n >= 20_000 && !this._row('SELECT 1 FROM revocations WHERE id=?', grant.id)) fail(429, 'REVOCATION_CAPACITY', 'The revocation limit has been reached');
    this.db.prepare('INSERT OR IGNORE INTO revocations(id,expires_at) VALUES (?,?)').run(grant.id, grant.exp);
    return { revoked: true };
  }
  consumeQuota(agentId: string, bucket: string, { limit, windowMs, scope = 'agent', amount = 1 }: QuotaOptions) {
    const accountId = this.accountForAgent(agentId);
    if (!['agent', 'account'].includes(scope)) fail(400, 'INVALID_ARGUMENT', 'Invalid quota scope');
    return this._consumeQuota(scope === 'account' ? accountId : agentId, bucket, { limit, windowMs, amount });
  }
  consumeServiceQuota(bucket: string, { limit, windowMs, amount = 1 }: QuotaOptions) {
    // Internal operator-controlled budget, not an anonymous quota API.
    return this._consumeQuota('service', bucket, { limit, windowMs, amount, service: true });
  }
  _consumeQuota(owner: string, bucket: string, options: { limit: number; windowMs: number; amount?: number; service?: boolean }) {
    return this._transaction(() => this._consumeQuotaInTransaction(owner, bucket, options));
  }
  _consumeQuotaInTransaction(owner: string, bucket: string, { limit, windowMs, amount = 1, service = false }: { limit: number; windowMs: number; amount?: number; service?: boolean }) {
    if (typeof bucket !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(bucket)) fail(400, 'INVALID_ARGUMENT', 'Invalid quota bucket');
    boundedInteger(limit, 'limit', 1, Number.MAX_SAFE_INTEGER);
    boundedInteger(amount, 'amount', 1, limit);
    boundedInteger(windowMs, 'windowMs', 100, 365 * DAY);
    const now = this.now(), start = Math.floor(now / windowMs) * windowMs, resetAt = start + windowMs;
    this.db.prepare('DELETE FROM quotas WHERE expires_at<=?').run(now);
    const previous = this._row('SELECT window_start,count FROM quotas WHERE owner=? AND bucket=?', owner, bucket);
    const count = previous?.window_start === start ? previous.count : 0;
    // Subtraction avoids overflowing safe integers when count + amount is huge.
    if (count > limit - amount) fail(429, 'QUOTA_EXCEEDED', 'Operation quota exhausted');
    if (!previous && service && this._requiredRow('SELECT COUNT(*) n FROM quotas WHERE owner=?', owner).n >= 256) fail(429, 'QUOTA_CAPACITY', 'The service quota bucket limit has been reached');
    if (!previous && this._requiredRow('SELECT COUNT(*) n FROM quotas').n >= Math.min(100_000, this.maxAgentRecords * 100) + 256) fail(429, 'QUOTA_CAPACITY', 'The service quota counter limit has been reached');
    this.db.prepare('INSERT INTO quotas(owner,bucket,window_start,expires_at,count) VALUES (?,?,?,?,?) ON CONFLICT(owner,bucket) DO UPDATE SET window_start=excluded.window_start,expires_at=excluded.expires_at,count=excluded.count').run(owner, bucket, start, resetAt, count + amount);
    return { remaining: limit - count - amount, resetAt };
  }
  _encrypt(agentId, value) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${this.realm}:${agentId}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  _decrypt(agentId, value) {
    try {
      const packed = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${this.realm}:${agentId}`));
      decipher.setAuthTag(packed.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString());
    } catch { fail(500, 'SUBSCRIPTION_CORRUPT', 'Stored subscription could not be authenticated'); }
  }
  putSubscription(agentId: string, record: HostedSubscription): HostedSubscription {
    this.accountForAgent(agentId);
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail(400, 'INVALID_ARGUMENT', 'Invalid subscription');
    text(record.id, 'subscription.id', 256);
    const expiry = record.expiresAt;
    const expiresAt = typeof expiry === 'string' ? Date.parse(expiry) : expiry;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 31 * DAY) fail(400, 'INVALID_ARGUMENT', 'Subscription expiry must be within 31 days');
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) fail(413, 'SUBSCRIPTION_TOO_LARGE', 'Subscription is too large');
    this.db.prepare('INSERT INTO subscriptions(agent_id,subscription_id,encrypted,expires_at) VALUES (?,?,?,?) ON CONFLICT(agent_id,subscription_id) DO UPDATE SET encrypted=excluded.encrypted,expires_at=excluded.expires_at').run(agentId, record.id, this._encrypt(agentId, serialized), expiresAt);
    return structuredClone(record);
  }
  setSubscription(agentId, record) { return this.putSubscription(agentId, record); }
  getSubscription(agentId: string, subscriptionId?: string): HostedSubscription | null {
    this.accountForAgent(agentId);
    const row = subscriptionId === undefined
      ? this._row('SELECT encrypted,expires_at FROM subscriptions WHERE agent_id=? AND expires_at>? ORDER BY subscription_id LIMIT 1', agentId, this.now())
      : this._row('SELECT encrypted,expires_at FROM subscriptions WHERE agent_id=? AND subscription_id=?', agentId, text(subscriptionId, 'subscriptionId'));
    if (!row || row.expires_at <= this.now()) return null;
    return this._decrypt(agentId, row.encrypted);
  }
  listSubscriptions(agentId: string): HostedSubscription[] {
    this.accountForAgent(agentId);
    return (this.db.prepare('SELECT encrypted FROM subscriptions WHERE agent_id=? AND expires_at>? ORDER BY subscription_id').all(agentId, this.now()) as unknown as StoreRow[])
      .map(row => this._decrypt(agentId, row.encrypted));
  }
  deleteSubscription(agentId: string, subscriptionId?: string): boolean {
    this.accountForAgent(agentId);
    return Boolean(subscriptionId === undefined
      ? this.db.prepare('DELETE FROM subscriptions WHERE agent_id=?').run(agentId).changes
      : this.db.prepare('DELETE FROM subscriptions WHERE agent_id=? AND subscription_id=?').run(agentId, text(subscriptionId, 'subscriptionId')).changes);
  }
  operatorSummary() {
    const now = this.now();
    const count = (sql: string, ...values: SQLInputValue[]) => this._requiredRow(sql, ...values).n;
    return {
      accounts: count('SELECT COUNT(*) n FROM accounts'),
      enabledAccounts: count('SELECT COUNT(*) n FROM accounts WHERE active=1'),
      agents: count('SELECT COUNT(*) n FROM agents'),
      enabledAgents: count('SELECT COUNT(*) n FROM agents a JOIN accounts u ON u.id=a.account_id WHERE a.active=1 AND u.active=1'),
      subscriptions: count('SELECT COUNT(*) n FROM subscriptions s JOIN agents a ON a.id=s.agent_id JOIN accounts u ON u.id=a.account_id WHERE s.expires_at>? AND a.active=1 AND u.active=1', now),
      serviceResponseBytesToday: count("SELECT COALESCE(SUM(count),0) n FROM quotas WHERE owner='service' AND bucket='egress_bytes' AND expires_at>?", now),
    };
  }
  cleanup() {
    const now = this.now();
    for (const table of ['offer_claims', 'revocations', 'quotas', 'subscriptions']) this.db.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).run(now);
  }
}
