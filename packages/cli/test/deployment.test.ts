import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deploymentConfig, startDeployment } from '../src/deploy/server.js';
import { EVENT_NAME, TEST_TEXTS, startMcpEventsPoc } from '../poc/mcp-events/server.js';
import { gatewayMcpToken } from '../src/gateway.js';
import { startGatewayClient } from '../src/gateway-client.js';

const PUBLIC_URL = 'https://relay.example.com';
const SERVER_KEY = 'synthetic-relay-server-key';

async function fixture(t, { enabled = true, ...overrides } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-deploy-test-'));
  const tokens = { A: randomBytes(32).toString('base64url'), B: randomBytes(32).toString('base64url') };
  const logs = [];
  const callbacks = [];
  const env = {
    NOKNOK_PUBLIC_URL: PUBLIC_URL, NOKNOK_SERVER_KEY: SERVER_KEY,
    NOKNOK_MCP_POC_ENABLED: enabled ? '1' : '0',
    NOKNOK_MCP_STATE_PATH: join(directory, 'state.json'),
    NOKNOK_MCP_AGENT_A_TOKEN: tokens.A, NOKNOK_MCP_AGENT_B_TOKEN: tokens.B,
    ...overrides,
  };
  const options = { env, port: 0, host: '127.0.0.1', logger: entry => logs.push(entry), mcpOptions: {
    workerIntervalMs: 10,
    webhookPost: async (_url, request) => {
      const payload = JSON.parse(request.body);
      callbacks.push(payload);
      return { status: 200, body: payload.type === 'verification' ? JSON.stringify({ challenge: payload.challenge }) : '{}' };
    },
  } };
  let app = await startDeployment(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let id = 0;
  return {
    tokens, logs, callbacks, env, directory, options,
    get app() { return app; },
    async restart() { await app.close(); app = await startDeployment(options); },
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(`${app.origin}${path}`, {
        method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      for (const token of Object.values(tokens)) assert.equal(text.includes(token), false, 'capabilities never appear in responses');
      return { status: response.status, text, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : undefined };
    },
    rpc(owner, method, params = {}) {
      return this.request(`/mcp/${tokens[owner]}`, { method: 'POST', body: { jsonrpc: '2.0', id: ++id, method, params } });
    },
    tool(owner, name, args = {}) { return this.rpc(owner, 'tools/call', { name, arguments: args }); },
    create() { return this.request('/v1/calls', { method: 'POST', headers: { 'X-Noknok-Key': SERVER_KEY }, body: { name: 'Alpha', purpose: 'Deployment integration test' } }); },
  };
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'event worker completed'); await delay(10); }
}

test('deployment defaults preserve the relay and require explicit MCP configuration', async t => {
  const base = { NOKNOK_PUBLIC_URL: PUBLIC_URL };
  assert.equal(deploymentConfig(base).mcp, undefined);
  assert.equal(deploymentConfig(base).retentionMs, 600000);
  assert.equal(deploymentConfig(base).meetingTtlMs, 7200000);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_MEETING_TTL_SECONDS: '0' }), /NOKNOK_MEETING_TTL_SECONDS/);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_MAX_MEETINGS: '0' }), /NOKNOK_MAX_MEETINGS/);
  assert.equal(deploymentConfig({ ...base, PORT: '9000' }).port, 9000);
  assert.throws(() => deploymentConfig({ ...base, PORT: '0' }), /PORT/);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_MCP_POC_ENABLED: 'true' }), /must be 0 or 1/);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_MCP_POC_ENABLED: '1' }), /requires both/);
  const f = await fixture(t, { enabled: false });
  assert.deepEqual((await f.request('/health')).body, { ok: true, version: 1 });
  assert.equal((await f.request(`/mcp/${f.tokens.A}`)).status, 404);
  assert.equal((await f.create()).status, 201);
  await assert.rejects(stat(f.env.NOKNOK_MCP_STATE_PATH), { code: 'ENOENT' });
});

