import type http from 'node:http';
import type { HostedStore } from './hosted-store.js';
import type { HostedIdentity } from './hosted-types.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import OAuth2Server from './oauth-engine.js';

export const HOSTED_OAUTH_SCOPES = ['noknok:events:read', 'noknok:events:manage', 'noknok:status:read'];
const SCOPE_LABELS = {
  'noknok:events:read': 'Discover activity notifications',
  'noknok:events:manage': 'Create, renew and remove this application’s notification subscriptions',
  'noknok:status:read': 'Read pending event identifiers and connection status',
};
const ACCESS_MS = 5 * 60_000, PAIR_MS = 10 * 60_000, GRANT_MS = 30 * 86_400_000;
const opaque = (prefix = '') => prefix + randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const bearer = req => /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const headers = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
function json(res, status, value) { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function page(res, content: string) {
  res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect NokNok</title><style>body{font:17px/1.6 system-ui;max-width:680px;margin:8vh auto;padding:24px;color:#172526;background:#f5f3eb}h1{line-height:1.15}button,input{font:inherit;padding:10px;margin:8px 0}button{cursor:pointer}code,dd{overflow-wrap:anywhere}dt{font-weight:600}dd{margin:0 0 12px}section{background:white;padding:24px;border-radius:12px}</style><main><h1>Connect your existing NokNok Agent</h1><section>${content}</section><p>Only event identifiers and status are shared. Your CLI keeps the message decryption keys. Plaintext you choose to send to a cloud model is processed by that model service.</p></main></html>`);
}
function fields(params: URLSearchParams): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of params) { if (Object.hasOwn(output, key)) throw failure(400, 'invalid_request', 'Duplicate parameters are not supported.'); output[key] = value; }
  return output;
}
async function body(req: http.IncomingMessage, kind: 'json' | 'form') {
  const expected = kind === 'json' ? /^application\/json(?:;|$)/i : /^application\/x-www-form-urlencoded(?:;|$)/i;
  if (!expected.test(String(req.headers['content-type'] || ''))) throw failure(415, 'invalid_request', `Use ${kind === 'json' ? 'application/json' : 'application/x-www-form-urlencoded'}.`);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw failure(413, 'invalid_request', 'Request body is too large.'); chunks.push(chunk); }
  const value = Buffer.concat(chunks).toString('utf8');
  if (kind === 'form') return fields(new URLSearchParams(value));
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(); return parsed; }
  catch { throw failure(400, 'invalid_request', 'Expected a JSON object.'); }
}
interface Client { id: string; name: string; redirectUris: string[]; method: string; secretHash?: string; grants: string[] }
interface Transaction { client_id: string; redirect_uri: string; response_type: string; state?: string; scope: string; resource: string; code_challenge: string; code_challenge_method: string }
export interface HostedOAuthIdentity extends HostedIdentity { grantId: string; scopes: string[] }

/** OAuth protocol mechanics are delegated to the maintained OAuth engine. This adapter owns
 * persistence, resource binding and the existing CLI identity's two-sided consent ceremony. */
