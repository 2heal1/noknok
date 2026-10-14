import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openHostedStore } from '../src/hosted-store.js';
import { createHostedOAuth, HOSTED_OAUTH_SCOPES } from '../src/hosted-oauth.js';
import { authorizeOAuth } from './oauth-helper.js';

const secret = () => randomBytes(32).toString('base64url');
async function setup(t, extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'noknok-oauth-')), realm = 'https://noknok.example';
  let now = Date.now(), store = openHostedStore({ dataDir, realm, now: () => now });
  const revoked: any[] = [], options = () => ({ store, onRevoke: (agentId, grantId) => revoked.push({ agentId, grantId }), ...extra });
  let oauth = createHostedOAuth(options());
  const server = http.createServer((req, res) => { void oauth.handle(req, res, new URL(req.url!, realm)).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const request = (path, options: RequestInit = {}) => fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });
  const post = (path, input, headers = {}) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(input).toString() });
  const register = async (extra = {}) => { const response = await request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test app', redirect_uris: ['https://chatgpt.com/connector_platform/oauth_redirect'], token_endpoint_auth_method: 'none', ...extra }) }); return { response, value: await response.json() }; };
  return { baseUrl, realm, revoked, request, post, register, get store() { return store; }, get oauth() { return oauth; }, advance(ms) { now += ms; },
    restart() { store.close(); store = openHostedStore({ dataDir, realm, now: () => now }); oauth = createHostedOAuth(options()); },
    agent() { const account = store.registerAccount(secret()); return { ...account, ...store.registerAgent(account.accountToken, { requestId: secret() }) }; } };
}
function refresh(env, connected, extra = {}) { return env.post('/oauth/token', { grant_type: 'refresh_token', client_id: connected.client.client_id, refresh_token: connected.tokens.refresh_token, resource: `${env.realm}/mcp`, ...extra }); }

