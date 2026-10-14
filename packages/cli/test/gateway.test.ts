import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway, gatewayMcpToken } from '../src/gateway.js';
import { gatewayRequest, gatewayOrigin, ACTIVITY_EVENT } from '../src/gateway-contract.js';
import { startGatewayClient } from '../src/gateway-client.js';
import { startRelay } from '../src/relay.js';
import { startReceiver } from '../src/receiver.js';
import { resolveAgentProfile } from '../src/profiles.js';
import { receiverCommand } from '../src/receiver-control.js';
import { main } from '../src/cli.js';

const token = () => randomBytes(32).toString('base64url');
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!(await check())) { assert.ok(Date.now() < end, 'condition reached'); await delay(10); }
}
async function fixture(t, options = {}) {
  let gateway = createGateway(options);
  const relay = await startRelay({ port: 0, contacts: true, extension: (...args) => gateway.handle(...args), extensionClose: () => gateway.close() });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await relay.close(); });
  async function post(path, body, headers = {}) {
    const r = await fetch(relay.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: r.status === 202 ? undefined : await r.json() };
  }
  const rpc = (owner, method, params = {}) => post('/mcp/' + gatewayMcpToken(owner), { jsonrpc: '2.0', id: 1, method, params });
  const control = (owner, input) => post('/v1/gateway', input, { Authorization: 'Bearer ' + owner });
  const client = (owner, dispatch) => {
    const c = startGatewayClient({ config: { origin: relay.url, token: owner }, dispatch, retryMs: 10 });
    clients.push(c); return c;
  };
  return { get gateway() { return gateway; }, relay, rpc, control, post, client,
    restartGateway() { gateway.close(); gateway = createGateway(options); } };
}

test('gateway restart restores a saved endpoint through client registration, without rerunning a tool', async t => {
  const f = await fixture(t), owner = token(); let executions = 0;
  const c = f.client(owner, async () => ({ count: ++executions }));
  await until(() => c.status().connected);
  assert.equal((await f.rpc(owner, 'ping')).body.result.count, 1);
  const address = c.mcpUrl;
  f.restartGateway();
  await until(() => f.gateway.status().agents === 1);
  assert.equal(c.mcpUrl, address);
  assert.equal((await f.rpc(owner, 'ping')).body.result.count, 2);
});

test('an expired receiver lease removes its MCP endpoint and pending in-memory operations', async t => {
  let clock = 0;
  const f = await fixture(t, { leaseMs: 50, now: () => clock }), owner = token();
  await f.control(owner, { op: 'register' });
  clock = 51;
  assert.equal((await f.rpc(owner, 'ping')).status, 404);
  assert.equal(f.gateway.status().agents, 0);
  assert.equal((await f.control(owner, { op: 'poll', waitMs: 0 })).status, 409);
});

test('deployment registration key gates new receivers but does not replace private MCP credentials', async t => {
  const f = await fixture(t, { serverKey: 'synthetic-deployment-key' }), owner = token();
  assert.equal((await f.control(owner, { op: 'register' })).status, 401);
  assert.equal((await f.post('/v1/gateway', { op: 'register' }, { Authorization: 'Bearer ' + owner, 'X-Noknok-Key': 'synthetic-deployment-key' })).status, 200);
  assert.equal((await f.rpc(token(), 'ping')).status, 404);
});

