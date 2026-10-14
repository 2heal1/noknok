import { encryptedMeetingFixture } from './e2ee-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationJoinLink } from './meeting-invitation-helper.js';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createMeetings } from '../src/meetings.js';
import { startRelay } from '../src/relay.js';
import { meetingInvitationText, meetingJoinInstructions } from '../web/meeting-invitation.js';
import { decodeMeetingLink, withMeetingKey } from '../src/meeting-client.js';
import { generateKey, encryptText, contentAAD } from '../src/e2ee.js';

async function fixture(t, options = {}) {
  const relay = await startRelay({ port: 0, ...options });
  t.after(() => relay.close());
  const retryTokens = new Map();
  function retryToken(operation, requestId) {
    if (requestId === undefined) return undefined;
    const key = `${operation}:${requestId}`;
    if (!retryTokens.has(key)) retryTokens.set(key, randomBytes(32).toString('base64url'));
    return retryTokens.get(key);
  }
  const encryption = encryptedMeetingFixture();
  async function rawRequest(path, { method = 'GET', body, token, headers, signal } = {}) {
    const response = await fetch(`${relay.url}${path}`, {
      method, signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(path, options = {}) {
    const response = await rawRequest(path, { ...options, body: await encryption.encode(path, options.body, options.token) });
    return { ...response, body: await encryption.decode(response.body) };
  }
  async function create(overrides = {}, headers) {
    const response = await request('/v1/meetings', { method: 'POST', body: { name: 'agent-codex', purpose: 'Collect reproduction evidence', context: 'Ticket 42', retryToken: retryToken('create', overrides.requestId), ...overrides }, headers });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response.body));
    const invite = new URLSearchParams(new URL(response.body.invitationUrl).hash.slice(1));
    const view = new URLSearchParams(new URL(response.body.viewUrl).hash.slice(1));
    return { ...response.body, path: `/v1/meetings/${response.body.meeting.id}`, inviteToken: invite.get('invite'), viewToken: view.get('view') };
  }
  async function join(room, overrides = {}) {
    const response = await request(`${room.path}/join`, { method: 'POST', body: { token: room.inviteToken, name: 'agent-trae', retryToken: retryToken(`join:${room.meeting.id}`, overrides.requestId), ...overrides } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function mutate(room, operation, token = room.participant.token, body = {}) {
    return request(`${room.path}/${operation}`, { method: 'POST', body, token });
  }
  return { ...relay, rawRequest, request, create, join, mutate, retryToken };
}

test('relay serves invitation assets while clients assemble complete encrypted handoffs', async t => {
  const f = await fixture(t);
  const key = generateKey(), encryptionId = randomUUID();
  const response = await f.rawRequest('/v1/meetings', { method: 'POST', body: {
    name: 'Host', encryption: { v: 1, id: encryptionId },
    purpose: await encryptText(key, 'Private goal', contentAAD(encryptionId, 'started', 'system', 'purpose')),
    context: await encryptText(key, '', contentAAD(encryptionId, 'started', 'system', 'context')),
  } });
  assert.equal(response.status, 201);
  const room = response.body;
  assert.equal(room.invitationText, undefined, 'The relay cannot produce a complete invitation without the locally held key.');
  assert.ok(!JSON.stringify(room).includes(key));
  const invitationUrl = withMeetingKey(room.invitationUrl, key, encryptionId);
  const viewUrl = withMeetingKey(room.viewUrl, key, encryptionId);
  for (const invitationText of [meetingInvitationText(invitationUrl, viewUrl), meetingInvitationText(invitationUrl, undefined, 'zh')]) {
    const link = invitationJoinLink({ ...room, invitationUrl, invitationText });
    const decoded = decodeMeetingLink(link);
    assert.equal(decoded.key, key);
    assert.equal(decoded.encryptionId, encryptionId);
    const joined = await f.rawRequest(`/v1/meetings/${decoded.id}/join`, { method: 'POST', body: { token: decoded.token, name: 'Invited agent', kind: 'agent' } });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.meeting.id, room.meeting.id);
  }
  const page = await fetch(invitationUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /npm install --global @noknok\/cli/);
  assert.match(html, /noknok skill/);
  assert.match(html, /noknok meeting join/);
  assert.ok(!html.includes('Private goal'));
  assert.ok(!html.includes(key));
  assert.ok(!html.includes(room.participant.token));
  const instructions = meetingJoinInstructions(invitationUrl);
  assert.ok(instructions.includes(`noknok meeting join '${invitationUrl}'`));
  assert.ok(instructions.indexOf('npm install') < instructions.indexOf('noknok skill'));
  // Existing invitations remain usable after the new page route is introduced.
  const old = new URL(invitationUrl);
  old.pathname = '/meeting';
  const params = new URLSearchParams(old.hash.slice(1));
  params.set('id', room.meeting.id);
  old.hash = params.toString();
  assert.deepEqual(decodeMeetingLink(old.href), decodeMeetingLink(invitationUrl));
  for (const file of ['meeting-invitation', 'e2ee']) {
    const asset = await fetch(`${f.url}/${file}.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(await asset.text(), /export (?:async )?function/);
  }
});

test('meetings have independent host, reusable invitation and read-only capabilities', async t => {
  const f = await fixture(t);
  const room = await f.create({ requestId: 'create-a' });
  assert.equal(room.meeting.state, 'active');
  assert.equal(room.participant.role, 'host');
  assert.equal(room.participant.kind, 'agent');
  assert.equal(room.meeting.hostId, room.participant.id);
  assert.equal(new Set([room.participant.token, room.inviteToken, room.viewToken]).size, 3);
  assert.equal(new URL(room.invitationUrl).search, '');
  assert.equal(new URL(room.invitationUrl).pathname, `/invite/${room.meeting.id}`);
  assert.equal(Date.parse(room.meeting.expiresAt) - Date.parse(room.meeting.createdAt), 7_200_000);
  assert.equal(Date.parse(room.meeting.purgeAt) - Date.parse(room.meeting.expiresAt), 600_000);
  const invitation = await f.request(`${room.path}/invitation`, { token: room.inviteToken });
  assert.equal(invitation.status, 200);
  assert.equal(invitation.body.meeting.participants.length, 1);
  for (const credential of [undefined, room.meeting.id, room.participant.token, room.viewToken]) {
    assert.equal((await f.request(`${room.path}/invitation`, { token: credential })).status, 401);
  }
  for (const credential of [undefined, room.meeting.id, room.inviteToken]) {
    assert.equal((await f.request(room.path, { token: credential })).status, 401);
  }
  const view = await f.request(room.path, { token: room.viewToken });
  assert.equal(view.status, 200);
  assert.equal(view.body.events[0].type, 'started');
  const allReadData = JSON.stringify([view.body, invitation.body]);
  for (const credential of [room.participant.token, room.inviteToken, room.viewToken]) assert.equal(allReadData.includes(credential), false);
  const repeated = await f.create({ requestId: 'create-a' });
  assert.equal(repeated.participant.token, room.participant.token);
  assert.equal(repeated.invitationUrl, room.invitationUrl);
  const conflict = await f.request('/v1/meetings', { method: 'POST', body: { name: 'agent-codex', purpose: 'Changed', requestId: 'create-a', retryToken: f.retryToken('create', 'create-a') } });
  assert.equal(conflict.status, 409);
});

test('multiple agents and humans join idempotently and speak with a shared ordered history', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const b = await f.join(room, { requestId: 'join-b' });
  const bAgain = await f.join(room, { requestId: 'join-b' });
  assert.equal(bAgain.participant.token, b.participant.token);
  const c = await f.join(room, { name: 'Reproduction owner', kind: 'human', requestId: 'join-c' });
  assert.equal(c.meeting.participants.length, 3);
  assert.equal(c.participant.kind, 'human');
  assert.notEqual(c.participant.token, b.participant.token);
  const question = await f.mutate(room, 'messages', room.participant.token, { type: 'request', text: 'Share steps', to: c.participant.id, requestId: 'q1' });
  assert.equal(question.status, 200);
  const answer = await f.mutate(room, 'messages', c.participant.token, { text: 'Open ticket URL, press Save', replyTo: question.body.event.seq, to: room.participant.id, requestId: 'a1' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.event.type, 'message');
  await f.mutate(room, 'messages', b.participant.token, { type: 'result', text: 'Reproduced' });
  const histories = await Promise.all([room.participant.token, b.participant.token, c.participant.token, room.viewToken].map(token => f.request(`${room.path}/events?after=0&waitMs=0`, { token })));
  for (const history of histories) {
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.events.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
    assert.equal(history.body.events[3].data.to, c.participant.id, 'targeted messages remain visible to everyone');
    assert.equal(history.body.events[4].from, c.participant.id, 'own messages are retained too');
    assert.equal(history.body.nextCursor, 6);
  }
});

test('public creation request IDs and meeting metadata never recover host credentials', async t => {
  const f = await fixture(t);
  const retryToken = randomBytes(32).toString('base64url');
  const body = { name: 'Public host name', kind: 'agent', purpose: 'Public goal', context: 'Public context', requestId: 'known-create-id', retryToken };
  const created = await f.request('/v1/meetings', { method: 'POST', body });
  assert.equal(created.status, 201);
  const hostToken = created.body.participant.token;
  const viewToken = new URLSearchParams(new URL(created.body.viewUrl).hash.slice(1)).get('view');
  for (const wrong of [undefined, '', 'guess', randomBytes(32).toString('base64url'), viewToken]) {
    const attack = await f.request('/v1/meetings', { method: 'POST', body: { ...body, retryToken: wrong } });
    assert.ok([400, 401].includes(attack.status));
    assert.equal(JSON.stringify(attack.body).includes(hostToken), false);
    assert.equal(attack.body.participant, undefined);
  }
  const wrongAndChanged = await f.request('/v1/meetings', { method: 'POST', body: { ...body, purpose: 'Changed', retryToken: randomBytes(32).toString('base64url') } });
  assert.equal(wrongAndChanged.status, 401, 'authorize recovery before disclosing fingerprint conflicts');
  assert.equal(wrongAndChanged.body.error.code, 'invalid_retry_token');
  const recovered = await f.request('/v1/meetings', { method: 'POST', body });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.participant.token, hostToken);
  const publicHistory = await f.request(`/v1/meetings/${created.body.meeting.id}`, { token: viewToken });
  assert.equal(JSON.stringify([created.body, recovered.body, publicHistory.body]).includes(retryToken), false);
  const changed = await f.request('/v1/meetings', { method: 'POST', body: { ...body, purpose: 'Changed' } });
  assert.equal(changed.status, 409);
});

test('shared invitation plus known join request ID cannot recover another participant', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const retryToken = randomBytes(32).toString('base64url');
  const body = { token: room.inviteToken, name: 'Public participant name', kind: 'human', requestId: 'known-join-id', retryToken };
  const joined = await f.request(`${room.path}/join`, { method: 'POST', body });
  assert.equal(joined.status, 200);
  for (const wrong of [undefined, 'guess', randomBytes(32).toString('base64url'), room.inviteToken]) {
    const attack = await f.request(`${room.path}/join`, { method: 'POST', body: { ...body, retryToken: wrong } });
    assert.ok([400, 401].includes(attack.status));
    assert.equal(JSON.stringify(attack.body).includes(joined.body.participant.token), false);
    assert.equal(attack.body.participant, undefined);
  }
  const recovered = await f.request(`${room.path}/join`, { method: 'POST', body });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.participant.token, joined.body.participant.token);
  assert.equal(recovered.body.meeting.participants.length, 2, 'failed guesses do not create extra participants');
  const view = await f.request(room.path, { token: room.viewToken });
  assert.equal(JSON.stringify([joined.body, recovered.body, view.body]).includes(retryToken), false);
});

test('private retry tokens are required and validated before creating idempotent credentials', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const nonCanonical = 'A'.repeat(42) + 'B';
  const predictableRequestId = randomBytes(32).toString('base64url');
  for (const retryToken of [undefined, null, 1, 'a'.repeat(42), 'a'.repeat(44), nonCanonical, predictableRequestId]) {
    const created = await f.request('/v1/meetings', { method: 'POST', body: { name: 'Host', purpose: 'Goal', requestId: predictableRequestId, retryToken } });
    assert.equal(created.status, 400);
    const joined = await f.request(`${room.path}/join`, { method: 'POST', body: { token: room.inviteToken, name: 'Guest', requestId: predictableRequestId, retryToken } });
    assert.equal(joined.status, 400);
  }
  assert.equal((await f.request(room.path, { token: room.participant.token })).body.meeting.participants.length, 1);
  assert.equal((await f.join(room)).meeting.participants.length, 2, 'non-idempotent joins remain available without retry credentials');
});

test('read-only views cannot join or mutate and the relay preserves opaque ciphertext', async t => {
  const f = await fixture(t);
  const room = await f.create();
  await f.mutate(room, 'messages', room.participant.token, { text: `Invite ${room.invitationUrl} and credential ${room.participant.token}` });
  for (const operation of ['messages', 'ready', 'leave', 'end']) {
    const response = await f.mutate(room, operation, room.viewToken, { text: 'Mutate', ready: true });
    assert.equal(response.status, 401, operation);
  }
  const join = await f.request(`${room.path}/join`, { method: 'POST', body: { token: room.viewToken, name: 'Intruder' } });
  assert.equal(join.status, 401);
  for (const suffix of ['', '/events?waitMs=0']) {
    const response = await f.rawRequest(`${room.path}${suffix}`, { token: room.viewToken });
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes(room.inviteToken), false);
    assert.equal(serialized.includes(room.participant.token), false);
    assert.match(serialized, /nkenc1/);
  }
  const host = await f.request(room.path, { token: room.participant.token });
  assert.equal(host.body.events[1].data.text.includes(room.invitationUrl), true);
});

test('only host ends; readiness is advisory and invalidated by messages, joins and leaves', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const b = await f.join(room);
  assert.equal((await f.mutate(room, 'end', b.participant.token, { text: 'End now' })).status, 403);
  assert.equal((await f.mutate(room, 'leave')).body.error.code, 'host_must_end');
  for (const token of [room.participant.token, b.participant.token]) await f.mutate(room, 'ready', token, { ready: true });
  let status = await f.request(room.path, { token: room.participant.token });
  assert.equal(status.body.meeting.readyBy.length, 2);
  assert.equal(status.body.meeting.state, 'active', 'everyone ready does not close the meeting');
  await f.mutate(room, 'messages', b.participant.token, { text: 'One more detail' });
  status = await f.request(room.path, { token: room.participant.token });
  assert.deepEqual(status.body.meeting.readyBy, []);
  await f.mutate(room, 'ready', room.participant.token, { ready: true });
  const c = await f.join(room, { name: 'Third' });
  assert.deepEqual(c.meeting.readyBy, []);
  await f.mutate(room, 'ready', room.participant.token, { ready: true });
  const left = await f.mutate(room, 'leave', c.participant.token, { requestId: 'leave-c' });
  assert.deepEqual(left.body.meeting.readyBy, []);
  assert.ok(left.body.meeting.participants.find(p => p.id === c.participant.id).leftAt);
  assert.equal((await f.request(room.path, { token: c.participant.token })).status, 200);
  for (const operation of ['messages', 'ready']) assert.equal((await f.mutate(room, operation, c.participant.token, { text: 'Late', ready: true })).body.error.code, 'participant_left');
  const ended = await f.mutate(room, 'end', room.participant.token, { text: 'Goal reached: reproduction confirmed', reason: 'goal_met', requestId: 'end-1' });
  assert.equal(ended.body.meeting.state, 'ended');
  assert.equal(ended.body.meeting.summary, 'Goal reached: reproduction confirmed');
  assert.equal(ended.body.event.type, 'closed');
  assert.equal(Date.parse(ended.body.meeting.purgeAt) - Date.parse(ended.body.meeting.closedAt), 600_000);
  const replay = await f.mutate(room, 'end', room.participant.token, { text: 'Goal reached: reproduction confirmed', reason: 'goal_met', requestId: 'end-1' });
  assert.equal(replay.body.event.seq, ended.body.event.seq);
  assert.equal((await f.mutate(room, 'messages', room.participant.token, { text: 'Late' })).status, 409);
  assert.equal((await f.request(`${room.path}/join`, { method: 'POST', body: { token: room.inviteToken, name: 'Late' } })).status, 409);
});

test('long polls wake on own messages, other participants, final closure and expiry', async t => {
  const f = await fixture(t, { meetingTtlMs: 350, retentionMs: 2000 });
  const room = await f.create();
  const waiting = f.request(`${room.path}/events?after=1&waitMs=25000`, { token: room.participant.token });
  await delay(15);
  const sent = await f.mutate(room, 'messages', room.participant.token, { text: 'Own event' });
  assert.equal((await waiting).body.events[0].seq, sent.body.event.seq);
  const viewWait = f.request(`${room.path}/events?after=2&waitMs=25000`, { token: room.viewToken });
  const b = await f.join(room);
  assert.equal((await viewWait).body.events[0].type, 'joined');
  const expiryWait = await f.request(`${room.path}/events?after=3&waitMs=25000`, { token: b.participant.token });
  assert.equal(expiryWait.body.meeting.state, 'expired');
  assert.equal(expiryWait.body.events.at(-1).data.reason, 'meeting_timeout');
  assert.equal(expiryWait.body.meeting.closedAt, room.meeting.expiresAt);

  const second = await f.create();
  const closureWait = f.request(`${second.path}/events?after=1&waitMs=25000`, { token: second.viewToken });
  await f.mutate(second, 'end');
  assert.equal((await closureWait).body.meeting.state, 'ended');
});

test('an early expiry timer keeps the poll open until the meeting actually expires', async t => {
  let now = 1000;
  const timers = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const timer = { callback, ms };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const meetings = createMeetings({ getUrl: () => 'http://localhost', meetingTtlMs: 1000 });
  t.after(() => meetings.close());
  async function request(path, body, token) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; };
    res.end = content => { res.body = JSON.parse(content); res.writableEnded = true; };
    await meetings.handle(req, res, new URL(path, 'http://localhost'));
    return res;
  }
  const created = await request('/v1/meetings', await encryptedMeetingFixture().encode('/v1/meetings', { name: 'Host', purpose: 'Expiry boundary' }));
  assert.equal(created.status, 201);
  const room = created.body;
  const waiting = await request(`/v1/meetings/${room.meeting.id}/events?after=1&waitMs=25000`, undefined, room.participant.token);
  assert.equal(timers.length, 1);
  now = 1999;
  timers[0].callback();
  assert.equal(waiting.writableEnded, undefined, 'an early timer must not return an active, empty response');
  assert.equal(timers.length, 2, 'the remaining expiry interval is scheduled again');
  now = 2000;
  timers[1].callback();
  assert.equal(waiting.body.meeting.state, 'expired');
  assert.equal(waiting.body.events.at(-1).data.reason, 'meeting_timeout');
  assert.equal(waiting.body.meeting.closedAt, room.meeting.expiresAt);
});

test('absolute expiry and retention are not extended by polling or messages; purge loses room', async t => {
  const f = await fixture(t, { meetingTtlMs: 200, retentionMs: 150, maxMeetings: 1 });
  const room = await f.create();
  const start = Date.parse(room.meeting.createdAt);
  await delay(90);
  await f.mutate(room, 'messages', room.participant.token, { text: 'Activity does not renew the room' });
  await f.request(`${room.path}/invitation`, { token: room.inviteToken });
  await delay(Math.max(1, start + 230 - Date.now()));
  const expired = await f.request(room.path, { token: room.participant.token });
  assert.equal(expired.body.meeting.state, 'expired');
  assert.equal(expired.body.meeting.expiresAt, room.meeting.expiresAt);
  assert.equal(expired.body.meeting.purgeAt, room.meeting.purgeAt);
  assert.equal((await f.mutate(room, 'messages', room.participant.token, { text: 'Revive' })).status, 409);
  await delay(Math.max(1, start + 380 - Date.now()));
  assert.equal((await f.request(room.path, { token: room.participant.token })).status, 404);
  assert.equal((await f.request(`${room.path}/join`, { method: 'POST', body: { token: room.inviteToken, name: 'Revive' } })).status, 404);
  assert.notEqual((await f.create()).meeting.id, room.meeting.id, 'purging releases the capacity slot');
});

test('server key gates creation but invited participants need only their capabilities', async t => {
  const f = await fixture(t, { serverKey: 'deployment-key' });
  const denied = await f.request('/v1/meetings', { method: 'POST', body: { name: 'Host', purpose: 'Test' } });
  assert.equal(denied.status, 401);
  const room = await f.create({}, { 'X-Noknok-Key': 'deployment-key' });
  assert.equal((await f.join(room)).participant.role, 'participant');
});

test('validates participants, message types, targets, reply references, names and cursors', async t => {
  const f = await fixture(t);
  for (const overrides of [{ name: '' }, { name: 'name\nspoof' }, { name: 'n'.repeat(257) }, { kind: 'bot' }, { kind: null }, { purpose: '' }, { context: 5 }, { requestId: '' }]) {
    const response = await f.request('/v1/meetings', { method: 'POST', body: { name: 'Host', purpose: 'Goal', ...overrides } });
    assert.equal(response.status, 400, JSON.stringify(overrides));
  }
  const room = await f.create();
  const b = await f.join(room);
  for (const body of [{ text: '' }, { text: 'x'.repeat(32769) }, { text: 'x', type: null }, { text: 'x', type: 'closed' }, { text: 'x', replyTo: 1 }, { text: 'x', replyTo: 999 }, { text: 'x', replyTo: '2' }, { text: 'x', to: 'unknown' }]) {
    assert.equal((await f.mutate(room, 'messages', room.participant.token, body)).status, 400, JSON.stringify(body).slice(0, 100));
  }
  await f.mutate(room, 'leave', b.participant.token);
  assert.equal((await f.mutate(room, 'messages', room.participant.token, { text: 'Gone?', to: b.participant.id })).status, 400);
  assert.equal((await f.mutate(room, 'ready', room.participant.token, { ready: 1 })).status, 400);
  for (const query of ['after=999', 'after=-1', 'waitMs=25001', 'after=0&after=1', 'waitMs=NaN']) assert.equal((await f.request(`${room.path}/events?${query}`, { token: room.participant.token })).status, 400, query);
});

test('message retries do not duplicate events and changed retry payloads conflict', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const body = { text: 'Evidence', requestId: 'send-1' };
  const first = await f.mutate(room, 'messages', room.participant.token, body);
  const again = await f.mutate(room, 'messages', room.participant.token, body);
  assert.equal(again.body.event.seq, first.body.event.seq);
  assert.equal((await f.mutate(room, 'messages', room.participant.token, { ...body, text: 'Changed evidence' })).status, 409);
  assert.equal((await f.request(room.path, { token: room.participant.token })).body.events.length, 2);
});

test('concurrent multi-agent replies and join retries remain ordered without duplicate identities', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const joins = await Promise.all(Array.from({ length: 8 }, () => f.join(room, { requestId: 'parallel-join' })));
  assert.equal(new Set(joins.map(join => join.participant.id)).size, 1);
  const b = joins[0];
  const c = await f.join(room, { name: 'Third' });
  const question = await f.mutate(room, 'messages', room.participant.token, { text: 'Inspect in parallel', type: 'request' });
  const replies = await Promise.all([b, c].map((joined, i) => f.mutate(room, 'messages', joined.participant.token, { text: `Evidence ${i}`, replyTo: question.body.event.seq, to: room.participant.id })));
  assert.deepEqual(replies.map(reply => reply.body.event.seq).sort((a, b) => a - b), [5, 6]);
  const history = await f.request(room.path, { token: room.participant.token });
  assert.equal(history.body.meeting.participants.length, 3);
  assert.equal(history.body.nextCursor, 6);
});

test('request body limits, cross-meeting credentials and simultaneous waits are enforced', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const other = await f.create();
  for (const token of [room.participant.token, room.viewToken, room.inviteToken]) assert.equal((await f.request(other.path, { token })).status, 401);
  const oversized = await f.request('/v1/meetings', { method: 'POST', body: { name: 'Host', purpose: 'Test', context: 'x'.repeat(128 * 1024) } });
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(`${f.url}/v1/meetings`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  const invalidJson = await fetch(`${f.url}/v1/meetings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  const waits = Array.from({ length: 4 }, () => f.request(`${room.path}/events?after=1&waitMs=25000`, { token: room.participant.token }));
  await delay(25);
  assert.equal((await f.request(`${room.path}/events?after=1&waitMs=25000`, { token: room.participant.token })).status, 429);
  await f.mutate(room, 'end');
  assert.ok((await Promise.all(waits)).every(response => response.body.meeting.state === 'ended'));
});

test('participant and room limits are bounded and leave does not create an unbounded identity history', async t => {
  const f = await fixture(t, { maxMeetings: 1 });
  const room = await f.create();
  const full = await f.request('/v1/meetings', { method: 'POST', body: { name: 'Other', purpose: 'Other' } });
  assert.equal(full.status, 503);
  for (let i = 1; i < 32; i++) {
    const participant = await f.join(room, { name: `Agent ${i}` });
    if (i === 1) await f.mutate(room, 'leave', participant.participant.token);
  }
  const extra = await f.request(`${room.path}/join`, { method: 'POST', body: { token: room.inviteToken, name: 'One too many' } });
  assert.equal(extra.status, 429);
  assert.equal(extra.body.error.code, 'meeting_full');
});

test('full event history rejects additions while preserving the host ability to close', async t => {
  const f = await fixture(t);
  const room = await f.create();
  for (let i = 0; i < 1998; i++) {
    const response = await f.mutate(room, 'ready', room.participant.token, { ready: i % 2 === 0, requestId: `r-${i}` });
    assert.equal(response.status, 200);
  }
  assert.equal((await f.mutate(room, 'messages', room.participant.token, { text: 'Beyond limit' })).status, 429);
  const ended = await f.mutate(room, 'end', room.participant.token, { text: 'Capacity reached', requestId: 'end-full' });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.nextCursor, 2000);
  assert.equal(ended.body.meeting.state, 'ended');
});

test('shutdown resolves pending waits; process state is not persisted to a new relay', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const waiting = f.request(`${room.path}/events?after=1&waitMs=25000`, { token: room.participant.token });
  await delay(20);
  await f.close();
  assert.equal((await waiting).status, 503);
  const restarted = await fixture(t);
  assert.equal((await restarted.request(room.path, { token: room.participant.token })).status, 404);
});
