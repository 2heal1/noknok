import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { startHostedService } from '../src/hosted-service.js';
import { MeetingStore } from '../src/meeting-client.js';
import { generateKey, encryptText, contentAAD } from '../src/e2ee.js';
import { authorizeOAuth } from './oauth-helper.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-oauth-integration-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const deliveries = [];
  const start = () => startHostedService({ dataDir: join(directory, 'service'), port, publicUrl: `http://127.0.0.1:${port}`,
    eventOptions: { workerIntervalMs: 60_000 }, webhookPost: async (url, options) => {
      assert.equal(await options.beforeSend?.(), true);
      const payload = JSON.parse(options.body);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      deliveries.push({ url, headers: options.headers, payload });
      return { status: 200, body: '{}' };
    } });
  let service = await start();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const agent = name => async (...args) => {
    let result;
    await main([...args, '--state-dir', join(directory, name)], { emit: value => { result = value; } });
    return result;
  };
  const state = name => readFile(join(directory, name, 'hosted.json'), 'utf8').then(JSON.parse);
  const rpc = async (token, method, params = {}) => {
    const response = await fetch(`${service.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    return { status: response.status, ...await response.json() };
  };
  const tool = async (token, name) => (await rpc(token, 'tools/call', { name: `noknok_${name}`, arguments: {} })).result;
  const authorize = async (name, scope?) => authorizeOAuth({ baseUrl: service.url, realm: service.url, agentToken: (await state(name)).agentToken, scope });
  const subscription = (agentId, destination) => ({ name: 'noknok.activity', arguments: { recipient_id: agentId }, delivery: { mode: 'webhook', url: `https://receiver.example/${destination}`, secret: `whsec_${randomBytes(32).toString('base64')}` }, ttlMs: 60_000 });
  return { directory, get service() { return service; }, deliveries, agent, state, rpc, tool, authorize, subscription,
    async restart() { await service.close(); service = await start(); } };
}

test('instant CLI and browser invitation meetings work without any OAuth grant', async t => {
  const f = await fixture(t), host = f.agent('host'), guest = f.agent('guest');
  const room = await host('meeting', 'create', '--server', f.service.url, '--purpose', 'Instant meeting without OAuth');
  const joined = await guest('meeting', 'join', room.invitationUrl);
  assert.equal(joined.meeting.purpose, 'Instant meeting without OAuth');
  const page = await fetch(room.invitationUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /meeting/);
  const invitationToken = new URLSearchParams(new URL(room.invitationUrl).hash.slice(1)).get('invite');
  const browserJoin = await fetch(`${f.service.url}/v1/meetings/${room.meetingId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitationToken, name: 'Browser guest', kind: 'human' }) });
  assert.equal(browserJoin.status, 200);
  assert.equal((await browserJoin.json()).participant.kind, 'human');
  await guest('meeting', 'send', joined.session, '--text', 'Reply over the original encrypted meeting transport');
  const received = await host('meeting', 'receive', room.session, '--timeout', '0');
  assert.ok(received.events.some(event => event.data?.text === 'Reply over the original encrypted meeting transport'));
  await host('meeting', 'end', room.session, '--text', 'Instant meeting complete');
  assert.equal((await guest('meeting', 'status', joined.session)).meeting.state, 'ended');
  assert.ok((await host('meeting', 'history', room.session)).events.some(event => event.data?.text === 'Reply over the original encrypted meeting transport'));
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM oauth_grants').get().n, 0);
});

test('OAuth Events reuse existing contacts, isolate chats, and revocation leaves CLI meetings usable', async t => {
  const f = await fixture(t), a = f.agent('caller'), b = f.agent('receiver');
  await a('hosted', 'setup', '--server', f.service.url, '--product', 'codex');
  const identityB = await b('hosted', 'setup', '--server', f.service.url, '--product', 'dot');
  const friend = await a('hosted', 'friend-link'); await b('hosted', 'friend-add', friend.link); await a('hosted', 'friends');
  const before = await f.state('receiver');
  const first = await f.authorize('receiver'), second = await f.authorize('receiver');
  assert.deepEqual(await f.state('receiver'), before, 'OAuth must not replace the CLI identity, contacts or encryption keys.');
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM agents').get().n, 2);
  const token1 = first.tokens.access_token, token2 = second.tokens.access_token;
  const params1 = f.subscription(identityB.agentId, 'chat-one'), params2 = f.subscription(identityB.agentId, 'chat-two');
  const sub1 = await f.rpc(token1, 'events/subscribe', params1), sub2 = await f.rpc(token2, 'events/subscribe', params2);
  assert.ok(sub1.result.id); assert.notEqual(sub1.result.id, sub2.result.id);
  assert.equal((await f.rpc(token1, 'events/subscribe', params1)).result.id, sub1.result.id);
  assert.equal((await f.tool(token1, 'subscription_status')).structuredContent.subscriptions.length, 1);
  assert.equal((await b('hosted', 'subscription-status')).subscriptions.length, 2);

  const called = await a('hosted', 'call', identityB.agentId, '--purpose', 'Private incoming meeting', '--context', 'Private meeting context', '--request-id', 'same-call');
  const repeated = await a('hosted', 'call', identityB.agentId, '--purpose', 'Private incoming meeting', '--context', 'Private meeting context', '--request-id', 'same-call');
  assert.equal(called.meetingId, repeated.meetingId);
  await f.service.events.flush();
  const incoming = f.deliveries.filter(item => item.payload.data.kind === 'incoming_meeting');
  assert.equal(incoming.length, 2, 'Each chat receives one logical event, including on a retried call.');
  assert.equal(incoming[0].payload.eventId, incoming[1].payload.eventId);
  for (const item of incoming) assert.deepEqual(Object.keys(item.payload.data).sort(), ['kind', 'meeting_id', 'recipient_id']);
  const notified = (await f.tool(token1, 'subscription_status')).structuredContent;
  assert.equal(notified.connected, true); assert.equal(notified.subscribed, true);
  assert.equal(notified.deliveries[0].status, 'delivered'); assert.equal(notified.processing, 'not_observed');
  const pending = (await f.tool(token1, 'pending')).structuredContent;
  assert.equal(pending.invitations[0].state, 'awaiting_execution_environment');
  assert.equal(f.service.meetings.inspect(called.meetingId).participants.length, 1, 'A 2xx webhook must not silently join on behalf of an unavailable CLI.');
  const local = await new MeetingStore(join(f.directory, 'caller')).load(called.session);
  const metadata = JSON.stringify({ incoming, pending, notified });
  for (const secret of ['Private incoming meeting', 'Private meeting context', local.encryptionKey, before.agentToken, before.accountToken]) assert.ok(!metadata.includes(secret));

  const grant1 = (await b('hosted', 'grants')).grants.find(item => item.client_id === first.client.client_id);
  await b('hosted', 'revoke', grant1.grant_id);
  assert.equal((await f.rpc(token1, 'events/list')).status, 401);
  assert.equal((await f.tool(token2, 'subscription_status')).structuredContent.subscriptions.length, 1);
  const refresh = await second.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: second.tokens.refresh_token, client_id: second.client.client_id, resource: `${f.service.url}/mcp` }).toString() });
  const renewed = await refresh.json(); assert.equal(refresh.status, 200, JSON.stringify(renewed));
  assert.notEqual(renewed.access_token, token2);
  assert.equal((await f.rpc(renewed.access_token, 'events/subscribe', params2)).result.id, sub2.result.id);

  const inbox = await b('hosted', 'inbox'), accepted = await b('hosted', 'accept', inbox.invitations[0].id);
  assert.equal(accepted.meeting.purpose, 'Private incoming meeting');
  const grant2 = (await b('hosted', 'grants')).grants.find(item => item.client_id === second.client.client_id);
  await b('hosted', 'revoke', grant2.grant_id);
  assert.equal((await b('hosted', 'subscription-status')).subscribed, false);
  const deliveredBeforeRevoke = f.deliveries.length;
  await a('meeting', 'send', called.session, '--text', 'Still talking after notification access was revoked');
  const read = await b('meeting', 'receive', accepted.session, '--timeout', '0');
  assert.ok(read.events.some(event => event.data?.text === 'Still talking after notification access was revoked'));
  await b('meeting', 'send', accepted.session, '--text', 'The original CLI still decrypts and replies');
  assert.ok((await a('meeting', 'receive', called.session, '--timeout', '0')).events.some(event => event.data?.text === 'The original CLI still decrypts and replies'));
  await f.service.events.flush(); assert.equal(f.deliveries.length, deliveredBeforeRevoke);
  assert.deepEqual(await f.state('receiver'), before);
  await a('meeting', 'end', called.session, '--text', 'Meeting ended by its host');
  assert.equal((await b('meeting', 'status', accepted.session)).meeting.state, 'ended');
  assert.ok((await b('meeting', 'history', accepted.session)).events.some(event => event.data?.text === 'Still talking after notification access was revoked'));
});

test('MCP OAuth enforces scopes on direct calls and rejects cross-Agent subscription and CLI routes', async t => {
  const f = await fixture(t), a = f.agent('a'), b = f.agent('b');
  const idA = await a('hosted', 'setup', '--server', f.service.url), idB = await b('hosted', 'setup', '--server', f.service.url);
  for (const method of ['GET', 'POST']) {
    const challenge = await fetch(`${f.service.url}/mcp`, { method });
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get('www-authenticate'), `Bearer resource_metadata="${f.service.url}/.well-known/oauth-protected-resource/mcp"`);
  }
  const full = await f.authorize('a'), token = full.tokens.access_token;
  const tools = (await f.rpc(token, 'tools/list')).result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['noknok_identity', 'noknok_pending', 'noknok_subscription_status']);
  for (const name of ['inbox', 'friend_link', 'friend_add', 'friend_revoke', 'meeting_create', 'meeting_join', 'meeting_send', 'meeting_ack', 'subscription_stop']) {
    const rejected = await f.tool(token, name);
    assert.equal(rejected.isError, true, name); assert.equal(rejected.structuredContent.error.code, 'insufficient_scope', name);
  }
  const cross = await f.rpc(token, 'events/subscribe', f.subscription(idB.agentId, 'foreign-agent'));
  assert.equal(cross.error.code, -32001);
  assert.equal((await f.tool(token, 'identity')).structuredContent.agentId, idA.agentId);
  for (const path of ['/oauth/pairings', '/v1/hosted/agents', '/v1/meetings']) {
    const key = generateKey(), encryptionId = randomUUID();
    const input = path === '/v1/meetings' ? { name: 'Must not create', kind: 'agent', encryption: { v: 1, id: encryptionId },
      purpose: await encryptText(key, 'Must not create', contentAAD(encryptionId, 'started', 'system', 'purpose')),
      context: await encryptText(key, '', contentAAD(encryptionId, 'started', 'system', 'context')) } : {};
    const rejected = await fetch(`${f.service.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
    assert.equal(rejected.status, 401, path);
  }
  const narrow = await f.authorize('a', 'noknok:status:read');
  assert.equal((await f.rpc(narrow.tokens.access_token, 'events/list')).error.code, -32001);
  assert.equal((await f.rpc(narrow.tokens.access_token, 'events/subscribe', f.subscription(idA.agentId, 'scope-denied'))).error.code, -32001);
  assert.equal((await f.tool(narrow.tokens.access_token, 'identity')).isError, false);
});

test('OAuth authorization and per-chat subscriptions survive restart without duplicating identities', async t => {
  const f = await fixture(t), a = f.agent('a');
  const identity = await a('hosted', 'setup', '--server', f.service.url);
  const auth = await f.authorize('a'), params = f.subscription(identity.agentId, 'persistent');
  const before = (await f.rpc(auth.tokens.access_token, 'events/subscribe', params)).result;
  await f.restart();
  assert.equal((await f.tool(auth.tokens.access_token, 'identity')).structuredContent.agentId, identity.agentId);
  assert.equal((await f.rpc(auth.tokens.access_token, 'events/subscribe', params)).result.id, before.id);
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM agents').get().n, 1);
  const grant = (await a('hosted', 'grants')).grants[0]; await a('hosted', 'revoke', grant.grant_id);
  await f.restart();
  assert.equal((await f.rpc(auth.tokens.access_token, 'events/list')).status, 401);
  assert.equal((await a('hosted', 'subscription-status')).subscriptions.length, 0);
  assert.equal((await a('hosted', 'identity')).agentId, identity.agentId);
});
