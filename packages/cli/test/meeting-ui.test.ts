import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingCache, mergeEvents, parseMeetingLink, randomId, randomRetryToken, transcriptOf } from '../web/meeting.js';
import { redactInvitations } from '../src/invitation.js';

test('viewing and exporting redact hosted contact grants and credentials without mutating evidence', () => {
  const credential = 'nk_agent_' + 'a'.repeat(43), grant = 'nk1.' + 'b'.repeat(40) + '.' + 'c'.repeat(43);
  const text = `Evidence remains. https://relay.example/contact#offer=${grant} https://relay.example/mcp/${credential} whsec_${'d'.repeat(32)}`;
  const record = { meeting: { id: 'room', context: text }, events: [{ seq: 1, type: 'message', data: { text } }] };
  for (const serialized of [JSON.stringify(transcriptOf(record)), JSON.stringify(redactInvitations(record))]) {
    assert.ok(serialized.includes('Evidence remains.'));
    for (const secret of [credential, grant, 'd'.repeat(32)]) assert.ok(!serialized.includes(secret));
  }
  assert.equal(record.meeting.context, text);
});

test('explicit viewer links remain read-only and opaque ids grant no join capability', () => {
  assert.deepEqual(parseMeetingLink('#id=room-1&view=read-secret&invite=join-secret'), { id: 'room-1', mode: 'view', token: 'read-secret' });
  assert.deepEqual(parseMeetingLink('#id=room-1'), { id: 'room-1', mode: 'saved' });
  assert.equal(parseMeetingLink('#id=../another-path&invite=secret'), null);
});

