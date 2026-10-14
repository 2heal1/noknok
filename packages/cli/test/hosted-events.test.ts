import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedEvents } from '../src/hosted-events.js';
import { createSecureWebhookPost, isPublicAddress, webhookHeaders } from '../src/webhook.js';
import { openHostedStore } from '../src/hosted-store.js';

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const ROTATED = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
const URL = 'https://receiver.example.com/events/B';
const params = (agentId = 'B', extra = {}) => ({ name: 'noknok.activity', arguments: { recipient_id: agentId },
  delivery: { mode: 'webhook', url: URL, secret: SECRET }, ...extra });
const unsubscribeParams = (...args) => {
  const value = params(...args); delete value.delivery.secret; delete value.ttlMs; return value;
};
const event = (id = 'evt_one', meetingId = 'meeting_one') => ({ eventId: id, kind: 'incoming_meeting', meetingId });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryStore(now) {
  const records = new Map(); const quotas = new Map();
  return {
    records, quotas,
    getSubscription: (agentId, id) => structuredClone([...records.values()].find(value => value.arguments.recipient_id === agentId && value.id === id) ?? null),
    listSubscriptions: agentId => structuredClone([...records.values()].filter(value => value.arguments.recipient_id === agentId && value.expiresAt > now())),
    putSubscription: (agentId, value) => records.set(`${agentId}:${value.id}`, structuredClone(value)),
    deleteSubscription(agentId, id) { return records.delete(`${agentId}:${id}`); },
    consumeQuota(agentId, bucket, { limit, windowMs }) {
      const key = `${agentId}:${bucket}:${Math.floor(now() / windowMs)}`;
      const count = quotas.get(key) ?? 0;
      if (count >= limit) throw Object.assign(new Error('Quota exceeded'), { status: 429, code: 'QUOTA_EXCEEDED' });
      quotas.set(key, count + 1);
      return { remaining: limit - count - 1, resetAt: now() + windowMs };
    },
  };
}
function fixture(t, options = {}) {
  let time = 1_700_000_000_000;
  const now = () => time;
  const store = options.store ?? memoryStore(now);
  const callbacks = [];
  let app;
  const configuration = { now, store, workerIntervalMs: 60_000, ...options,
    webhookPost: async (url, request) => {
      if (request.beforeSend && !await request.beforeSend()) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
      const payload = JSON.parse(request.body);
      const call = { url, ...request, payload }; callbacks.push(call);
      if (options.webhookPost) return options.webhookPost(url, request);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      return { status: 204, body: '' };
    } };
  app = createHostedEvents(configuration);
  t.after(() => app.close());
  return {
    get app() { return app; }, store, callbacks,
    advance(ms) { time += ms; },
    restart() { app.close(); app = createHostedEvents(configuration); },
    get sent() { return callbacks.filter(call => !call.payload.type); },
  };
}

test('hosted events target the authenticated receiver and return no subscription secrets', async t => {
  const f = fixture(t);
  await assert.rejects(f.app.subscribe('B', params(), { owner: undefined }), error => error.code === -32001);
  assert.throws(() => f.app.unsubscribe('B', unsubscribeParams(), { owner: undefined }), error => error.code === -32001);
  assert.equal(f.callbacks.length, 0, 'a missing grant must not fall back to the Agent identity');
  await assert.rejects(f.app.subscribe('A', params('B'), { owner: 'grant_test' }), error => error.code === -32001);
  const sub = await f.app.subscribe('B', params(), { owner: 'grant_test' });
  assert.equal(f.app.list('B').events[0].inputSchema.properties.recipient_id.enum[0], 'B');
  assert.deepEqual(f.app.status('A').subscriptions, []);
  assert.throws(() => f.app.unsubscribe('A', unsubscribeParams('B'), { owner: 'grant_test' }), error => error.code === -32001);
  assert.deepEqual(f.app.unsubscribe('A', unsubscribeParams('A'), { owner: 'grant_test' }), {});
  assert.equal(f.app.status('B').subscribed, true);
  assert.equal(f.app.status('B').subscriptions[0].id, sub.id);
  assert.equal(JSON.stringify(f.app.status('B')).includes('whsec_'), false);
  assert.equal(JSON.stringify(f.app.status('B')).includes('receiver.example.com'), false);
  assert.deepEqual(f.app.unsubscribe('B', unsubscribeParams(), { owner: 'grant_test' }), {});
  assert.deepEqual(f.app.unsubscribe('B', unsubscribeParams(), { owner: 'grant_test' }), {});
  assert.equal(f.app.status('B').subscribed, false);
});