test('gateway credentials cannot replace owner credentials or broaden the communication contract', async t => {
  const f = await fixture(t), owner = token();
  assert.equal((await f.control(owner, { op: 'register' })).status, 200);
  assert.equal((await f.control(gatewayMcpToken(owner), { op: 'poll', waitMs: 0 })).status, 409);
  assert.equal((await f.rpc(token(), 'server/discover')).status, 404);
  assert.equal((await f.rpc(owner, 'tools/call', { name: 'run_shell', arguments: { command: 'anything' } })).body.error.code, -32602);
  assert.equal((await f.rpc(owner, 'tools/call', { name: 'noknok_history', arguments: { session: 'ac_00000000-0000-0000-0000-000000000000', path: '/etc/passwd' } })).body.error.code, -32602);
  assert.equal((await f.rpc(owner, 'proxy/http', { url: 'http://127.0.0.1' })).body.error.code, -32601);
  assert.equal((await f.post('/mcp/' + gatewayMcpToken(owner), {}, { Origin: 'https://example.test' })).status, 403);
  assert.equal(f.gateway.status().pending, 0);
  assert.throws(() => gatewayOrigin('http://192.168.1.1'), /HTTPS/);
  assert.throws(() => gatewayOrigin('https://example.test/arbitrary-path'), /HTTPS/);
  assert.throws(() => gatewayRequest('tools/call', { name: 'noknok_call', arguments: { contact: 'B', purpose: 'Test', agent: 'other' } }), /Unknown tool argument/);
});

test('independent agents and multiple operations do not wait behind a stalled operation', async t => {
  const f = await fixture(t), a = token(), b = token();
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const ca = f.client(a, async (_method, params) => params.name === 'noknok_identity' ? stalled : { owner: 'A' });
  const cb = f.client(b, async () => ({ owner: 'B' }));
  await until(() => ca.status().connected && cb.status().connected);
  const first = f.rpc(a, 'tools/call', { name: 'noknok_identity' });
  await until(() => f.gateway.status().pending === 1);
  const others = await Promise.all([f.rpc(a, 'ping'), f.rpc(b, 'ping'), f.rpc(b, 'server/discover')]);
  assert.deepEqual(others.map(r => r.body.result.owner), ['A', 'B', 'B']);
  release({ owner: 'A', completed: true });
  assert.equal((await first).body.result.completed, true);
  assert.equal(f.gateway.status().bytes, 0);
});

test('timeouts retain a mutation key and do not execute an operation twice', async t => {
  const f = await fixture(t, { requestTimeoutMs: 50 }), owner = token();
  await f.control(owner, { op: 'register' });
  const pending = f.rpc(owner, 'tools/call', { name: 'noknok_friend_link' });
  const polled = await f.control(owner, { op: 'poll', waitMs: 100 });
  assert.equal(polled.body.jobs.length, 1);
  const job = polled.body.jobs[0];
  assert.equal(job.params.arguments.request_id, job.id);
  const timeout = await pending;
  assert.equal(timeout.body.error.data.mayHaveExecuted, true);
  assert.equal(timeout.body.error.data.requestId, job.id);
  assert.equal((await f.control(owner, { op: 'poll', waitMs: 0 })).body.jobs.length, 0);
  assert.equal((await f.control(owner, { op: 'respond', id: job.id, response: { result: {} } })).status, 410);
  assert.deepEqual(f.gateway.status(), { agents: 1, pending: 0, bytes: 0, storage: 'memory' });
});

test('response ownership, registration limits and request capacity are enforced', async t => {
  const f = await fixture(t, { maxAgents: 2, maxPending: 1, requestTimeoutMs: 1000 }), a = token(), b = token();
  await f.control(a, { op: 'register' }); await f.control(b, { op: 'register' });
  assert.equal((await f.control(token(), { op: 'register' })).status, 503);
  const pending = f.rpc(a, 'ping');
  const job = (await f.control(a, { op: 'poll', waitMs: 100 })).body.jobs[0];
  assert.equal((await f.rpc(a, 'ping')).body.error.code, -32000);
  assert.equal((await f.control(b, { op: 'respond', id: job.id, response: { result: {} } })).status, 410);
  await f.control(a, { op: 'respond', id: job.id, response: { result: { owner: 'A' } } });
  assert.equal((await pending).body.result.owner, 'A');
});

