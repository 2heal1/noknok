import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startViewer } from '../src/viewer.js';
import { viewerBrandAssets } from '../src/viewer-assets.js';

const A = 'ac_11111111-1111-4111-8111-111111111111';
const B = 'ac_22222222-2222-4222-8222-222222222222';
const C = 'ac_33333333-3333-4333-8333-333333333333';
const D = 'ac_44444444-4444-4444-8444-444444444444';
const TIMES = Array.from({ length: 10 }, (_, index) => `2026-10-10T00:00:0${index}.000Z`);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-viewer-test-'));
  let viewer;
  t.after(async () => { await viewer?.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    async session(id, overrides = {}, history = []) {
      const metadata = { v: 1, id, server: 'http://relay.invalid:4317', callId: 'call-one', role: 'caller', token: 'NEVER-EXPOSE-PARTICIPANT-TOKEN', cursor: 997, createdAt: TIMES[0], purpose: 'Diagnose local startup', ...overrides };
      await writeFile(join(directory, `${id}.json`), JSON.stringify(metadata));
      if (history !== undefined) await writeFile(join(directory, `${id}.ndjson`), typeof history === 'string' ? history : history.map(record => JSON.stringify(record)).join('\n') + '\n');
      return metadata;
    },
    async start(options = {}) { viewer = await startViewer({ port: 0, directory, ...options }); return viewer; },
  };
}
const event = (seq, type, from, data, at = TIMES[seq]) => ({ seq, type, from, at, data });
const recorded = (entry, at = TIMES[0]) => ({ recordedAt: at, ...entry });
const received = item => recorded({ direction: 'received', event: item }, item.at);
test('bundled viewer branding is served through the explicit read-only asset allowlist', async t => {
  const f = await fixture(t);
  const viewer = await f.start();
  for (const [path, [, contentType]] of viewerBrandAssets) {
    const response = await rawRequest(viewer, { path });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], contentType, path);
    assert.match(response.headers['content-security-policy'], /img-src 'self'/);
    assert.equal((await rawRequest(viewer, { path, method: 'POST' })).status, 405);
  }
  assert.equal((await rawRequest(viewer, { path: '/agent-unknown.svg' })).status, 404);
});
const snapshot = (state = 'waiting', at = TIMES[0], extra = {}) => recorded({
  direction: 'session',
  call: { id: 'call-one', state, purpose: 'Snapshot purpose is not authoritative metadata', context: 'Initial diagnostic context', participants: { caller: { name: 'Initial Alice' }, callee: null }, createdAt: TIMES[0], ...extra },
}, at);