test('notifications contain opaque references only, signed with stable event IDs', async t => {
  const f = fixture(t); await f.app.subscribe('B', params(), { owner: 'grant_test' });
  await assert.rejects(f.app.notify('B', { ...event(), text: 'private chat content' }), error => error.code === -32602);
  assert.equal((await f.app.notify('B', event())).status, 'queued');
  await f.app.flush();
  assert.equal(f.sent.length, 1);
  const { payload, body, headers } = f.sent[0];
  assert.deepEqual(payload.data, { recipient_id: 'B', kind: 'incoming_meeting', meeting_id: 'meeting_one' });
  assert.equal(payload.eventId, headers['webhook-id']);
  const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`${payload.eventId}.${headers['webhook-timestamp']}.${body}`).digest('base64');
  assert.equal(headers['webhook-signature'], `v1,${expected}`);
  assert.equal((await f.app.notify('B', event())).status, 'delivered');
  await f.app.flush(); assert.equal(f.sent.length, 1);
  assert.equal(f.app.status('B').deliveries[0].status, 'delivered');
});

test('subscriptions survive manager restart, events do not; expiry and finite ttl are enforced', async t => {
  const f = fixture(t);
  const first = await f.app.subscribe('B', params('B', { ttlMs: 1500 }), { owner: 'grant_test' });
  await f.app.notify('B', event());
  f.restart();
  assert.equal(f.app.status('B').subscribed, true);
  assert.deepEqual(f.app.status('B').deliveries, []);
  f.advance(1000);
  const refreshed = await f.app.subscribe('B', params('B', { ttlMs: 1500 }), { owner: 'grant_test' });
  assert.equal(first.id, refreshed.id);
  assert.ok(refreshed.refreshBefore > first.refreshBefore);
  f.advance(1600);
  assert.equal(f.app.status('B').subscribed, false);
  assert.equal((await f.app.notify('B', event())).reason, 'no_active_subscription');
  const indefinite = await f.app.subscribe('B', params('B', { ttlMs: null }), { owner: 'grant_test' });
  assert.equal(typeof indefinite.refreshBefore, 'string');
  await assert.rejects(f.app.subscribe('B', params('B', { ttlMs: 999 }), { owner: 'grant_test' }), error => error.code === -32602);
  await assert.rejects(f.app.subscribe('B', params('B', { cursor: 'unavailable' }), { owner: 'grant_test' }), error => error.code === -32602);
});

test('real control-store restart restores an encrypted callback and has no persisted activity', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'noknok-events-store-'));
  const options = { dataDir, realm: 'https://noknok.example' };
  let store = openHostedStore(options);
  let app;
  t.after(() => { app?.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const secret = () => randomBytes(32).toString('base64url');
  const account = store.registerAccount(secret());
  const { agentId } = store.registerAgent(account.accountToken, { requestId: secret() });
  const calls = [];
  const webhookPost = async (_url, request) => {
    const data = JSON.parse(request.body);
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    calls.push(data); return { status: 204 };
  };
  app = createHostedEvents({ store, webhookPost, workerIntervalMs: 60_000 });
  const registered = await app.subscribe(agentId, params(agentId), { owner: 'grant_test' });
  await app.notify(agentId, event('evt_never_persist_this_activity'));
  app.close(); store.close();
  const saved = readFileSync(join(dataDir, 'control.sqlite'));
  for (const value of [SECRET, URL, 'evt_never_persist_this_activity']) assert.equal(saved.includes(Buffer.from(value)), false, value);
  store = openHostedStore(options);
  app = createHostedEvents({ store, webhookPost, workerIntervalMs: 60_000 });
  assert.equal(app.status(agentId).subscriptions[0].id, registered.id);
  assert.deepEqual(app.status(agentId).deliveries, []);
  await app.notify(agentId, event()); await app.flush();
  assert.equal(calls.length, 1);
  store.revokeAgent(agentId);
  await assert.rejects(app.notify(agentId, event('evt_after_revoke')), error => error.status === 403);
});

test('key rotation emits both signatures briefly and new URLs retain independent subscriptions', async t => {
  const f = fixture(t, { rotationWindowMs: 1500 });
  const first = await f.app.subscribe('B', params(), { owner: 'grant_test' });
  const second = await f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: URL, secret: ROTATED } }), { owner: 'grant_test' });
  assert.equal(first.id, second.id);
  await f.app.notify('B', event()); await f.app.flush();
  assert.equal(f.sent[0].headers['webhook-signature'].split(' ').length, 2);
  f.advance(1600);
  await f.app.notify('B', event('evt_two', 'meeting_two')); await f.app.flush();
  assert.equal(f.sent[1].headers['webhook-signature'].split(' ').length, 1);
  await f.app.notify('B', event('evt_cancelled', 'meeting_three'));
  const replacement = await f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: `${URL}/new`, secret: SECRET } }), { owner: 'grant_test' });
  assert.notEqual(second.id, replacement.id);
  await f.app.flush();
  assert.equal(f.sent.length, 3, 'adding a destination preserves the existing queue');
  assert.equal(f.app.status('B').subscriptions.length, 2);
  assert.equal(f.app.status('B').deliveries.find(d => d.eventId === 'evt_cancelled').status, 'delivered');
  await f.app.notify('B', event('evt_new', 'meeting_four')); await f.app.flush();
  assert.equal(f.sent.at(-1).url, `${URL}/new`);
  assert.equal(f.sent.at(-1).headers['webhook-signature'].split(' ').length, 1);
});