test('OAuth metadata and DCR support exact redirect registration and limited scopes', async t => {
  const env = await setup(t);
  const resource = await (await env.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, `${env.realm}/mcp`); assert.deepEqual(resource.scopes_supported, HOSTED_OAUTH_SCOPES);
  const metadata = await (await env.request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']); assert.ok(metadata.registration_endpoint);
  for (const redirect of ['http://example.com/callback', 'https://example.com/cb#fragment', 'https://user:password@example.com/cb', 'javascript:alert(1)', 'https://*/callback', 'https://*.example.com/callback', 'https://example.com;/callback', "https://example.com'/callback", 'http://[::1]:3000/callback', 'https://[::1]/callback', 'https://192.0.2.1/callback']) {
    const rejected = await env.register({ redirect_uris: [redirect] });
    assert.equal(rejected.response.status, 400, redirect); assert.equal(rejected.value.error, 'invalid_redirect_uri', redirect);
  }
  for (const redirect of ['https://example.com/callback', 'http://localhost:3000/callback', 'http://127.0.0.1:3000/callback', 'https://127.0.0.1/callback', 'https://例子.example/callback']) {
    assert.equal((await env.register({ redirect_uris: [redirect] })).response.status, 201, redirect);
  }
  assert.equal((await env.register({ scope: 'noknok:messages:send' })).response.status, 400);
  assert.equal((await env.register({ grant_types: ['password'] })).response.status, 400);
  const { value: client } = await env.register();
  const query = { response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: `${env.realm}/mcp`, code_challenge: secret(), code_challenge_method: 'S256' };
  for (const extra of [{ redirect_uri: 'https://chatgpt.com/connector_platform/oauth_redirect/extra' }, { resource: `${env.realm}/other` }, { scope: 'noknok:messages:send' }, { code_challenge_method: 'plain' }, { code_challenge: '' }]) {
    const response = await env.request(`/oauth/authorize?${new URLSearchParams({ ...query, ...extra })}`); assert.equal(response.status, 400); assert.equal(response.headers.get('location'), null);
  }
  assert.equal((await env.request(`/oauth/authorize?${new URLSearchParams(query)}&client_id=duplicate`)).status, 400);
});

test('OAuth page CSP does not trust unsafe callback hosts in persisted client metadata', async t => {
  const env = await setup(t), { value: client } = await env.register();
  const saved = JSON.parse(env.store.db.prepare('SELECT value FROM oauth_clients WHERE id=?').get(client.client_id).value);
  for (const redirect of ['https://*/callback', 'https://*.example.com/callback', 'https://example.com;/callback', 'http://[::1]:3000/callback', 'https://192.0.2.1/callback']) {
    env.store.db.prepare('UPDATE oauth_clients SET value=? WHERE id=?').run(JSON.stringify({ ...saved, redirectUris: [redirect] }), client.client_id);
    const response = await env.request(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, resource: `${env.realm}/mcp`, code_challenge: secret(), code_challenge_method: 'S256' })}`);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type')!, /^application\/json/);
    assert.equal((await response.json()).error, 'invalid_redirect_uri');
    const formAction = response.headers.get('content-security-policy')!.split(';').map(value => value.trim()).filter(value => value.startsWith('form-action '));
    assert.deepEqual(formAction, ["form-action 'self'"]);
  }
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM oauth_grants').get().n, 0);
});

test('two-sided pairing preserves the existing identity, rejects cross-Agent access and stores only hashed credentials', async t => {
  const env = await setup(t), agent = env.agent(), other = env.agent();
  const contacts = env.store.acceptOffer(agent.agentId, env.store.issueOffer(other.agentId));
  const connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken, beforeConfirm: async context => {
    assert.equal((await context.browser('finish')).status, 200);
    const foreign = await env.request(`/oauth/pairings/${context.pairing.pairing_id}`, { headers: { Authorization: `Bearer ${other.agentToken}` } }); assert.equal(foreign.status, 404);
    const blind = await context.cli(`/oauth/pairings/${context.pairing.pairing_id}/confirm`, 'POST', { confirmation: 'wrong' }); assert.equal(blind.status, 400);
    const csrf = await env.post('/oauth/authorize', { action: 'finish', csrf: 'é'.repeat(context.csrf.length) }, { Cookie: context.cookie, Origin: env.realm }); assert.equal(csrf.status, 403);
    const origin = await env.post('/oauth/authorize', { action: 'finish', csrf: context.csrf }, { Cookie: context.cookie, Origin: 'https://attacker.example' }); assert.equal(origin.status, 403);
  } });
  const actor = env.oauth.authenticate(connected.tokens.access_token);
  assert.equal(actor.agentId, agent.agentId); assert.equal(actor.accountId, agent.accountId); assert.deepEqual(actor.scopes, HOSTED_OAUTH_SCOPES);
  assert.equal(env.oauth.isGrantActive(actor.grantId, other.agentId), false);
  assert.equal((env.store.db.prepare('SELECT COUNT(*) n FROM agents').get() as any).n, 2);
  env.store.verifyCapability(agent.agentId, other.agentId, contacts.contact.capability);
  const saved = JSON.stringify(['oauth_clients', 'oauth_pairings', 'oauth_transactions', 'oauth_codes', 'oauth_tokens', 'oauth_grants'].map(table => env.store.db.prepare(`SELECT * FROM ${table}`).all()));
  for (const credential of [agent.agentToken, agent.accountToken, connected.tokens.access_token, connected.tokens.refresh_token, connected.exchangeBody.code]) assert.ok(!saved.includes(credential));
  assert.ok(!connected.pairing.verification_uri_complete.includes(connected.pairing.user_code));
  assert.equal((await connected.browser('finish')).status, 400);
  env.restart(); assert.equal(env.oauth.authenticate(connected.tokens.access_token).agentId, agent.agentId);
});

test('PKCE code verifier, redirect URI and resource are bound to the authorization request', async t => {
  const env = await setup(t), agent = env.agent();
  const connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken, exchange: false });
  const wrongResource = await env.post('/oauth/token', { ...connected.exchangeBody, resource: 'https://other.example/mcp' }); assert.equal(wrongResource.status, 400);
  const wrongClient = await env.register();
  const crossClient = await env.post('/oauth/token', { ...connected.exchangeBody, client_id: wrongClient.value.client_id }); assert.equal(crossClient.status, 400);
  const wrongVerifier = await env.post('/oauth/token', { ...connected.exchangeBody, code_verifier: secret() }); assert.equal(wrongVerifier.status, 400);
  const consumed = await env.post('/oauth/token', connected.exchangeBody); assert.equal(consumed.status, 400);
  const second = await authorizeOAuth({ ...env, agentToken: agent.agentToken, exchange: false });
  const wrongRedirect = await env.post('/oauth/token', { ...second.exchangeBody, redirect_uri: `${second.exchangeBody.redirect_uri}?changed=1` }); assert.equal(wrongRedirect.status, 400);
});

test('refresh tokens rotate, narrow scopes and revoke the entire family on replay', async t => {
  const env = await setup(t), agent = env.agent(), connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken });
  const badScope = await refresh(env, connected, { scope: 'noknok:messages:send' }); assert.equal(badScope.status, 400);
  const renewed = await refresh(env, connected, { scope: 'noknok:status:read' }), tokens = await renewed.json(); assert.equal(renewed.status, 200, JSON.stringify(tokens));
  assert.notEqual(tokens.refresh_token, connected.tokens.refresh_token); assert.deepEqual(env.oauth.authenticate(tokens.access_token).scopes, ['noknok:status:read']);
  env.restart();
  const replay = await refresh(env, connected); assert.equal(replay.status, 400);
  assert.throws(() => env.oauth.authenticate(connected.tokens.access_token), { status: 401 }); assert.throws(() => env.oauth.authenticate(tokens.access_token), { status: 401 });
  assert.equal(env.revoked.length, 1);
  assert.equal((await refresh(env, { ...connected, tokens })).status, 400);
  assert.equal(env.store.authenticate(agent.agentToken).agentId, agent.agentId);
});

test('concurrent refresh replay cannot leave an active token family', async t => {
  const env = await setup(t), agent = env.agent(), connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken });
  const results = await Promise.all([refresh(env, connected), refresh(env, connected)]);
  assert.ok(results.some(response => response.status === 400));
  for (const response of results) { const value = await response.json(); if (response.status === 200) assert.throws(() => env.oauth.authenticate(value.access_token), { status: 401 }); }
  assert.throws(() => env.oauth.authenticate(connected.tokens.access_token), { status: 401 });
});

test('authorization-code replay revokes tokens from that code, but other clients cannot revoke them', async t => {
  const env = await setup(t), agent = env.agent(), connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken });
  const other = await env.register();
  assert.equal((await env.post('/oauth/token', { ...connected.exchangeBody, client_id: other.value.client_id })).status, 400);
  assert.equal(env.oauth.authenticate(connected.tokens.access_token).agentId, agent.agentId);
  assert.equal((await env.post('/oauth/token', connected.exchangeBody)).status, 400);
  assert.throws(() => env.oauth.authenticate(connected.tokens.access_token), { status: 401 });
});

test('OAuth revocation is immediately effective and isolated from another grant and CLI credentials', async t => {
  const env = await setup(t), agent = env.agent(), other = env.agent();
  const first = await authorizeOAuth({ ...env, agentToken: agent.agentToken }), second = await authorizeOAuth({ ...env, agentToken: agent.agentToken });
  const actor = env.oauth.authenticate(first.tokens.access_token);
  const foreign = await env.request(`/oauth/grants/${actor.grantId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${other.agentToken}` } }); assert.equal(foreign.status, 404);
  const revoked = await env.request(`/oauth/grants/${actor.grantId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${agent.agentToken}` } }); assert.equal(revoked.status, 200);
  assert.throws(() => env.oauth.authenticate(first.tokens.access_token), { status: 401 });
  assert.equal(env.oauth.authenticate(second.tokens.access_token).agentId, agent.agentId); assert.equal(env.store.authenticate(agent.agentToken).agentId, agent.agentId);
  assert.equal((await env.post('/oauth/revoke', { client_id: second.client.client_id, token: second.tokens.refresh_token })).status, 200);
  assert.throws(() => env.oauth.authenticate(second.tokens.access_token), { status: 401 });
});

test('confidential clients must authenticate every token and revocation request', async t => {
  const env = await setup(t), agent = env.agent();
  for (const method of ['client_secret_post', 'client_secret_basic']) {
    const registered = await env.register({ token_endpoint_auth_method: method }), client = registered.value;
    const connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken, client });
    assert.equal((await refresh(env, connected)).status, 401);
    assert.equal((await env.post('/oauth/revoke', { client_id: client.client_id, token: connected.tokens.access_token })).status, 401);
    const body = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: connected.tokens.refresh_token, resource: `${env.realm}/mcp`, ...(method === 'client_secret_post' ? { client_secret: client.client_secret } : {}) };
    const headers = method === 'client_secret_basic' ? { Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` } : {};
    const renewed = await env.post('/oauth/token', body, headers); assert.equal(renewed.status, 200, await renewed.text());
  }
});

