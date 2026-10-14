import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHostedEvents } from '../src/hosted-events.js';
import { openHostedStore } from '../src/hosted-store.js';
import type { SubscriptionArguments, WebhookPost } from '../src/hosted-types.js';

const firstSecret = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
const secondSecret = `whsec_${Buffer.alloc(32, 2).toString('base64')}`;
const nonce = () => randomBytes(24).toString('base64url');

test('verification cache survives restart but is bounded by principal, URL, key and original verification time', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'noknok-subscription-refresh-'));
  let time = 1_700_000_000_000;
  const options = { dataDir, realm: 'https://noknok.example', now: () => time };
  let store = openHostedStore(options);
  const account = store.registerAccount(nonce());
  const a = store.registerAgent(account.accountToken, { requestId: nonce() });
  const b = store.registerAgent(account.accountToken, { requestId: nonce() });
  let verifications = 0;
  const webhookPost: WebhookPost = async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.equal(payload.type, 'verification');
    verifications++;
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  };
  let events = createHostedEvents({ store, now: options.now, webhookPost });
  t.after(async () => { events.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const params = (agentId: string, secret = firstSecret, suffix = ''): SubscriptionArguments => ({
    name: 'noknok.activity', arguments: { recipient_id: agentId },
    delivery: { mode: 'webhook', url: `https://receiver.example/events${suffix}`, secret },
  });

  const initial = await events.subscribe(a.agentId, params(a.agentId), { owner: 'grant_test' });
  time += 100_000;
  const refreshed = await events.subscribe(a.agentId, params(a.agentId), { owner: 'grant_test' });
  assert.equal(refreshed.id, initial.id);
  assert.equal(verifications, 1);
  events.close(); store.close();
  store = openHostedStore(options);
  events = createHostedEvents({ store, now: options.now, webhookPost });
  time += 100_000;
  await events.subscribe(a.agentId, params(a.agentId), { owner: 'grant_test' });
  assert.equal(verifications, 1);
  time += 100_001;
  await events.subscribe(a.agentId, params(a.agentId), { owner: 'grant_test' });
  assert.equal(verifications, 2, 'refresh must not extend the original verification cache');
  await events.subscribe(a.agentId, params(a.agentId, secondSecret), { owner: 'grant_test' });
  assert.equal(verifications, 3, 'rotation requires proof with the replacement signing key');
  await events.subscribe(a.agentId, params(a.agentId, secondSecret, '/new'), { owner: 'grant_test' });
  assert.equal(verifications, 4, 'a new endpoint requires its own proof');
  await events.subscribe(b.agentId, params(b.agentId, secondSecret, '/new'), { owner: 'grant_test' });
  assert.equal(verifications, 5, 'another principal cannot reuse verification');
});

test('multiple grant subscriptions survive restart and revocation preserves identity and existing friendships', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'noknok-subscription-grants-'));
  let time = 1_700_000_000_000;
  const options = { dataDir, realm: 'https://noknok.example', now: () => time };
  let store = openHostedStore(options);
  const account = store.registerAccount(nonce());
  const a = store.registerAgent(account.accountToken, { requestId: nonce() });
  const b = store.registerAgent(account.accountToken, { requestId: nonce() });
  const friendship = store.acceptOffer(a.agentId, store.issueOffer(b.agentId));
  const owners = new Set(['grant_first', 'grant_second']);
  const calls: string[] = [];
  let verifications = 0;
  const webhookPost: WebhookPost = async (_url, request) => {
    const payload = JSON.parse(request.body);
    if (payload.type === 'verification') { verifications++; return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }; }
    calls.push(request.headers['X-MCP-Subscription-Id']); return { status: 204, body: '' };
  };
  const config = { now: options.now, webhookPost, workerIntervalMs: 60_000, validateSubscription: (agentId: string, owner: string) => agentId === a.agentId && owners.has(owner) };
  let events = createHostedEvents({ store, ...config });
  t.after(async () => { events.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const params: SubscriptionArguments = { name: 'noknok.activity', arguments: { recipient_id: a.agentId },
    delivery: { mode: 'webhook', url: 'https://receiver.example/events', secret: firstSecret } };
  const first = await events.subscribe(a.agentId, params, { owner: 'grant_first' });
  const second = await events.subscribe(a.agentId, params, { owner: 'grant_second' });
  events.close(); store.close();
  store = openHostedStore(options); events = createHostedEvents({ store, ...config });
  assert.equal(events.status(a.agentId).subscriptions.length, 2);
  assert.deepEqual(events.status(a.agentId).deliveries, []);
  time += 100_000;
  assert.equal((await events.subscribe(a.agentId, params, { owner: 'grant_first' })).id, first.id);
  assert.equal(verifications, 2, 'a restart preserves each grant’s own bounded verification proof');
  owners.delete('grant_first'); events.revokeOwner(a.agentId, 'grant_first');
  events.close(); store.close();
  store = openHostedStore(options); events = createHostedEvents({ store, ...config });
  assert.deepEqual(events.status(a.agentId).subscriptions.map(sub => sub.id), [second.id]);
  assert.deepEqual(store.authenticate(a.agentToken), { agentId: a.agentId, accountId: account.accountId });
  store.verifyCapability(a.agentId, b.agentId, friendship.contact.capability);
  await events.notify(a.agentId, { eventId: 'evt_after_restart', kind: 'incoming_meeting', meetingId: 'meeting_existing' });
  await events.flush();
  assert.deepEqual(calls, [second.id]);
});