test('new subscriptions must verify and a failed challenge preserves the old endpoint', async t => {
  let failNew = false;
  const f = fixture(t, { webhookPost: async (_url, request) => {
    const data = JSON.parse(request.body);
    return data.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: failNew ? 'wrong' : data.challenge }) } : { status: 204 };
  } });
  const first = await f.app.subscribe('B', params(), { owner: 'grant_test' }); failNew = true;
  await assert.rejects(f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: `${URL}/new`, secret: SECRET } }), { owner: 'grant_test' }), error => error.code === -32015 && error.data.reason === 'challenge_failed');
  assert.equal(f.app.status('B').subscriptions[0].id, first.id);
  await f.app.notify('B', event()); await f.app.flush();
  assert.equal(f.sent[0].url, URL);
});

test('concurrent subscribe completion cannot resurrect a superseded callback', async t => {
  const gates = [];
  const f = fixture(t, { webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body); const gate = deferred(); gates.push({ ...gate, payload });
    await gate.promise; return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  } });
  const old = f.app.subscribe('B', params(), { owner: 'grant_test' }).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  const latest = f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: URL, secret: ROTATED } }), { owner: 'grant_test' });
  await new Promise(resolve => setImmediate(resolve));
  gates[1].resolve(); const accepted = await latest;
  gates[0].resolve(); assert.equal((await old).code, -32009);
  assert.equal(f.app.status('B').subscriptions[0].id, accepted.id);
});

test('unsubscribe invalidates in-flight verification and aborts queued deliveries', async t => {
  const gate = deferred();
  const f = fixture(t, { webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body); await gate.promise;
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  } });
  const subscribing = f.app.subscribe('B', params(), { owner: 'grant_test' }).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  f.app.unsubscribe('B', unsubscribeParams(), { owner: 'grant_test' }); gate.resolve();
  assert.equal((await subscribing).code, -32009);
  assert.equal(f.app.status('B').subscribed, false);
});

test('an old endpoint unsubscribe cannot delete a replacement, while active unsubscribe cancels its queue', async t => {
  const f = fixture(t); await f.app.subscribe('B', params(), { owner: 'grant_test' });
  const newDelivery = { mode: 'webhook', url: `${URL}/replacement`, secret: ROTATED };
  const replacement = await f.app.subscribe('B', params('B', { delivery: newDelivery }), { owner: 'grant_test' });
  f.app.unsubscribe('B', unsubscribeParams(), { owner: 'grant_test' });
  assert.equal(f.app.status('B').subscriptions[0].id, replacement.id);
  await f.app.notify('B', event());
  f.app.unsubscribe('B', { name: 'noknok.activity', arguments: { recipient_id: 'B' }, delivery: { mode: 'webhook', url: newDelivery.url } }, { owner: 'grant_test' });
  await f.app.flush();
  assert.equal(f.sent.length, 0); assert.equal(f.app.status('B').deliveries[0].reason, 'unsubscribed');
});

test('delivery concurrency is globally bounded and unconsumed events expire in RAM', async t => {
  const gates = [];
  const f = fixture(t, { maxConcurrentDeliveries: 2, eventTtlMs: 1000, webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body);
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    const gate = deferred(); gates.push(gate); await gate.promise; return { status: 204 };
  } });
  await f.app.subscribe('B', params(), { owner: 'grant_test' });
  for (let index = 0; index < 3; index++) await f.app.notify('B', event(`evt_${index}`, `meeting_${index}`));
  const flushing = f.app.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, 2);
  await f.app.flush(); assert.equal(gates.length, 2);
  gates.forEach(gate => gate.resolve()); await flushing;
  f.advance(1000); await f.app.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.app.status('B').deliveries.find(d => d.eventId === 'evt_2').reason, 'event_expired');
});