test('private deployment serves meetings with configured limits and separate read-only capability', async t => {
  const f = await fixture(t, { enabled: false, NOKNOK_MEETING_TTL_SECONDS: '60', NOKNOK_MAX_MEETINGS: '1' });
  const retryToken = randomBytes(32).toString('base64url');
  const created = await f.request('/v1/meetings', { method: 'POST', headers: { 'X-Noknok-Key': SERVER_KEY }, body: { name: 'agent-codex', purpose: 'Private meeting', requestId: 'private-meeting-create', retryToken } });
  assert.equal(created.status, 201);
  const { meeting, participant, invitationUrl, viewUrl } = created.body;
  assert.equal(Date.parse(meeting.expiresAt) - Date.parse(meeting.createdAt), 60000);
  assert.equal(new URL(invitationUrl).origin, PUBLIC_URL);
  assert.equal(new URL(invitationUrl).search, '');
  assert.equal((await f.request('/meeting')).status, 200);
  assert.equal((await f.request('/meeting.js')).status, 200);
  const path = `/v1/meetings/${meeting.id}`;
  assert.equal((await f.request(path)).status, 401);
  const view = new URLSearchParams(new URL(viewUrl).hash.slice(1)).get('view');
  const read = await f.request(path, { headers: { Authorization: `Bearer ${view}` } });
  assert.equal(read.status, 200);
  assert.equal(read.text.includes(participant.token), false);
  assert.equal(JSON.stringify([created.body, read.body, f.logs]).includes(retryToken), false);
  assert.equal((await f.request(`${path}/end`, { method: 'POST', headers: { Authorization: `Bearer ${view}` }, body: {} })).status, 401);
  assert.equal((await f.request('/v1/meetings', { method: 'POST', headers: { 'X-Noknok-Key': SERVER_KEY }, body: { name: 'Another', purpose: 'Capacity' } })).status, 503);
  assert.deepEqual(f.logs, []);
  await assert.rejects(stat(f.env.NOKNOK_MCP_STATE_PATH), { code: 'ENOENT' });
});

test('native gateway deployment routes independent endpoints without legacy identity files', async t => {
  const base = { NOKNOK_PUBLIC_URL: PUBLIC_URL };
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_GATEWAY_ENABLED: 'true' }), /must be 0 or 1/);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_GATEWAY_ENABLED: '1', NOKNOK_MCP_POC_ENABLED: '1' }), /Choose/);
  const f = await fixture(t, { enabled: false, NOKNOK_GATEWAY_ENABLED: '1', NOKNOK_SERVER_KEY: '' });
  const owner = randomBytes(32).toString('base64url');
  const client = startGatewayClient({ config: { origin: f.app.origin, token: owner }, dispatch: async method => ({ nativeGateway: true, method }) });
  t.after(() => client.close());
  await eventually(() => client.status().connected);
  const result = await f.request('/mcp/' + gatewayMcpToken(owner), { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'server/discover' } });
  assert.deepEqual(result.body.result, { nativeGateway: true, method: 'server/discover' });
  assert.equal((await f.request('/view')).status, 200);
  await assert.rejects(stat(f.env.NOKNOK_MCP_STATE_PATH), { code: 'ENOENT' });
  assert.equal(deploymentConfig(f.env).retentionMs, 60000);
});

test('the shared listener preserves invitations, viewer and relay messages beside isolated MCP tools and callbacks', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/health')).body, { ok: true, version: 1 });
  const call = (await f.create()).body;
  assert.equal(new URL(call.invitationUrl).origin, PUBLIC_URL);
  const inviteUrl = new URL(call.invitationUrl);
  assert.equal((await f.request(`${inviteUrl.pathname}${inviteUrl.search}`)).status, 200);
  assert.equal((await f.request('/view')).status, 200);
  const path = `/v1/calls/${call.call.id}`;
  const joined = await f.request(`${path}/join`, { method: 'POST', body: { token: inviteUrl.searchParams.get('key'), name: 'Beta', requestId: 'join-test' } });
  assert.equal(joined.status, 200);
  const sent = await f.request(`${path}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${call.participant.token}` }, body: { type: 'message', text: 'Legacy relay still works', requestId: 'legacy-test' } });
  assert.equal(sent.status, 200);
  const received = await f.request(`${path}/events?after=1&waitMs=0`, { headers: { Authorization: `Bearer ${joined.body.participant.token}` } });
  assert.equal(received.body.events[0].data.text, 'Legacy relay still works');
  assert.equal((await f.request('/v1/calls', { method: 'POST', body: { name: 'No key', purpose: 'No key' } })).status, 401);
  assert.equal((await f.request('/mcp/invalid')).status, 404);
  assert.equal((await f.request(`/mcp/${f.tokens.A}`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request(`/mcp/${f.tokens.A}`)).status, 405);
  const discovery = await f.rpc('B', 'server/discover');
  assert.deepEqual(discovery.body.result.capabilities, { tools: {}, events: {} });
  assert.equal((await f.tool('A', 'whoami')).body.result.structuredContent.agent_id, 'A');
  assert.equal((await f.tool('B', 'whoami')).body.result.structuredContent.agent_id, 'B');
  const subscription = { name: EVENT_NAME, arguments: { recipient_id: 'B' }, delivery: { mode: 'webhook', url: 'https://callback.example/events', secret: `whsec_${randomBytes(32).toString('base64')}` }, cursor: null };
  assert.equal((await f.rpc('A', 'events/subscribe', subscription)).body.error.code, -32001);
  assert.ok((await f.rpc('B', 'events/subscribe', subscription)).body.result.id);
  const message = (await f.tool('A', 'send_message', { recipient_id: 'B', text: TEST_TEXTS[0], request_id: 'deployment-ping' })).body.result.structuredContent.message;
  await eventually(() => f.callbacks.some(event => event.data?.message_id === message.id));
  assert.equal((await f.tool('A', 'read_inbox')).body.result.structuredContent.messages.length, 0);
  assert.equal((await f.tool('B', 'read_inbox')).body.result.structuredContent.messages[0].id, message.id);
  assert.equal((await f.tool('A', 'read_inbox', { agent_id: 'B' })).body.error.code, -32602);
  for (const secret of [...Object.values(f.tokens), SERVER_KEY, subscription.delivery.url, subscription.delivery.secret]) assert.equal(JSON.stringify(f.logs).includes(secret), false);
  for (const route of ['/mcp/status', '/mcp/state.json', '/state.json']) assert.equal((await f.request(route)).status, 404);
});

