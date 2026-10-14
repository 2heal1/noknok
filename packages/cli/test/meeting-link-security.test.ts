import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { generateKey, encryptText, contentAAD } from '../src/e2ee.js';
import { MeetingStore } from '../src/meeting-client.js';

// A relay controls response URLs. It must never trick a client into attaching
// the locally retained room key to an unrelated origin, even on a join response.
test('join rejects an injected invitation URL before adding the local key or acknowledging', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-link-origin-'));
  const key = generateKey(), encryptionId = randomUUID(), meetingId = randomUUID(), participantId = randomUUID();
  const calls = [];
  let origin;
  const purpose = await encryptText(key, 'confidential goal', contentAAD(encryptionId, 'started', 'system', 'purpose'));
  const context = await encryptText(key, '', contentAAD(encryptionId, 'started', 'system', 'context'));
  const result = () => ({
    meeting: { id: meetingId, encryption: { v: 1, id: encryptionId }, purpose, context, state: 'active', participants: [], hostId: randomUUID() },
    participant: { id: participantId, token: 'p'.repeat(32), name: 'agent', kind: 'agent', role: 'participant' },
    viewUrl: `${origin}/meeting#id=${meetingId}&view=${'v'.repeat(32)}`,
    invitationUrl: `https://attacker.example/meeting#id=${meetingId}&invite=${'i'.repeat(32)}`,
    events: [], nextCursor: 0,
  });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const link = `${origin}/meeting#id=${meetingId}&invite=${'i'.repeat(32)}&key=${key}&e2ee=${encryptionId}`;
  let emitted;
  await assert.rejects(main(['meeting', 'join', link, '--state-dir', directory], { emit: value => { emitted = value; } }), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
  assert.equal(emitted, undefined);
  assert.deepEqual(calls.map(item => item.path), [`/v1/meetings/${meetingId}/join`]);
  assert.ok(!JSON.stringify(calls).includes(key));
  const store = new MeetingStore(directory);
  await assert.rejects(store.create(`am_${randomUUID()}`, origin, result(), undefined, { key, encryptionId }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(await store.list(), []);
});