test('transient errors retry with bounded exponential backoff, stable body and new signatures', async t => {
  const f = fixture(t, { webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body);
    return payload.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: payload.challenge }) } : { status: 503 };
  } });
  await f.app.subscribe('B', params(), { owner: 'grant_test' }); await f.app.notify('B', event()); await f.app.flush();
  await f.app.flush(); assert.equal(f.sent.length, 1);
  f.advance(1000); await f.app.flush(); assert.equal(f.sent.length, 2);
  f.advance(1999); await f.app.flush(); assert.equal(f.sent.length, 2);
  f.advance(1); await f.app.flush(); assert.equal(f.sent.length, 3);
  f.advance(4000); await f.app.flush(); assert.equal(f.sent.length, 4);
  f.advance(10_000); await f.app.flush(); assert.equal(f.sent.length, 4);
  assert.equal(new Set(f.sent.map(call => call.body)).size, 1);
  assert.equal(new Set(f.sent.map(call => call.headers['webhook-signature'])).size, 4);
  assert.deepEqual(f.app.status('B').deliveries[0], { eventId: 'evt_one', subscriptionId: f.app.status('B').subscriptions[0].id, status: 'failed', attempts: 4, reason: 'http_503' });
});

test('410, 413, redirects and other permanent failures are never retried', async t => {
  for (const code of [302, 400, 401, 403, 404, 410, 413]) {
    const f = fixture(t, { webhookPost: async (_url, request) => {
      const data = JSON.parse(request.body);
      return data.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) } : { status: code };
    } });
    await f.app.subscribe('B', params(), { owner: 'grant_test' }); await f.app.notify('B', event()); await f.app.flush();
    f.advance(10_000); await f.app.flush();
    assert.equal(f.sent.length, 1, String(code)); assert.equal(f.app.status('B').deliveries[0].status, 'failed'); f.app.close();
  }
});

test('a 410 disables the current endpoint, cancels pending events and requires a fresh verified subscription', async t => {
  let gone = true;
  const f = fixture(t, { maxConcurrentDeliveries: 1, webhookPost: async (_url, request) => {
    const data = JSON.parse(request.body);
    return data.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) } : { status: gone ? 410 : 204 };
  } });
  await f.app.subscribe('B', params(), { owner: 'grant_test' });
  await f.app.notify('B', event()); await f.app.notify('B', event('evt_pending', 'meeting_two'));
  await f.app.flush();
  assert.equal(f.app.status('B').subscribed, false);
  assert.equal(f.app.status('B').subscriptions[0].reason, 'callback_gone');
  assert.equal(f.app.status('B').deliveries.find(item => item.eventId === 'evt_pending').reason, 'callback_gone');
  assert.equal((await f.app.notify('B', event('evt_blocked', 'meeting_three'))).status, 'unavailable');
  f.restart(); assert.equal(f.app.status('B').subscribed, false);
  gone = false; await f.app.subscribe('B', params(), { owner: 'grant_test' });
  assert.equal(f.app.status('B').subscribed, true);
  assert.equal(f.app.status('B').subscriptions[0].reason, undefined);
  await f.app.notify('B', event('evt_fresh', 'meeting_four')); await f.app.flush();
  assert.equal(f.sent.length, 2); assert.equal(f.app.status('B').deliveries.at(-1).status, 'delivered');
});

test('an old in-flight 410 cannot disable a newer verified subscription', async t => {
  const gate = deferred();
  const f = fixture(t, { webhookPost: async (_url, request) => {
    const data = JSON.parse(request.body);
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    await gate.promise; return { status: 410 };
  } });
  await f.app.subscribe('B', params(), { owner: 'grant_test' }); await f.app.notify('B', event());
  const sending = f.app.flush(); await new Promise(resolve => setImmediate(resolve));
  await f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: URL, secret: ROTATED } }), { owner: 'grant_test' });
  gate.resolve(); await sending;
  assert.equal(f.app.status('B').subscribed, true);
  assert.equal(f.app.status('B').subscriptions[0].reason, undefined);
});