async function get(viewer, path = '/api/calls', options = {}) {
  const response = await fetch(`${viewer.url}${path}`, options);
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function rawRequest(viewer, { path = '/api/calls', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(viewer.url, { path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('merges both local participants, deduplicates events and preserves verified call facts', async t => {
  const f = await fixture(t);
  const joined = event(1, 'joined', 'system', { participants: { caller: { name: 'Alice' }, callee: { name: 'Bob' } } });
  const request = event(2, 'request', 'caller', { text: 'Please inspect the deployment.' });
  const result = event(3, 'result', 'callee', { text: 'The old asset is missing.', replyTo: 2 });
  const done = event(4, 'done', 'caller', { text: 'Diagnosis confirmed.' });
  const closed = event(5, 'closed', 'system', { state: 'completed', reason: 'both_participants_finished' });
  await f.session(A, {}, [snapshot(), received(joined), recorded({ direction: 'sent', event: request, callState: 'connected' }, TIMES[2]), received(result), received(done), received(closed)]);
  await f.session(B, { role: 'callee', server: 'http://relay.invalid:4317/', createdAt: TIMES[1] }, [
    snapshot('connected', TIMES[1], { participants: { caller: { name: 'Alice' }, callee: { name: 'Bob' } }, context: 'Initial diagnostic context' }),
    received(joined), received(request), recorded({ direction: 'sent', event: result, callState: 'connected' }, TIMES[3]), received(done),
    recorded({ direction: 'sent', callState: 'completed', action: 'finish' }, TIMES[5]),
  ]);
  const viewer = await f.start();
  const listing = await get(viewer);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.calls.length, 1);
  assert.deepEqual(listing.body.warnings, []);
  const call = listing.body.calls[0];
  assert.match(call.key, /^[a-f0-9]{64}$/);
  assert.equal(call.key, createHash('sha256').update(JSON.stringify(['http://relay.invalid:4317', 'call-one'])).digest('hex'));
  assert.deepEqual(call.participants, { caller: { name: 'Alice' }, callee: { name: 'Bob' } });
  assert.equal(call.purpose, 'Diagnose local startup');
  assert.equal(call.state, 'completed');
  assert.equal(call.createdAt, TIMES[0]);
  assert.equal(call.lastActivityAt, TIMES[5]);
  assert.equal(call.coverage, 'both');
  assert.equal(call.localSessionCount, 2);
  assert.equal(call.messageCount, 3);
  assert.equal(call.eventCount, 5);
  assert.equal(call.preview, 'Diagnosis confirmed.');
  const detail = (await get(viewer, `/api/calls/${call.key}`)).body;
  assert.equal(detail.call.context, 'Initial diagnostic context');
  assert.deepEqual(detail.sessions.map(session => session.id), [A, B]);
  assert.deepEqual(detail.events.map(item => item.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(detail.events[1].observedBy, [A, B]);
  assert.deepEqual(detail.events[2].data, { text: 'The old asset is missing.', replyTo: 2 });
  assert.equal(detail.source.readOnly, true);
});

test('uses both server and call ID for isolation and sorts by latest activity', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [received(event(1, 'message', 'caller', { text: 'First call' }, TIMES[2]))]);
  await f.session(B, { callId: 'call-two' }, [received(event(1, 'message', 'callee', { text: 'Second call' }, TIMES[8]))]);
  await f.session(C, { server: 'https://other-relay.invalid' }, [received(event(1, 'message', 'caller', { text: 'Other server' }, TIMES[5]))]);
  const listing = (await get(await f.start())).body;
  assert.equal(listing.calls.length, 3);
  assert.deepEqual(listing.calls.map(call => call.preview), ['Second call', 'Other server', 'First call']);
  assert.equal(new Set(listing.calls.map(call => call.key)).size, 3);
  assert.ok(listing.calls.every(call => call.eventCount === 1));
});

test('only whitelisted fields reach the API and viewing never writes or changes a cursor', async t => {
  const f = await fixture(t);
  const invitation = 'noknok://invite/aSecretInvitation';
  await f.session(A, { invitation, internalSecret: 'PRIVATE-METADATA' }, [
    snapshot('connected', TIMES[0], { token: 'SNAPSHOT-TOKEN', context: `Context ${invitation}`, participants: { caller: { name: 'Alice', token: 'NAME-TOKEN' }, callee: { name: 'Bob' } } }),
    recorded({ direction: 'sent', requestId: 'PRIVATE-REQUEST-ID', callState: 'connected', token: 'RECORD-TOKEN', event: { ...event(1, 'message', 'caller', { text: 'Public text', token: 'DATA-TOKEN', cursor: 888, invitation }), token: 'EVENT-TOKEN' } }, TIMES[1]),
  ]);
  await writeFile(join(f.directory, '.accept-private.json'), JSON.stringify({ invitation, token: 'ACCEPT-TOKEN' }));
  const before = new Map(await Promise.all((await readdir(f.directory)).map(async name => [name, await readFile(join(f.directory, name), 'utf8')])));
  const viewer = await f.start();
  const listing = (await get(viewer)).body;
  const detail = (await get(viewer, `/api/calls/${listing.calls[0].key}`)).body;
  const serialized = JSON.stringify([listing, detail]);
  for (const secret of ['NEVER-EXPOSE-PARTICIPANT-TOKEN', 'PRIVATE-METADATA', 'PRIVATE-REQUEST-ID', 'SNAPSHOT-TOKEN', 'NAME-TOKEN', 'RECORD-TOKEN', 'DATA-TOKEN', 'EVENT-TOKEN', 'ACCEPT-TOKEN', invitation, 'cursor']) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(detail.sessions[0], { id: A, role: 'caller', createdAt: TIMES[0] });
  assert.equal(detail.call.context, 'Context [redacted invitation]');
  assert.equal((await get(viewer)).body.calls.length, 1);
  const after = new Map(await Promise.all((await readdir(f.directory)).map(async name => [name, await readFile(join(f.directory, name), 'utf8')])));
  assert.deepEqual(after, before);
  assert.equal(JSON.parse(after.get(`${A}.json`)).cursor, 997);
});

test('HTTPS invitation capabilities are removed from all local viewer and export data', async t => {
  const f = await fixture(t);
  const invitation = 'https://relay.example/invite/11111111-1111-4111-8111-111111111111?key=PRIVATE-HTTPS-KEY';
  const reordered = 'http://127.0.0.1:4317/invite/22222222-2222-4222-8222-222222222222?unused=value&key=SECOND-PRIVATE-KEY';
  await f.session(A, { from: invitation, purpose: `Purpose ${invitation}`, invitationUrl: invitation }, [
    snapshot('connected', TIMES[0], { from: invitation, context: `Context ${invitation}`, participants: { caller: { name: invitation }, callee: { name: 'Bob' } } }),
    received(event(1, 'message', 'callee', { text: `See ${reordered}` })),
  ]);
  const viewer = await f.start();
  const listing = (await get(viewer)).body;
  const detail = (await get(viewer, `/api/calls/${listing.calls[0].key}`)).body;
  assert.equal(detail.call.from, '[redacted invitation]');
  assert.equal(detail.call.purpose, 'Purpose [redacted invitation]');
  assert.equal(detail.call.context, 'Context [redacted invitation]');
  assert.equal(detail.call.participants.caller.name, '[redacted invitation]');
  assert.equal(detail.call.preview, 'See [redacted invitation]');
  assert.equal(detail.events[0].data.text, 'See [redacted invitation]');
  for (const secret of ['PRIVATE-HTTPS-KEY', 'SECOND-PRIVATE-KEY', '?key=']) assert.equal(JSON.stringify([listing, detail]).includes(secret), false);
  assert.ok((await readFile(join(f.directory, `${A}.ndjson`), 'utf8')).includes(invitation));
});

test('local viewer hides single-use friend links without modifying local history', async t => {
  const f = await fixture(t);
  const link = `noknok://contact/${Buffer.from(JSON.stringify({ token: 'PRIVATE-FRIEND-CAPABILITY' })).toString('base64url')}`;
  await f.session(A, {}, [received(event(1, 'message', 'callee', { text: `Add ${link}` }))]);
  const viewer = await f.start();
  const listing = (await get(viewer)).body;
  const detail = (await get(viewer, `/api/calls/${listing.calls[0].key}`)).body;
  assert.equal(detail.events[0].data.text, 'Add [redacted contact invitation]');
  assert.equal(JSON.stringify([listing, detail]).includes(link), false);
  assert.ok((await readFile(join(f.directory, `${A}.ndjson`), 'utf8')).includes(link));
});

test('local viewer redacts invitation capabilities after quotes without altering source records', async t => {
  const f = await fixture(t);
  const token = 'PRIVATE-QUOTED-INVITATION-KEY';
  const path = '/invite/11111111-1111-4111-8111-111111111111';
  const invitations = [
    `https://relay'example.test${path}?key=${token}`,
    ...["'preview'", '"preview"', '`preview`', '<preview>'].map(value =>
      `https://relay.example${path}?preview=${value}&key=${token}`),
  ];
  const ordinary = 'https://relay.example/docs?topic=invitation';
  const text = [...invitations, ordinary].join('\n');
  await f.session(A, {}, [
    snapshot('connected', TIMES[0], { context: text }),
    received(event(1, 'message', 'callee', { text })),
  ]);
  const before = await readFile(join(f.directory, `${A}.ndjson`), 'utf8');
  const viewer = await f.start();
  const listing = (await get(viewer)).body;
  const detail = (await get(viewer, `/api/calls/${listing.calls[0].key}`)).body;
  const expected = [...invitations.map(() => '[redacted invitation]'), ordinary].join('\n');
  assert.equal(detail.call.context, expected);
  assert.equal(detail.events[0].data.text, expected);
  assert.equal(JSON.stringify([listing, detail]).includes(token), false);
  assert.equal(await readFile(join(f.directory, `${A}.ndjson`), 'utf8'), before);
});

test('bad session JSON, invalid history lines and a partially written tail do not hide healthy records', async t => {
  const f = await fixture(t);
  const good = received(event(1, 'message', 'callee', { text: 'Preserved evidence' }));
  await f.session(A, {}, `${JSON.stringify(snapshot())}\n{broken}\n${JSON.stringify(good)}\n{"recordedAt":`);
  await writeFile(join(f.directory, `${B}.json`), '{bad session');
  await f.session(C, { callId: 'healthy-other' }, [snapshot(), received(event(1, 'message', 'caller', { text: 'Still available' }))]);
  const viewer = await f.start();
  const listing = (await get(viewer)).body;
  assert.equal(listing.calls.length, 2);
  assert.deepEqual(new Set(listing.warnings.map(warning => warning.code)), new Set(['invalid_history_line', 'partial_history_line', 'invalid_session']));
  const call = listing.calls.find(item => item.callId === 'call-one');
  const detail = (await get(viewer, `/api/calls/${call.key}`)).body;
  assert.equal(detail.events[0].data.text, 'Preserved evidence');
  assert.equal(detail.warnings.length, 2);
});

test('records with no proven state remain unknown and invalid timestamps are never emitted', async t => {
  const f = await fixture(t);
  await f.session(A, { createdAt: 'yesterday' }, [recorded({ direction: 'received', event: event(1, 'message', 'caller', { text: 'No state evidence' }, 'invalid') }, 'also invalid')]);
  const viewer = await f.start();
  const call = (await get(viewer)).body.calls[0];
  assert.equal(call.state, 'unknown');
  assert.equal(call.createdAt, null);
  assert.equal(call.lastActivityAt, null);
  const detail = (await get(viewer, `/api/calls/${call.key}`)).body;
  assert.equal(detail.events[0].at, null);
  assert.equal(detail.call.context, '');
});

test('joined events prove connection and newer nonempty participant names win', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [
    snapshot(),
    received(event(1, 'joined', 'system', { participants: { caller: { name: 'Alice' }, callee: { name: 'Bob' } } })),
    snapshot('connected', TIMES[3], { participants: { caller: { name: '' }, callee: { name: 'Robert' } } }),
  ]);
  const call = (await get(await f.start())).body.calls[0];
  assert.equal(call.state, 'connected');
  assert.deepEqual(call.participants, { caller: { name: 'Alice' }, callee: { name: 'Robert' } });
});

test('local hangup supplies state without duplicating a separately observed system close', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [snapshot(), recorded({ direction: 'sent', action: 'hangup', callState: 'cancelled', reason: 'User stopped.' }, TIMES[3])]);
  const viewer = await f.start();
  let call = (await get(viewer)).body.calls[0];
  assert.equal(call.state, 'cancelled');
  assert.equal(call.eventCount, 0);
  await f.session(B, { role: 'callee' }, [received(event(1, 'closed', 'system', { state: 'cancelled', reason: 'User stopped.' }, TIMES[3]))]);
  call = (await get(viewer)).body.calls[0];
  assert.equal(call.state, 'cancelled');
  assert.equal(call.eventCount, 1);
});

