import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { startRelay } from '../src/relay.js';
import { api } from '../src/client.js';
import { decodeMeetingLink, MeetingStore } from '../src/meeting-client.js';
import { main } from '../src/cli.js';

const runFile = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/bin/noknok.js', import.meta.url));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-meeting-cli-'));
  const relay = await startRelay({ port: 0, ...options });
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const env = { ...process.env, NOKNOK_HOME: directory, NOKNOK_SERVER: relay.url };
  delete env.NOKNOK_AGENT;
  delete env.NOKNOK_PRODUCT;
  delete env.NOKNOK_SERVER_KEY;
  const execute = (args, override = {}) => runFile(process.execPath, [cli, ...args], { env: { ...env, ...override }, timeout: 10000 });
  const run = async (args, override) => JSON.parse((await execute(args, override)).stdout);
  const meeting = (action, binding, args = []) => run(['meeting', action, ...(binding?.session ? [binding.session] : []), ...args, ...(binding?.localAgent ? ['--agent', binding.localAgent] : [])]);
  return { directory, relay, env, execute, run, meeting };
}

test('three agents and a human discuss; only host ends; every local transcript survives relay loss', async t => {
  const f = await fixture(t);
  const host = await f.meeting('create', null, ['--purpose', 'Collect reproducible oncall evidence', '--product', 'codex']);
  const peer = await f.meeting('join', null, [host.invitationUrl, '--product', 'dot']);
  const third = await f.meeting('join', null, [host.invitationUrl, '--product', 'doubaowork']);
  assert.equal(host.participant.name, 'agent-codex');
  assert.equal(peer.participant.name, 'agent-dot');
  assert.equal(third.participant.name, 'agent-doubaowork');
  const link = decodeMeetingLink(host.invitationUrl);
  const human = await api(f.relay.url, `/v1/meetings/${link.id}/join`, { method: 'POST', body: { token: link.token, name: 'Reporter', kind: 'human', requestId: randomUUID(), retryToken: randomBytes(32).toString('base64url') } });
  const question = await f.meeting('send', host, ['--text', 'Share reproduction steps', '--to', peer.participant.id, '--type', 'request']);
  await Promise.all([
    f.meeting('send', peer, ['--text', 'Open settings and press Save', '--reply-to', String(question.event.seq)]),
    f.meeting('send', third, ['--text', 'Confirmed on the staging build', '--reply-to', String(question.event.seq)]),
    api(f.relay.url, `/v1/meetings/${link.id}/messages`, { method: 'POST', token: human.participant.token, body: { text: 'The URL is https://example.test/repro', requestId: randomUUID() } }),
  ]);
  for (const member of [host, peer, third]) await f.meeting('ready', member);
  const before = await f.meeting('status', host);
  assert.equal(before.meeting.state, 'active', 'Readiness must not auto-close.');
  assert.equal(before.meeting.readyBy.length, 3);
  await f.meeting('send', peer, ['--text', 'Additional detail: browser reload also reproduces it']);
  assert.deepEqual((await f.meeting('status', host)).meeting.readyBy, []);
  await assert.rejects(f.meeting('end', peer), error => JSON.parse(error.stderr).error.code === 'host_required');
  const ended = await f.meeting('end', host, ['--text', 'Reproduction steps and URL collected']);
  assert.equal(ended.meeting.state, 'ended');
  const final = await f.meeting('status', host);
  for (const member of [peer, third]) await f.meeting('receive', member, ['--timeout', '0']);
  await f.relay.close();
  for (const member of [host, peer, third]) {
    const history = await f.meeting('history', member);
    assert.deepEqual(history.events, final.events);
    assert.equal(new Set(history.events.map(event => event.seq)).size, history.events.length);
    assert.deepEqual(history.events.map(event => event.seq), Array.from({ length: history.events.length }, (_, i) => i + 1));
    assert.equal(history.source, 'local');
    assert.equal(history.meeting.state, 'ended');
    assert.equal(JSON.stringify(history).includes(human.participant.token), false);
    const saved = join(f.directory, 'profiles', member.localAgent, 'meetings', `${member.session}.json`);
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
    assert.ok(JSON.parse(await readFile(saved, 'utf8')).token);
    assert.equal(member.participant.token, undefined);
  }
});

test('fresh same-name agents get independent profiles; explicitly bound retries preserve one participant', async t => {
  const f = await fixture(t);
  const host = await f.meeting('create', null, ['--purpose', 'Inspect identity isolation']);
  const first = await f.meeting('join', null, [host.invitationUrl, '--name', 'agent-codex']);
  const second = await f.meeting('join', null, [host.invitationUrl, '--name', 'agent-codex']);
  assert.notEqual(first.localAgent, second.localAgent);
  assert.notEqual(first.participant.id, second.participant.id);
  const repeated = await f.run(['meeting', 'join', host.invitationUrl, '--name', 'agent-codex', '--agent', first.localAgent]);
  assert.equal(repeated.session, first.session);
  assert.equal(repeated.participant.id, first.participant.id);
  assert.equal(repeated.restored, true);
  const withoutName = await f.run(['meeting', 'join', host.invitationUrl, '--agent', first.localAgent]);
  assert.equal(withoutName.participant.name, 'agent-codex');
  assert.equal(withoutName.session, first.session);
  await assert.rejects(f.run(['meeting', 'join', host.invitationUrl, '--name', 'Someone else', '--agent', first.localAgent]), error => JSON.parse(error.stderr).error.code === 'MEETING_IDENTITY_CONFLICT');
  assert.equal((await f.meeting('status', host)).meeting.participants.length, 3);
});

