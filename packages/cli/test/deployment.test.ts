import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deploymentConfig, startDeployment } from '../src/deploy/server.js';
import { encryptedMeetingFixture } from './e2ee-fixture.js';

const PUBLIC_URL = 'https://relay.example.com';
const SERVER_KEY = 'synthetic-relay-server-key';

async function fixture(t, overrides = {}) {
  const encrypted = encryptedMeetingFixture();
  const env = { NOKNOK_PUBLIC_URL: PUBLIC_URL, NOKNOK_SERVER_KEY: SERVER_KEY, ...overrides };
  const options = { env, port: 0, host: '127.0.0.1' };
  let app = await startDeployment(options);
  t.after(() => app.close());
  return {
    env, options,
    get app() { return app; },
    async restart() { await app.close(); app = await startDeployment(options); },
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const wire = await encrypted.encode(path, body, headers.Authorization?.replace(/^Bearer /, ''));
      const response = await fetch(`${app.origin}${path}`, {
        method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(wire === undefined ? {} : { body: JSON.stringify(wire) }),
      });
      const text = await response.text();
      return { status: response.status, text, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? await encrypted.decode(JSON.parse(text)) : undefined };
    },
    create() { return this.request('/v1/meetings', { method: 'POST', headers: { 'X-Noknok-Key': SERVER_KEY }, body: { name: 'Alpha', purpose: 'Deployment integration test' } }); },
  };
}

test('deployment configuration exposes only encrypted meetings and validates limits', async t => {
  const base = { NOKNOK_PUBLIC_URL: PUBLIC_URL };
  assert.deepEqual(deploymentConfig(base), { port: 8080, publicUrl: PUBLIC_URL, retentionMs: 600000, meetingTtlMs: 7200000, maxMeetings: 50, serverKey: undefined });
  assert.throws(() => deploymentConfig({}), /NOKNOK_PUBLIC_URL/);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_MEETING_TTL_SECONDS: '0' }), /NOKNOK_MEETING_TTL_SECONDS/);
  assert.throws(() => deploymentConfig({ ...base, NOKNOK_MAX_MEETINGS: '0' }), /NOKNOK_MAX_MEETINGS/);
  assert.equal(deploymentConfig({ ...base, PORT: '9000' }).port, 9000);
  assert.throws(() => deploymentConfig({ ...base, PORT: '0' }), /PORT/);
  const f = await fixture(t);
  assert.deepEqual((await f.request('/health')).body, { ok: true, version: 1 });
  for (const path of ['/mcp', '/mcp/invalid', '/v1/gateway', '/v1/contacts', '/v1/calls', '/view']) assert.equal((await f.request(path)).status, 404, path);
  assert.equal((await f.create()).status, 201);
});

test('private deployment serves encrypted meetings with limits and separate read-only capability', async t => {
  const f = await fixture(t, { NOKNOK_MEETING_TTL_SECONDS: '60', NOKNOK_MAX_MEETINGS: '1' });
  const retryToken = randomBytes(32).toString('base64url');
  const created = await f.request('/v1/meetings', { method: 'POST', headers: { 'X-Noknok-Key': SERVER_KEY }, body: { name: 'agent-codex', purpose: 'Private meeting', requestId: 'private-meeting-create', retryToken } });
  assert.equal(created.status, 201);
  const { meeting, participant, invitationUrl, viewUrl } = created.body;
  assert.equal(Date.parse(meeting.expiresAt) - Date.parse(meeting.createdAt), 60000);
  assert.equal(new URL(invitationUrl).origin, PUBLIC_URL);
  assert.equal(new URL(invitationUrl).search, '');
  for (const path of ['/meeting', '/meeting.js', '/meeting-invitation.js', '/e2ee.js']) assert.equal((await f.request(path)).status, 200);
  assert.ok(!created.text.includes('Private meeting'));
  const path = `/v1/meetings/${meeting.id}`;
  assert.equal((await f.request(path)).status, 401);
  const view = new URLSearchParams(new URL(viewUrl).hash.slice(1)).get('view');
  const read = await f.request(path, { headers: { Authorization: `Bearer ${view}` } });
  assert.equal(read.status, 200);
  assert.equal(read.text.includes(participant.token), false);
  assert.equal(JSON.stringify([created.body, read.body]).includes(retryToken), false);
  assert.equal((await f.request(`${path}/end`, { method: 'POST', headers: { Authorization: `Bearer ${view}` }, body: {} })).status, 401);
  assert.equal((await f.request('/v1/meetings', { method: 'POST', headers: { 'X-Noknok-Key': SERVER_KEY }, body: { name: 'Another', purpose: 'Capacity' } })).status, 503);
});