test('daily notification budget is shared by account, persists over restart, and excludes coalesced/duplicate events', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'noknok-events-daily-'));
  const options = { dataDir, realm: 'https://noknok.example' };
  let store = openHostedStore(options), app;
  t.after(() => { app?.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const secret = () => randomBytes(32).toString('base64url');
  const account = store.registerAccount(secret());
  const a = store.registerAgent(account.accountToken, { requestId: secret() });
  const b = store.registerAgent(account.accountToken, { requestId: secret() });
  const webhookPost = async (_url, request) => {
    const data = JSON.parse(request.body);
    return data.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) } : { status: 204 };
  };
  const config = { webhookPost, workerIntervalMs: 60_000, dailyNotificationLimit: 2 };
  app = createHostedEvents({ store, ...config });
  await app.subscribe(a.agentId, params(a.agentId), { owner: 'grant_test' }); await app.subscribe(b.agentId, params(b.agentId), { owner: 'grant_test' });
  await app.notify(a.agentId, event());
  assert.equal((await app.notify(a.agentId, event())).status, 'queued');
  assert.equal((await app.notify(a.agentId, event('evt_coalesced'))).status, 'coalesced');
  assert.equal((await app.notify(b.agentId, event('evt_second', 'meeting_two'))).status, 'queued');
  app.close(); store.close(); store = openHostedStore(options); app = createHostedEvents({ store, ...config });
  await assert.rejects(app.notify(a.agentId, event('evt_over_budget', 'meeting_three')), error => error.code === 'QUOTA_EXCEEDED');
  await assert.rejects(app.notify(b.agentId, event('evt_over_budget_b', 'meeting_four')), error => error.code === 'QUOTA_EXCEEDED');
  assert.deepEqual(app.status(a.agentId).deliveries, []);
});

test('authorization revocation cancels a retry and also blocks enqueue', async t => {
  let permitted = true;
  const f = fixture(t, { webhookPost: async (_url, request) => {
    const data = JSON.parse(request.body);
    return data.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) } : { status: 503 };
  } });
  await f.app.subscribe('B', params(), { owner: 'grant_test' }); await f.app.notify('B', event(), { authorize: () => permitted }); await f.app.flush();
  permitted = false; f.advance(1000); await f.app.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.app.status('B').deliveries[0].reason, 'authorization_revoked');
  assert.equal((await f.app.notify('B', event('evt_two'), { authorize: () => false })).status, 'cancelled');
});

test('coalescing, global/per-agent queue bounds, rate limits and transient history bounds hold', async t => {
  const f = fixture(t, { maxPending: 3, maxPendingPerAgent: 2, maxHistory: 1 });
  await f.app.subscribe('B', params(), { owner: 'grant_test' }); await f.app.subscribe('C', params('C'), { owner: 'grant_test' });
  await f.app.notify('B', event());
  const coalesced = await f.app.notify('B', event('evt_duplicate_meeting'));
  assert.equal(coalesced.status, 'coalesced'); assert.equal(coalesced.eventId, 'evt_one');
  await f.app.notify('B', event('evt_two', 'meeting_two'));
  assert.equal((await f.app.notify('B', event('evt_three', 'meeting_three'))).reason, 'queue_full');
  await f.app.notify('C', event('evt_four', 'meeting_four'));
  assert.equal((await f.app.notify('C', event('evt_five', 'meeting_five'))).reason, 'queue_full');
  await f.app.flush();
  assert.equal(f.app.status('B').deliveries.length + f.app.status('C').deliveries.length, 1);
  const limited = fixture(t, { notificationLimit: 1, subscriptionLimit: 1 });
  await limited.app.subscribe('B', params(), { owner: 'grant_test' });
  await assert.rejects(limited.app.subscribe('B', params(), { owner: 'grant_test' }), error => error.status === 429);
  await limited.app.notify('B', event()); await limited.app.flush();
  await assert.rejects(limited.app.notify('B', event('evt_two', 'meeting_two')), error => error.status === 429);
});

test('daily subscription verification budget rejects before another callback request', async t => {
  const f = fixture(t, { dailySubscriptionLimit: 2 });
  await f.app.subscribe('B', params(), { owner: 'grant_test' });
  f.advance(300_001);
  await f.app.subscribe('B', params(), { owner: 'grant_test' });
  f.advance(60_000);
  await assert.rejects(f.app.subscribe('B', params(), { owner: 'grant_test' }), error => error.code === 'QUOTA_EXCEEDED');
  assert.equal(f.callbacks.length, 2);
  assert.equal(f.app.status('B').subscribed, true, 'failed renewal does not remove the current subscription');
  f.advance(86_400_000);
  await f.app.subscribe('B', params(), { owner: 'grant_test' });
  assert.equal(f.callbacks.length, 3);
});

