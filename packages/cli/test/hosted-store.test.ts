import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openHostedStore } from '../src/hosted-store.js';

const secret = () => randomBytes(32).toString('base64url');
function setup(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'noknok-store-'));
  let now = 1_800_000_000_000;
  const args = { dataDir, realm: 'https://noknok.example', now: () => now, ...options };
  let store = openHostedStore(args);
  t.after(() => { try { store.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } });
  return { dataDir, get store() { return store; }, advance(ms) { now += ms; }, args,
    restart() { store.close(); store = openHostedStore(args); return store; },
    agent() { const account = store.registerAccount(secret()); return { ...account, ...store.registerAgent(account.accountToken, { requestId: secret() }) }; } };
}
function rejectsCode(fn, code) { assert.throws(fn, (error) => error.code === code); }

test('public registration is bounded, private, idempotent and recoverable after restart', (t) => {
  const env = setup(t, { maxAccounts: 2, maxAgentsPerAccount: 1 });
  const requestId = secret();
  const a = env.store.registerAccount(requestId);
  assert.deepEqual(env.store.registerAccount(requestId), a);
  const registrationSecret = secret();
  const agent = env.store.registerAgent(a.accountToken, { requestId: registrationSecret });
  rejectsCode(() => env.store.registerAgent(a.accountToken, { requestId: secret() }), 'AGENT_CAPACITY');
  rejectsCode(() => env.store.registerAccount('guessable'), 'INVALID_ARGUMENT');
  const b = env.store.registerAccount(secret());
  assert.notEqual(a.accountId, b.accountId);
  rejectsCode(() => env.store.registerAccount(secret()), 'ACCOUNT_CAPACITY');
  env.restart();
  assert.deepEqual(env.store.registerAccount(requestId), a);
  assert.deepEqual(env.store.registerAgent(a.accountToken, { requestId: registrationSecret }), agent);
  assert.deepEqual(env.store.authenticate(agent.agentToken), { agentId: agent.agentId, accountId: a.accountId });
  rejectsCode(() => env.store.authenticate(a.accountToken), 'UNAUTHENTICATED');
});

test('independent SQLite connections recover the same account without creating duplicates', (t) => {
  const env = setup(t);
  const second = openHostedStore(env.args);
  try {
    const requestId = secret();
    assert.deepEqual(env.store.registerAccount(requestId), second.registerAccount(requestId));
    assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  } finally { second.close(); }
});

test('unsupported control schemas fail before changing identity data or service keys', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'noknok-schema-rejection-'));
  const options = { dataDir, realm: 'https://noknok.example' };
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = openHostedStore(options);
  const account = store.registerAccount(secret());
  const a = store.registerAgent(account.accountToken, { requestId: secret() });
  const b = store.registerAgent(account.accountToken, { requestId: secret() });
  const contact = store.acceptOffer(a.agentId, store.issueOffer(b.agentId));
  store.close();
  for (const version of ['1', '2', 'unsupported', null]) {
    const database = new DatabaseSync(join(dataDir, 'control.sqlite'));
    if (version === null) database.prepare("DELETE FROM meta WHERE name='schema_version'").run();
    else database.prepare("INSERT OR REPLACE INTO meta(name,value) VALUES ('schema_version',?)").run(version);
    database.close();
    const files = ['control.sqlite', 'signing.key', 'subscriptions.key'];
    const before = files.map(file => readFileSync(join(dataDir, file)));
    rejectsCode(() => openHostedStore(options), 'STORE_CONFIGURATION_MISMATCH');
    files.forEach((file, index) => assert.deepEqual(readFileSync(join(dataDir, file)), before[index], file));
  }
  const database = new DatabaseSync(join(dataDir, 'control.sqlite'));
  database.prepare("INSERT INTO meta(name,value) VALUES ('schema_version','3')").run();
  database.close();
  const reopened = openHostedStore(options);
  try {
    assert.deepEqual(reopened.authenticate(a.agentToken), { agentId: a.agentId, accountId: account.accountId });
    reopened.verifyCapability(a.agentId, b.agentId, contact.contact.capability);
  } finally { reopened.close(); }
});

