import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentAAD, encryptText, generateKey } from '../src/e2ee.js';
import { decryptMeetingResult } from '../src/meeting-crypto.js';
import { MeetingStore } from '../src/meeting-client.js';

async function fixture() {
  const credentials = { key: generateKey(), encryptionId: randomUUID() };
  const seal = (text, type, from, field, to?, replyTo?) => encryptText(credentials.key, text,
    contentAAD(credentials.encryptionId, type, from, field, to, replyTo));
  const meetingId = randomUUID(), participantId = randomUUID();
  const purpose = await seal('Confidential goal', 'started', 'system', 'purpose');
  const context = await seal('Confidential context', 'started', 'system', 'context');
  const started = { seq: 1, type: 'started', from: 'system', at: '2026-10-14T00:00:00.000Z',
    bodyExpiresAt: '2026-10-14T00:05:00.000Z', bodyState: 'pending', data: { purpose, context } };
  const result = {
    meeting: { id: meetingId, encryption: { v: 1, id: credentials.encryptionId }, hostId: participantId, state: 'active', purpose, context },
    participant: { id: participantId, token: generateKey(), name: 'agent', kind: 'agent', role: 'host' },
    viewUrl: `https://relay.test/meeting#id=${meetingId}&view=${generateKey()}`,
    events: [started], nextCursor: 1, deliveryReceipts: [{ seq: 1, token: 'initial-receipt' }],
  };
  return { credentials, seal, result, participantId };
}

test('meeting decryption rejects missing keys, plaintext content and relay encryption downgrade', async () => {
  const f = await fixture();
  const decoded = await decryptMeetingResult(f.result, f.credentials);
  assert.equal(decoded.meeting.purpose, 'Confidential goal');
  assert.equal(decoded.events[0].data.context, 'Confidential context');
  assert.notEqual(f.result.meeting.purpose, decoded.meeting.purpose, 'Wire response is never mutated.');
  await assert.rejects(decryptMeetingResult(f.result, { key: '', encryptionId: f.credentials.encryptionId }), { code: 'E2EE_KEY_REQUIRED' });
  for (const encryption of [undefined, { v: 0, id: f.credentials.encryptionId }, { v: 1, id: randomUUID() }]) {
    await assert.rejects(decryptMeetingResult({ ...f.result, meeting: { ...f.result.meeting, encryption } }, f.credentials), { code: 'E2EE_DOWNGRADE' });
  }
  await assert.rejects(decryptMeetingResult({ ...f.result, meeting: { ...f.result.meeting, purpose: 'secret in plaintext' } }, f.credentials), { code: 'E2EE_INVALID_CONTENT' });
  for (const field of ['purpose', 'context']) {
    const stripped = structuredClone(f.result);
    delete stripped.events[0].data[field];
    await assert.rejects(decryptMeetingResult(stripped, f.credentials), { code: 'E2EE_INVALID_CONTENT' });
  }
});

test('meeting encrypted messages bind sender, type, recipient and reply target', async () => {
  const f = await fixture();
  const text = await f.seal('Private instructions', 'request', f.participantId, 'text', 'recipient', 1);
  const event = { seq: 2, type: 'request', from: f.participantId, data: { text, to: 'recipient', replyTo: 1 } };
  const result = { ...f.result, events: [event], nextCursor: 2 };
  assert.equal((await decryptMeetingResult(result, f.credentials)).events[0].data.text, 'Private instructions');
  for (const changed of [
    { ...event, type: 'message' }, { ...event, from: 'different-sender' },
    { ...event, data: { ...event.data, to: 'different-recipient' } },
    { ...event, data: { ...event.data, replyTo: 2 } },
  ]) await assert.rejects(decryptMeetingResult({ ...result, events: [changed] }, f.credentials), { code: 'E2EE_DECRYPTION_FAILED' });
  await assert.rejects(decryptMeetingResult({ ...result, events: [{ ...event, data: {} }] }, f.credentials), { code: 'E2EE_INVALID_CONTENT' });
});

test('relay timeout reason is the sole accepted plaintext closure field', async () => {
  const f = await fixture();
  const closed = { seq: 2, type: 'closed', from: 'system', data: { state: 'expired', reason: 'meeting_timeout' } };
  const result = { ...f.result, meeting: { ...f.result.meeting, state: 'expired', reason: 'meeting_timeout' }, events: [closed] };
  assert.equal((await decryptMeetingResult(result, f.credentials)).events[0].data.reason, 'meeting_timeout');
  await assert.rejects(decryptMeetingResult({ ...result, events: [{ ...closed, data: { ...closed.data, text: 'Injected secret summary' } }] }, f.credentials), { code: 'E2EE_INVALID_CONTENT' });
  await assert.rejects(decryptMeetingResult({ ...result, meeting: { ...result.meeting, reason: 'arbitrary plaintext' } }, f.credentials), { code: 'E2EE_INVALID_CONTENT' });
});

test('archive never persists rejected content or receipts, and rejects cross-sequence ciphertext replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-crypto-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(), store = new MeetingStore(directory), id = `am_${randomUUID()}`;
  await store.create(id, 'https://relay.test', f.result, undefined, f.credentials);
  await store.archive(id, f.result);
  const before = await readFile(store.path(id), 'utf8');
  const invalid = { ...f.result, events: [{ ...f.result.events[0], data: { ...f.result.events[0].data, context: 'stripped ciphertext' } }],
    deliveryReceipts: [{ seq: 1, token: 'receipt-must-not-save' }] };
  await assert.rejects(store.archive(id, invalid), { code: 'E2EE_INVALID_CONTENT' });
  assert.equal(await readFile(store.path(id), 'utf8'), before, 'Failed authentication never commits an archive or ACK capability.');
  const replay = { ...f.result, events: [{ ...f.result.events[0], seq: 2 }], nextCursor: 2,
    deliveryReceipts: [{ seq: 2, token: 'replay-receipt' }] };
  await assert.rejects(store.archive(id, replay), { code: 'E2EE_REPLAY' });
  assert.equal(await readFile(store.path(id), 'utf8'), before);
  await store.archive(id, f.result); // A legitimate repeat at the original sequence is safe.
});

test('durable outgoing requests reuse the original ciphertext and reject changed content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-crypto-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(), store = new MeetingStore(directory), id = `am_${randomUUID()}`;
  await store.create(id, 'https://relay.test', f.result, undefined, f.credentials);
  const body = { requestId: randomUUID(), type: 'message', text: 'Retry safely after a lost response' };
  const first = await store.mutation(id, body, undefined);
  assert.notEqual(first.text, body.text);
  assert.deepEqual(await new MeetingStore(directory).mutation(id, body, undefined), first, 'Restart retries preserve the GCM nonce and exact encrypted bytes.');
  await assert.rejects(store.mutation(id, { ...body, text: 'Changed payload' }, undefined), { code: 'IDEMPOTENCY_CONFLICT' });
  const next = await store.mutation(id, { ...body, requestId: randomUUID() }, undefined);
  assert.notEqual(next.text, first.text, 'A new operation always gets fresh encryption.');
});
