import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '../src/relay.mjs';
import { startReceiver, ACTIVITY_EVENT } from '../src/receiver.mjs';
import { resolveAgentProfile } from '../src/profiles.mjs';
import { main } from '../src/cli.mjs';
import { Store } from '../src/store.mjs';
import { receiverCommand } from '../src/receiver-control.mjs';

async function fixture(t, { workerIntervalMs = 0, contactTimeout = 0.01 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-receiver-'));
  const oldHome = process.env.AGENTCALL_HOME, oldAgent = process.env.AGENTCALL_AGENT, oldProduct = process.env.AGENTCALL_PRODUCT;
  process.env.AGENTCALL_HOME = root;
  delete process.env.AGENTCALL_AGENT; delete process.env.AGENTCALL_PRODUCT;
  let relay = await startRelay({ port: 0, contacts: true });
  const profiles = {};
  const exec = async (who, command, args = [], options = {}) => {
    let result;
    const argv = [command, '--agent', profiles[who].handle];
    for (const [key, val] of Object.entries(options)) argv.push('--' + key + '=' + val);
    argv.push('--', ...args);
    await main(argv, { emit: value => { result = value; } });
    return result;
  };
  for (const who of ['A', 'B', 'C']) {
    profiles[who] = await resolveAgentProfile({ create: true, home: root });
    await exec(who, 'identity', [], { product: who === 'B' ? 'dot' : 'doubaowork', server: relay.url });
  }
  const link = await exec('A', 'friend-link');
  await exec('B', 'friend-add', [link.contactLink]);
  await exec('A', 'friends');
  let app, clock = Date.now(), deliveryStatus = 200;
  const delivered = [];
  const secret = 'whsec_' + randomBytes(32).toString('base64');
  const post = async (url, { body, headers }) => {
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(headers['webhook-id'] + '.' + headers['webhook-timestamp'] + '.' + body).digest('base64');
    assert.ok(headers['webhook-signature'].split(' ').includes('v1,' + expected));
    const data = JSON.parse(body);
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    delivered.push({ url, data, headers });
    return { status: deliveryStatus, body: '{}' };
  };
  async function start() {
    app = await startReceiver({ directory: profiles.B.directory, agent: profiles.B.handle, run: main,
      webhookPost: post, workerIntervalMs, now: () => clock, contactTimeout, retryBaseMs: 1 });
    return app;
  }
  const rpc = async (method, params, { url = app.url, origin } = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name: 'agentcall_' + name, arguments: args });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const sub = (extras = {}) => ({ name: ACTIVITY_EVENT, arguments: {}, delivery: { mode: 'webhook', url: 'https://callback.example.test/agentcall', secret }, ttlMs: null, ...extras });
  await start();
  t.after(async () => {
    await receiverCommand('stop', { directory: profiles.B.directory, agent: profiles.B.handle }).catch(() => {});
    await app?.close();
    await relay.close();
    await rm(root, { recursive: true, force: true });
    for (const [key, val] of [['AGENTCALL_HOME', oldHome], ['AGENTCALL_AGENT', oldAgent], ['AGENTCALL_PRODUCT', oldProduct]]) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
  });
  return { root, get relay() { return relay; }, profiles, exec, rpc, tool, sub, secret, delivered, start,
    async restartSwitch() {
      const port = Number(new URL(relay.url).port);
      await relay.close();
      relay = await startRelay({ port, contacts: true });
    },
    get app() { return app; }, set status(value) { deliveryStatus = value; }, advance: ms => { clock += ms; } };
}
const value = response => {
  assert.equal(response.isError, false, JSON.stringify(response));
  return response.structuredContent;
};