test('contact exchange binds both directions and cannot be stolen or forged by C', (t) => {
  const env = setup(t);
  const a = env.agent(), b = env.agent(), c = env.agent();
  const offer = env.store.issueOffer(b.agentId);
  assert.equal(env.store.claimOffer(b.agentId, offer).accepted, false);
  const exchange = env.store.acceptOffer(a.agentId, offer);
  assert.deepEqual(env.store.acceptOffer(a.agentId, offer), exchange);
  assert.equal(exchange.contact.peerId, b.agentId);
  assert.equal(exchange.issuedCapability, exchange.reciprocal.capability);
  const reciprocal = env.store.claimOffer(b.agentId, offer);
  assert.equal(reciprocal.contact.peerId, a.agentId);
  assert.equal(reciprocal.issuedCapability, exchange.contact.capability);
  env.store.verifyCapability(a.agentId, b.agentId, exchange.contact.capability);
  env.store.verifyCapability(b.agentId, a.agentId, reciprocal.contact.capability);
  rejectsCode(() => env.store.verifyCapability(c.agentId, b.agentId, exchange.contact.capability), 'FORBIDDEN');
  rejectsCode(() => env.store.verifyCapability(a.agentId, c.agentId, exchange.contact.capability), 'FORBIDDEN');
  rejectsCode(() => env.store.acceptOffer(c.agentId, offer), 'OFFER_CONSUMED');
  rejectsCode(() => env.store.claimOffer(c.agentId, offer), 'FORBIDDEN');
  rejectsCode(() => env.store.revokeCapability(c.agentId, exchange.contact.capability), 'FORBIDDEN');
  rejectsCode(() => env.store.revokeCapability(a.agentId, exchange.contact.capability), 'FORBIDDEN');
  const [v, body, signature] = exchange.contact.capability.split('.');
  const modified = JSON.parse(Buffer.from(body, 'base64url').toString());
  modified.subject = c.agentId;
  const forged = `${v}.${Buffer.from(JSON.stringify(modified)).toString('base64url')}.${signature}`;
  rejectsCode(() => env.store.verifyCapability(c.agentId, b.agentId, forged), 'INVALID_CAPABILITY');
  rejectsCode(() => env.store.verifyCapability(a.agentId, b.agentId, `${v}.${body}.${'é'.repeat(43)}`), 'INVALID_CAPABILITY');
  env.restart();
  assert.deepEqual(env.store.claimOffer(b.agentId, offer), reciprocal);
  env.store.verifyCapability(a.agentId, b.agentId, exchange.contact.capability);
  env.store.revokeCapability(b.agentId, exchange.contact.capability);
  env.restart();
  rejectsCode(() => env.store.verifyCapability(a.agentId, b.agentId, exchange.contact.capability), 'CAPABILITY_REVOKED');
  env.store.verifyCapability(b.agentId, a.agentId, reciprocal.contact.capability);
});

test('contact offers and grants expire, and revoked agents lose access in both directions', (t) => {
  const env = setup(t);
  const a = env.agent(), b = env.agent();
  const oldOffer = env.store.issueOffer(b.agentId, { ttlMs: 1000 });
  env.advance(1001);
  rejectsCode(() => env.store.acceptOffer(a.agentId, oldOffer), 'INVALID_OFFER');
  const exchange = env.store.acceptOffer(a.agentId, env.store.issueOffer(b.agentId));
  env.advance(90 * 86_400_000 + 1);
  rejectsCode(() => env.store.verifyCapability(a.agentId, b.agentId, exchange.contact.capability), 'INVALID_CAPABILITY');
  const next = env.store.acceptOffer(a.agentId, env.store.issueOffer(b.agentId));
  env.store.revokeAgent(b.agentId);
  assert.equal(env.store.isAgentActive(b.agentId), false);
  rejectsCode(() => env.store.authenticate(b.agentToken), 'UNAUTHENTICATED');
  rejectsCode(() => env.store.verifyCapability(a.agentId, b.agentId, next.contact.capability), 'AGENT_UNAVAILABLE');
  rejectsCode(() => env.store.verifyCapability(b.agentId, a.agentId, next.reciprocal.capability), 'AGENT_UNAVAILABLE');
});