test('conflicting copies of one event produce a warning and remain a single visible event', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [received(event(1, 'message', 'caller', { text: 'First copy' }))]);
  await f.session(B, { role: 'callee' }, [received(event(1, 'message', 'caller', { text: 'Different copy' }))]);
  const viewer = await f.start();
  const call = (await get(viewer)).body.calls[0];
  const detail = (await get(viewer, `/api/calls/${call.key}`)).body;
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].data.text, 'First copy');
  assert.deepEqual(detail.events[0].observedBy, [A, B]);
  assert.equal(detail.warnings[0].code, 'event_conflict');
});

test('symbolic links are not followed for session files, histories or the state directory', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [received(event(1, 'message', 'caller', { text: 'Allowed file' }))]);
  await symlink(join(f.directory, `${A}.json`), join(f.directory, `${B}.json`));
  await f.session(C, { callId: 'no-follow-history' });
  await rm(join(f.directory, `${C}.ndjson`));
  await symlink(join(f.directory, `${A}.ndjson`), join(f.directory, `${C}.ndjson`));
  const viewer = await f.start();
  const result = (await get(viewer)).body;
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls.find(call => call.callId === 'no-follow-history').eventCount, 0);
  assert.equal(result.warnings.filter(warning => warning.code === 'unsafe_file').length, 2);
  const link = `${f.directory}-link`;
  await symlink(f.directory, link);
  t.after(() => rm(link));
  const other = await startViewer({ port: 0, directory: link });
  t.after(() => other.close());
  const blocked = (await get(other)).body;
  assert.deepEqual(blocked.calls, []);
  assert.equal(blocked.warnings[0].code, 'unsafe_directory');
});