test('OAuth grants isolate subscriptions and receipts even with the same callback, and refresh only their own signing key', async t => {
  const owners = new Set(['grant_first', 'grant_second']);
  const f = fixture(t, { validateSubscription: (agentId, owner) => agentId === 'B' && owners.has(owner) });
  const first = await f.app.subscribe('B', params(), { owner: 'grant_first' });
  const second = await f.app.subscribe('B', params(), { owner: 'grant_second' });
  assert.notEqual(first.id, second.id);
  assert.equal(f.callbacks.length, 2, 'verification proof must not cross authorization grants');
  const refreshed = await f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: URL, secret: ROTATED } }), { owner: 'grant_first' });
  assert.equal(refreshed.id, first.id);
  assert.equal(f.store.getSubscription('B', first.id).secret, ROTATED);
  assert.equal(f.store.getSubscription('B', second.id).secret, SECRET);
  await assert.rejects(f.app.subscribe('A', params('B'), { owner: 'grant_first' }), error => error.status === 403);
  await assert.rejects(f.app.subscribe('B', { ...params(), owner: 'grant_first' }, { owner: 'grant_second' }), error => error.code === -32602);
  const queued = await f.app.notify('B', event());
  assert.equal(queued.deliveries.length, 2);
  await f.app.flush();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(new Set(f.sent.map(call => call.headers['X-MCP-Subscription-Id'])), new Set([first.id, second.id]));
  const secondView = f.app.status('B', 'grant_second');
  assert.deepEqual(secondView.subscriptions.map(sub => sub.id), [second.id]);
  assert.deepEqual(secondView.deliveries.map(delivery => delivery.subscriptionId), [second.id]);
  for (const sensitive of ['grant_first', 'grant_second', 'receiver.example.com', 'whsec_']) {
    assert.equal(JSON.stringify(secondView).includes(sensitive), false);
  }
  assert.equal(secondView.processingAcknowledged, false, 'HTTP success is not application processing');
  f.app.unsubscribe('B', unsubscribeParams(), { owner: 'grant_first' });
  assert.equal(f.app.status('B', 'grant_first').subscribed, false);
  assert.equal(f.app.status('B', 'grant_second').subscribed, true);
});

test('revoking a grant aborts callback verification without disturbing another grant verifying the same URL', async t => {
  const gates = [];
  const owners = new Set(['grant_first', 'grant_second']);
  const f = fixture(t, { validateSubscription: (_agentId, owner) => owners.has(owner), webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body), gate = deferred(); gates.push({ ...gate, request });
    await gate.promise;
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  } });
  const first = f.app.subscribe('B', params(), { owner: 'grant_first' }).then(() => null, error => error);
  const second = f.app.subscribe('B', params(), { owner: 'grant_second' });
  await new Promise(resolve => setImmediate(resolve));
  owners.delete('grant_first'); f.app.revokeOwner('B', 'grant_first');
  assert.equal(gates[0].request.signal.aborted, true);
  assert.equal(gates[1].request.signal.aborted, false);
  gates.forEach(gate => gate.resolve());
  assert.equal((await first).code, -32009);
  const accepted = await second;
  assert.deepEqual(f.app.status('B').subscriptions.map(sub => sub.id), [accepted.id]);
  await assert.rejects(f.app.subscribe('B', params(), { owner: 'grant_first' }), error => error.status === 403);
});

test('grant revalidation rejects a completed challenge when access changed without the local revocation hook', async t => {
  let allowed = true;
  const gate = deferred();
  const f = fixture(t, { validateSubscription: () => allowed, webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body); await gate.promise;
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  } });
  const subscribing = f.app.subscribe('B', params(), { owner: 'grant_first' }).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  allowed = false; gate.resolve();
  assert.equal((await subscribing).status, 403);
  assert.equal(f.app.status('B').subscribed, false);
});

test('grant revocation cancels queued and in-flight notifications, including expired records, without cancelling other owners', async t => {
  const gate = deferred(), requests = [];
  const owners = new Set(['grant_first', 'grant_second']);
  const f = fixture(t, { validateSubscription: (_agentId, owner) => owners.has(owner), maxConcurrentDeliveries: 2,
    webhookPost: async (_url, request) => {
      const payload = JSON.parse(request.body);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      requests.push(request); await gate.promise; return { status: 204 };
    } });
  const first = await f.app.subscribe('B', params('B', { ttlMs: 1000 }), { owner: 'grant_first' });
  const second = await f.app.subscribe('B', params(), { owner: 'grant_second' });
  await f.app.notify('B', event());
  await f.app.notify('B', event('evt_second', 'meeting_two'));
  const sending = f.app.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  f.advance(1001);
  owners.delete('grant_first'); f.app.revokeOwner('B', 'grant_first');
  assert.equal(requests.find(request => request.headers['X-MCP-Subscription-Id'] === first.id).signal.aborted, true);
  assert.equal(requests.find(request => request.headers['X-MCP-Subscription-Id'] === second.id).signal.aborted, false);
  assert.ok(f.app.status('B', 'grant_first').deliveries.every(delivery => delivery.status === 'cancelled' && delivery.reason === 'authorization_revoked'));
  gate.resolve(); await sending; await f.app.flush();
  assert.ok(f.app.status('B', 'grant_second').deliveries.every(delivery => delivery.status === 'delivered'));
  const aggregate = f.app.deliveryStatus('B', 'evt_one');
  assert.equal(aggregate.status, 'delivered', 'a cancelled first subscription must not hide a successful second one');
  assert.equal(aggregate.deliveries.length, 2);
  assert.equal(f.app.deliveryStatus('B', 'evt_one', 'grant_first').status, 'cancelled');
  assert.equal(f.app.deliveryStatus('B', 'evt_missing'), null);
  assert.equal((await f.app.notify('B', event('evt_third', 'meeting_three'))).subscriptionId, second.id);
});