export function createHostedOAuth({ store, onRevoke = () => {}, clientKey = req => req.socket.remoteAddress || 'unknown' }: {
  store: HostedStore; onRevoke?: (agentId: string, grantId: string) => void; clientKey?: (req: http.IncomingMessage) => string;
}) {
  const { db, realm } = store, resource = `${realm}/mcp`;
  const secure = realm.startsWith('https:'), cookieName = secure ? '__Host-noknok_oauth' : 'noknok_oauth';
  const row = (sql: string, ...args): any => db.prepare(sql).get(...args);
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_pairings (id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), expires_at INTEGER NOT NULL, transaction_id TEXT UNIQUE, status TEXT NOT NULL, confirmation TEXT);
    CREATE TABLE IF NOT EXISTS oauth_transactions (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), client_id TEXT NOT NULL REFERENCES oauth_clients(id), scope TEXT NOT NULL, resource TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), value TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), kind TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_rates (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);`);
  function cleanup() {
    const now = store.now();
    db.prepare('DELETE FROM oauth_rates WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM oauth_transactions WHERE expires_at<=?').run(now);
    db.prepare('DELETE FROM oauth_pairings WHERE expires_at<=?').run(now - PAIR_MS);
    db.prepare('DELETE FROM oauth_codes WHERE expires_at<=?').run(now);
    db.prepare("DELETE FROM oauth_tokens WHERE kind='access' AND expires_at<=?").run(now);
    // Keep used refresh hashes until their family expires, so replay remains detectable.
    db.prepare('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE expires_at<=?)').run(now);
    db.prepare('DELETE FROM oauth_codes WHERE grant_id IN (SELECT id FROM oauth_grants WHERE expires_at<=?)').run(now);
    db.prepare('DELETE FROM oauth_grants WHERE expires_at<=?').run(now);
  }
  function limit(key: string, ceiling: number, window = 60_000) {
    const id = hash(key), now = store.now();
    const saved = row('SELECT count,expires_at FROM oauth_rates WHERE id=?', id);
    if (saved?.expires_at > now && saved.count >= ceiling) throw failure(429, 'temporarily_unavailable', 'Too many requests; retry later.');
    if (!saved && row('SELECT COUNT(*) n FROM oauth_rates').n >= 10_000) throw failure(429, 'temporarily_unavailable', 'Request budget is full.');
    db.prepare('INSERT INTO oauth_rates(id,count,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at').run(id, saved?.expires_at > now ? saved.count + 1 : 1, saved?.expires_at > now ? saved.expires_at : now + window);
  }
  function client(id: string): Client | undefined { const saved = text(id, 256) && row('SELECT value FROM oauth_clients WHERE id=?', id); return saved ? JSON.parse(saved.value) : undefined; }
  function grant(id: string) { const saved = row('SELECT * FROM oauth_grants WHERE id=?', id); return saved && !saved.revoked && saved.expires_at > store.now() && store.isAgentActive(saved.agent_id) ? saved : undefined; }
  function revokeGrant(id: string) {
    const saved = row('SELECT agent_id FROM oauth_grants WHERE id=?', id);
    if (!saved) return;
    db.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').run(id);
    onRevoke(saved.agent_id, id);
  }
  function scopes(value: unknown): string[] {
    if (value === undefined || value === '') return [...HOSTED_OAUTH_SCOPES];
    if (typeof value !== 'string' || value.length > 256) throw failure(400, 'invalid_scope', 'Invalid scopes.');
    const result = [...new Set(value.split(' '))];
    if (!result.length || result.some(scope => !HOSTED_OAUTH_SCOPES.includes(scope))) throw failure(400, 'invalid_scope', 'Only event and status permissions are available.');
    return result;
  }
  function requireResource(value: unknown) { if (value !== resource) throw failure(400, 'invalid_target', 'The resource must exactly match this service MCP URL.'); }
  function authenticate(token: string): HostedOAuthIdentity {
    const saved = text(token, 256) && row("SELECT * FROM oauth_tokens WHERE hash=? AND kind='access'", hash(token));
    const owner = saved && grant(saved.grant_id);
    if (!saved || !owner || saved.expires_at <= store.now() || owner.resource !== resource) throw failure(401, 'invalid_token', 'The OAuth access token is invalid, expired or revoked.');
    return { agentId: owner.agent_id, accountId: store.accountForAgent(owner.agent_id), grantId: owner.id, scopes: saved.scope.split(' ') };
  }
  function tokenModel(authorizedClient?: Client) {
    return {
      getAccessToken: async () => false as const,
      getClient: async (id: string) => authorizedClient ? (id === authorizedClient.id ? authorizedClient : false) : client(id),
      validateRedirectUri: async (uri: string, value: Client) => value.redirectUris.includes(uri),
      validateScope: async (_user, _client, requested: string[]) => requested?.length && requested.every(scope => HOSTED_OAUTH_SCOPES.includes(scope)) ? requested : false,
      generateAuthorizationCode: async () => opaque('oac_'), generateAccessToken: async () => opaque('oat_'), generateRefreshToken: async () => opaque('ort_'),
      saveAuthorizationCode: async (code, registered, user) => {
        if (!store.isAgentActive(user.agentId)) throw failure(400, 'invalid_grant', 'Agent is unavailable.');
        const grantId = opaque('ogr_'), now = store.now();
        store._transaction(() => {
          if (row('SELECT COUNT(*) n FROM oauth_grants WHERE agent_id=?', user.agentId).n >= 100) throw failure(429, 'temporarily_unavailable', 'Agent grant limit reached.');
          db.prepare('INSERT INTO oauth_grants(id,agent_id,client_id,scope,resource,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(grantId, user.agentId, registered.id, code.scope.join(' '), resource, now, now + GRANT_MS);
          db.prepare('INSERT INTO oauth_codes(hash,grant_id,value,expires_at) VALUES (?,?,?,?)').run(hash(code.authorizationCode), grantId,
            JSON.stringify({ redirectUri: code.redirectUri, codeChallenge: code.codeChallenge, codeChallengeMethod: code.codeChallengeMethod }), Math.min(code.expiresAt.getTime(), now + 60_000));
        });
        return { ...code, client: registered, user: { agentId: user.agentId, grantId } };
      },
      getAuthorizationCode: async (code: string) => {
        const saved = text(code, 256) && row('SELECT * FROM oauth_codes WHERE hash=?', hash(code));
        const owner = saved && grant(saved.grant_id);
        if (!saved || !owner || saved.expires_at <= store.now() || (authorizedClient && owner.client_id !== authorizedClient.id)) return false;
        if (saved.used) { revokeGrant(owner.id); return false; }
        return { ...JSON.parse(saved.value), authorizationCode: code, expiresAt: new Date(saved.expires_at), scope: owner.scope.split(' '), client: client(owner.client_id), user: { agentId: owner.agent_id, grantId: owner.id } };
      },
      revokeAuthorizationCode: async code => {
        const changed = Number(db.prepare('UPDATE oauth_codes SET used=1 WHERE hash=? AND used=0').run(hash(code.authorizationCode)).changes) === 1;
        if (!changed) revokeGrant(code.user.grantId);
        return changed;
      },
      getRefreshToken: async (token: string) => {
        const saved = text(token, 256) && row("SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh'", hash(token));
        const owner = saved && grant(saved.grant_id);
        if (!saved || !owner || saved.expires_at <= store.now()) return false;
        return { refreshToken: token, refreshTokenExpiresAt: new Date(saved.expires_at), scope: saved.scope.split(' '), client: client(owner.client_id), user: { agentId: owner.agent_id, grantId: owner.id } };
      },
      revokeToken: async token => {
        const changed = Number(db.prepare("UPDATE oauth_tokens SET used=1 WHERE hash=? AND kind='refresh' AND used=0").run(hash(token.refreshToken)).changes) === 1;
        if (!changed) revokeGrant(token.user.grantId);
        return changed;
      },
      saveToken: async (token, registered, user) => {
        const owner = grant(user.grantId);
        if (!owner || owner.client_id !== registered.id || owner.resource !== resource || token.scope.some(scope => !owner.scope.split(' ').includes(scope))) throw failure(400, 'invalid_grant', 'Grant is unavailable.');
        token.accessTokenExpiresAt = new Date(Math.min(store.now() + ACCESS_MS, owner.expires_at));
        token.refreshTokenExpiresAt = new Date(owner.expires_at);
        store._transaction(() => {
          db.prepare('INSERT INTO oauth_tokens(hash,grant_id,kind,scope,expires_at) VALUES (?,?,?,?,?)').run(hash(token.accessToken), owner.id, 'access', token.scope.join(' '), token.accessTokenExpiresAt.getTime());
          db.prepare('INSERT INTO oauth_tokens(hash,grant_id,kind,scope,expires_at) VALUES (?,?,?,?,?)').run(hash(token.refreshToken), owner.id, 'refresh', token.scope.join(' '), owner.expires_at);
        });
        return { ...token, client: registered, user };
      },
    };
  }
  function engine(authorizedClient?: Client) {
    const options = { model: tokenModel(authorizedClient), requirePKCE: true, enablePlainPKCE: false, authorizationCodeLifetime: 60,
      accessTokenLifetime: ACCESS_MS / 1000, refreshTokenLifetime: GRANT_MS / 1000, requireClientAuthentication: { authorization_code: false, refresh_token: false }, alwaysIssueNewRefreshToken: true };
    return new OAuth2Server(options);
  }
  function authenticateClient(req, input): Client {
    let id = input.client_id, secret = input.client_secret, method = secret === undefined ? 'none' : 'client_secret_post';
    if (req.headers.authorization) {
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(req.headers.authorization);
      if (!match || secret !== undefined) throw failure(401, 'invalid_client', 'Invalid client authentication.');
      const decoded = Buffer.from(match[1], 'base64').toString('utf8'), colon = decoded.indexOf(':');
      if (colon < 0) throw failure(401, 'invalid_client', 'Invalid client authentication.');
      let basicId, basicSecret;
      try { basicId = decodeURIComponent(decoded.slice(0, colon)); basicSecret = decodeURIComponent(decoded.slice(colon + 1)); } catch { throw failure(401, 'invalid_client', 'Invalid client authentication.'); }
      if (id !== undefined && id !== basicId) throw failure(401, 'invalid_client', 'Conflicting client identifiers.');
      id = basicId; secret = basicSecret; method = 'client_secret_basic';
    }
    const registered = client(id);
    if (!registered || registered.method !== method || (registered.secretHash && (!text(secret, 256) || !equal(hash(secret), registered.secretHash)))) throw failure(401, 'invalid_client', 'Invalid client authentication.');
    input.client_id = id;
    return registered;
  }
  function cookie(req) { return String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1); }
  function csrf(secret: string) { return createHmac('sha256', store.signingKey).update(`oauth-csrf:${secret}`).digest('base64url'); }
  function transaction(req) {
    const secret = cookie(req), saved = text(secret, 256) && row('SELECT * FROM oauth_transactions WHERE id=? AND expires_at>?', hash(secret), store.now());
    if (!saved) throw failure(400, 'invalid_request', 'Authorization session expired. Restart connecting from your application.');
    return { id: saved.id, auth: JSON.parse(saved.value) as Transaction, secret: secret! };
  }
  function hidden(secret: string, action: string) { return `<input type="hidden" name="csrf" value="${csrf(secret)}"><input type="hidden" name="action" value="${action}">`; }
  function show(req, res) {
    const tx = transaction(req), registered = client(tx.auth.client_id)!;
    const pairing = row('SELECT * FROM oauth_pairings WHERE transaction_id=?', tx.id);
    const details = `<dl><dt>Application (self-reported name)</dt><dd>${escape(registered.name)}</dd><dt>Callback address</dt><dd>${escape(tx.auth.redirect_uri)}</dd><dt>Permissions</dt><dd><ul>${tx.auth.scope.split(' ').map(scope => `<li>${escape(SCOPE_LABELS[scope])}</li>`).join('')}</ul></dd>${pairing ? `<dt>Existing Agent</dt><dd>${escape(pairing.agent_id)}</dd>` : ''}</dl>`;
    if (!pairing) return page(res, `${details}<p>Run <code>noknok hosted pair --agent YOUR_EXISTING_HANDLE</code> in the CLI that already owns your Agent. Enter its short-lived pairing code below. Never enter an Agent token or encryption key.</p><form method="post" action="/oauth/authorize">${hidden(tx.secret, 'pair')}<label>Pairing code <input name="user_code" required autocomplete="off" maxlength="20"></label><br><button>Review Agent and permissions</button></form>`);
    if (pairing.expires_at <= store.now()) throw failure(400, 'invalid_request', 'Pairing expired; restart authorization.');
    if (pairing.status === 'review') return page(res, `${details}<p>Verify this is the application you intended to connect. Approving here also requires confirmation from your original CLI.</p><form method="post" action="/oauth/authorize">${hidden(tx.secret, 'consent')}<button>Confirm in browser</button></form><form method="post" action="/oauth/authorize">${hidden(tx.secret, 'deny')}<button>Deny</button></form>`);
    if (['awaiting_cli', 'approved'].includes(pairing.status)) return page(res, `${details}<p>In your original CLI, inspect this exact request:</p><p><code>noknok hosted pair-status ${escape(pairing.id)} --agent YOUR_EXISTING_HANDLE</code></p><p>Review the application, Agent and permissions there, then use the confirmation value shown by that command with <code>hosted pair-confirm</code>.</p><p>Request status: <strong>${escape(pairing.status)}</strong></p><form method="post" action="/oauth/authorize">${hidden(tx.secret, 'finish')}<button>Finish after CLI confirmation</button></form>`);
    throw failure(400, 'invalid_request', 'This pairing has already been used. Restart authorization.');
  }
  function pairingView(saved) {
    const tx = saved.transaction_id && row('SELECT value FROM oauth_transactions WHERE id=?', saved.transaction_id), auth = tx && JSON.parse(tx.value), registered = auth && client(auth.client_id);
    return { pairing_id: saved.id, agent_id: saved.agent_id, expires_at: saved.expires_at, status: saved.expires_at <= store.now() ? 'expired' : saved.status,
      ...(registered ? { client: { client_id: registered.id, client_name: registered.name, redirect_uri: auth.redirect_uri }, scope: auth.scope } : {}),
      ...(saved.status === 'awaiting_cli' ? { confirmation: saved.confirmation } : {}) };
  }
  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      if (req.method !== 'GET') throw failure(405, 'invalid_request', 'Use GET.');
      return json(res, 200, { resource, authorization_servers: [realm], scopes_supported: HOSTED_OAUTH_SCOPES, bearer_methods_supported: ['header'], resource_name: 'NokNok Events' });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (req.method !== 'GET') throw failure(405, 'invalid_request', 'Use GET.');
      return json(res, 200, { issuer: realm, authorization_endpoint: `${realm}/oauth/authorize`, token_endpoint: `${realm}/oauth/token`, registration_endpoint: `${realm}/oauth/register`, revocation_endpoint: `${realm}/oauth/revoke`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], scopes_supported: HOSTED_OAUTH_SCOPES,
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'] });
    }
    const ip = clientKey(req);
    limit(`http:${ip}`, 180);
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      limit(`register:${ip}`, 20); const input = await body(req, 'json');
      const method = input.token_endpoint_auth_method ?? 'client_secret_basic';
      if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method) || !Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 10) throw failure(400, 'invalid_client_metadata', 'Provide supported client authentication and redirect URIs.');
      const uris = [...new Set<string>(input.redirect_uris)];
      for (const value of uris) {
        let target: URL;
        try { if (!text(value, 2048)) throw Error(); target = new URL(value); } catch { throw failure(400, 'invalid_redirect_uri', 'Invalid redirect URI.'); }
        if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) || target.username || target.password || target.hash) throw failure(400, 'invalid_redirect_uri', 'Use HTTPS redirect URIs without fragments or credentials.');
      }
      if ((input.grant_types !== undefined && (!Array.isArray(input.grant_types) || !input.grant_types.includes('authorization_code') || input.grant_types.some(value => !['authorization_code', 'refresh_token'].includes(value)))) || (input.response_types !== undefined && (!Array.isArray(input.response_types) || input.response_types.length !== 1 || input.response_types[0] !== 'code'))) throw failure(400, 'invalid_client_metadata', 'Only authorization code and refresh token grants are supported.');
      if (input.scope !== undefined) scopes(input.scope);
      if (input.client_name !== undefined && !text(input.client_name, 120)) throw failure(400, 'invalid_client_metadata', 'Invalid client name.');
      if (row('SELECT COUNT(*) n FROM oauth_clients').n >= 10_000) throw failure(429, 'temporarily_unavailable', 'Client registration capacity reached.');
      const secret = method === 'none' ? undefined : opaque('ocs_');
      const registered: Client = { id: opaque('ocl_'), name: input.client_name || 'Unnamed OAuth application', redirectUris: uris, method, ...(secret ? { secretHash: hash(secret) } : {}), grants: input.grant_types || ['authorization_code', 'refresh_token'] };
      db.prepare('INSERT INTO oauth_clients(id,value) VALUES (?,?)').run(registered.id, JSON.stringify(registered));
      return json(res, 201, { client_id: registered.id, client_id_issued_at: Math.floor(store.now() / 1000), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_name: registered.name, redirect_uris: uris, token_endpoint_auth_method: method, grant_types: registered.grants, response_types: ['code'], scope: HOSTED_OAUTH_SCOPES.join(' ') });
    }
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
      const input = fields(url.searchParams), registered = client(input.client_id);
      if (!registered || !registered.redirectUris.includes(input.redirect_uri)) throw failure(400, 'invalid_request', 'Unknown client or unregistered redirect URI.');
      requireResource(input.resource);
      if (input.response_type !== 'code' || input.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge || '') || (input.state !== undefined && (!text(input.state, 512) || !/^[\x20-\x7e]+$/.test(input.state)))) throw failure(400, 'invalid_request', 'Authorization code with S256 PKCE and a valid state parameter is required.');
      limit(`authorize:${ip}`, 30);
      if (row('SELECT COUNT(*) n FROM oauth_transactions').n >= 10_000) throw failure(429, 'temporarily_unavailable', 'Authorization session capacity reached.');
      const auth = { client_id: registered.id, redirect_uri: input.redirect_uri, response_type: 'code', state: input.state, scope: scopes(input.scope).join(' '), resource, code_challenge: input.code_challenge, code_challenge_method: 'S256' };
      const secret = opaque(); db.prepare('INSERT INTO oauth_transactions(id,value,expires_at) VALUES (?,?,?)').run(hash(secret), JSON.stringify(auth), store.now() + PAIR_MS);
      res.setHeader('Set-Cookie', `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PAIR_MS / 1000}${secure ? '; Secure' : ''}`);
      req.headers.cookie = `${cookieName}=${secret}`; return show(req, res);
    }
    if (url.pathname === '/oauth/continue' && req.method === 'GET') return show(req, res);
    if (url.pathname === '/oauth/pair' && req.method === 'GET') return page(res, '<p>Add the NokNok <code>/mcp</code> URL to your application and choose OAuth. Enter the short-lived pairing code on the authorization page opened by that application.</p><p>The pairing link itself contains no credentials.</p>');
    if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
      const input = await body(req, 'form'), tx = transaction(req);
      if (req.headers.origin !== realm || !text(input.csrf, 256) || !equal(input.csrf, csrf(tx.secret))) throw failure(403, 'access_denied', 'Invalid browser confirmation.');
      const paired = row('SELECT * FROM oauth_pairings WHERE transaction_id=?', tx.id);
      if (input.action === 'pair') {
        limit(`pair-code:${ip}`, 15); limit(`pair-session:${tx.id}`, 5, PAIR_MS);
        const code = typeof input.user_code === 'string' ? input.user_code.replace(/[ -]/g, '').toUpperCase() : '';
        if (!/^[A-F0-9]{12}$/.test(code) || paired) throw failure(400, 'invalid_request', 'Invalid or already used pairing code.');
        const changed = db.prepare("UPDATE oauth_pairings SET transaction_id=?,status='review' WHERE code_hash=? AND transaction_id IS NULL AND expires_at>? AND status='waiting_for_browser'").run(tx.id, hash(code), store.now());
        if (Number(changed.changes) !== 1) throw failure(400, 'invalid_request', 'Invalid or expired pairing code.');
        return show(req, res);
      }
      if (!paired || paired.expires_at <= store.now() || !store.isAgentActive(paired.agent_id)) throw failure(400, 'invalid_request', 'Pairing is unavailable.');
      if (input.action === 'deny' && paired.status === 'review') {
        db.prepare("UPDATE oauth_pairings SET status='denied' WHERE id=?").run(paired.id);
        const redirect = new URL(tx.auth.redirect_uri); redirect.searchParams.set('error', 'access_denied'); if (tx.auth.state !== undefined) redirect.searchParams.set('state', tx.auth.state);
        res.writeHead(302, { ...headers, Location: redirect.href }); return res.end();
      }
      if (input.action === 'consent' && paired.status === 'review') {
        db.prepare("UPDATE oauth_pairings SET status='awaiting_cli',confirmation=? WHERE id=? AND status='review'").run(opaque('confirm_'), paired.id);
        return show(req, res);
      }
      if (input.action === 'finish' && paired.status === 'awaiting_cli') return show(req, res);
      if (input.action === 'finish' && paired.status === 'approved') {
        if (Number(db.prepare("UPDATE oauth_pairings SET status='completed' WHERE id=? AND status='approved'").run(paired.id).changes) !== 1) throw failure(400, 'invalid_request', 'Pairing already used.');
        const response = new OAuth2Server.Response();
        await engine().authorize(new OAuth2Server.Request({ method: 'GET', headers: {}, query: tx.auth, body: {} }), response, { allowEmptyState: true, authenticateHandler: { handle: () => ({ agentId: paired.agent_id }) } });
        db.prepare('DELETE FROM oauth_transactions WHERE id=?').run(tx.id);
        res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
        res.writeHead(response.status || 302, { ...headers, ...response.headers }); return res.end();
      }
      throw failure(400, 'invalid_request', 'Invalid authorization step.');
    }
    if ((url.pathname === '/oauth/token' || url.pathname === '/oauth/revoke') && req.method === 'POST') {
      const input = await body(req, 'form'), registered = authenticateClient(req, input);
      limit(`token:${registered.id}`, 60);
      if (url.pathname === '/oauth/revoke') {
        if (!text(input.token, 256)) throw failure(400, 'invalid_request', 'A token is required.');
        const saved = row('SELECT g.id,g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=?', hash(input.token));
        if (saved?.client_id === registered.id) revokeGrant(saved.id);
        return json(res, 200, {});
      }
      requireResource(input.resource);
      if (!['authorization_code', 'refresh_token'].includes(input.grant_type)) throw failure(400, 'unsupported_grant_type', 'Unsupported grant type.');
      if (input.grant_type === 'authorization_code' && (!text(input.code_verifier, 128) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier))) throw failure(400, 'invalid_request', 'A valid PKCE verifier is required.');
      const response = new OAuth2Server.Response();
      await engine(registered).token(new OAuth2Server.Request({ method: 'POST', headers: { ...req.headers, 'content-type': 'application/x-www-form-urlencoded' }, query: {}, body: input }), response);
      res.writeHead(response.status || 200, { ...headers, ...response.headers, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(response.body));
    }
    if (url.pathname === '/oauth/pairings' && req.method === 'POST') {
      store.authenticate(bearer(req)); await body(req, 'json'); const actor = store.authenticate(bearer(req)); limit(`pair:${actor.agentId}`, 5, PAIR_MS);
      const id = opaque('pair_'), code = randomBytes(6).toString('hex').toUpperCase(), expiresAt = store.now() + PAIR_MS;
      db.prepare('INSERT INTO oauth_pairings(id,code_hash,agent_id,expires_at,status) VALUES (?,?,?,?,?)').run(id, hash(code), actor.agentId, expiresAt, 'waiting_for_browser');
      return json(res, 201, { pairing_id: id, user_code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, verification_uri: `${realm}/oauth/pair`, verification_uri_complete: `${realm}/oauth/pair`, expires_at: expiresAt });
    }
    const pairMatch = /^\/oauth\/pairings\/([A-Za-z0-9_-]+)(\/confirm)?$/.exec(url.pathname);
    if (pairMatch) {
      const actor = store.authenticate(bearer(req)), saved = row('SELECT * FROM oauth_pairings WHERE id=? AND agent_id=?', pairMatch[1], actor.agentId);
      if (!saved) throw failure(404, 'invalid_request', 'Pairing not found.');
      if (!pairMatch[2] && req.method === 'GET') return json(res, 200, pairingView(saved));
      if (pairMatch[2] && req.method === 'POST') {
        const input = await body(req, 'json'); store.authenticate(bearer(req)); limit(`confirm:${actor.agentId}`, 10);
        if (saved.status !== 'awaiting_cli' || saved.expires_at <= store.now() || !text(input.confirmation, 256) || !equal(input.confirmation, saved.confirmation)) throw failure(400, 'invalid_request', 'Review this exact pending request before confirming it.');
        if (Number(db.prepare("UPDATE oauth_pairings SET status='approved' WHERE id=? AND status='awaiting_cli'").run(saved.id).changes) !== 1) throw failure(400, 'invalid_request', 'Pairing confirmation already used.');
        return json(res, 200, pairingView({ ...saved, status: 'approved' }));
      }
      throw failure(405, 'invalid_request', 'Unsupported pairing method.');
    }
    if (url.pathname === '/oauth/grants' && req.method === 'GET') {
      const actor = store.authenticate(bearer(req));
      const grants = db.prepare('SELECT * FROM oauth_grants WHERE agent_id=? ORDER BY created_at DESC').all(actor.agentId) as any[];
      return json(res, 200, { grants: grants.map(saved => ({ grant_id: saved.id, client_id: saved.client_id, client_name: client(saved.client_id)?.name, agent_id: saved.agent_id, scope: saved.scope, created_at: saved.created_at, expires_at: saved.expires_at, revoked: !!saved.revoked })) });
    }
    const grantMatch = /^\/oauth\/grants\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (grantMatch && req.method === 'DELETE') {
      const actor = store.authenticate(bearer(req)), saved = row('SELECT id FROM oauth_grants WHERE id=? AND agent_id=?', grantMatch[1], actor.agentId);
      if (!saved) throw failure(404, 'invalid_request', 'Grant not found.'); revokeGrant(saved.id); return json(res, 200, { revoked: true, grant_id: saved.id });
    }
    throw failure(404, 'invalid_request', 'Unknown OAuth endpoint or method.');
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/oauth/') && !['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return false;
    try { cleanup(); await route(req, res, url); }
    catch (error) {
      const status = error.status || error.statusCode || error.code === 'UNAUTHENTICATED' && 401 || 500;
      const code = status >= 500 ? 'server_error' : /^[a-z_]+$/.test(error.name) ? error.name : /^[a-z_]+$/.test(error.code) ? error.code : status === 401 ? 'invalid_token' : 'invalid_request';
      if (!res.writableEnded) json(res, status, { error: code, error_description: status >= 500 ? 'Authorization service unavailable.' : error.message });
    }
    return true;
  }
  return { handle, authenticate, isGrantActive: (id: string, agentId?: string) => { const saved = grant(id); return !!saved && (!agentId || saved.agent_id === agentId); }, revokeGrant };
}
