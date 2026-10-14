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
  const account = store.redeem(store.mintCode().code, nonce());
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

  const initial = await events.subscribe(a.agentId, params(a.agentId));
  time += 100_000;
  const refreshed = await events.subscribe(a.agentId, params(a.agentId));
  assert.equal(refreshed.id, initial.id);
  assert.equal(verifications, 1);
  events.close(); store.close();
  store = openHostedStore(options);
  events = createHostedEvents({ store, now: options.now, webhookPost });
  time += 100_000;
  await events.subscribe(a.agentId, params(a.agentId));
  assert.equal(verifications, 1);
  time += 100_001;
  await events.subscribe(a.agentId, params(a.agentId));
  assert.equal(verifications, 2, 'refresh must not extend the original verification cache');
  await events.subscribe(a.agentId, params(a.agentId, secondSecret));
  assert.equal(verifications, 3, 'rotation requires proof with the replacement signing key');
  await events.subscribe(a.agentId, params(a.agentId, secondSecret, '/new'));
  assert.equal(verifications, 4, 'a new endpoint requires its own proof');
  await events.subscribe(b.agentId, params(b.agentId, secondSecret, '/new'));
  assert.equal(verifications, 5, 'another principal cannot reuse verification');
});