test('deployment carries ciphertext between participants and requires the creation credential', async t => {
  const f = await fixture(t);
  const call = (await f.create()).body;
  assert.equal(new URL(call.invitationUrl).origin, PUBLIC_URL);
  const path = `/v1/meetings/${call.meeting.id}`;
  const inviteToken = new URLSearchParams(new URL(call.invitationUrl).hash.slice(1)).get('invite');
  const joined = await f.request(`${path}/join`, { method: 'POST', body: { token: inviteToken, name: 'Beta', requestId: 'join-test', retryToken: randomBytes(32).toString('base64url') } });
  assert.equal(joined.status, 200);
  const sent = await f.request(`${path}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${call.participant.token}` }, body: { type: 'message', text: 'Encrypted listener works', requestId: 'encrypted-test' } });
  assert.equal(sent.status, 200);
  const received = await f.request(`${path}/events?after=${joined.body.nextCursor}&waitMs=0`, { headers: { Authorization: `Bearer ${joined.body.participant.token}` } });
  assert.equal(received.body.events[0].data.text, 'Encrypted listener works');
  assert.ok(!sent.text.includes('Encrypted listener works'));
  assert.ok(!received.text.includes('Encrypted listener works'));
  assert.equal((await f.request('/v1/meetings', { method: 'POST', body: { name: 'No key', purpose: 'No key' } })).status, 401);
});

test('chunked oversized meeting uploads return 413 and do not stop the listener', async t => {
  const f = await fixture(t);
  const response = await new Promise<{ status?: number; body: string }>((done, reject) => {
    const request = http.request(`${f.app.origin}/v1/meetings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Noknok-Key': SERVER_KEY } }, incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('error', reject);
      incoming.on('end', () => done({ status: incoming.statusCode, body }));
    });
    request.on('error', reject);
    request.write('x'.repeat(256 * 1024));
    setImmediate(() => request.end('y'));
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, 'body_too_large');
  assert.equal((await f.request('/health')).status, 200);
});

test('shutdown drains encrypted meeting long polls and a failed bind cleans up', async t => {
  const f = await fixture(t);
  const call = (await f.create()).body;
  let completed = false;
  const poll = f.request(`/v1/meetings/${call.meeting.id}/events?after=${call.nextCursor}&waitMs=25000`, { headers: { Authorization: `Bearer ${call.participant.token}` } }).then(result => { completed = true; return result; });
  await delay(50);
  assert.equal(completed, false, 'the request must be waiting when shutdown starts');
  await Promise.race([
    Promise.all([f.app.close(), f.app.close(), poll]).then(results => {
      assert.equal(results[2].status, 503);
      assert.equal(results[2].body.error.code, 'relay_closing');
    }),
    delay(2000, undefined, { ref: false }).then(() => { throw new Error('Deployment did not drain promptly.'); }),
  ]);
  await assert.rejects(fetch(`${f.app.origin}/health`));
  await f.restart();
  await assert.rejects(startDeployment({ ...f.options, port: f.app.port }), { code: 'EADDRINUSE' });
  const recovered = await startDeployment(f.options);
  await recovered.close();
  assert.equal((await f.request('/health')).status, 200);
});
