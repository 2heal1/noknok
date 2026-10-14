import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startMcpEventsPoc, EVENT_NAME, TEST_TEXTS } from '../poc/mcp-events/server.js';
import { CallbackError, createSecureWebhookPost, isPublicAddress, signingKey, webhookHeaders } from '../poc/mcp-events/webhook.js';
import { redactState } from '../poc/mcp-events/status.js';

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const CALLBACK = 'https://receiver.example.com/events';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-mcp-test-'));
  const callbacks = [];
  const logs = [];
  let clock = Date.parse('2026-10-12T08:00:00Z');
  const webhookPost = async (url, request) => {
    callbacks.push({ url, ...request, payload: JSON.parse(request.body) });
    const payload = JSON.parse(request.body);
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    return { status: 202, body: '' };
  };
  const config = { statePath: join(directory, 'state.json'), webhookPost, workerIntervalMs: 0, now: () => clock, logger: event => logs.push(event), ...options };
  let app = await startMcpEventsPoc(config);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let id = 0;
  return {
    callbacks, logs, directory,
    get app() { return app; },
    advance(ms) { clock += ms; },
    async restart() { await app.close(); app = await startMcpEventsPoc(config); },
    async raw(owner, rpc, init = {}) {
      return fetch(`${app.url}${app.endpoints[owner]}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc), ...init });
    },
    async rpc(owner, method, params = {}) {
      const response = await this.raw(owner, { jsonrpc: '2.0', id: ++id, method, params });
      assert.equal(response.status, 200);
      return response.json();
    },
    tool(owner, name, args = {}) { return this.rpc(owner, 'tools/call', { name, arguments: args }); },
    subscription(owner, extra = {}) { return { name: EVENT_NAME, arguments: { recipient_id: owner }, delivery: { mode: 'webhook', url: `${CALLBACK}/${owner}`, secret: SECRET }, cursor: null, ...extra }; },
    async subscribe(owner, extra = {}) { return this.rpc(owner, 'events/subscribe', this.subscription(owner, extra)); },
    async send(owner, request_id, text = TEST_TEXTS[0], reply_to) {
      return this.tool(owner, 'send_message', { recipient_id: owner === 'A' ? 'B' : 'A', text, request_id, ...(reply_to ? { reply_to } : {}) });
    },
  };
}
function value(result) { assert.ok(result.result, JSON.stringify(result)); return result.result.structuredContent; }

test('authenticated identity isolation, MCP discovery, request limits and secret-free diagnostics', async t => {
  const f = await fixture(t);
  const initial = f.app.snapshot();
  assert.equal((await stat(f.app.statePath)).mode & 0o777, 0o600);
  assert.equal(Buffer.from(initial.agents.A.token, 'base64url').length, 32);
  assert.notEqual(initial.agents.A.token, initial.agents.B.token);
  assert.equal((await fetch(`${f.app.url}/mcp/bogus`)).status, 404);
  assert.equal((await fetch(`${f.app.url}${f.app.endpoints.A}`)).status, 405);
  assert.equal((await f.raw('A', {}, { headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.raw('A', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.raw('A', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await f.raw('A', {}, { body: 'x'.repeat(32_769) })).status, 413);
  assert.equal((await f.rpc('A', 'initialize', { protocolVersion: '2025-03-26' })).result.protocolVersion, '2025-03-26');
  assert.deepEqual((await f.rpc('A', 'server/discover')).result.supportedVersions, ['2026-07-28']);
  assert.deepEqual((await f.rpc('A', 'server/discover')).result.capabilities, { tools: {}, events: {} });
  assert.equal(value(await f.tool('A', 'whoami')).agent_id, 'A');
  assert.equal(value(await f.tool('B', 'whoami')).agent_id, 'B');
  assert.equal((await f.tool('A', 'whoami', { agent_id: 'B' })).error.code, -32602);
  assert.equal((await f.tool('A', 'send_message', { recipient_id: 'A', text: TEST_TEXTS[0], request_id: 'bad' })).error.code, -32001);
  assert.equal((await f.tool('A', 'send_message', { recipient_id: 'B', text: 'real user data', request_id: 'bad' })).error.code, -32602);
  const message = value(await f.send('A', 'one')).message;
  assert.equal(value(await f.tool('A', 'read_inbox')).messages.length, 0);
  assert.equal(value(await f.tool('B', 'read_inbox')).messages[0].id, message.id);
  assert.equal((await f.rpc('A', 'events/subscribe', f.subscription('B'))).error.code, -32001);
  const events = (await f.rpc('B', 'events/list')).result.events;
  assert.deepEqual(events[0].inputSchema.properties.recipient_id.enum, ['B']);
  const log = JSON.stringify(f.logs);
  assert.equal(log.includes(initial.agents.A.token), false);
  assert.equal(log.includes(initial.agents.B.token), false);
  assert.equal(JSON.stringify(f.app.status()).includes(initial.agents.A.token), false);
  assert.equal(JSON.stringify(redactState(f.app.snapshot())).includes(initial.agents.A.token), false);
});

test('A→B→A synthetic round trip is filtered, signed, idempotent and bounded', async t => {
  const f = await fixture(t);
  const a = await f.subscribe('A');
  const b = await f.subscribe('B');
  assert.ok(a.result.id);
  assert.ok(b.result.id);
  assert.equal(f.callbacks.length, 2);
  const firstVerification = f.callbacks[0];
  assert.match(firstVerification.headers['webhook-id'], /^msg_verification_/);
  const first = value(await f.send('A', 'ping-1')).message;
  assert.equal(value(await f.send('A', 'ping-1')).duplicate, true);
  assert.equal((await f.send('A', 'ping-1', TEST_TEXTS[1])).error.code, -32009);
  await f.app.flush();
  const eventCall = f.callbacks[2];
  assert.equal(eventCall.url, `${CALLBACK}/B`);
  assert.equal(eventCall.payload.data.message_id, first.id);
  assert.equal(eventCall.payload.eventId, eventCall.headers['webhook-id']);
  assert.equal(eventCall.headers['X-MCP-Subscription-Id'], b.result.id);
  const independentSignature = createHmac('sha256', Buffer.alloc(32, 7)).update(`${first.event_id}.${eventCall.headers['webhook-timestamp']}.${eventCall.body}`).digest('base64');
  assert.equal(eventCall.headers['webhook-signature'], `v1,${independentSignature}`);
  assert.equal(f.app.status().deliveries[0].status, 'delivered');
  assert.equal(f.app.status().messages[0].replied, false, '2xx is receipt, not an agent reply');
  const second = value(await f.send('B', 'pong-1', TEST_TEXTS[1], first.id)).message;
  await f.app.flush();
  assert.equal(f.callbacks[3].url, `${CALLBACK}/A`);
  assert.equal(f.callbacks[3].payload.data.reply_to, first.id);
  const third = value(await f.send('A', 'ack-1', TEST_TEXTS[2], second.id)).message;
  await f.app.flush();
  assert.equal((await f.send('B', 'loop-1', TEST_TEXTS[0], third.id)).error.code, -32000);
  assert.equal((await f.send('B', 'other-reply', TEST_TEXTS[1], first.id)).error.code, -32009);
  assert.equal((await f.send('A', 'wrong-reply', TEST_TEXTS[1], first.id)).error.code, -32602);
  assert.equal(value(await f.tool('A', 'read_inbox')).messages.length, 1);
  assert.equal(value(await f.tool('B', 'read_inbox')).messages.length, 2);
  assert.equal(f.app.status().messages[0].replied, true);
  assert.equal(f.app.snapshot().messages.length, 3);
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
  assert.equal(JSON.stringify(f.logs).includes(CALLBACK), false);
});

test('callback verification rejects wrong challenges, redirects, timeouts and invalid signing keys', async t => {
  for (const [response, reason] of [
    [{ status: 200, body: '{"challenge":"wrong"}' }, 'challenge_failed'],
    [{ status: 302, body: '{}' }, 'challenge_failed'],
    [{ status: 200, body: 'not json' }, 'challenge_failed'],
  ]) {
    const f = await fixture(t, { webhookPost: async () => response });
    const result = await f.subscribe('B');
    assert.equal(result.error.code, -32015);
    assert.equal(result.error.data.reason, reason);
    assert.equal(f.app.snapshot().subscriptions.length, 0);
  }
  const f = await fixture(t, { webhookPost: async () => { throw new CallbackError('timeout'); } });
  assert.equal((await f.subscribe('B')).error.data.reason, 'timeout');
  assert.equal((await f.subscribe('B', { delivery: { mode: 'webhook', url: CALLBACK, secret: 'whsec_bad' } })).error.data.reason, 'invalid_secret');
  assert.equal((await f.subscribe('B', { delivery: { mode: 'webhook', url: 'http://receiver.example.com/', secret: SECRET } })).error.data.reason, 'invalid_url');
  for (const secret of ['', 'abc', `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`, 'whsec_!!!!']) assert.throws(() => signingKey(secret));
});

test('subscriptions survive restart, refresh idempotently, rotate keys and stop on expiry/unsubscribe', async t => {
  const f = await fixture(t);
  const initial = await f.subscribe('B', { ttlMs: 60_000 });
  const token = f.app.snapshot().agents.B.token;
  assert.equal((await f.subscribe('B', { ttlMs: 60_000 })).result.id, initial.result.id);
  assert.equal(f.callbacks.length, 1, 'valid verification is cached');
  await f.restart();
  assert.equal(f.app.snapshot().agents.B.token, token);
  assert.equal(f.app.snapshot().subscriptions.length, 1);
  const replacement = `whsec_${randomBytes(32).toString('base64')}`;
  const refreshed = await f.subscribe('B', { ttlMs: 60_000, delivery: { mode: 'webhook', url: `${CALLBACK}/B`, secret: replacement } });
  assert.equal(refreshed.result.id, initial.result.id);
  assert.equal(f.callbacks.length, 2);
  await f.send('A', 'rotate');
  await f.app.flush();
  assert.equal(f.callbacks.at(-1).headers['webhook-signature'].split(' ').length, 2);
  await f.send('A', 'cancel');
  const unsubscribe = f.subscription('B');
  delete unsubscribe.delivery.secret;
  assert.deepEqual((await f.rpc('B', 'events/unsubscribe', unsubscribe)).result, {});
  assert.deepEqual((await f.rpc('B', 'events/unsubscribe', unsubscribe)).result, {});
  await f.app.flush();
  assert.equal(f.callbacks.length, 3, 'queued delivery cancelled');
  await f.send('A', 'after-cancel');
  await f.app.flush();
  assert.equal(f.callbacks.length, 3, 'no new delivery after unsubscribe');
  assert.equal(f.app.status().deliveries[1].status, 'cancelled');
  await f.subscribe('B', { ttlMs: 1000, delivery: { mode: 'webhook', url: `${CALLBACK}/B`, secret: replacement } });
  await f.send('A', 'expire');
  f.advance(1001);
  await f.app.flush();
  assert.equal(f.app.status().deliveries.at(-1).reason, 'inactive_or_expired');
});

test('failed deliveries retry across restart with stable event IDs and bounded attempts', async t => {
  const attempts = [];
  const f = await fixture(t, { webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body);
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    attempts.push(request);
    return { status: attempts.length === 3 ? 200 : 503, body: '' };
  } });
  await f.subscribe('B');
  const first = value(await f.send('A', 'stable-id')).message;
  await f.app.flush();
  await f.restart();
  assert.equal(value(await f.send('A', 'stable-id')).message.id, first.id);
  assert.equal(f.app.snapshot().messages.length, 1);
  await f.app.flush();
  assert.equal(attempts.length, 1);
  f.advance(1000); await f.app.flush();
  f.advance(2000); await f.app.flush();
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map(request => JSON.parse(request.body).eventId)).size, 1);
  assert.equal(new Set(attempts.map(request => request.headers['webhook-signature'])).size, 3);
  assert.equal(f.app.status().deliveries[0].status, 'delivered');
  await f.send('A', 'eventually-fails');
  for (let attempt = 0; attempt < 6; attempt++) { f.advance(10_000); await f.app.flush(); }
  assert.equal(f.app.status().deliveries[1].attempts, 4);
  assert.equal(f.app.status().deliveries[1].status, 'failed');
  const disk = JSON.parse(await readFile(f.app.statePath, 'utf8'));
  assert.equal(disk.deliveries[1].attempts, 4);
});

test('410/413 never retry; 410 deactivates the subscription', async t => {
  for (const status of [410, 413]) {
    let calls = 0;
    const f = await fixture(t, { webhookPost: async (_url, request) => {
      const payload = JSON.parse(request.body);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      calls++; return { status, body: '' };
    } });
    await f.subscribe('B'); await f.send('A', `terminal-${status}`);
    await f.app.flush(); f.advance(60_000); await f.app.flush();
    assert.equal(calls, 1);
    assert.equal(f.app.status().deliveries[0].status, 'failed');
    assert.equal(f.app.status().subscriptions[0].active, status !== 410);
  }
});

test('persisted last attempt is not retried after crash recovery; live state lock cannot be shared', async t => {
  let calls = 0;
  const f = await fixture(t, { webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body);
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    calls++; return { status: 503, body: '' };
  } });
  await assert.rejects(startMcpEventsPoc({ statePath: f.app.statePath }), error => error.code === 'ELOCKED' && error.message.includes(String(process.pid)));
  assert.equal(Number((await readFile(`${f.app.statePath}.lock`, 'utf8')).trim()), process.pid);
  await f.subscribe('B'); await f.send('A', 'interrupted-final-attempt');
  await f.app.close();
  const saved = JSON.parse(await readFile(f.app.statePath, 'utf8'));
  saved.deliveries[0].attempts = 4;
  await writeFile(f.app.statePath, JSON.stringify(saved), { mode: 0o600 });
  await f.restart();
  await f.app.flush();
  assert.equal(calls, 0);
  assert.equal(f.app.status().deliveries[0].status, 'failed');
  assert.equal(f.app.status().deliveries[0].reason, 'attempt_limit');
});

test('secure webhook transport rejects private destinations and pins the public address on each connection', async () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  let connections = 0;
  const neverRequest = () => { connections++; throw new Error('Should not connect.'); };
  const privatePost = createSecureWebhookPost({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], request: neverRequest });
  await assert.rejects(privatePost(CALLBACK, { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  await assert.rejects(privatePost('https://[::1]/', { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  await assert.rejects(privatePost('https://user:pass@example.com/', { headers: {}, body: '{}' }), error => error.reason === 'invalid_url');
  assert.equal(connections, 0);
  let lookups = 0;
  const requests = [];
  const post = createSecureWebhookPost({
    resolve: async () => { lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; },
    request(url, options, callback) {
      connections++; requests.push({ url, options });
      options.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
      const req = new EventEmitter();
      req.end = () => {
        const response = new EventEmitter(); response.statusCode = 302;
        callback(response); response.emit('end');
      };
      return req;
    },
  });
  assert.equal((await post(CALLBACK, { headers: {}, body: '{}' })).status, 302, 'redirect is returned, never followed');
  assert.equal(requests[0].url.hostname, 'receiver.example.com', 'TLS and Host retain the original hostname');
  assert.equal(requests[0].options.agent, false);
  await assert.rejects(post(CALLBACK, { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  assert.equal(connections, 1);
  assert.equal(lookups, 2, 'DNS checked again for each delivery');
});

test('Standard Webhooks signature changes on tampering and supports key rotation', () => {
  const body = '{"eventId":"evt_test","data":{"text":"noknok-poc: ping"}}';
  const sub = { id: 'sub_test', secret: SECRET };
  const signed = webhookHeaders(sub, 'evt_test', body, 100_000);
  assert.equal(signed['webhook-timestamp'], '100');
  const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`evt_test.100.${body}`).digest('base64');
  assert.equal(signed['webhook-signature'], `v1,${expected}`);
  assert.notEqual(webhookHeaders(sub, 'evt_test', `${body} `, 100_000)['webhook-signature'], signed['webhook-signature']);
  assert.notEqual(webhookHeaders(sub, 'evt_other', body, 100_000)['webhook-signature'], signed['webhook-signature']);
  assert.notEqual(webhookHeaders(sub, 'evt_test', body, 101_000)['webhook-signature'], signed['webhook-signature']);
});