test('out-of-order polling and mutation responses produce one ordered transcript', () => {
  const events = mergeEvents([{ seq: 2, type: 'message', data: { text: 'second' } }], [{ seq: 3, type: 'message', data: { text: 'third' } }, { seq: 1, type: 'started' }, { seq: 2, type: 'message', data: { text: 'second' } }]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
});

test('download contains public transcript and never persisted access credentials', () => {
  const record = { meeting: { id: 'meeting', purpose: 'Reproduce issue' }, events: [{ seq: 1, type: 'started' }], access: { participant: 'private-token', invite: 'invitation-secret', view: 'viewer-secret' }, participantId: 'owner', archived: true, partial: true };
  const exported = transcriptOf(record);
  assert.equal(exported.source, 'local-copy');
  assert.equal(exported.partial, true);
  assert.deepEqual(exported.meeting, record.meeting);
  const serialized = JSON.stringify(exported);
  for (const secret of ['private-token', 'invitation-secret', 'viewer-secret']) assert.equal(serialized.includes(secret), false);
});

test('export removes pasted invitation links and known credentials without changing local history', () => {
  const context = '排查登录失败。邀请 https://relay.example/meeting#id=other&invite=unrelated-secret';
  const text = '复现步骤：打开页面。Bearer participant-secret /meeting#invite=another-secret&id=another';
  const record = {
    meeting: { id: 'meeting', purpose: '确认复现', context },
    events: [{ seq: 1, type: 'message', data: { text, nested: ['viewer-secret', '正常说明保留'] } }],
    access: { participant: 'participant-secret', invite: 'invitation-secret', view: 'viewer-secret' },
  };
  const exported = transcriptOf(record);
  const serialized = JSON.stringify(exported);
  for (const secret of ['participant-secret', 'invitation-secret', 'viewer-secret', 'unrelated-secret', 'another-secret']) assert.equal(serialized.includes(secret), false);
  assert.ok(exported.meeting.context.startsWith('排查登录失败。邀请 '));
  assert.ok(exported.events[0].data.text.startsWith('复现步骤：打开页面。'));
  assert.equal(exported.events[0].data.nested[1], '正常说明保留');
  assert.equal(record.meeting.context, context);
  assert.equal(record.events[0].data.text, text);
  assert.equal(record.events[0].data.nested[0], 'viewer-secret');
});

test('plain HTTP browser fallback creates RFC 4122 version 4 ids using secure random bytes', () => {
  let calls = 0;
  const provider = { getRandomValues(bytes) { calls++; assert.ok(bytes instanceof Uint8Array); bytes.fill(255); return bytes; } };
  assert.equal(randomId(provider), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
  assert.match(randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => randomId({}), /安全随机数/);
});

test('create and join retry proofs use 32 secure random bytes in base64url', () => {
  let requestedBytes;
  const token = randomRetryToken({ getRandomValues(bytes) { requestedBytes = bytes.length; bytes.fill(255); return bytes; } });
  assert.equal(requestedBytes, 32);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Buffer.from(token, 'base64url'), Buffer.alloc(32, 255));
});

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.beforeSet?.(key, value); this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

function localRoom(id, extra = {}) {
  return { meeting: { id, purpose: id, state: 'active' }, access: { participant: `${id}-participant-secret` }, events: [{ seq: 1, type: 'started' }], snapshotCursor: 1, ...extra };
}

test('two browser tabs with stale lists preserve separate rooms, credentials and archives', () => {
  const backing = new MemoryStorage();
  const tabA = new MeetingCache(backing), tabB = new MeetingCache(backing);
  assert.deepEqual(tabA.read().rooms, []);
  assert.deepEqual(tabB.read().rooms, []);
  const a = localRoom('A');
  const b = localRoom('B', { archived: true, events: [{ seq: 1, type: 'started' }, { seq: 2, type: 'message', data: { text: 'Preserve this offline transcript' } }] });
  tabA.save(a, '', 'Alice');
  tabB.save(b, '', 'Bob');
  tabA.save({ ...a, events: [...a.events, { seq: 2, type: 'message', data: { text: 'new A reply' } }] }, '', 'Alice');
  const rooms = new Map(tabB.read().rooms.map((room) => [room.meeting.id, room]));
  assert.equal(rooms.size, 2);
  assert.equal(rooms.get('A').access.participant, 'A-participant-secret');
  assert.equal(rooms.get('A').events[1].data.text, 'new A reply');
  assert.equal(rooms.get('B').access.participant, 'B-participant-secret');
  assert.equal(rooms.get('B').archived, true);
  assert.equal(rooms.get('B').events[1].data.text, 'Preserve this offline transcript');
});

test('same-room stale viewer save retains participant credentials and newer discussion', () => {
  const backing = new MemoryStorage();
  const tabA = new MeetingCache(backing), tabB = new MeetingCache(backing);
  tabA.save(localRoom('A', { participantId: 'person-A', snapshotCursor: 3, events: [{ seq: 1 }, { seq: 3, type: 'message', data: { text: 'latest' } }] }), '');
  tabB.save(localRoom('A', { mode: 'view', access: { view: 'readonly-capability' }, events: [{ seq: 1 }, { seq: 2, type: 'message', data: { text: 'earlier' } }] }), '');
  const [saved] = tabA.read().rooms;
  assert.equal(saved.access.participant, 'A-participant-secret');
  assert.equal(saved.access.view, 'readonly-capability');
  assert.equal(saved.participantId, 'person-A');
  assert.equal(saved.snapshotCursor, 3);
  assert.deepEqual(saved.events.map((event) => event.seq), [1, 2, 3]);
});

test('explicit clear cannot be resurrected by another tab or a write racing clear', () => {
  const backing = new MemoryStorage();
  const tabA = new MeetingCache(backing), tabB = new MeetingCache(backing);
  const record = localRoom('A');
  tabA.save(record, '');
  tabB.clear('A');
  assert.equal(tabA.save(record, '').cleared, true);
  assert.deepEqual(tabA.read().rooms, []);
  const freshGeneration = tabA.generation('A');
  tabA.save(record, freshGeneration);
  backing.beforeSet = (key) => {
    if (key.includes('.room.')) { backing.beforeSet = null; tabB.clear('A'); }
  };
  assert.equal(tabA.save(record, freshGeneration).cleared, true);
  assert.deepEqual(tabB.read().rooms, []);
  assert.equal([...backing.values.values()].some((value) => value.includes('A-participant-secret')), false);
});