test('configured credentials persist across restart and mismatches fail without replacing state or retaining a lock', async t => {
  const f = await fixture(t);
  await f.tool('A', 'send_message', { recipient_id: 'B', text: TEST_TEXTS[0], request_id: 'before-restart' });
  await f.restart();
  assert.equal((await f.tool('B', 'read_inbox')).body.result.structuredContent.messages.length, 1);
  await f.app.close();
  const original = await readFile(f.env.NOKNOK_MCP_STATE_PATH, 'utf8');
  await assert.rejects(startDeployment({ ...f.options, env: { ...f.env, NOKNOK_MCP_AGENT_A_TOKEN: randomBytes(32).toString('base64url') } }), /do not match/);
  assert.equal(await readFile(f.env.NOKNOK_MCP_STATE_PATH, 'utf8'), original);
  await assert.rejects(stat(`${f.env.NOKNOK_MCP_STATE_PATH}.lock`), { code: 'ENOENT' });
  for (const invalid of [{ A: f.tokens.A }, { A: f.tokens.A, B: f.tokens.A }, { A: 'bad', B: f.tokens.B }, { A: 'x'.repeat(43), B: f.tokens.B }]) {
    await assert.rejects(startMcpEventsPoc({ statePath: f.env.NOKNOK_MCP_STATE_PATH, agentTokens: invalid }), /agentTokens must contain different/);
  }
  await f.restart();
  assert.equal((await f.tool('A', 'whoami')).body.result.structuredContent.agent_id, 'A');
});

test('chunked oversized MCP uploads retain the upstream 413 response', async t => {
  const f = await fixture(t);
  const response = await new Promise((done, reject) => {
    const request = http.request(`${f.app.origin}/mcp/${f.tokens.A}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('error', reject);
      incoming.on('end', () => done({ status: incoming.statusCode, body }));
    });
    request.on('error', reject);
    request.write('x'.repeat(16_384));
    setImmediate(() => request.end('y'.repeat(16_385)));
  });
  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), { error: 'Request too large.' });
  assert.equal((await f.rpc('A', 'server/discover')).status, 200);
});

test('shutdown drains legacy long polls and releases MCP state; failed public bind also cleans up', async t => {
  const f = await fixture(t);
  const call = (await f.create()).body;
  const poll = f.request(`/v1/calls/${call.call.id}/events?after=0&waitMs=25000`, { headers: { Authorization: `Bearer ${call.participant.token}` } });
  await delay(50);
  await Promise.race([
    Promise.all([f.app.close(), f.app.close(), poll]).then(results => assert.equal(results[2].status, 200)),
    delay(2000, undefined, { ref: false }).then(() => { throw new Error('Deployment did not drain promptly.'); }),
  ]);
  await assert.rejects(stat(`${f.env.NOKNOK_MCP_STATE_PATH}.lock`), { code: 'ENOENT' });
  await assert.rejects(fetch(`${f.app.origin}/health`));
  await f.restart();
  const otherState = join(f.directory, 'failed-bind.json');
  await assert.rejects(startDeployment({ ...f.options, port: f.app.port, env: { ...f.env, NOKNOK_MCP_STATE_PATH: otherState } }), { code: 'EADDRINUSE' });
  await assert.rejects(stat(`${otherState}.lock`), { code: 'ENOENT' });
  const recovered = await startDeployment({ ...f.options, env: { ...f.env, NOKNOK_MCP_STATE_PATH: otherState } });
  await recovered.close();
  assert.equal((await f.request('/health')).status, 200);
});
