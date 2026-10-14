import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startHostedService } from '../src/hosted-service.mjs';
import { hostedDeploymentConfig } from '../deploy/hosted-server.mjs';

const secret = () => randomBytes(32).toString('base64url');
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'noknok-service-'));
  const delivered = [];
  const start = () => startHostedService({ dataDir, publicUrl: 'http://127.0.0.1:4317', port: 0,
    eventOptions: { workerIntervalMs: 60_000, retryBaseMs: 1 },
    webhookPost: async (url, request) => {
      if (request.beforeSend && !await request.beforeSend()) throw new Error('cancelled');
      const payload = JSON.parse(request.body);
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      delivered.push({ url, ...payload }); return { status: 200, body: '{}' };
    }, ...options });
  let service = await start();
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function raw(path, { token, method = 'POST', value } = {}) {
    const response = await fetch(service.origin + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
    const body = await response.json(); return { status: response.status, body };
  }
  async function register() {
    const { code } = service.store.mintCode();
    const redeemed = await raw('/v1/hosted/redeem', { value: { code, requestId: secret() } });
    assert.equal(redeemed.status, 200);
    const registered = await raw('/v1/hosted/agents', { token: redeemed.body.accountToken, value: { requestId: secret() } });
    assert.equal(registered.status, 200);
    return { ...registered.body, ...redeemed.body };
  }
  async function rpc(actor, method, params = {}) {
    const result = await raw('/mcp', { token: actor.agentToken, value: { jsonrpc: '2.0', id: randomUUID(), method, params } });
    if (result.status !== 200) throw Object.assign(new Error(result.body.error.message), result.body.error);
    if (result.body.error) throw Object.assign(new Error(result.body.error.message), result.body.error);
    return result.body.result;
  }
  async function tool(actor, name, args = {}) {
    const result = await rpc(actor, 'tools/call', { name: `noknok_${name}`, arguments: args });
    if (result.isError) throw Object.assign(new Error(result.structuredContent.error.message), result.structuredContent.error);
    return result.structuredContent;
  }
  async function pair(a, b) {
    const offer = await tool(b, 'friend_link');
    const accepted = await tool(a, 'friend_add', { link: offer.link });
    const claimed = await tool(b, 'friend_claim', { offer: offer.offer });
    assert.equal(claimed.accepted, true);
    return { ...accepted, claimed, offer };
  }
  async function subscribe(actor) {
    return rpc(actor, 'events/subscribe', { name: 'agentcall.activity', arguments: { recipient_id: actor.agentId }, delivery: {
      mode: 'webhook', url: `https://receiver.example.com/${actor.agentId}`, secret: `whsec_${randomBytes(32).toString('base64')}` }, cursor: null });
  }
  return { get service() { return service; }, dataDir, delivered, raw, register, rpc, tool, pair, subscribe,
    async restart() { await service.close(); service = await start(); } };
}