test('background receiver accepts a friend between polls and pushes signed activities without a model wait loop', async t => {
  const f = await fixture(t);
  assert.equal(f.app.status().receiving, false);
  await assert.rejects(f.exec('A', 'call', [(await f.exec('B', 'identity')).agent.id], { purpose: 'Not subscribed yet' }), { code: 'CONTACT_UNAVAILABLE' });
  const subscribed = await f.rpc('events/subscribe', f.sub());
  assert.equal(subscribed.error, undefined);
  assert.equal(subscribed.result.refreshBefore, null);
  assert.equal(f.app.status().receiving, true);
  // No active contact poll is required: the background receiver owns a lease.
  const call = await f.exec('A', 'call', [(await f.exec('B', 'identity')).agent.id], { purpose: 'Discuss receiver architecture', context: 'Compare event delivery and model-side polling.' });
  await f.app.collect();
  await f.app.flush();
  const inbox = value(await f.tool('inbox'));
  const incoming = inbox.activities.find(a => a.kind === 'incoming_call');
  assert.equal(incoming.viewSession, call.viewSession);
  assert.notEqual(incoming.session, call.session);
  assert.equal(f.delivered[0].data.data.activity_id, incoming.id);
  assert.equal(f.delivered[0].data.name, ACTIVITY_EVENT);
  assert.equal((await f.exec('A', 'status', [call.session])).call.state, 'connected');
  await f.exec('A', 'send', [call.session], { text: 'Which component should receive while dot is idle?' });
  await f.app.collect(); await f.app.flush();
  const messages = value(await f.tool('inbox')).activities.filter(a => a.kind === 'message');
  assert.equal(messages.length, 1);
  const history = value(await f.tool('history', { session: incoming.session })).history;
  assert.ok(history.some(r => r.event?.data.text === 'Which component should receive while dot is idle?'));
  value(await f.tool('send', { session: incoming.session, text: 'A background receiver handles transport; an event starts the agent task.', request_id: 'reply-once' }));
  const reply = await f.exec('A', 'receive', [call.session], { timeout: 0 });
  assert.ok(reply.events.some(e => e.data.text?.includes('background receiver')));
  value(await f.tool('ack_activity', { activity_id: incoming.id }));
  value(await f.tool('ack_activity', { activity_id: incoming.id }));
  assert.ok(!value(await f.tool('inbox')).activities.some(a => a.id === incoming.id));
  await f.exec('A', 'finish', [call.session], { text: 'Agreed.' });
  await f.app.collect();
  value(await f.tool('finish', { session: incoming.session, text: 'Agreed, task complete.' }));
  await f.app.collect();
  assert.equal(value(await f.tool('status', { session: incoming.session })).call.state, 'completed');
  assert.ok(value(await f.tool('inbox')).activities.some(a => a.kind === 'completed'));
  assert.equal((await stat(join(f.profiles.B.directory, 'receiver-state.json'))).mode & 0o777, 0o600);
});

test('receiver credentials, tools and events are bound to one profile and preserve contact revocation', async t => {
  const f = await fixture(t);
  const found = await f.rpc('server/discover');
  assert.deepEqual(found.result.capabilities, { tools: {}, events: {} });
  assert.deepEqual(found.result.supportedVersions, ['2026-07-28']);
  const tools = (await f.rpc('tools/list')).result.tools;
  assert.ok(!tools.some(t => ['agentcall_listen', 'agentcall_receive'].includes(t.name)));
  assert.equal((await f.rpc('tools/call', { name: 'agentcall_identity', arguments: { agent: f.profiles.A.handle } })).error.code, -32602);
  assert.equal((await f.rpc('events/subscribe', f.sub({ arguments: { recipient_id: 'C' } }))).error.code, -32602);
  assert.equal((await f.rpc('ping', {}, { url: f.app.url.replace(/[^/]+$/, 'unknown') })).status, 404);
  assert.equal((await f.rpc('ping', {}, { origin: 'https://evil.example' })).status, 403);
  const b = (await f.exec('B', 'identity')).agent;
  await f.rpc('events/subscribe', f.sub());
  await assert.rejects(f.exec('C', 'call', [b.id], { purpose: 'No friendship' }), { code: 'CONTACT_NOT_FOUND' });
  const a = (await f.exec('A', 'identity')).agent;
  value(await f.tool('friend_remove', { contact: a.id }));
  await assert.rejects(f.exec('A', 'call', [b.id], { purpose: 'Revoked permission' }), { code: 'CONTACT_UNAVAILABLE' });
  const cSession = await new Store(f.profiles.C.directory).create(f.relay.url, { id: '11111111-1111-4111-8111-111111111111', purpose: 'Foreign' }, { role: 'caller', token: 'foreign' });
  const denied = await f.tool('history', { session: cSession.id });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'SESSION_NOT_FOUND');
  const stopped = f.sub(); delete stopped.delivery.secret;
  await f.rpc('events/unsubscribe', stopped);
  assert.equal(f.app.status().receiving, false);
});