test('realms are pinned to persistent keys and another service cannot accept contact grants', (t) => {
  const env = setup(t), other = setup(t, { realm: 'https://other.example' });
  const a = env.agent(), b = env.agent();
  const exchange = env.store.acceptOffer(a.agentId, env.store.issueOffer(b.agentId));
  const x = other.agent(), y = other.agent();
  rejectsCode(() => other.store.verifyCapability(x.agentId, y.agentId, exchange.contact.capability), 'INVALID_CAPABILITY');
  rejectsCode(() => openHostedStore({ ...env.args, realm: 'https://other.example' }), 'STORE_CONFIGURATION_MISMATCH');
  rejectsCode(() => openHostedStore({ ...env.args, realm: 'https://noknok.example/path' }), 'INVALID_REALM');
});

test('agent and account quotas persist and reset at bounded window boundaries', (t) => {
  const env = setup(t);
  const a = env.agent(), b = env.store.registerAgent(a.accountToken, { requestId: secret() });
  const budget = { limit: 2, windowMs: 86_400_000, scope: 'account' };
  assert.equal(env.store.consumeQuota(a.agentId, 'wake.daily', budget).remaining, 1);
  assert.equal(env.store.consumeQuota(b.agentId, 'wake.daily', budget).remaining, 0);
  env.restart();
  rejectsCode(() => env.store.consumeQuota(a.agentId, 'wake.daily', budget), 'QUOTA_EXCEEDED');
  assert.equal(env.store.consumeQuota(a.agentId, 'messages', { limit: 1, windowMs: 1000 }).remaining, 0);
  assert.equal(env.store.consumeQuota(b.agentId, 'messages', { limit: 1, windowMs: 1000 }).remaining, 0);
  env.advance(86_400_000);
  assert.equal(env.store.consumeQuota(a.agentId, 'wake.daily', budget).remaining, 1);
});

test('subscriptions persist encrypted, coexist, cannot cross identity AAD, and expire', (t) => {
  const env = setup(t), a = env.agent(), b = env.agent();
  const record = { id: 'subscription-1', owner: 'grant_test', name: 'noknok.activity', arguments: { recipient_id: a.agentId },
    url: 'https://host.example/private-target', secret: 'whsec_very-secret-value', active: true, expiresAt: env.args.now() + 60_000 };
  env.store.putSubscription(a.agentId, record);
  rejectsCode(() => env.store.getSubscription(a.agentId, undefined), 'INVALID_ARGUMENT');
  rejectsCode(() => env.store.deleteSubscription(a.agentId, undefined), 'INVALID_ARGUMENT');
  assert.deepEqual(env.store.getSubscription(a.agentId, record.id), record);
  assert.equal(env.store.getSubscription(b.agentId, record.id), null);
  assert.equal(env.store.deleteSubscription(a.agentId, 'not-the-id'), false);
  env.restart();
  assert.deepEqual(env.store.getSubscription(a.agentId, record.id), record);
  const databaseBytes = readFileSync(join(env.dataDir, 'control.sqlite'));
  for (const sensitive of [record.secret, record.url, a.agentToken, a.accountToken]) assert.equal(databaseBytes.includes(Buffer.from(sensitive)), false);
  const raw = new DatabaseSync(join(env.dataDir, 'control.sqlite'));
  try {
    const ciphertext = raw.prepare('SELECT encrypted FROM subscriptions WHERE agent_id=?').get(a.agentId).encrypted;
    raw.prepare('INSERT INTO subscriptions(agent_id,subscription_id,encrypted,expires_at) VALUES (?,?,?,?)').run(b.agentId, record.id, ciphertext, record.expiresAt);
    rejectsCode(() => env.store.getSubscription(b.agentId, record.id), 'SUBSCRIPTION_CORRUPT');
  } finally { raw.close(); }
  const rotated = { ...record, id: 'subscription-2', secret: 'whsec_new-private-value' };
  env.store.putSubscription(a.agentId, rotated);
  assert.deepEqual(env.store.getSubscription(a.agentId, rotated.id), rotated);
  assert.equal(env.store.listSubscriptions(a.agentId).length, 2);
  assert.equal(env.store.deleteSubscription(a.agentId, record.id), true);
  assert.deepEqual(env.store.getSubscription(a.agentId, rotated.id), rotated);
  env.advance(60_001);
  assert.equal(env.store.getSubscription(a.agentId, rotated.id), null);
  env.store.cleanup();
});