test('access expiry, absolute refresh expiry and Agent revocation fail closed', async t => {
  const env = await setup(t), agent = env.agent(), connected = await authorizeOAuth({ ...env, agentToken: agent.agentToken });
  env.advance(5 * 60_000 + 1); assert.throws(() => env.oauth.authenticate(connected.tokens.access_token), { status: 401 });
  const renewed = await refresh(env, connected), tokens = await renewed.json(); assert.equal(renewed.status, 200);
  env.store.revokeAgent(agent.agentId); assert.throws(() => env.oauth.authenticate(tokens.access_token), { status: 401 });
  assert.equal((await refresh(env, { ...connected, tokens })).status, 400);
  env.advance(31 * 86_400_000); assert.equal((await refresh(env, connected)).status, 400);
});

test('pairing codes expire and browser guessing has a bounded per-session budget', async t => {
  const env = await setup(t), agent = env.agent();
  const response = await env.request('/oauth/pairings', { method: 'POST', headers: { Authorization: `Bearer ${agent.agentToken}`, 'Content-Type': 'application/json' }, body: '{}' }), pairing = await response.json();
  const { value: client } = await env.register();
  const authorization = await env.request(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: `${env.realm}/mcp`, code_challenge: secret(), code_challenge_method: 'S256' })}`);
  const cookie = authorization.headers.get('set-cookie')!.split(';')[0], csrf = /name="csrf" value="([^"]+)"/.exec(await authorization.text())![1];
  for (let i = 0; i < 5; i++) assert.equal((await env.post('/oauth/authorize', { action: 'pair', csrf, user_code: '0000-0000-0000' }, { Cookie: cookie, Origin: env.realm })).status, 400);
  assert.equal((await env.post('/oauth/authorize', { action: 'pair', csrf, user_code: pairing.user_code }, { Cookie: cookie, Origin: env.realm })).status, 429);
  env.advance(10 * 60_000 + 1);
  const status = await env.request(`/oauth/pairings/${pairing.pairing_id}`, { headers: { Authorization: `Bearer ${agent.agentToken}` } }); assert.equal((await status.json()).status, 'expired');
  assert.equal((await env.post('/oauth/authorize', { action: 'pair', csrf, user_code: pairing.user_code }, { Cookie: cookie, Origin: env.realm })).status, 400);
});

test('Agent credentials are rechecked after a slow pairing upload', async t => {
  const env = await setup(t), agent = env.agent();
  let observed!: () => void;
  const authenticated = new Promise<void>(resolve => { observed = resolve; });
  const originalAuthenticate = env.store.authenticate.bind(env.store);
  env.store.authenticate = token => { const result = originalAuthenticate(token); observed(); return result; };
  let request!: http.ClientRequest;
  const pending = new Promise<number>(resolve => {
    request = http.request(`${env.baseUrl}/oauth/pairings`, { method: 'POST', headers: { Authorization: `Bearer ${agent.agentToken}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => { response.resume(); resolve(response.statusCode!); });
    request.write('{');
  });
  await authenticated; env.store.revokeAgent(agent.agentId); request.end('}');
  assert.equal(await pending, 401);
  assert.equal((env.store.db.prepare('SELECT COUNT(*) n FROM oauth_pairings').get() as any).n, 0);
});

test('trusted caller identity keeps OAuth rate budgets separate behind a proxy', async t => {
  const env = await setup(t, { clientKey: req => String(req.headers['x-test-client']) });
  const register = key => env.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-client': key }, body: JSON.stringify({ redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'none' }) });
  for (let i = 0; i < 20; i++) assert.equal((await register('one')).status, 201);
  assert.equal((await register('one')).status, 429);
  assert.equal((await register('two')).status, 201);
});
