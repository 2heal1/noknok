import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createMeetings } from '../src/meetings.js';

function fixture(t, options = {}) {
  const rooms = new Map();
  const meetings = createMeetings({ getUrl: () => 'http://relay.test', ...options, onEvent(room) { rooms.set(room.id, room); } });
  t.after(() => meetings.close());
  async function request(path, { method = 'GET', token, body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = new EventEmitter();
    let result;
    res.writeHead = status => { res.status = status; };
    res.end = data => { result = { status: res.status, body: JSON.parse(data) }; res.writableEnded = true; };
    await meetings.handle(req, res, new URL(path, 'http://relay.test'));
    assert.ok(result, 'request should complete without long polling');
    return result;
  }
  async function create(overrides = {}) {
    const payload = { name: 'Host', purpose: 'Private purpose', context: 'Private context', requestId: randomBytes(8).toString('hex'), retryToken: randomBytes(32).toString('base64url'), ...overrides };
    const response = await request('/v1/meetings', { method: 'POST', body: payload });
    assert.equal(response.status, 201);
    const host = response.body;
    host.path = `/v1/meetings/${host.meeting.id}`;
    host.payload = payload;
    return host;
  }
  async function join(host, name = 'Peer') {
    const response = await request(`${host.path}/join`, { method: 'POST', body: { name, token: new URLSearchParams(new URL(host.invitationUrl).hash.slice(1)).get('invite') } });
    assert.equal(response.status, 200);
    return response.body;
  }
  async function ack(host, participant, receipts) {
    return request(`${host.path}/ack`, { method: 'POST', token: participant.participant.token, body: { receipts: receipts ?? participant.deliveryReceipts } });
  }
  async function read(host, participant = host) { return (await request(host.path, { token: participant.participant.token })).body; }
  return { meetings, rooms, request, create, join, ack, read };
}

test('creation awaits its first peer and explicit participant receipts erase every metadata copy', async t => {
  const f = fixture(t);
  const host = await f.create();
  assert.equal(host.deliveryReceipts.length, 1);
  assert.equal((await f.ack(host, host)).status, 200);
  assert.equal((await f.read(host)).events[0].data.context, 'Private context', 'host ACK must not erase the first invitation');
  const peer = await f.join(host);
  assert.deepEqual(peer.deliveryReceipts.map(receipt => receipt.seq), [1, 2]);
  const first = peer.deliveryReceipts[0];
  const viewer = new URLSearchParams(new URL(host.viewUrl).hash.slice(1)).get('view');
  const view = await f.request(host.path, { token: viewer });
  assert.equal(view.body.deliveryReceipts, undefined);
  assert.equal((await f.request(`${host.path}/ack`, { method: 'POST', token: viewer, body: { receipts: [first] } })).status, 401);
  assert.equal((await f.ack(host, peer, [first, { seq: 2, token: 'forged' }])).status, 400);
  assert.ok((await f.read(host)).events[0].data, 'invalid batches do not partially ACK');
  assert.equal((await f.ack(host, peer, [first])).status, 200);
  const cleaned = await f.read(host);
  assert.equal(cleaned.events[0].bodyState, 'delivered');
  assert.equal(cleaned.events[0].data, undefined);
  assert.equal(cleaned.meeting.purpose, undefined);
  assert.equal(cleaned.meeting.context, undefined);
  assert.equal(f.meetings.inspect(host.meeting.id).purpose, undefined);
  const retry = await f.request('/v1/meetings', { method: 'POST', body: host.payload });
  assert.equal(retry.body.meeting.context, undefined);
  assert.equal(retry.body.events[0].data, undefined);
  const invite = new URLSearchParams(new URL(host.invitationUrl).hash.slice(1)).get('invite');
  assert.equal((await f.request(`${host.path}/invitation`, { token: invite })).body.meeting.context, undefined);
  assert.deepEqual((await f.ack(host, peer, [first])).body.acknowledged, [1], 'ACK retry remains idempotent after deletion');
  const room = f.rooms.get(host.meeting.id);
  assert.equal(room.purpose, undefined);
  assert.equal(room.context, undefined);
  assert.ok(!JSON.stringify([...room.mutations.values()]).includes('Private context'));
});

test('reads do not ACK and all original participants must acknowledge before message deletion', async t => {
  const f = fixture(t);
  const host = await f.create();
  const peer = await f.join(host);
  const third = await f.join(host, 'Third');
  const payload = { text: 'Private message payload', to: peer.participant.id, requestId: 'send-once' };
  const sent = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: payload });
  const seq = sent.body.event.seq;
  assert.deepEqual(sent.body.deliveryReceipts.map(receipt => receipt.seq), [seq], 'mutation receipts cover only its returned body');
  const peerRead = await f.read(host, peer);
  assert.equal((await f.read(host)).events.find(event => event.seq === seq).data.text, payload.text);
  assert.equal((await f.ack(host, peer, sent.body.deliveryReceipts)).status, 400, 'receipts cannot cross participant identities');
  await f.ack(host, host, sent.body.deliveryReceipts);
  await f.ack(host, peer, peerRead.deliveryReceipts.filter(receipt => receipt.seq === seq));
  assert.ok((await f.read(host)).events.find(event => event.seq === seq).data, 'directed messages still have room-wide delivery recipients');
  const thirdRead = await f.read(host, third);
  await f.ack(host, third, thirdRead.deliveryReceipts.filter(receipt => receipt.seq === seq));
  const retry = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: payload });
  assert.equal(retry.body.event.seq, seq);
  assert.equal(retry.body.event.bodyState, 'delivered');
  assert.equal(retry.body.event.data, undefined);
  assert.ok(!JSON.stringify([...f.rooms.get(host.meeting.id).mutations.values()]).includes(payload.text));
});