test('hosted service gates all creation and disables legacy registration/proxy routes', async t => {
  const f = await fixture(t);
  assert.equal((await f.raw('/v1/meetings', { value: { name: 'anonymous', purpose: 'bypass' } })).status, 401);
  for (const path of ['/v1/calls', '/v1/contacts/register', '/v1/gateway', '/proxy', '/mcp/invalid']) {
    const result = await f.raw(path, { value: { op: 'register' } });
    assert.ok([401, 404].includes(result.status), path);
  }
  assert.equal((await f.raw('/v1/hosted/redeem', { value: { code: 'invalid', requestId: secret() } })).status, 403);
  const a = await f.register();
  const discovery = await f.rpc(a, 'server/discover');
  assert.deepEqual(discovery.supportedVersions, ['2026-07-28']);
  assert.ok(discovery.capabilities.events);
  const tools = await f.rpc(a, 'tools/list');
  assert.ok(tools.tools.some(tool => tool.name === 'noknok_meeting_create'));
  assert.ok(!tools.tools.some(tool => /shell|proxy|fetch_url/.test(tool.name)));
  const endpoint = await f.raw(`/mcp/${a.agentToken}`, { value: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.deepEqual(endpoint.body.result, {});
});

test('friend meeting uses authenticated recipient, delivers minimal event and supports agents plus a human', async t => {
  const f = await fixture(t);
  const a = await f.register(), b = await f.register(), c = await f.register();
  const friend = await f.pair(a, b);
  assert.equal((await f.tool(b, 'subscription_status')).subscribed, false);
  await f.subscribe(b);
  await assert.rejects(f.rpc(c, 'events/subscribe', { name: 'agentcall.activity', arguments: { recipient_id: b.agentId }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/stolen', secret: `whsec_${randomBytes(32).toString('base64')}` } }), /authenticated receiver/);
  const args = { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Collect reproduction evidence', context: 'private-context-marker', name: 'agent-dot', request_id: 'first-meeting' };
  await assert.rejects(f.tool(c, 'call', args), error => error.code === 'FORBIDDEN');
  const call = await f.tool(a, 'call', args);
  const repeated = await f.tool(a, 'call', args);
  assert.equal(repeated.meeting.id, call.meeting.id);
  assert.equal(repeated.invitationId, call.invitationId);
  await f.service.events.flush();
  const notification = f.delivered.find(event => event.data.meeting_id === call.meeting.id);
  assert.ok(notification);
  assert.equal(notification.data.recipient_id, b.agentId);
  assert.ok(!JSON.stringify(notification).includes('private-context-marker'));
  assert.ok(!JSON.stringify(notification).includes(friend.contact.capability));
  assert.equal((await f.tool(c, 'inbox')).invitations.length, 0);
  await assert.rejects(f.tool(c, 'meeting_join', { invitation_id: call.invitationId }), /No invitation/);
  await assert.rejects(f.tool(c, 'meeting_read', { meeting_id: call.meeting.id }), /Join this meeting/);
  const inbox = await f.tool(b, 'inbox');
  assert.equal(inbox.invitations[0].status, 'delivered');
  assert.ok(!JSON.stringify(inbox).includes('invite='));
  const joined = await f.tool(b, 'meeting_join', { invitation_id: call.invitationId, name: 'agent-doubaowork' });
  assert.equal(joined.meeting.id, call.meeting.id);
  const inviteToken = new URLSearchParams(new URL(call.invitationUrl).hash.slice(1)).get('invite');
  const human = await f.raw(`/v1/meetings/${call.meeting.id}/join`, { value: { token: inviteToken, name: 'Reporter', kind: 'human' } });
  assert.equal(human.status, 200);
  const sent = await f.tool(b, 'meeting_send', { meeting_id: call.meeting.id, text: 'Steps: open preview and select retry.', request_id: 'reply-1' });
  const resent = await f.tool(b, 'meeting_send', { meeting_id: call.meeting.id, text: 'Steps: open preview and select retry.', request_id: 'reply-1' });
  assert.equal(sent.event.seq, resent.event.seq);
  const humanSent = await f.raw(`/v1/meetings/${call.meeting.id}/messages`, { token: human.body.participant.token, value: { text: 'Only fails after clearing cache.' } });
  assert.equal(humanSent.status, 200);
  const read = await f.tool(a, 'meeting_read', { meeting_id: call.meeting.id });
  assert.equal(read.meeting.participants.filter(item => item.kind === 'human').length, 1);
  assert.equal(read.events.filter(item => item.data.text === 'Steps: open preview and select retry.').length, 1);
  await assert.rejects(f.tool(b, 'meeting_end', { meeting_id: call.meeting.id, request_id: 'not-host' }), /Only the meeting host/);
  await f.tool(a, 'meeting_end', { meeting_id: call.meeting.id, text: 'Evidence complete.', request_id: 'end' });
  assert.equal((await f.tool(a, 'meeting_read', { meeting_id: call.meeting.id })).meeting.state, 'ended');
  for (const file of await readdir(f.dataDir)) assert.ok(!(await readFile(join(f.dataDir, file))).includes(Buffer.from('private-context-marker')));
});

test('unavailable subscription preserves same meeting fallback and revocation cancels pending notification', async t => {
  const f = await fixture(t);
  const a = await f.register(), b = await f.register();
  const friend = await f.pair(a, b);
  const call = await f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Fallback', request_id: 'fallback' });
  assert.equal(call.notification.status, 'unavailable');
  assert.ok(call.invitationUrl.includes(call.meeting.id));
  await f.subscribe(b);
  const next = await f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Queued', request_id: 'queued' });
  await f.tool(b, 'friend_revoke', { capability: friend.claimed.issuedCapability });
  await f.service.events.flush();
  assert.ok(!f.delivered.some(event => event.data.meeting_id === next.meeting.id));
  await assert.rejects(f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Denied', request_id: 'denied' }), error => error.code === 'CAPABILITY_REVOKED');
  await assert.rejects(f.tool(b, 'meeting_join', { invitation_id: next.invitationId }), /no longer valid/);
  f.service.store.revokeAgent(b.agentId);
  const inbox = await f.tool(a, 'inbox');
  assert.equal(inbox.outgoing[0].status, 'revoked');
});

test('control state survives restart while transcripts and targeted invitations do not', async t => {
  const f = await fixture(t);
  const a = await f.register(), b = await f.register();
  const friend = await f.pair(a, b);
  await f.subscribe(b);
  const call = await f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Before restart', request_id: 'before' });
  await f.restart();
  assert.equal((await f.tool(b, 'subscription_status')).subscribed, true);
  assert.equal((await f.tool(b, 'inbox')).invitations.length, 0);
  await assert.rejects(f.tool(a, 'meeting_read', { meeting_id: call.meeting.id }), /Join this meeting/);
  const claimed = await f.tool(b, 'friend_claim', { offer: friend.offer.offer });
  assert.equal(claimed.contact.capability, friend.claimed.contact.capability);
  const next = await f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'After restart', request_id: 'after' });
  assert.notEqual(next.meeting.id, call.meeting.id);
  await f.service.events.flush();
  assert.ok(f.delivered.some(event => event.data.meeting_id === next.meeting.id));
});

test('owner and global budgets apply to MCP and direct REST; purge removes cached meeting results', async t => {
  const f = await fixture(t, { maxMeetings: 2, maxOwnerMeetings: 1, maxParticipants: 2, retentionMs: 30, meetingTtlMs: 2000 });
  const a = await f.register(), b = await f.register();
  const args = { purpose: 'Quota', request_id: 'one' };
  const room = await f.tool(a, 'meeting_create', args);
  await assert.rejects(f.tool(a, 'meeting_create', { ...args, request_id: 'two' }), error => error.code === 'owner_meeting_limit');
  const raw = await f.raw('/v1/meetings', { token: a.agentToken, value: { name: 'bypass', purpose: 'Quota bypass' } });
  assert.equal(raw.status, 429);
  await f.tool(b, 'meeting_create', { purpose: 'Other account', request_id: 'two' });
  await assert.rejects(f.tool(b, 'meeting_create', { purpose: 'Full', request_id: 'three' }), error => error.code === 'relay_capacity_exceeded');
  await f.tool(b, 'meeting_join', { link: room.invitationUrl });
  const token = new URLSearchParams(new URL(room.invitationUrl).hash.slice(1)).get('invite');
  assert.equal((await f.raw(`/v1/meetings/${room.meeting.id}/join`, { value: { name: 'Human', kind: 'human', token } })).status, 429);
  await f.tool(a, 'meeting_end', { meeting_id: room.meeting.id, request_id: 'end' });
  await delay(50);
  assert.equal((await f.raw(`/v1/meetings/${room.meeting.id}`, { method: 'GET', token: room.participant.token })).status, 404);
  const replacement = await f.tool(a, 'meeting_create', args);
  assert.notEqual(replacement.meeting.id, room.meeting.id);
});

test('low-resource deployment defaults are bounded and reject unsafe environment values', () => {
  const config = hostedDeploymentConfig({});
  assert.equal(config.maxMeetings, 5); assert.equal(config.maxParticipants, 8);
  assert.equal(config.maxTotalBytes, 8 * 1024 * 1024);
  assert.equal(config.deliveryTtlMs, 300_000);
  assert.equal(hostedDeploymentConfig({ NOKNOK_DELIVERY_TTL_SECONDS: '60' }).deliveryTtlMs, 60_000);
  assert.throws(() => hostedDeploymentConfig({ NOKNOK_DELIVERY_TTL_SECONDS: '0' }));
  assert.throws(() => hostedDeploymentConfig({ NOKNOK_DELIVERY_TTL_SECONDS: '3601' }));
  assert.throws(() => hostedDeploymentConfig({ NOKNOK_MAX_MEETINGS: '999999' }));
  assert.throws(() => hostedDeploymentConfig({ NOKNOK_MAX_TOTAL_BYTES: '-1' }));
});

test('notification budget failure preserves accepted friendship and a usable meeting fallback', async t => {
  const f = await fixture(t, { eventOptions: { workerIntervalMs: 60_000, dailyNotificationLimit: 1 } });
  const a = await f.register(), b = await f.register();
  await f.subscribe(b);
  const friend = await f.pair(a, b); // friend_added consumes this account's first notification.
  const call = await f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Budget fallback', request_id: 'quota' });
  assert.equal(call.notification.status, 'unavailable');
  assert.equal(call.notification.reason, 'notification_quota');
  assert.ok(call.invitationUrl);
  assert.equal((await f.tool(a, 'meeting_read', { meeting_id: call.meeting.id })).meeting.state, 'active');
  const status = await f.tool(b, 'subscription_status');
  assert.equal(status.subscribed, true);
  assert.ok(status.recentNotificationFailures.some(item => item.eventId === call.notification.eventId));
  const offer = await f.tool(b, 'friend_link');
  const another = await f.tool(a, 'friend_add', { link: offer.link });
  assert.equal(another.notification.status, 'unavailable');
  assert.ok(another.contact.capability);
});

test('join and readiness wake the host and old delivery history becomes unknown, never queued forever', async t => {
  let now = Date.now();
  const f = await fixture(t, { eventOptions: { workerIntervalMs: 60_000, eventTtlMs: 100, now: () => now } });
  const a = await f.register(), b = await f.register();
  const friend = await f.pair(a, b); await f.subscribe(a); await f.subscribe(b);
  const call = await f.tool(a, 'call', { peer_id: b.agentId, capability: friend.contact.capability, purpose: 'Readiness', request_id: 'ready' });
  await f.service.events.flush(); now += 101;
  assert.equal((await f.tool(a, 'inbox')).outgoing[0].notification.status, 'unknown');
  await f.tool(b, 'meeting_join', { invitation_id: call.invitationId });
  await f.service.events.flush();
  const afterJoin = f.delivered.filter(item => item.data.recipient_id === a.agentId).length;
  assert.ok(afterJoin > 0);
  await f.tool(b, 'meeting_ready', { meeting_id: call.meeting.id, ready: true, request_id: 'ready-1' });
  await f.service.events.flush();
  assert.ok(f.delivered.filter(item => item.data.recipient_id === a.agentId).length > afterJoin);
});

test('participant revocation is rechecked after slow request bodies and before long-poll delivery', async t => {
  const f = await fixture(t);
  const a = await f.register(), b = await f.register();
  const room = await f.tool(a, 'meeting_create', { purpose: 'Revocation race', request_id: 'revoke' });
  const joined = await f.tool(b, 'meeting_join', { link: room.invitationUrl });
  const path = `/v1/meetings/${room.meeting.id}/messages`;
  let received;
  const receiving = new Promise(resolve => { received = resolve; });
  const listen = req => { if (req.url === path) received(); };
  f.service.server.on('request', listen);
  let writer;
  const sent = new Promise((resolve, reject) => {
    writer = http.request(f.service.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${joined.participant.token}`, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    writer.on('error', reject); writer.write('{"text":');
  });
  await receiving;
  f.service.store.revokeAgent(b.agentId); writer.end('"must not enter transcript"}');
  assert.equal((await sent).status, 403); f.service.server.off('request', listen);
  const c = await f.register(), cJoin = await f.tool(c, 'meeting_join', { link: room.invitationUrl });
  const snapshot = await f.tool(c, 'meeting_read', { meeting_id: room.meeting.id });
  const waitPath = `/v1/meetings/${room.meeting.id}/events?after=${snapshot.nextCursor}&waitMs=2000`;
  let arrived; const waiting = new Promise(resolve => { arrived = resolve; });
  const listener = req => { if (req.url === waitPath) arrived(); }; f.service.server.on('request', listener);
  const poll = f.raw(waitPath, { method: 'GET', token: cJoin.participant.token });
  await waiting; f.service.store.revokeAgent(c.agentId);
  await f.tool(a, 'meeting_send', { meeting_id: room.meeting.id, text: 'Do not deliver to revoked participant.', request_id: 'after-revoke' });
  assert.equal((await poll).status, 403); f.service.server.off('request', listener);
  assert.ok(!(await f.tool(a, 'meeting_read', { meeting_id: room.meeting.id })).events.some(item => item.data.text === 'must not enter transcript'));
});

test('response byte budgets apply to guest reads and survive service restarts', async t => {
  const f = await fixture(t, { maxDailyEgressBytes: 100_000, maxAccountDailyEgressBytes: 5000 });
  const a = await f.register();
  const room = await f.tool(a, 'meeting_create', { purpose: 'Egress limits', request_id: 'egress' });
  const view = new URLSearchParams(new URL(room.viewUrl).hash.slice(1)).get('view');
  let result;
  for (let i = 0; i < 10; i++) {
    result = await f.raw(`/v1/meetings/${room.meeting.id}`, { method: 'GET', token: view });
    if (result.status !== 200) break;
  }
  assert.equal(result.status, 429);
  f.service.store.consumeServiceQuota('egress_bytes', { limit: 100_000, windowMs: 86_400_000, amount: 90_000 });
  await f.restart();
  // Repeated responses exhaust the same persisted global bucket after restart.
  for (let i = 0; i < 200; i++) { result = await f.raw('/health', { method: 'GET' }); if (result.status !== 200) break; }
  assert.equal(result.status, 429); assert.equal(result.body.error.code, 'service_egress_limit');
});

test('native agents explicitly acknowledge saved bodies; hosted retry caches cannot resurrect them', async t => {
  const f = await fixture(t);
  const a = await f.register(), b = await f.register();
  const friend = await f.pair(a, b);
  const args = { peer_id: b.agentId, capability: friend.contact.capability,
    purpose: 'private-purpose-to-delete', context: 'private-context-to-delete', request_id: 'pending-call' };
  const call = await f.tool(a, 'call', args);
  const meeting_id = call.meeting.id;
  const sendArgs = { meeting_id, text: 'private-message-to-delete', request_id: 'pending-message' };
  await f.tool(a, 'meeting_send', sendArgs);
  const aRead = await f.tool(a, 'meeting_read', { meeting_id });
  assert.ok(aRead.deliveryReceipts.length >= 2);
  await f.tool(a, 'meeting_ack', { meeting_id, receipts: aRead.deliveryReceipts });
  // Sending and the sender's save do not count as the absent peer receiving it.
  assert.ok(JSON.stringify(await f.tool(a, 'meeting_read', { meeting_id })).includes(sendArgs.text));
  const joinArgs = { invitation_id: call.invitationId };
  await f.tool(b, 'meeting_join', joinArgs);
  const bRead = await f.tool(b, 'meeting_read', { meeting_id });
  assert.ok(JSON.stringify(bRead).includes(sendArgs.text));
  assert.ok(bRead.deliveryReceipts.length >= 2);
  // A read/notification alone does not delete content; only receipt ACK does.
  assert.ok(JSON.stringify(await f.tool(a, 'meeting_read', { meeting_id })).includes(sendArgs.text));
  await assert.rejects(f.tool(a, 'meeting_ack', { meeting_id, receipts: bRead.deliveryReceipts }));
  await f.tool(b, 'meeting_ack', { meeting_id, receipts: bRead.deliveryReceipts });
  await f.tool(b, 'meeting_ack', { meeting_id, receipts: bRead.deliveryReceipts });
  const snapshots = [
    await f.tool(a, 'meeting_read', { meeting_id }),
    await f.tool(b, 'meeting_read', { meeting_id }),
    await f.tool(a, 'call', args),
    await f.tool(b, 'meeting_join', joinArgs),
    await f.tool(a, 'meeting_send', sendArgs),
    f.service.meetings.inspect(meeting_id),
  ];
  for (const snapshot of snapshots) {
    for (const marker of [args.purpose, args.context, sendArgs.text]) assert.ok(!JSON.stringify(snapshot).includes(marker), marker);
  }
  assert.ok(snapshots[0].events.some(event => event.bodyState === 'delivered'));
  const endArgs = { meeting_id, text: 'private-summary-to-delete', request_id: 'close-pending' };
  const ended = await f.tool(a, 'meeting_end', endArgs);
  await f.tool(a, 'meeting_ack', { meeting_id, receipts: ended.deliveryReceipts });
  const finalRead = await f.tool(b, 'meeting_read', { meeting_id });
  assert.equal(finalRead.meeting.summary, endArgs.text);
  await f.tool(b, 'meeting_ack', { meeting_id, receipts: finalRead.deliveryReceipts });
  assert.ok(!JSON.stringify(await f.tool(a, 'meeting_end', endArgs)).includes(endArgs.text));
  assert.ok(!JSON.stringify(f.service.meetings.inspect(meeting_id)).includes(endArgs.text));
});

test('native pending bodies expire without ACK, including cached creation metadata', async t => {
  const f = await fixture(t, { deliveryTtlMs: 30 });
  const a = await f.register();
  const args = { purpose: 'expiring-native-purpose', context: 'expiring-native-context', request_id: 'expiry' };
  const created = await f.tool(a, 'meeting_create', args);
  assert.equal(created.meeting.context, args.context);
  await delay(60);
  const read = await f.tool(a, 'meeting_read', { meeting_id: created.meeting.id });
  const retry = await f.tool(a, 'meeting_create', args);
  for (const snapshot of [read, retry, f.service.meetings.inspect(created.meeting.id)]) {
    assert.ok(!JSON.stringify(snapshot).includes(args.purpose));
    assert.ok(!JSON.stringify(snapshot).includes(args.context));
  }
  assert.equal(read.events.find(event => event.type === 'started').bodyState, 'expired');
  assert.equal((await f.tool(a, 'identity')).transcriptStorage, 'participant');
});

test('native acknowledgment validates receipt shape before dispatch', async t => {
  const f = await fixture(t);
  const a = await f.register();
  const created = await f.tool(a, 'meeting_create', { purpose: 'Validate ACK', request_id: 'ack-schema' });
  for (const receipts of [null, [], 'invalid', [{ seq: 1 }], [{ seq: 1, token: 'x', extra: true }], [{ seq: 0, token: 'x' }]]) {
    await assert.rejects(f.tool(a, 'meeting_ack', { meeting_id: created.meeting.id, receipts }), error => error.code === -32602);
  }
});

test('revocation during native MCP uploads prevents joining and exposing pending bodies', async t => {
  const f = await fixture(t);
  const host = await f.register();
  const room = await f.tool(host, 'meeting_create', { purpose: 'never-disclose-to-revoked-agent', request_id: 'slow-join' });
  for (const privateUrl of [false, true]) {
    const peer = await f.register();
    const path = privateUrl ? `/mcp/${peer.agentToken}` : '/mcp';
    let arrive;
    const arriving = new Promise(resolve => { arrive = resolve; });
    const listen = req => { if (req.url === path) arrive(); };
    f.service.server.on('request', listen);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 'slow-join', method: 'tools/call',
      params: { name: 'noknok_meeting_join', arguments: { link: room.invitationUrl } } });
    let writer;
    const response = new Promise((resolve, reject) => {
      writer = http.request(f.service.origin + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(privateUrl ? {} : { Authorization: `Bearer ${peer.agentToken}` }),
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      writer.on('error', reject);
      writer.write(payload.slice(0, -1));
    });
    await arriving;
    f.service.store.revokeAgent(peer.agentId);
    writer.end('}');
    const rejected = await response;
    f.service.server.off('request', listen);
    assert.equal(rejected.status, 401);
    assert.ok(!JSON.stringify(rejected.body).includes('never-disclose-to-revoked-agent'));
    assert.equal(f.service.meetings.inspect(room.meeting.id).participants.length, 1);
  }
});