test('persisted grant revocation blocks renewal, retry and enqueue even without a local revocation hook', async t => {
  let allowed = true;
  const f = fixture(t, { validateSubscription: () => allowed, webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body);
    return payload.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: payload.challenge }) } : { status: 503 };
  } });
  await f.app.subscribe('B', params(), { owner: 'grant_first' });
  await f.app.notify('B', event()); await f.app.flush();
  allowed = false;
  assert.equal(f.app.status('B').subscribed, false);
  await assert.rejects(f.app.subscribe('B', params(), { owner: 'grant_first' }), error => error.status === 403);
  assert.equal((await f.app.notify('B', event('evt_new'))).reason, 'no_active_subscription');
  f.advance(1000); await f.app.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.app.deliveryStatus('B', 'evt_one').reason, 'authorization_revoked');
});

test('OAuth revocation stays idempotent after administrative agent removal and still aborts its in-memory deliveries', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'noknok-events-agent-revoked-'));
  const store = openHostedStore({ dataDir, realm: 'https://noknok.example', now: () => 1_700_000_000_000 });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const account = store.registerAccount(randomBytes(32).toString('base64url'));
  const a = store.registerAgent(account.accountToken, { requestId: randomBytes(32).toString('base64url') });
  const b = store.registerAgent(account.accountToken, { requestId: randomBytes(32).toString('base64url') });
  const gate = deferred();
  const f = fixture(t, { store, maxConcurrentDeliveries: 1, webhookPost: async (_url, request) => {
    const payload = JSON.parse(request.body);
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    await gate.promise; return { status: 204 };
  } });
  await f.app.subscribe(a.agentId, params(a.agentId), { owner: 'grant_first' });
  await f.app.subscribe(b.agentId, params(b.agentId), { owner: 'grant_second' });
  await f.app.notify(a.agentId, event());
  await f.app.notify(a.agentId, event('evt_queued', 'meeting_two'));
  await f.app.notify(b.agentId, event('evt_other', 'meeting_other'));
  const sending = f.app.flush(); await new Promise(resolve => setImmediate(resolve));
  store.revokeAgent(a.agentId);
  assert.doesNotThrow(() => f.app.revokeOwner(a.agentId, 'grant_first'));
  assert.doesNotThrow(() => f.app.revokeOwner(a.agentId, 'grant_first'));
  assert.equal(f.sent[0].signal.aborted, true);
  for (const id of ['evt_one', 'evt_queued']) assert.equal(f.app.deliveryStatus(a.agentId, id).reason, 'authorization_revoked');
  gate.resolve(); await sending; await f.app.flush();
  assert.equal(f.app.deliveryStatus(b.agentId, 'evt_other').status, 'delivered');
  assert.equal(f.app.status(b.agentId, 'grant_second').subscribed, true);
});

test('subscription capacity counts destinations and grants while allowing refresh and released slots', async t => {
  const f = fixture(t, { maxSubscriptionsPerAgent: 2 });
  await f.app.subscribe('B', params(), { owner: 'grant_first' });
  await f.app.subscribe('B', params(), { owner: 'grant_second' });
  await f.app.subscribe('B', params(), { owner: 'grant_first' });
  await assert.rejects(f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: `${URL}/new`, secret: SECRET } }), { owner: 'grant_first' }), error => error.status === 429);
  f.app.revokeOwner('B', 'grant_second');
  await f.app.subscribe('B', params('B', { delivery: { mode: 'webhook', url: `${URL}/new`, secret: SECRET } }), { owner: 'grant_first' });
  assert.equal(f.app.status('B').subscriptions.length, 2);
});

