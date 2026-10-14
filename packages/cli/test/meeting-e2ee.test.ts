import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { startRelay } from '../src/relay.js';
import { MeetingStore } from '../src/meeting-client.js';
import { generateKey } from '../src/e2ee.js';

test('installed clients keep content and keys out of relay traffic; retries preserve authenticated ciphertext', async t => {
  const root = await mkdtemp(join(tmpdir(), 'noknok-e2ee-wire-'));
  const relay = await startRelay({ port: 0 });
  const originalFetch = globalThis.fetch, traffic: string[] = [];
  t.after(async () => { globalThis.fetch = originalFetch; await relay.close(); await rm(root, { recursive: true, force: true }); });
  globalThis.fetch = async (url, init) => {
    traffic.push(String(url), String(init?.body || ''));
    const response = await originalFetch(url, init);
    traffic.push(await response.clone().text());
    return response;
  };
  async function run(profile, ...args) {
    let result;
    await main(['meeting', ...args, '--state-dir', join(root, profile)], { emit: value => { result = value; } });
    return result;
  }
  const host = await run('host', 'create', '--server', relay.url, '--purpose', 'private-goal-5278', '--context', 'private-context-5364', '--request-id', 'create-once');
  const retry = await run('host', 'create', '--server', relay.url, '--purpose', 'private-goal-5278', '--context', 'private-context-5364', '--request-id', 'create-once');
  assert.equal(retry.session, host.session);
  assert.equal(retry.invitationUrl, host.invitationUrl);
  const peer = await run('peer', 'join', host.invitationUrl);
  const sent = await run('host', 'send', host.session, '--text', 'private-message-3638', '--request-id', 'send-once');
  const resent = await run('host', 'send', host.session, '--text', 'private-message-3638', '--request-id', 'send-once');
  assert.equal(resent.event.seq, sent.event.seq);
  const beforeConflict = traffic.length;
  await assert.rejects(run('host', 'send', host.session, '--text', 'changed-message', '--request-id', 'send-once'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(traffic.length, beforeConflict);
  const received = await run('peer', 'receive', peer.session, '--timeout', '0');
  assert.equal(received.events.find(event => event.seq === sent.event.seq).data.text, 'private-message-3638');
  await run('host', 'end', host.session, '--text', 'private-summary-2364', '--reason', 'private-reason-6529');
  const ended = await run('peer', 'receive', peer.session, '--timeout', '0');
  assert.equal(ended.meeting.summary, 'private-summary-2364');
  assert.equal(ended.meeting.reason, 'private-reason-6529');
  const key = new URLSearchParams(new URL(host.invitationUrl).hash.slice(1)).get('key')!;
  const wire = traffic.join('\n');
  for (const secret of [key, 'private-goal-5278', 'private-context-5364', 'private-message-3638', 'private-summary-2364', 'private-reason-6529']) assert.equal(wire.includes(secret), false);
  assert.match(wire, /nkenc1\./);
  assert.equal((await new MeetingStore(join(root, 'host')).load(host.session)).encryptionKey, key);
});

test('bad tags, wrong keys, downgrade and cross-sequence replay never archive or acknowledge unverified content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'noknok-e2ee-integrity-'));
  const relay = await startRelay({ port: 0 }), originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await relay.close(); await rm(root, { recursive: true, force: true }); });
  async function run(profile, ...args) {
    let result;
    await main(['meeting', ...args, '--state-dir', join(root, profile)], { emit: value => { result = value; } });
    return result;
  }
  const host = await run('host', 'create', '--server', relay.url, '--purpose', 'Confidential');
  const peer = await run('peer', 'join', host.invitationUrl);
  const sent = await run('host', 'send', host.session, '--text', 'Authenticate before ACK');
  const store = new MeetingStore(join(root, 'peer'));
  const before = await readFile(store.path(peer.session), 'utf8');
  for (const mode of ['tag', 'plaintext', 'type', 'sender', 'downgrade', 'stripped']) {
    let acknowledgments = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/ack')) acknowledgments++;
      const response = await originalFetch(url, init);
      if (!String(url).includes('/events?')) return response;
      const result = await response.json(), event = result.events.find(item => item.seq === sent.event.seq);
      if (mode === 'tag') { const wire = event.data.text; event.data.text = wire.slice(0, -2) + (wire.at(-2) === 'A' ? 'B' : 'A') + wire.at(-1); }
      if (mode === 'plaintext') event.data.text = 'plaintext downgrade';
      if (mode === 'type') event.type = 'request';
      if (mode === 'sender') event.from = host.meetingId;
      if (mode === 'downgrade') delete result.meeting.encryption;
      if (mode === 'stripped') delete event.data.text;
      return Response.json(result);
    };
    await assert.rejects(run('peer', 'receive', peer.session, '--timeout', '0'), error => error.code?.startsWith('E2EE_'));
    assert.equal(acknowledgments, 0, mode);
    assert.equal(await readFile(store.path(peer.session), 'utf8'), before, mode);
  }
  globalThis.fetch = originalFetch;
  const saved = await store.load(peer.session);
  const response = await originalFetch(`${relay.url}/v1/meetings/${host.meetingId}/events?after=0&waitMs=0`, { headers: { authorization: `Bearer ${saved.token}` } });
  const wireResult = await response.json();
  await run('peer', 'receive', peer.session, '--timeout', '0');
  const replay = wireResult.events.find(event => event.seq === sent.event.seq);
  await assert.rejects(store.archive(peer.session, { ...wireResult, events: [{ ...replay, seq: replay.seq + 1 }] }), { code: 'E2EE_REPLAY' });
  const badLink = new URL(host.invitationUrl), params = new URLSearchParams(badLink.hash.slice(1));
  params.set('key', generateKey()); badLink.hash = params.toString();
  // Send a fresh pending body because previously acknowledged bodies may be gone.
  await run('host', 'send', host.session, '--text', 'Wrong-key receiver');
  let acknowledgments = 0;
  globalThis.fetch = async (url, init) => { if (String(url).endsWith('/ack')) acknowledgments++; return originalFetch(url, init); };
  await assert.rejects(run('wrong-key', 'join', badLink.href), { code: 'E2EE_DECRYPTION_FAILED' });
  assert.equal(acknowledgments, 0);
});