test('stored control fields omit plaintext bearer credentials and use restrictive file permissions', (t) => {
  const env = setup(t);
  const requestId = secret();
  const a = env.store.registerAccount(requestId), r = secret();
  const agent = env.store.registerAgent(a.accountToken, { requestId: r });
  assert.equal(statSync(env.dataDir).mode & 0o777, 0o700);
  for (const name of readdirSync(env.dataDir)) assert.equal(statSync(join(env.dataDir, name)).mode & 0o777, 0o600);
  const databaseBytes = readFileSync(join(env.dataDir, 'control.sqlite'));
  for (const value of [requestId, r, a.accountToken, agent.agentToken]) assert.equal(databaseBytes.includes(Buffer.from(value)), false);
  const raw = new DatabaseSync(join(env.dataDir, 'control.sqlite'));
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.deepEqual(tables.sort(), ['accounts', 'agents', 'meta', 'offer_claims', 'quotas', 'revocations', 'subscriptions']);
  } finally { raw.close(); }
});

test('storage refuses changed keys and symlink files instead of silently adopting them', (t) => {
  const env = setup(t);
  const key = join(env.dataDir, 'signing.key'), original = readFileSync(key);
  writeFileSync(key, randomBytes(32));
  rejectsCode(() => openHostedStore(env.args), 'STORE_CONFIGURATION_MISMATCH');
  writeFileSync(key, original);
  const destination = mkdtempSync(join(tmpdir(), 'noknok-store-link-'));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  symlinkSync(env.dataDir, join(destination, 'linked'));
  rejectsCode(() => openHostedStore({ ...env.args, dataDir: join(destination, 'linked') }), 'INVALID_STORE');
});

test('byte quotas debit actual amounts atomically, persist, and share the service budget', (t) => {
  const env = setup(t), a = env.agent(), b = env.agent();
  const budget = { limit: 50 * 1024 * 1024, windowMs: 86_400_000, scope: 'account' };
  assert.equal(env.store.consumeQuota(a.agentId, 'egress.bytes', { ...budget, amount: 12 * 1024 * 1024 }).remaining, 38 * 1024 * 1024);
  env.restart();
  assert.equal(env.store.consumeQuota(a.agentId, 'egress.bytes', { ...budget, amount: 38 * 1024 * 1024 }).remaining, 0);
  rejectsCode(() => env.store.consumeQuota(a.agentId, 'egress.bytes', { ...budget, amount: 1 }), 'QUOTA_EXCEEDED');
  assert.equal(env.store.consumeQuota(b.agentId, 'egress.bytes', { ...budget, amount: 1024 }).remaining, budget.limit - 1024);
  const global = { limit: 512 * 1024 * 1024, windowMs: 86_400_000 };
  assert.equal(env.store.consumeServiceQuota('egress.bytes', { ...global, amount: 500 * 1024 * 1024 }).remaining, 12 * 1024 * 1024);
  env.restart();
  rejectsCode(() => env.store.consumeServiceQuota('egress.bytes', { ...global, amount: 13 * 1024 * 1024 }), 'QUOTA_EXCEEDED');
  assert.equal(env.store.consumeServiceQuota('egress.bytes', { ...global, amount: 12 * 1024 * 1024 }).remaining, 0);
  env.advance(86_400_000);
  assert.equal(env.store.consumeServiceQuota('egress.bytes', { ...global, amount: 1024 }).remaining, global.limit - 1024);
});