test('CLI subscription stop is scoped to its authenticated agent and works with revoked grant owners', async t => {
  const owners = new Set(['grant_first', 'grant_second']);
  const gate = deferred();
  const f = fixture(t, { maxConcurrentDeliveries: 1, validateSubscription: (_agentId, owner) => owners.has(owner),
    webhookPost: async (_url, request) => {
      const payload = JSON.parse(request.body);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      await gate.promise; return { status: 204 };
    } });
  const first = await f.app.subscribe('B', params(), { owner: 'grant_first' });
  const second = await f.app.subscribe('B', params(), { owner: 'grant_second' });
  await f.app.notify('B', event());
  const sending = f.app.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.app.stop('A', first.id), {});
  assert.equal(f.app.status('B', 'grant_first').subscribed, true);
  assert.equal(f.sent[0].signal.aborted, false);
  owners.delete('grant_first');
  assert.deepEqual(f.app.stop('B', first.id), {});
  assert.deepEqual(f.app.stop('B', first.id), {});
  assert.equal(f.sent[0].signal.aborted, true);
  assert.equal(f.app.status('B', 'grant_first').subscriptions.length, 0);
  assert.equal(f.app.deliveryStatus('B', 'evt_one', 'grant_first').reason, 'unsubscribed');
  gate.resolve(); await sending; await f.app.flush();
  assert.equal(f.app.deliveryStatus('B', 'evt_one', 'grant_second').status, 'delivered');
  assert.deepEqual(f.app.status('B').subscriptions.map(sub => sub.id), [second.id]);
});

test('CLI subscription stop cancels a matching pending verification and cannot cancel another agent', async t => {
  const gate = deferred(); let request;
  const f = fixture(t, { webhookPost: async (_url, input) => {
    request = input;
    const payload = JSON.parse(input.body); await gate.promise;
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  } });
  const subscribing = f.app.subscribe('B', params(), { owner: 'grant_first' }).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  const id = request.headers['X-MCP-Subscription-Id'];
  f.app.stop('A', id); assert.equal(request.signal.aborted, false);
  f.app.stop('B', id); assert.equal(request.signal.aborted, true);
  gate.resolve(); assert.equal((await subscribing).code, -32009);
  assert.equal(f.app.status('B').subscribed, false);
});

test('secure transport validates all DNS answers, IPv6, and a pinned address on every request', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1',
    '224.0.0.1', '::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  let connections = 0;
  const noRequest = () => { connections++; throw new Error('Unexpected private connection.'); };
  const blocked = createSecureWebhookPost({ request: noRequest, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  await assert.rejects(blocked(URL, { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  await assert.rejects(blocked('https://[::1]/', { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  await assert.rejects(blocked('https://[::ffff:127.0.0.1]/', { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  await assert.rejects(blocked('http://public.example/', { headers: {}, body: '{}' }), error => error.reason === 'invalid_url');
  assert.equal(connections, 0);
  let dnsCalls = 0;
  const post = createSecureWebhookPost({ resolve: async () => [{ address: ++dnsCalls === 1 ? '2606:4700:4700::1111' : '::1', family: 6 }],
    request(url, options, callback) {
      connections++; assert.equal(url.hostname, 'receiver.example.com'); assert.equal(options.agent, false);
      options.lookup(url.hostname, {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, '2606:4700:4700::1111'); assert.equal(family, 6); });
      const req = new EventEmitter();
      req.end = () => { const response = new EventEmitter(); response.statusCode = 302; callback(response); response.emit('end'); };
      return req;
    } });
  assert.equal((await post(URL, { headers: {}, body: '{}' })).status, 302);
  await assert.rejects(post(URL, { headers: {}, body: '{}' }), error => error.reason === 'address_not_public');
  assert.equal(connections, 1, 'a redirect does not create a second request'); assert.equal(dnsCalls, 2);
});

test('secure transport rechecks authorization after DNS and before opening any connection', async () => {
  const gate = deferred(); let authorized = true; let connections = 0;
  const post = createSecureWebhookPost({ resolve: async () => { await gate.promise; return [{ address: '8.8.8.8', family: 4 }]; },
    request: () => { connections++; throw new Error('Unexpected connection.'); } });
  const pending = post(URL, { headers: {}, body: '{}', beforeSend: () => authorized });
  authorized = false; gate.resolve();
  await assert.rejects(pending, error => error.reason === 'cancelled'); assert.equal(connections, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(post(URL, { headers: {}, body: '{}', signal: aborted.signal }), error => error.reason === 'cancelled');
  assert.equal(connections, 0);
});

test('signatures cover the exact body and remove previous key after the overlap expires', () => {
  const sub = { id: 'sub_test', secret: SECRET, previousSecret: ROTATED, rotateUntil: 2000 };
  const signed = webhookHeaders(sub, 'evt_one', '{}', 1000)['webhook-signature'];
  assert.equal(signed.split(' ').length, 2);
  assert.notEqual(webhookHeaders(sub, 'evt_one', '{} ', 1000)['webhook-signature'], signed);
  assert.notEqual(webhookHeaders(sub, 'evt_two', '{}', 1000)['webhook-signature'], signed);
  assert.equal(webhookHeaders(sub, 'evt_one', '{}', 2000)['webhook-signature'].split(' ').length, 1);
});
