import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createContactSwitch, contactAgentId } from '../src/contact-switch.js';
import { startRelay } from '../src/relay.js';

const token = () => randomBytes(32).toString('base64url');
const peer = name => ({ name, token: token(), contacts: [] });
function unpack(value) { return JSON.parse(Buffer.from(value.split('/').at(-1), 'base64url').toString('utf8')); }
async function fixture(t, options = {}) {
  let url;
  let relay;
  let contactSwitch;
  let server;
  if (options.switchOptions) {
    contactSwitch = createContactSwitch({ getUrl: () => url, ...options.switchOptions });
    server = http.createServer((req, res) => contactSwitch.handle(req, res, new URL(req.url, url)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  } else {
    relay = await startRelay({ port: 0, contacts: true });
    url = relay.url;
  }
  async function close() {
    if (relay) return relay.close();
    contactSwitch.close();
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
  t.after(close);
  async function request(agent, body, options = {}) {
    const response = await fetch(`${url}/v1/contacts${options.query || ''}`, {
      method: options.method || 'POST', signal: options.signal,
      headers: { Authorization: `Bearer ${agent?.token}`, 'Content-Type': 'application/json', ...options.headers },
      ...((options.method || 'POST') === 'GET' ? {} : { body: options.raw ?? JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function register(agent) {
    const result = await request(agent, { op: 'register', name: agent.name, contacts: agent.contacts });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    agent.id = result.body.agent.id;
    return result.body;
  }
  async function friend(a, b) {
    const invitation = await request(a, { op: 'invite', requestId: token() });
    assert.equal(invitation.status, 200);
    const link = unpack(invitation.body.contactLink);
    const requestId = token();
    const result = await request(b, { op: 'add', inviteId: link.inviteId, inviteToken: link.token, requestId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { link, requestId, response: result.body };
  }
  async function invitation() {
    if (!relay) return `noknok://invite/${Buffer.from(JSON.stringify({ v: 1, server: url, callId: '7c71fcf7-36ae-4d64-8073-3f2d948d1440', token: token(), expiresAt: new Date(Date.now() + 60_000).toISOString() })).toString('base64url')}`;
    const response = await fetch(`${url}/v1/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Caller', purpose: 'A bounded local validation' }) });
    assert.equal(response.status, 201);
    return (await response.json()).invitation;
  }
  return { url, request, register, friend, invitation, close };
}
async function waitForDelivery(f, a, body) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await f.request(a, body);
    if (result.status !== 404) return result;
    await delay(5);
  }
  assert.fail('Receiver did not become reachable.');
}

test('background receiver leases bridge polling gaps and expire independently of registration', async t => {
  let now = Date.now();
  const f = await fixture(t, { switchOptions: { now: () => now, leaseMs: 1000 } });
  const a = peer('A'), b = peer('B');
  await f.register(a); await f.register(b); await f.friend(a, b);
  const invitation = await f.invitation();
  const call = requestId => f.request(a, { op: 'deliver', recipientId: b.id, invitation, requestId });
  assert.equal((await call('not-ready')).status, 404);
  assert.equal((await f.request(b, { op: 'ready', enabled: true })).status, 200);
  assert.equal((await call('ready-with-no-poll')).status, 200);
  now += 1001;
  await f.register(b);
  assert.equal((await call('registration-is-not-readiness')).status, 404);
  await f.request(b, { op: 'ready', enabled: true });
  await f.request(b, { op: 'ready', enabled: false });
  assert.equal((await call('stopped')).status, 404);
  assert.equal((await f.request(b, { op: 'ready', enabled: 'yes' })).status, 400);
});

test('contact switch is opt-in and identities are credential-derived with private responses', async t => {
  const ordinary = await startRelay({ port: 0 });
  t.after(() => ordinary.close());
  assert.equal((await fetch(`${ordinary.url}/v1/contacts`, { method: 'POST' })).status, 404);
  const f = await fixture(t);
  const a = peer('Trae');
  const initial = await f.register(a);
  assert.equal(a.id, contactAgentId(a.token));
  assert.equal((await f.register(a)).instanceId, initial.instanceId);
  assert.equal(initial.leaseMs, 90_000);
  assert.equal(JSON.stringify(initial).includes(a.token), false);
  assert.equal((await f.request(a, { op: 'register', name: 'Imposter', contacts: [], agentId: a.id })).status, 400);
  const b = peer('Trae');
  await f.register(b);
  assert.notEqual(a.id, b.id);
  const invite = await f.request(a, { op: 'invite', requestId: 'link' });
  assert.equal(invite.headers.get('cache-control'), 'no-store');
  assert.equal(unpack(invite.body.contactLink).server, f.url);
  assert.notEqual(unpack(invite.body.contactLink).token, a.token);
});

test('single-use friendship grants require the invitation and replay only to its original redeemer', async t => {
  const f = await fixture(t);
  const [a, b, c] = [peer('Trae'), peer('dot'), peer('Other')];
  for (const agent of [a, b, c]) await f.register(agent);
  const { link, requestId, response } = await f.friend(a, b);
  assert.deepEqual(response.contact, { id: a.id, name: a.name });
  const add = { op: 'add', inviteId: link.inviteId, inviteToken: link.token, requestId };
  assert.deepEqual((await f.request(b, add)).body, response);
  for (const body of [add, { ...add, inviteId: 'unknown' }, { ...add, inviteToken: token() }]) {
    const denied = await f.request(c, body);
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error.code, 'contact_unavailable');
  }
  assert.equal((await f.request(b, { ...add, requestId: 'another-attempt' })).body.error.code, 'contact_unavailable');
  const inbox = await f.request(a, { op: 'poll', after: 0 });
  assert.deepEqual(inbox.body.events, [{ seq: 1, type: 'contact_added', contact: { id: b.id, name: b.name } }]);
  assert.deepEqual((await f.request(c, { op: 'poll' })).body.events, []);
  assert.equal((await f.request(c, { op: 'list' })).status, 400);
  assert.equal((await f.request(c, { op: 'poll', agentId: a.id })).status, 400);
});

test('authorized live call delivery wakes the receiver, preserves relay sessions and deduplicates retries', async t => {
  const f = await fixture(t);
  const [a, b] = [peer('Trae'), peer('dot')];
  for (const agent of [a, b]) await f.register(agent);
  await f.friend(a, b);
  // Renewal can race the owner saving a newly accepted contact.
  await f.register(a);
  const invitation = await f.invitation();
  const receive = f.request(b, { op: 'poll', after: 0, waitMs: 10_000 });
  const body = { op: 'deliver', recipientId: b.id, invitation, requestId: 'start-chat' };
  assert.equal((await waitForDelivery(f, a, body)).status, 200);
  const incoming = await receive;
  assert.deepEqual(incoming.body.events, [{ seq: 1, type: 'incoming_call', from: { id: a.id, name: a.name }, invitation }]);
  const repeated = await f.request(a, body);
  assert.deepEqual(repeated.body, { delivered: true, recipientId: b.id });
  assert.equal((await f.request(b, { op: 'poll' })).body.events.length, 1);
  assert.equal((await f.request(a, { ...body, invitation: `${invitation}a` })).body.error.code, 'idempotency_conflict');
  const call = unpack(invitation);
  const joined = await fetch(`${f.url}/v1/calls/${call.callId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: call.token, name: b.name }) });
  assert.equal(joined.status, 200);
  const view = await fetch(`${f.url}/v1/session-view`, { headers: { Authorization: `Bearer ${call.callId}` } });
  assert.equal(view.status, 200);
  assert.equal((await view.json()).call.state, 'connected');
  await f.request(b, { op: 'ack', through: 1 });
  assert.deepEqual((await f.request(b, { op: 'poll', after: 1 })).body.events, []);
});

test('unknown, offline, unapproved and revoked recipients are indistinguishable', async t => {
  const f = await fixture(t);
  const [a, b, c] = [peer('A'), peer('B'), peer('C')];
  for (const agent of [a, b, c]) await f.register(agent);
  await f.friend(a, b);
  const invitation = await f.invitation();
  const delivery = recipientId => ({ op: 'deliver', recipientId, invitation, requestId: token() });
  const offline = await f.request(a, delivery(b.id));
  assert.equal(offline.body.error.code, 'contact_unavailable');
  const unknown = await f.request(a, delivery(contactAgentId(token())));
  assert.deepEqual(unknown.body, offline.body);
  const receive = f.request(b, { op: 'poll', waitMs: 1000 });
  await delay(20);
  const unapproved = await f.request(c, delivery(b.id));
  assert.deepEqual(unapproved.body, offline.body);
  // No contact graph transitivity: knowing A's ID and naming it in a local
  // allow-list cannot create the missing grant on A's side.
  c.contacts = [a.id];
  await f.register(c);
  assert.deepEqual((await f.request(c, delivery(a.id))).body, offline.body);
  // A persisted the new contact and later intentionally removed it.
  await f.request(a, { op: 'ack', through: 1 });
  await f.register(a);
  assert.deepEqual((await f.request(a, delivery(b.id))).body, offline.body);
  assert.deepEqual((await receive).body.events, []);
});

test('delivery validates the exact relay origin before the receiver can follow an invitation', async t => {
  const f = await fixture(t);
  const [a, b] = [peer('A'), peer('B')];
  for (const agent of [a, b]) await f.register(agent);
  await f.friend(a, b);
  const valid = await f.invitation();
  const decoded = unpack(valid);
  const receiving = f.request(b, { op: 'poll', waitMs: 1000 });
  await delay(20);
  const invalid = [
    'https://external.invalid/invite/secret',
    `noknok://invite/${Buffer.from(JSON.stringify({ ...decoded, server: 'http://169.254.169.254' })).toString('base64url')}`,
    `noknok://invite/${Buffer.from(JSON.stringify({ ...decoded, server: `${f.url}/other` })).toString('base64url')}`,
    `noknok://invite/${Buffer.from(JSON.stringify({ ...decoded, expiresAt: '2000-01-01T00:00:00.000Z' })).toString('base64url')}`,
  ];
  for (const invitation of invalid) {
    const result = await f.request(a, { op: 'deliver', recipientId: b.id, invitation, requestId: token() });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, 'invalid_invitation');
  }
  assert.deepEqual((await receiving).body.events, []);
});

test('receive cancellation removes reachability and shutdown resolves pending polls', async t => {
  const f = await fixture(t);
  const [a, b] = [peer('A'), peer('B')];
  for (const agent of [a, b]) await f.register(agent);
  await f.friend(a, b);
  const abort = new AbortController();
  const receive = f.request(b, { op: 'poll', waitMs: 25_000 }, { signal: abort.signal });
  const rejected = assert.rejects(receive, { name: 'AbortError' });
  await delay(20);
  abort.abort();
  await rejected;
  await delay(20);
  assert.equal((await f.request(a, { op: 'deliver', recipientId: b.id, invitation: await f.invitation(), requestId: 'after-disconnect' })).body.error.code, 'contact_unavailable');
  const ending = f.request(b, { op: 'poll', waitMs: 25_000 });
  await delay(20);
  await f.close();
  const result = await ending;
  assert.equal(result.status, 200);
  assert.equal(result.body.closed, true);
});

test('contact state expires and a restarted switch exposes a new instance without retaining contacts', async t => {
  let clock = Date.now();
  const f = await fixture(t, { switchOptions: { now: () => clock, leaseMs: 50, inviteTtlMs: 100, retentionMs: 200 } });
  const [a, b] = [peer('A'), peer('B')];
  const first = await f.register(a);
  await f.register(b);
  const invite = unpack((await f.request(a, { op: 'invite', requestId: 'expiring' })).body.contactLink);
  clock += 101;
  assert.equal((await f.request(b, { op: 'add', inviteId: invite.inviteId, inviteToken: invite.token, requestId: 'late' })).body.error.code, 'contact_unavailable');
  clock += 201;
  assert.equal((await f.request(a, { op: 'poll' })).body.error.code, 'registration_required');
  const renewed = await f.register(a);
  assert.notEqual(renewed.instanceId, first.instanceId);
  assert.equal((await f.request(a, { op: 'poll', after: 1 })).body.error.code, 'invalid_cursor');
  const second = await fixture(t);
  assert.notEqual((await second.register(a)).instanceId, first.instanceId);
  assert.deepEqual((await second.request(a, { op: 'poll' })).body.events, []);
});

test('contact endpoint rejects browser origins, malformed credentials and oversized bodies', async t => {
  const f = await fixture(t);
  const a = peer('A');
  const body = { op: 'register', name: 'A', contacts: [] };
  for (const candidate of [undefined, 'short', `${a.token}=`, 'x'.repeat(43), 'A'.repeat(42) + '_']) {
    const result = await f.request({ token: candidate }, body);
    assert.equal(result.status, 401);
  }
  assert.equal((await f.request(a, body, { headers: { Origin: 'http://localhost' } })).status, 403);
  assert.equal((await f.request(a, body, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.request(a, body, { method: 'GET' })).status, 405);
  assert.equal((await f.request(a, body, { query: '?agentId=other' })).status, 400);
  assert.equal((await f.request(a, body, { raw: '{' })).status, 400);
  assert.equal((await f.request(a, body, { raw: JSON.stringify({ ...body, name: 'x'.repeat(40_000) }) })).status, 413);
  assert.equal((await f.request(a, { ...body, name: 'A\nB' })).status, 400);
  assert.equal((await f.request(a, { ...body, contacts: Array.from({ length: 101 }, token).map(contactAgentId) })).status, 400);
  assert.equal((await f.request(a, body, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('invitation limits and self-add denial are bounded without creating contact events', async t => {
  const f = await fixture(t);
  const a = peer('A');
  await f.register(a);
  let first;
  for (let i = 0; i < 16; i++) {
    const result = await f.request(a, { op: 'invite', requestId: String(i) });
    assert.equal(result.status, 200);
    first ??= result.body;
  }
  assert.equal((await f.request(a, { op: 'invite', requestId: 'too-many' })).status, 429);
  assert.deepEqual((await f.request(a, { op: 'invite', requestId: '0' })).body, first);
  const link = unpack(first.contactLink);
  assert.equal((await f.request(a, { op: 'add', inviteId: link.inviteId, inviteToken: link.token, requestId: 'self' })).body.error.code, 'contact_unavailable');
  assert.deepEqual((await f.request(a, { op: 'poll' })).body.events, []);
});