test('quota amounts reject invalid arithmetic and retain a bounded number of service buckets', (t) => {
  const env = setup(t), a = env.agent();
  const options = { limit: 10, windowMs: 1000 };
  for (const amount of [0, -1, 0.5, NaN, Infinity, 11, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    rejectsCode(() => env.store.consumeQuota(a.agentId, 'bytes', { ...options, amount }), 'INVALID_ARGUMENT');
    rejectsCode(() => env.store.consumeServiceQuota('bytes', { ...options, amount }), 'INVALID_ARGUMENT');
  }
  assert.equal(env.store.consumeServiceQuota('bytes', { ...options, amount: 10 }).remaining, 0);
  rejectsCode(() => env.store.consumeServiceQuota('bytes', { ...options, amount: 1 }), 'QUOTA_EXCEEDED');
  for (let i = 1; i < 256; i++) env.store.consumeServiceQuota(`bucket.${i}`, options);
  rejectsCode(() => env.store.consumeServiceQuota('bucket.overflow', options), 'QUOTA_CAPACITY');
  env.advance(1000);
  assert.equal(env.store.consumeServiceQuota('bucket.overflow', options).remaining, 9);
  const huge = { limit: Number.MAX_SAFE_INTEGER, windowMs: 1000 };
  env.store.consumeServiceQuota('safe.integer', { ...huge, amount: Number.MAX_SAFE_INTEGER - 1 });
  rejectsCode(() => env.store.consumeServiceQuota('safe.integer', { ...huge, amount: 2 }), 'QUOTA_EXCEEDED');
  assert.equal(env.store.consumeServiceQuota('safe.integer', { ...huge, amount: 1 }).remaining, 0);
});

test('unclaimed contact links expire at 30 minutes without deleting established friendships', t => {
  const env = setup(t);
  const a = env.agent(), b = env.agent();
  const expiredOffer = env.store.issueOffer(a.agentId);
  const acceptedOffer = env.store.issueOffer(a.agentId);
  env.advance(29 * 60_000);
  assert.equal(env.store.claimOffer(a.agentId, expiredOffer).expired, false);
  const exchange = env.store.acceptOffer(b.agentId, acceptedOffer);
  env.advance(60_000);
  assert.equal(env.store.claimOffer(a.agentId, expiredOffer).expired, true);
  rejectsCode(() => env.store.acceptOffer(b.agentId, expiredOffer), 'INVALID_OFFER');
  env.restart();
  assert.equal(env.store.claimOffer(a.agentId, expiredOffer).expired, true);
  assert.equal(env.store.claimOffer(a.agentId, acceptedOffer).accepted, true);
  assert.equal(env.store.verifyCapability(b.agentId, a.agentId, exchange.contact.capability).issuer, a.agentId);
});

test('registration quotas are atomic, persistent and charge only new accounts', t => {
  const env = setup(t), source = '192.0.2.10', requestId = secret();
  const first = env.store.registerAccount(requestId, source);
  for (let i = 0; i < 9; i++) env.store.registerAccount(secret(), source);
  rejectsCode(() => env.store.registerAccount(secret(), source), 'QUOTA_EXCEEDED');
  env.restart();
  assert.deepEqual(env.store.registerAccount(requestId, source), first);
  rejectsCode(() => env.store.registerAccount(secret(), source), 'QUOTA_EXCEEDED');
  env.advance(3_600_000);
  for (let i = 0; i < 10; i++) env.store.registerAccount(secret(), source);
  env.advance(3_600_000);
  rejectsCode(() => env.store.registerAccount(secret(), source), 'QUOTA_EXCEEDED');
  assert.equal(env.store.db.prepare("SELECT count FROM quotas WHERE owner='service' AND bucket='accounts.day'").get().count, 20);
  // Another source retains its allowance; raw client addresses are not stored.
  env.store.registerAccount(secret(), '192.0.2.11');
  assert.equal(JSON.stringify(env.store.db.prepare('SELECT owner,bucket FROM quotas').all()).includes(source), false);
  env.advance(86_400_000);
  env.store.registerAccount(secret(), source);
});

test('daily registration ceiling bounds distributed signups without charging failed attempts', t => {
  const env = setup(t);
  for (let i = 0; i < 100; i++) env.store.registerAccount(secret(), `192.0.2.${i + 1}`);
  rejectsCode(() => env.store.registerAccount(secret(), '198.51.100.1'), 'QUOTA_EXCEEDED');
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 100);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM quotas WHERE owner != ?').get('service').n, 200);
  env.restart();
  rejectsCode(() => env.store.registerAccount(secret(), '198.51.100.1'), 'QUOTA_EXCEEDED');
  env.advance(86_400_000);
  env.store.registerAccount(secret(), '198.51.100.1');
});