test('durable join receipt restores credentials after the first local session save is lost', async t => {
  const f = await fixture(t);
  const host = await f.meeting('create', null, ['--purpose', 'Recover join receipt']);
  const peer = await f.meeting('join', null, [host.invitationUrl, '--name', 'Guest']);
  const file = join(f.directory, 'profiles', peer.localAgent, 'meetings', `${peer.session}.json`);
  const original = JSON.parse(await readFile(file, 'utf8'));
  await rm(file);
  const recovered = await f.run(['meeting', 'join', host.invitationUrl, '--name', 'Guest', '--agent', peer.localAgent]);
  assert.equal(recovered.session, peer.session);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, original.token);
  assert.equal((await f.meeting('status', host)).meeting.participants.length, 2);
});

test('a public request ID cannot recover another profile’s host or guest credentials', async t => {
  const f = await fixture(t);
  const hostArgs = ['--purpose', 'Protect participant recovery', '--name', 'Host', '--request-id', 'public-create-id'];
  const host = await f.meeting('create', null, hostArgs);
  const guestArgs = [host.invitationUrl, '--name', 'Guest', '--request-id', 'public-join-id'];
  const guest = await f.meeting('join', null, guestArgs);
  const failures = [];
  for (const [action, args] of [['create', hostArgs], ['join', guestArgs]]) {
    await assert.rejects(f.meeting(action, null, args), error => {
      const failure = JSON.parse(error.stderr).error;
      failures.push(error.stderr);
      return failure.code === 'invalid_retry_token' && failure.localAgent !== host.localAgent && failure.localAgent !== guest.localAgent;
    });
  }
  const recoveredHost = await f.meeting('create', { localAgent: host.localAgent }, hostArgs);
  const recoveredGuest = await f.meeting('join', { localAgent: guest.localAgent }, guestArgs);
  assert.equal(recoveredHost.session, host.session);
  assert.equal(recoveredGuest.session, guest.session);
  const status = await f.meeting('status', host);
  assert.equal(status.meeting.participants.length, 2);
  const output = JSON.stringify([host, guest, recoveredHost, recoveredGuest, status, ...failures]);
  for (const member of [host, guest]) {
    const directory = join(f.directory, 'profiles', member.localAgent, 'meetings');
    const receipts = (await readdir(directory)).filter(file => file.startsWith('.request-') && file.endsWith('.json'));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(await readFile(join(directory, receipts[0]), 'utf8'));
    assert.match(receipt.retryToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(output.includes(receipt.retryToken), false);
    const history = await f.meeting('history', member);
    assert.equal(JSON.stringify(history).includes(receipt.retryToken), false);
    assert.equal((await stat(join(directory, receipts[0]))).mode & 0o777, 0o600);
  }
});

test('an unpublished local receipt without a retry capability is upgraded once before use', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-retry-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MeetingStore(directory);
  const original = await store.receipt('old-unpublished-request', 'Agent', 'request');
  await original.release();
  const file = (await readdir(store.directory)).find(name => name.startsWith('.request-') && name.endsWith('.json'));
  const receipt = JSON.parse(await readFile(join(store.directory, file), 'utf8'));
  delete receipt.retryToken;
  await writeFile(join(store.directory, file), JSON.stringify(receipt), { mode: 0o600 });
  const migrated = await store.receipt('old-unpublished-request', 'Agent', 'request');
  await migrated.release();
  const repeated = await store.receipt('old-unpublished-request', 'Agent', 'request');
  await repeated.release();
  assert.match(migrated.retryToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(repeated.retryToken, migrated.retryToken);
  assert.equal(migrated.session, original.session);
});

test('send during receive archives all events without blocking the sender or skipping unseen messages', async t => {
  const f = await fixture(t);
  const host = await f.meeting('create', null, ['--purpose', 'Concurrent local activity']);
  const peer = await f.meeting('join', null, [host.invitationUrl]);
  await f.meeting('receive', host, ['--timeout', '0']);
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const listener = request => {
    if (request.url.startsWith(`/v1/meetings/${host.meetingId}/events`) && Number(new URL(request.url, f.relay.url).searchParams.get('waitMs')) > 0) signalStarted();
  };
  f.relay.server.on('request', listener);
  const waiting = f.meeting('receive', host, ['--timeout', '3']);
  await started;
  const sent = await f.meeting('send', host, ['--text', 'Question while waiting', '--request-id', 'same-message']);
  const got = await waiting;
  f.relay.server.off('request', listener);
  assert.ok(got.events.some(event => event.seq === sent.event.seq));
  await f.meeting('send', host, ['--text', 'Question while waiting', '--request-id', 'same-message']);
  await f.meeting('send', peer, ['--text', 'Reply']);
  const update = await f.meeting('receive', host, ['--timeout', '0']);
  assert.ok(update.events.some(event => event.data.text === 'Reply'));
  const history = await f.meeting('history', host);
  assert.equal(history.events.filter(event => event.data.text === 'Question while waiting').length, 1);
  assert.equal(new Set(history.events.map(event => event.seq)).size, history.events.length);
});

test('meeting capabilities reject view links as invitations and sessions remain profile-scoped', async t => {
  const f = await fixture(t);
  const host = await f.meeting('create', null, ['--purpose', 'Capability isolation']);
  await assert.rejects(f.meeting('join', null, [host.viewUrl]), error => JSON.parse(error.stderr).error.code === 'INVALID_INVITATION');
  assert.throws(() => decodeMeetingLink(host.invitationUrl.replace('#', '?')), { code: 'INVALID_INVITATION' });
  assert.throws(() => decodeMeetingLink(`${host.invitationUrl}&invite=another`), { code: 'INVALID_INVITATION' });
  const store = new MeetingStore(join(f.directory, 'profiles', host.localAgent));
  assert.equal((await store.list()).length, 1);
  assert.equal((await f.meeting('sessions', { localAgent: host.localAgent })).sessions[0].session, host.session);
});

test('a newer archived send is not marked delivered by an older receive response', async t => {
  const f = await fixture(t);
  const host = await f.meeting('create', null, ['--purpose', 'Exercise reordered responses']);
  const store = new MeetingStore(join(f.directory, 'profiles', host.localAgent));
  const saved = await store.load(host.session);
  const send = text => api(f.relay.url, `/v1/meetings/${host.meetingId}/messages`, { method: 'POST', token: saved.token, body: { text, requestId: randomUUID() } });
  await send('First incoming event');
  await api(f.relay.url, `/v1/meetings/${host.meetingId}/ready`, { method: 'POST', token: saved.token, body: { ready: true, requestId: randomUUID() } });
  const earlierSnapshot = await api(f.relay.url, `/v1/meetings/${host.meetingId}/events?after=0&waitMs=0`, { token: saved.token });
  const later = await send('Must still be delivered');
  await store.archive(host.session, { ...later, events: [later.event] });
  await store.archive(host.session, earlierSnapshot, { delivered: true });
  const local = await store.load(host.session);
  assert.equal(local.archiveCursor, later.event.seq);
  assert.equal(local.readCursor, earlierSnapshot.nextCursor);
  assert.equal(local.revision, later.nextCursor);
  assert.deepEqual(local.meeting.readyBy, [], 'Older snapshots must not restore readiness reset by a later message.');
  const next = await f.meeting('receive', host, ['--timeout', '0']);
  assert.deepEqual(next.events.map(event => event.data.text), ['Must still be delivered']);
});

test('archive failures after acknowledged create/send retain credentials and original retry identifiers', async t => {
  const f = await fixture(t);
  const directory = join(f.directory, 'explicit-owner');
  const originalFetch = globalThis.fetch;
  const failArchive = () => {
    globalThis.fetch = (url, options) => String(url).includes('/events?')
      ? Promise.resolve(Response.json({ error: { code: 'test_archive_failed', message: 'Synthetic archive failure' } }, { status: 503 }))
      : originalFetch(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const run = async args => { let result; await main([...args, '--state-dir', directory], { emit: value => { result = value; } }); return result; };
  failArchive();
  let creationError;
  await assert.rejects(run(['meeting', 'create', '--purpose', 'Recover successful mutations', '--server', f.relay.url]), error => {
    creationError = error;
    return error.code === 'test_archive_failed' && /^am_/.test(error.session) && typeof error.requestId === 'string';
  });
  const store = new MeetingStore(directory);
  const saved = await store.load(creationError.session);
  globalThis.fetch = originalFetch;
  const host = await run(['meeting', 'create', '--purpose', 'Recover successful mutations', '--server', f.relay.url, '--request-id', creationError.requestId]);
  assert.equal(host.session, saved.id);
  assert.equal(host.restored, true);
  failArchive();
  let sendError;
  await assert.rejects(run(['meeting', 'send', host.session, '--text', 'Save once']), error => {
    sendError = error;
    return error.code === 'test_archive_failed' && error.session === host.session && typeof error.requestId === 'string';
  });
  globalThis.fetch = originalFetch;
  await run(['meeting', 'send', host.session, '--text', 'Save once', '--request-id', sendError.requestId]);
  const history = await run(['meeting', 'history', host.session]);
  assert.equal(history.events.filter(event => event.data.text === 'Save once').length, 1);
});