test('activities and subscriptions survive restart; retries retain event IDs and acknowledgment cancels pending delivery', async t => {
  const f = await fixture(t);
  await f.rpc('events/subscribe', f.sub());
  const call = await f.exec('A', 'call', [(await f.exec('B', 'identity')).agent.id], { purpose: 'Recover delivery' });
  await f.app.collect();
  f.status = 503; await f.app.flush();
  const first = f.delivered[0];
  assert.equal(f.app.status().deliveries.pending, 1);
  const endpoint = f.app.url.split('/mcp/')[1];
  await f.app.close();
  await f.start();
  assert.equal(f.app.url.split('/mcp/')[1], endpoint);
  f.advance(10); f.status = 200; await f.app.flush();
  assert.equal(f.delivered[1].data.eventId, first.data.eventId);
  assert.equal(f.app.status().deliveries.pending, 0);
  await f.app.collect();
  assert.equal(value(await f.tool('inbox')).activities.filter(a => a.kind === 'incoming_call').length, 1);
  await f.exec('A', 'send', [call.session], { text: 'Message persisted before notification.' });
  // Simulate a stop between receive cursor persistence and activity persistence.
  const incoming = value(await f.tool('inbox')).activities[0];
  await main(['receive', '--agent', f.profiles.B.handle, '--timeout', '0', incoming.session], { emit: () => {} });
  await f.app.collect();
  const recovered = value(await f.tool('inbox')).activities.find(a => a.kind === 'message');
  assert.ok(recovered);
  value(await f.tool('ack_activity', { activity_id: recovered.id }));
  await f.app.flush();
  assert.ok(!f.delivered.some(d => d.data.eventId === recovered.id));
  value(await f.tool('ack_activity', { activity_id: incoming.id }));
  await f.app.close();
  // Simulate pruning old acknowledged activities. Session watermarks prevent
  // re-emitting old call/message events from the still-retained transcript.
  const path = join(f.profiles.B.directory, 'receiver-state.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.activities = []; saved.deliveries = [];
  await writeFile(path, JSON.stringify(saved));
  await f.start(); await f.app.collect();
  assert.deepEqual(value(await f.tool('inbox')).activities, []);
});

test('callback rejection, expiration and permanent failures stop background reception without losing the inbox', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('events/subscribe', f.sub({ delivery: { mode: 'webhook', url: 'http://127.0.0.1', secret: f.secret } }))).error.code, -32015);
  await f.rpc('events/subscribe', f.sub({ ttlMs: 1000 }));
  f.advance(1001); await f.app.collect();
  assert.equal(f.app.status().receiving, false);
  await f.rpc('events/subscribe', f.sub());
  await f.exec('A', 'call', [(await f.exec('B', 'identity')).agent.id], { purpose: 'Callback gone' });
  await f.app.collect(); f.status = 410; await f.app.flush(); await f.app.collect();
  assert.equal(f.app.status().subscribed, false);
  assert.equal(f.app.status().receiving, false);
  assert.equal(value(await f.tool('inbox')).activities.length, 1);
});

test('CLI starts one detached receiver, keeps it after the setup command exits and stops it via authenticated control', async t => {
  const f = await fixture(t);
  await f.app.close();
  const options = { directory: f.profiles.B.directory, agent: f.profiles.B.handle, port: 0 };
  t.after(() => receiverCommand('stop', options).catch(() => {}));
  const first = await receiverCommand('start', options);
  assert.equal(first.backgroundRunning, true);
  assert.equal(first.setupRequired, true);
  assert.equal(first.subscribed, false);
  const second = await receiverCommand('start', options);
  assert.equal(second.localMcpUrl, first.localMcpUrl);
  assert.equal((await receiverCommand('status', options)).backgroundRunning, true);
  const stopped = await receiverCommand('stop', options);
  assert.equal(stopped.stopped, true);
  assert.equal((await receiverCommand('status', options)).backgroundRunning, false);
});

test('expired callback subscriptions can be replaced without exhausting capacity', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const request = f.sub({ ttlMs: 1000 });
    request.delivery.url += '-' + i;
    assert.equal((await f.rpc('events/subscribe', request)).error, undefined);
  }
  const replacement = f.sub();
  replacement.delivery.url += '-replacement';
  assert.equal((await f.rpc('events/subscribe', replacement)).error.code, -32000);
  f.advance(1001);
  assert.equal((await f.rpc('events/subscribe', replacement)).error, undefined);
  assert.equal(f.app.status().subscriptions.length, 1);
});

test('the timer worker receives and delivers calls and messages with no model-side polling', async t => {
  const f = await fixture(t, { workerIntervalMs: 20, contactTimeout: 0.05 });
  const b = (await f.exec('B', 'identity')).agent;
  await f.rpc('events/subscribe', f.sub());
  const call = await f.exec('A', 'call', [b.id], { purpose: 'Autonomous transport, no model wait' });
  const until = async kind => {
    for (let i = 0; i < 100; i++) {
      if (f.delivered.some(d => d.data.data.kind === kind)) return;
      await delay(20);
    }
    assert.fail('Worker did not deliver ' + kind);
  };
  await until('incoming_call');
  await f.exec('A', 'send', [call.session], { text: 'Wake the subscribed host.' });
  await until('message');
  assert.ok(f.app.status().lastPollAt);
});

test('switch restart marks old calls unavailable and background reception recovers for new calls', async t => {
  const f = await fixture(t);
  const b = (await f.exec('B', 'identity')).agent;
  await f.rpc('events/subscribe', f.sub());
  const old = await f.exec('A', 'call', [b.id], { purpose: 'Old memory call' });
  await f.app.collect();
  await f.restartSwitch();
  await f.app.collect();
  assert.ok(value(await f.tool('inbox')).activities.some(a => a.kind === 'unavailable' && a.viewSession === old.callId));
  const fresh = await f.exec('A', 'call', [b.id], { purpose: 'Recovered receiver' });
  await f.app.collect();
  assert.ok(value(await f.tool('inbox')).activities.some(a => a.kind === 'incoming_call' && a.viewSession === fresh.callId));
});
