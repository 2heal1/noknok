import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedEvents } from '../src/hosted-events.js';
import { CallbackError } from '../src/webhook.js';

const SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-host', version: '1' } };
const params = (extra = {}) => ({ name: 'noknok.activity', arguments: { recipient_id: 'agent_test' },
  delivery: { mode: 'webhook', url: 'https://receiver.example/private-callback', secret: SECRET }, cursor: null, ...extra });

function fixture(t, options = {}) {
  const records = new Map(), reports = [];
  const counts = { quota: 0, callbacks: 0 };
  const store = {
    getSubscription: (_agent, id) => records.get(id), listSubscriptions: () => [...records.values()],
    putSubscription: (_agent, value) => { options.beforeStore?.(); records.set(value.id, value); return value; },
    deleteSubscription: (_agent, id) => records.delete(id), consumeQuota: () => { counts.quota++; },
  };
  const app = createHostedEvents({ store, workerIntervalMs: 60_000, webhookPost: async (_url, request) => {
    counts.callbacks++;
    if (options.callback) return options.callback(request);
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(request.body).challenge }) };
  } });
  t.after(() => app.close());
  const authorization = { owner: 'grant_test', report: event => { reports.push(event); options.report?.(event); } };
  return { app, records, reports, counts, authorization };
}

test('MCP 2 request metadata and replay hints preserve subscription identity on create, refresh and unsubscribe', async t => {
  const f = fixture(t);
  const first = await f.app.subscribe('agent_test', params({ _meta: META, maxAgeMs: 300_000, ttlMs: null }), f.authorization);
  const refreshed = await f.app.subscribe('agent_test', params({ _meta: { ...META, progressToken: 'next-request' }, maxAgeMs: 0 }), f.authorization);
  assert.equal(refreshed.id, first.id);
  assert.equal(f.counts.callbacks, 1, 'metadata and replay hints must not invalidate a recent callback proof');
  assert.equal(f.records.size, 1);
  const saved = f.records.get(first.id);
  assert.equal('_meta' in saved, false);
  assert.equal('maxAgeMs' in saved, false);
  const stop = params({ _meta: { ...META, progressToken: 3 } });
  delete stop.delivery.secret; delete stop.cursor;
  assert.deepEqual(f.app.unsubscribe('agent_test', stop, f.authorization), {});
  assert.equal(f.records.size, 0);
  assert.deepEqual(f.reports, [
    { stage: 'verification_started' }, { stage: 'callback_response', httpStatus: 200 }, { stage: 'subscription_stored' },
    { stage: 'verification_cached' }, { stage: 'subscription_stored' },
  ]);
});

test('metadata support does not relax parameter types, unknown fields or receiver authorization', async t => {
  const f = fixture(t);
  for (const meta of [null, [], true, 0, 'metadata']) {
    await assert.rejects(f.app.subscribe('agent_test', params({ _meta: meta }), f.authorization), error => error.code === -32602);
    const stop = params({ _meta: meta }); delete stop.delivery.secret; delete stop.cursor;
    assert.throws(() => f.app.unsubscribe('agent_test', stop, f.authorization), error => error.code === -32602);
  }
  for (const maxAgeMs of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '300000']) {
    await assert.rejects(f.app.subscribe('agent_test', params({ maxAgeMs }), f.authorization), error => error.code === -32602);
  }
  for (const extra of [{ unknown: true }, { report: {} }]) {
    await assert.rejects(f.app.subscribe('agent_test', params(extra), f.authorization), error => error.code === -32602);
  }
  const unknownStop = params({ _meta: META, unknown: true }); delete unknownStop.delivery.secret; delete unknownStop.cursor;
  assert.throws(() => f.app.unsubscribe('agent_test', unknownStop, f.authorization), error => error.code === -32602);
  await assert.rejects(f.app.subscribe('agent_test', params({ _meta: META, arguments: { recipient_id: 'agent_test', extra: true } }),
    f.authorization), error => error.code === -32001);
  await assert.rejects(f.app.subscribe('agent_other', params({ _meta: META }), f.authorization), error => error.code === -32001);
  const foreignStop = params({ _meta: META }); delete foreignStop.delivery.secret; delete foreignStop.cursor;
  assert.throws(() => f.app.unsubscribe('agent_other', foreignStop, f.authorization), error => error.code === -32001);
  assert.deepEqual(f.counts, { quota: 0, callbacks: 0 });
  assert.equal(f.records.size, 0);
});

test('callback diagnostics report only bounded status and allowlisted failure reasons', async t => {
  for (const [status, body] of [[200, 'null'], [403, 'private upstream response'], [700, '{}']]) {
    const f = fixture(t, { callback: () => ({ status, body }) });
    await assert.rejects(f.app.subscribe('agent_test', params({ _meta: META }), f.authorization),
      error => error.code === -32015 && error.data.reason === 'challenge_failed');
    assert.deepEqual(f.reports, [{ stage: 'verification_started' },
      { stage: 'callback_response', httpStatus: status <= 599 ? status : 0 },
      { stage: 'verification_failed', reason: 'challenge_failed' }]);
    assert.equal(f.records.size, 0);
  }
  for (const reason of ['dns_failed', 'private-untrusted-error-reason']) {
    const f = fixture(t, { callback: () => { throw new CallbackError(reason); } });
    await assert.rejects(f.app.subscribe('agent_test', params(), f.authorization), error => error.code === -32015);
    assert.deepEqual(f.reports, [{ stage: 'verification_started' },
      { stage: 'verification_failed', reason: reason === 'dns_failed' ? reason : 'internal_error' }]);
  }
});

test('diagnostic failures cannot change subscription results and persistence failures have a separate stage', async t => {
  const successful = fixture(t, { report: () => { throw new Error('logger unavailable'); } });
  await successful.app.subscribe('agent_test', params(), successful.authorization);
  assert.equal(successful.records.size, 1);
  const rejected = fixture(t, { callback: () => ({ status: 200, body: 'null' }), report: () => { throw new Error('logger unavailable'); } });
  await assert.rejects(rejected.app.subscribe('agent_test', params(), rejected.authorization),
    error => error.code === -32015 && error.data.reason === 'challenge_failed');
  const storage = fixture(t, { beforeStore: () => { throw new Error('private database details'); } });
  await assert.rejects(storage.app.subscribe('agent_test', params(), storage.authorization), error => error.code === -32015);
  assert.deepEqual(storage.reports, [{ stage: 'verification_started' }, { stage: 'callback_response', httpStatus: 200 }, { stage: 'subscription_store_failed' }]);
  assert.equal(storage.records.size, 0);
  for (const f of [successful, rejected, storage]) {
    const serialized = JSON.stringify(f.reports);
    for (const secret of [SECRET, 'receiver.example', 'agent_test', 'grant_test', 'private database details']) assert.equal(serialized.includes(secret), false);
  }
});