test('pending TTL deletes unattended bodies without traffic and valid expired receipts remain retryable', async t => {
  const f = fixture(t, { deliveryTtlMs: 35 });
  const host = await f.create();
  const room = f.rooms.get(host.meeting.id);
  const deadline = room.events[0].bodyExpiresAt;
  await f.ack(host, host);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(room.events[0].data, undefined, 'timer cleanup must not require an incoming request');
  assert.equal(room.events[0].bodyState, 'expired');
  const peer = await f.join(host);
  assert.equal(peer.events[0].bodyExpiresAt, deadline, 'joining cannot extend a delivery deadline');
  assert.equal(peer.events[0].data, undefined);
  assert.ok(!peer.deliveryReceipts.some(receipt => receipt.seq === 1));
  assert.deepEqual((await f.ack(host, host)).body.acknowledged, [1]);
  const retry = await f.request('/v1/meetings', { method: 'POST', body: host.payload });
  assert.equal(retry.body.events[0].bodyState, 'expired');
  assert.equal(retry.body.meeting.context, undefined);
});

test('late joins do not enlarge existing delivery claims or resurrect deleted bodies', async t => {
  const f = fixture(t);
  const host = await f.create();
  const peer = await f.join(host);
  const sent = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: { text: 'Snapshot participants' } });
  const seq = sent.body.event.seq;
  const late = await f.join(host, 'Late');
  assert.ok(late.events.find(event => event.seq === seq).data);
  assert.ok(!late.deliveryReceipts.some(receipt => receipt.seq === seq));
  await f.ack(host, host, sent.body.deliveryReceipts);
  await f.ack(host, peer, (await f.read(host, peer)).deliveryReceipts.filter(receipt => receipt.seq === seq));
  assert.equal((await f.read(host, late)).events.find(event => event.seq === seq).bodyState, 'delivered');
  const later = await f.join(host, 'Even later');
  assert.equal(later.events.find(event => event.seq === seq).data, undefined);
});