test('eight large requests are delivered in bounded batches without dropping or repeating work', async t => {
  const f = await fixture(t), owner = token();
  await f.control(owner, { op: 'register' });
  const requests = Array.from({ length: 8 }, (_, i) => f.rpc(owner, 'tools/call', { name: 'noknok_call',
    arguments: { contact: 'friend', purpose: 'Large concurrent request ' + i, context: 'x'.repeat(65536) } }));
  await until(() => f.gateway.status().pending === 8);
  const seen = new Set(); let batches = 0;
  while (seen.size < 8) {
    const result = await f.control(owner, { op: 'poll', capacity: 8, waitMs: 0 });
    assert.ok(Buffer.byteLength(JSON.stringify(result.body)) < 1048576);
    assert.ok(result.body.jobs.length); batches++;
    for (const job of result.body.jobs) {
      assert.equal(seen.has(job.id), false); seen.add(job.id);
      await f.control(owner, { op: 'respond', id: job.id, response: { result: { received: true } } });
    }
  }
  assert.ok(batches > 1);
  assert.ok((await Promise.all(requests)).every(r => r.body.result.received));
});

test('detached reception survives the setup command and restores its private gateway endpoint', async t => {
  const f = await fixture(t), root = await mkdtemp(join(tmpdir(), 'noknok-gateway-daemon-'));
  const oldHome = process.env.NOKNOK_HOME;
  process.env.NOKNOK_HOME = root;
  const profile = await resolveAgentProfile({ create: true });
  t.after(async () => {
    await receiverCommand('stop', { directory: profile.directory, agent: profile.handle });
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.NOKNOK_HOME; else process.env.NOKNOK_HOME = oldHome;
  });
  await main(['identity', '--agent', profile.handle, '--server', f.relay.url, '--product', 'dot'], { emit: () => {} });
  const start = () => receiverCommand('start', { directory: profile.directory, agent: profile.handle, gateway: f.relay.url });
  const first = await start();
  await until(async () => (await receiverCommand('status', { directory: profile.directory, agent: profile.handle })).gateway?.connected);
  assert.equal(first.backgroundRunning, true);
  assert.equal(first.setupRequired, true, 'no fake native subscription');
  assert.equal(first.receiving, false);
  const config = JSON.parse(await readFile(join(profile.directory, 'gateway.json'), 'utf8'));
  assert.equal((await stat(join(profile.directory, 'gateway.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await f.rpc(config.token, 'server/discover')).body.result.capabilities.events, {});
  await receiverCommand('stop', { directory: profile.directory, agent: profile.handle });
  const restarted = await start();
  assert.equal(restarted.mcpUrl, first.mcpUrl);
  await until(async () => (await receiverCommand('status', { directory: profile.directory, agent: profile.handle })).gateway?.connected);
  assert.equal((await f.rpc(config.token, 'tools/call', { name: 'noknok_identity' })).body.result.structuredContent.agent.name, 'agent-dot');
});

test('the local consumer independently rejects arbitrary operations from a compromised gateway', async t => {
  let used = false, dispatched = 0, rejected;
  const config = { origin: 'https://gateway.example.test', token: token() };
  const c = startGatewayClient({ config, retryMs: 10, dispatch: async () => { dispatched++; }, fetcher: async (_url, opts) => {
    const input = JSON.parse(opts.body);
    if (input.op === 'respond') rejected = input.response.error;
    if (input.op === 'poll' && used) await delay(10);
    const jobs = used ? [] : [{ id: '00000000-0000-4000-8000-000000000000', method: 'tools/call', params: { name: 'read_file', arguments: { path: '/etc/passwd' } } }];
    if (input.op === 'poll') used = true;
    return new Response(JSON.stringify(input.op === 'poll' ? { jobs } : { registered: true }), { status: 200 });
  } });
  t.after(() => c.close());
  await until(() => rejected);
  assert.equal(dispatched, 0);
  assert.equal(rejected.code, -32602);
});

test('no-Tunnel MCP works through an outbound receiver, with local subscriptions, bilateral contacts and real HTTP transcripts', async t => {
  const f = await fixture(t), root = await mkdtemp(join(tmpdir(), 'noknok-gateway-e2e-'));
  const oldHome = process.env.NOKNOK_HOME;
  process.env.NOKNOK_HOME = root;
  const profiles = {}, receivers = [], callbacks = [];
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  const exec = async (who, command, args = [], options = {}) => {
    let result;
    const argv = [command, '--agent', profiles[who].handle, ...Object.entries(options).map(([k, v]) => '--' + k + '=' + v), '--', ...args];
    await main(argv, { emit: v => { result = v; } }); return result;
  };
  t.after(async () => {
    await Promise.all(receivers.map(r => r.close()));
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.NOKNOK_HOME; else process.env.NOKNOK_HOME = oldHome;
  });
  for (const who of ['A', 'B', 'C']) {
    profiles[who] = await resolveAgentProfile({ create: true, home: root });
    await exec(who, 'identity', [], { product: who === 'B' ? 'dot' : 'doubaowork', server: f.relay.url });
  }
  await exec('B', 'friend-add', [(await exec('A', 'friend-link')).contactLink]); await exec('A', 'friends');
  const bIdentity = await exec('B', 'identity');
  const b = await startReceiver({ directory: profiles.B.directory, agent: profiles.B.handle, gateway: f.relay.url, run: main,
    workerIntervalMs: 10, contactTimeout: 0.01, webhookPost: async (_url, request) => {
      const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(request.headers['webhook-id'] + '.' + request.headers['webhook-timestamp'] + '.' + request.body).digest('base64');
      assert.ok(request.headers['webhook-signature'].includes('v1,' + expected));
      const payload = JSON.parse(request.body);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      callbacks.push(payload); return { status: 200, body: '{}' };
    } });
  receivers.push(b);
  await until(() => b.status().gateway.connected);
  const config = JSON.parse(await readFile(join(profiles.B.directory, 'gateway.json'), 'utf8'));
  assert.equal((await f.rpc(config.token, 'server/discover')).body.result.capabilities.events !== undefined, true);
  const subscribe = await f.rpc(config.token, 'events/subscribe', { _meta: { test: true }, name: ACTIVITY_EVENT, arguments: {},
    delivery: { mode: 'webhook', url: 'https://callback.example.test/noknok', secret }, ttlMs: null });
  assert.equal(subscribe.body.error, undefined, JSON.stringify(subscribe.body));
  await until(() => b.status().receiving);
  await assert.rejects(exec('C', 'call', [bIdentity.agent.id], { purpose: 'Unapproved caller' }), { code: 'CONTACT_NOT_FOUND' });
  const call = await exec('A', 'call', [bIdentity.agent.id], { purpose: 'Synthetic native gateway acceptance' });
  await until(() => callbacks.some(p => p.data.kind === 'incoming_call'));
  const inbox = (await f.rpc(config.token, 'tools/call', { name: 'noknok_inbox' })).body.result.structuredContent;
  const incoming = inbox.activities.find(a => a.kind === 'incoming_call');
  assert.equal(incoming.viewSession, call.viewSession);
  await f.rpc(config.token, 'tools/call', { name: 'noknok_send', arguments: { session: incoming.session, text: 'Synthetic gateway reply.', request_id: 'gateway-reply' } });
  const received = await exec('A', 'receive', [call.session], { timeout: 0 });
  assert.equal(received.events.some(e => e.data.text === 'Synthetic gateway reply.'), true);
  const view = await fetch(f.relay.url + '/v1/session-view', { headers: { Authorization: 'Bearer ' + call.viewSession } });
  assert.equal((await view.json()).events.some(e => e.data.text === 'Synthetic gateway reply.'), true);
  assert.equal(JSON.stringify(f.gateway.status()).includes(secret), false);
  const stored = JSON.parse(await readFile(join(profiles.B.directory, 'receiver-state.json'), 'utf8'));
  assert.equal(stored.subscriptions[0].secret, secret);
  await exec('A', 'finish', [call.session], { text: 'Synthetic first side complete' });
  await f.rpc(config.token, 'tools/call', { name: 'noknok_finish', arguments: { session: incoming.session, text: 'Synthetic second side complete' } });
  assert.equal((await exec('A', 'status', [call.session])).call.state, 'completed');
  assert.equal((await receiverCommand('status', { directory: profiles.B.directory, agent: profiles.B.handle })).mcpUrl, b.status().gateway.mcpUrl);
  // This is deliberately a synthetic host: no real dot execution is claimed.
});