test('host, origin and method checks protect the local API and HEAD returns no data', async t => {
  const f = await fixture(t);
  await f.session(A);
  const viewer = await f.start();
  const port = viewer.server.address().port;
  for (const host of ['attacker.invalid', `attacker.invalid:${port}`, `127.0.0.1:${port + 1}`]) assert.equal((await rawRequest(viewer, { headers: { Host: host } })).status, 403);
  for (const origin of ['null', 'https://attacker.invalid', `http://127.0.0.1:${port + 1}`]) assert.equal((await rawRequest(viewer, { headers: { Origin: origin } })).status, 403);
  const allowed = await rawRequest(viewer, { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], undefined);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
  assert.match(allowed.headers['content-security-policy'], /default-src 'none'/);
  assert.match(allowed.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await rawRequest(viewer, { method: 'POST' })).status, 405);
  assert.equal((await rawRequest(viewer, { method: 'DELETE' })).status, 405);
  const head = await rawRequest(viewer, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(Number(head.headers['content-length']) > 0);
});

test('static routing is a fixed whitelist and does not expose arbitrary files', async t => {
  const f = await fixture(t);
  const viewer = await f.start();
  for (const path of ['/../src/viewer.js', '/%2e%2e/src/viewer.js', '/src/viewer.js', '/api/calls/../../package.json', '/package.json', '/.noknok', '/app.js/../src/store.js']) {
    assert.equal((await rawRequest(viewer, { path })).status, 404, path);
  }
  assert.equal((await get(viewer, `/api/calls/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await get(viewer, '/health')).body.readOnly, true);
  for (const path of ['/', '/index.html', '/app.js', '/styles.css']) {
    const response = await rawRequest(viewer, { path });
    // The UI is independently authored; absent assets must fail closed.
    assert.ok([200, 404].includes(response.status));
    if (response.status === 200) {
      assert.match(response.headers['content-security-policy'], /script-src 'self'/);
      assert.match(response.headers['content-security-policy'], /style-src 'self'/);
    }
  }
});

test('a missing directory yields an empty state and is never created', async t => {
  const f = await fixture(t);
  const directory = join(f.directory, 'does-not-exist');
  const viewer = await f.start({ directory });
  const result = (await get(viewer)).body;
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.source, { directory, readOnly: true });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await viewer.close();
  await viewer.close();
});

test('oversized files are skipped with warnings and another call remains available', async t => {
  const f = await fixture(t);
  await f.session(A, {}, 'x'.repeat(16 * 1024 * 1024 + 1));
  await f.session(B, { callId: 'healthy' }, [received(event(1, 'message', 'caller', { text: 'Healthy' }))]);
  await writeFile(join(f.directory, `${C}.json`), 'x'.repeat(128 * 1024 + 1));
  await f.session(D, { server: 'http://secret:password@relay.invalid' });
  const result = (await get(await f.start())).body;
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls.find(call => call.callId === 'healthy').eventCount, 1);
  assert.equal(result.warnings.filter(warning => warning.code === 'read_limit').length, 2);
  assert.ok(result.warnings.some(warning => warning.code === 'invalid_session'));
  assert.equal(JSON.stringify(result).includes('password'), false);
});

test('bind failures reject startup instead of leaving a pending server', async t => {
  const f = await fixture(t);
  const viewer = await f.start();
  assert.equal(viewer.server.address().address, '127.0.0.1');
  await assert.rejects(startViewer({ port: viewer.server.address().port, directory: f.directory }), { code: 'EADDRINUSE' });
});

test('clock skew and late stale snapshots cannot regress connected or completed states', async t => {
  const f = await fixture(t);
  const fastLocalClock = '2026-10-10T00:01:00.000Z';
  const evenLaterLocalClock = '2026-10-10T00:02:00.000Z';
  const joined = event(1, 'joined', 'system', { participants: { caller: { name: 'Alice' }, callee: { name: 'Bob' } } });
  await f.session(A, {}, [snapshot('waiting', fastLocalClock), received(joined)]);
  const viewer = await f.start();
  assert.equal((await get(viewer)).body.calls[0].state, 'connected');
  await f.session(A, {}, [snapshot('waiting', fastLocalClock), received(joined), received(event(2, 'closed', 'system', { state: 'completed' }, TIMES[5]))]);
  await f.session(B, { role: 'callee' }, [snapshot('connected', evenLaterLocalClock)]);
  assert.equal((await get(viewer)).body.calls[0].state, 'completed');
});

test('conflicting terminal evidence follows relay sequence before wall-clock time', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [received(event(8, 'closed', 'system', { state: 'completed' }, TIMES[3]))]);
  await f.session(B, { role: 'callee' }, [
    snapshot('cancelled', '2026-10-10T00:01:00.000Z'),
    received(event(5, 'closed', 'system', { state: 'cancelled' }, TIMES[9])),
  ]);
  assert.equal((await get(await f.start())).body.calls[0].state, 'completed');
});

test('conflicting copies do not alter the state established by the displayed event', async t => {
  const f = await fixture(t);
  await f.session(A, {}, [received(event(2, 'closed', 'system', { state: 'completed' }))]);
  await f.session(B, { role: 'callee' }, [received(event(2, 'closed', 'system', { state: 'cancelled' }))]);
  const viewer = await f.start();
  const listing = (await get(viewer)).body;
  assert.equal(listing.calls[0].state, 'completed');
  assert.equal(listing.warnings[0].code, 'event_conflict');
});

test('large numbers of empty history lines are bounded without hiding session metadata', async t => {
  const f = await fixture(t);
  await f.session(A, {}, '\n'.repeat(100_010));
  const listing = (await get(await f.start())).body;
  assert.equal(listing.calls.length, 1);
  assert.equal(listing.calls[0].eventCount, 0);
  assert.equal(listing.warnings[0].code, 'history_line_limit');
});