test('departure and revoked recipients release claims without claiming successful delivery', async t => {
  const unavailable = new Set();
  const f = fixture(t, { isParticipantAvailable: (room, participant) => !unavailable.has(participant.id) });
  const host = await f.create();
  const peer = await f.join(host);
  let sent = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: { text: 'Before leave' } });
  await f.ack(host, host, sent.body.deliveryReceipts);
  await f.request(`${host.path}/leave`, { method: 'POST', token: peer.participant.token, body: {} });
  assert.equal((await f.read(host)).events.find(event => event.seq === sent.body.event.seq).bodyState, 'recipient_unavailable');
  const third = await f.join(host, 'Third');
  sent = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: { text: 'Before revocation' } });
  await f.ack(host, host, sent.body.deliveryReceipts);
  unavailable.add(third.participant.id);
  const event = (await f.read(host)).events.find(item => item.seq === sent.body.event.seq);
  assert.equal(event.bodyState, 'recipient_unavailable');
  assert.equal(event.data, undefined);
});

test('ending summaries and custom reasons are deleted with their closed event, including replay caches', async t => {
  const f = fixture(t);
  const host = await f.create();
  const peer = await f.join(host);
  const payload = { text: 'Sensitive final summary', reason: 'Sensitive custom reason', requestId: 'end-once' };
  const ended = await f.request(`${host.path}/end`, { method: 'POST', token: host.participant.token, body: payload });
  assert.equal(ended.body.meeting.summary, payload.text);
  await f.ack(host, host, ended.body.deliveryReceipts);
  await f.ack(host, peer, (await f.read(host, peer)).deliveryReceipts);
  const retry = await f.request(`${host.path}/end`, { method: 'POST', token: host.participant.token, body: payload });
  assert.equal(retry.body.event.bodyState, 'delivered');
  assert.equal(retry.body.event.data, undefined);
  assert.equal(retry.body.meeting.summary, undefined);
  assert.equal(retry.body.meeting.reason, undefined);
  const room = f.rooms.get(host.meeting.id);
  assert.equal(room.summary, undefined);
  assert.equal(room.reason, undefined);
  assert.ok(!JSON.stringify([...room.mutations.values()]).includes('Sensitive'));
});

test('deletion reclaims body bytes while retaining bounded delivery metadata', async t => {
  const f = fixture(t);
  const host = await f.create();
  const peer = await f.join(host);
  const sent = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: { text: 'x'.repeat(30000) } });
  const before = f.meetings.stats().bytes;
  await f.ack(host, host, sent.body.deliveryReceipts);
  await f.ack(host, peer, (await f.read(host, peer)).deliveryReceipts.filter(receipt => receipt.seq === sent.body.event.seq));
  const after = f.meetings.stats().bytes;
  assert.ok(before - after > 29000);
  assert.ok(after > 0);
  const event = (await f.read(host)).events.at(-1);
  assert.equal(event.seq, sent.body.event.seq);
  assert.equal(event.from, host.participant.id);
  assert.equal(event.at, sent.body.event.at);
});

test('the first peer claim batch respects room and global memory limits before joining', async t => {
  for (const limits of [{ maxRoomBytes: 90000 }, { maxTotalBytes: 130000 }]) {
    await t.test(Object.keys(limits)[0], async subtest => {
      const f = fixture(subtest, limits);
      const host = await f.create();
      let count = 0;
      for (; count < 1000; count++) {
        const response = await f.request(`${host.path}/messages`, { method: 'POST', token: host.participant.token, body: { text: 'Pending first peer' } });
        if (response.status === 429) break;
        assert.equal(response.status, 200);
      }
      assert.ok(count > 1 && count < 1000, 'the memory budget should fill before the event count');
      const before = f.meetings.stats().bytes;
      const invite = new URLSearchParams(new URL(host.invitationUrl).hash.slice(1)).get('invite');
      const rejected = await f.request(`${host.path}/join`, { method: 'POST', body: { name: 'Peer', token: invite } });
      assert.equal(rejected.status, 429);
      assert.equal(f.meetings.stats().bytes, before);
      assert.equal(f.rooms.get(host.meeting.id).participants.size, 1);
    });
  }
});
