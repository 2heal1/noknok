import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CallbackError, callbackUrl, signingKey, webhookHeaders, createSecureWebhookPost } from './webhook.mjs';

const DAY = 86_400_000;
const KINDS = ['incoming_meeting', 'meeting_activity', 'friend_added', 'friend_request', 'incoming_call', 'message', 'meeting_ended'];
const TRANSIENT = new Set(['timeout', 'dns_failed', 'network_failed', 'response_failed']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class HostedEventError extends Error {
  constructor(code, message, data, status = 400) { super(message); Object.assign(this, { code, data, status }); }
}
function invalid(message) { throw new HostedEventError(-32602, message); }

/**
 * Persistent subscriptions, transient delivery queue. The caller authenticates
 * agentId; it must never come from the request's recipient_id or display name.
 * The store encrypts subscription records at rest. No event content is saved.
 */
export function createHostedEvents({ store, webhookPost = createSecureWebhookPost(), now = Date.now,
  validateDelivery = () => true, eventName = 'agentcall.activity', ttlMs = DAY,
  rotationWindowMs = 300_000, retryBaseMs = 1000, workerIntervalMs = 250,
  eventTtlMs = 300_000, maxPending = 128, maxPendingPerAgent = 16,
  maxHistory = 128, maxConcurrentDeliveries = 4, maxConcurrentVerifications = 4,
  subscriptionLimit = 30, dailySubscriptionLimit = 60, notificationLimit = 120, dailyNotificationLimit = 200 } = {}) {
  if (!store || typeof store.getSubscription !== 'function' || typeof store.putSubscription !== 'function'
    || typeof store.deleteSubscription !== 'function' || typeof store.consumeQuota !== 'function') {
    throw new TypeError('A persistent hosted control store is required.');
  }
  for (const [name, value] of Object.entries({ ttlMs, rotationWindowMs, retryBaseMs, workerIntervalMs, eventTtlMs,
    maxPending, maxPendingPerAgent, maxHistory, maxConcurrentDeliveries, maxConcurrentVerifications, subscriptionLimit, dailySubscriptionLimit, notificationLimit, dailyNotificationLimit })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  }
  if (ttlMs > 31 * DAY) throw new TypeError('Subscription lifetime cannot exceed 31 days.');
  const pendingSubscriptions = new Map();
  const deliveries = new Map();
  let closed = false;
  let running = 0;
  let verifying = 0;
  const isActive = subscription => subscription?.active !== false && Number.isFinite(subscription?.expiresAt) && subscription.expiresAt > now();
  const subscription = agentId => store.getSubscription(agentId);
  const key = (agentId, eventId) => `${agentId}:${eventId}`;
  const publicDelivery = item => ({ eventId: item.eventId, status: item.status, attempts: item.attempts,
    ...(item.reason ? { reason: item.reason } : {}) });
  function ensureOpen() { if (closed) throw new HostedEventError(-32000, 'Event delivery is stopped.', undefined, 503); }
  function finish(item, status, reason) {
    item.status = status; item.reason = reason; item.finishedAt = now(); item.controller?.abort();
  }
  function cancel(agentId, subscriptionId, reason) {
    for (const item of deliveries.values()) {
      if (item.agentId === agentId && item.subscriptionId === subscriptionId && item.status === 'queued') finish(item, 'cancelled', reason);
    }
  }
  function prune() {
    const terminal = [];
    for (const [id, item] of deliveries) {
      if (item.status === 'queued' && item.expiresAt <= now()) finish(item, 'failed', 'event_expired');
      if (item.status !== 'queued') {
        if (item.finishedAt + eventTtlMs <= now()) deliveries.delete(id);
        else terminal.push(id);
      }
    }
    for (const id of terminal.slice(0, Math.max(0, terminal.length - maxHistory))) deliveries.delete(id);
  }
  function validateParams(agentId, params, withSecret) {
    if (!identifier(agentId)) invalid('Invalid authenticated receiver.');
    if (!object(params, withSecret ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs'] : ['name', 'arguments', 'delivery'])) invalid('Invalid subscription arguments.');
    if (params.name !== eventName) invalid('Unknown event.');
    if (!object(params.arguments, ['recipient_id']) || params.arguments.recipient_id !== agentId) {
      throw new HostedEventError(-32001, 'Only the authenticated receiver may manage its subscription.', undefined, 403);
    }
    if (!object(params.delivery, withSecret ? ['mode', 'url', 'secret'] : ['mode', 'url']) || params.delivery.mode !== 'webhook') invalid('Webhook delivery is required.');
    if (params.cursor != null) invalid('This event has no replay cursor.');
    if (params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 1000)) invalid('ttlMs must be at least 1000 milliseconds.');
    try { callbackUrl(params.delivery.url); if (withSecret) signingKey(params.delivery.secret); }
    catch (error) { throw new HostedEventError(-32015, 'Invalid callback configuration.', { reason: error.reason }); }
    return 'sub_' + createHash('sha256').update(JSON.stringify([agentId, params.delivery.url, eventName, { recipient_id: agentId }])).digest('hex').slice(0, 32);
  }
  async function subscribe(agentId, params) {
    ensureOpen();
    const id = validateParams(agentId, params, true);
    if (verifying >= maxConcurrentVerifications) throw new HostedEventError(-32000, 'Callback verification capacity reached.', undefined, 429);
    store.consumeQuota(agentId, 'events.subscribe', { limit: subscriptionLimit, windowMs: 60_000 });
    store.consumeQuota(agentId, 'events.subscribe.daily', { limit: dailySubscriptionLimit, windowMs: DAY, scope: 'account' });
    const operation = { id, token: Symbol(), controller: new AbortController() };
    pendingSubscriptions.get(agentId)?.controller.abort();
    pendingSubscriptions.set(agentId, operation);
    const candidate = { id, owner: agentId, name: eventName, arguments: { recipient_id: agentId },
      url: params.delivery.url, secret: params.delivery.secret, active: true,
      revision: randomUUID(), expiresAt: now() + Math.min(params.ttlMs ?? ttlMs, ttlMs) };
    verifying++;
    try {
      const challenge = randomBytes(32).toString('base64url');
      const body = JSON.stringify({ type: 'verification', challenge });
      const started = now();
      const response = await webhookPost(candidate.url, { body,
        headers: webhookHeaders(candidate, `msg_verification_${randomUUID()}`, body, now()),
        signal: operation.controller.signal,
        beforeSend: () => !closed && pendingSubscriptions.get(agentId) === operation });
      let answer;
      try { answer = JSON.parse(response.body); } catch { throw new CallbackError('challenge_failed'); }
      if (response.status < 200 || response.status >= 300 || now() - started > 10_000 || !same(challenge, answer.challenge)) throw new CallbackError('challenge_failed');
      if (closed || pendingSubscriptions.get(agentId) !== operation) throw new HostedEventError(-32009, 'Subscription changed during verification.');
      const previous = subscription(agentId);
      if (previous?.id === id && isActive(previous)) {
        if (previous.secret !== candidate.secret) {
          candidate.previousSecret = previous.secret; candidate.rotateUntil = now() + rotationWindowMs;
        } else if (previous.rotateUntil > now()) {
          candidate.previousSecret = previous.previousSecret; candidate.rotateUntil = previous.rotateUntil;
        }
      }
      candidate.verifiedAt = now();
      candidate.expiresAt = now() + Math.min(params.ttlMs ?? ttlMs, ttlMs);
      // The single synchronous transaction switches only after verification.
      // A failed replacement leaves the former endpoint and queue untouched.
      store.putSubscription(agentId, candidate);
      if (previous && previous.id !== id) cancel(agentId, previous.id, 'subscription_replaced');
      return { id, refreshBefore: new Date(candidate.expiresAt).toISOString(), cursor: null, truncated: false };
    } catch (error) {
      if (error instanceof HostedEventError || error?.status === 429) throw error;
      throw new HostedEventError(-32015, 'Callback verification failed.', { reason: error.reason ?? 'network_failed' });
    } finally {
      verifying--;
      if (pendingSubscriptions.get(agentId) === operation) pendingSubscriptions.delete(agentId);
    }
  }
  function unsubscribe(agentId, params) {
    ensureOpen();
    const id = validateParams(agentId, params, false);
    const pending = pendingSubscriptions.get(agentId);
    if (pending?.id === id) { pending.controller.abort(); pendingSubscriptions.delete(agentId); }
    store.deleteSubscription(agentId, id);
    cancel(agentId, id, 'unsubscribed');
    return {};
  }
  async function permitted(item) {
    try { return await validateDelivery(item.agentId, item.data) !== false && await item.authorize() !== false; }
    catch { return false; }
  }
  async function notify(agentId, event, { authorize = () => true } = {}) {
    ensureOpen(); prune();
    if (!identifier(agentId) || !object(event, ['eventId', 'kind', 'meetingId', 'exchangeId']) || !identifier(event.eventId)
      || !KINDS.includes(event.kind) || (event.meetingId !== undefined && !identifier(event.meetingId))
      || (event.exchangeId !== undefined && !identifier(event.exchangeId)) || typeof authorize !== 'function') invalid('Invalid activity notification.');
    const data = { recipient_id: agentId, kind: event.kind,
      ...(event.meetingId ? { meeting_id: event.meetingId } : {}), ...(event.exchangeId ? { exchange_id: event.exchangeId } : {}) };
    const item = { agentId, eventId: event.eventId, data, authorize };
    if (!await permitted(item)) return { eventId: event.eventId, status: 'cancelled', reason: 'authorization_revoked' };
    if (closed) return { eventId: event.eventId, status: 'cancelled', reason: 'stopped' };
    const sub = subscription(agentId);
    if (!isActive(sub)) return { eventId: event.eventId, status: 'unavailable', reason: 'no_active_subscription' };
    const duplicate = deliveries.get(key(agentId, event.eventId));
    if (duplicate) {
      if (JSON.stringify(duplicate.data) !== JSON.stringify(data)) throw new HostedEventError(-32009, 'eventId already identifies another activity.');
      return publicDelivery(duplicate);
    }
    const pending = [...deliveries.values()].filter(entry => entry.status === 'queued');
    const coalesced = event.meetingId && pending.find(entry => entry.agentId === agentId && entry.subscriptionId === sub.id
      && entry.data.meeting_id === event.meetingId && entry.data.kind === event.kind && !entry.inFlight);
    if (coalesced) return { ...publicDelivery(coalesced), status: 'coalesced' };
    if (pending.length >= maxPending || pending.filter(entry => entry.agentId === agentId).length >= maxPendingPerAgent) {
      return { eventId: event.eventId, status: 'unavailable', reason: 'queue_full' };
    }
    store.consumeQuota(agentId, 'events.notify', { limit: notificationLimit, windowMs: 60_000 });
    store.consumeQuota(agentId, 'events.notify.daily', { limit: dailyNotificationLimit, windowMs: DAY, scope: 'account' });
    Object.assign(item, { subscriptionId: sub.id, status: 'queued', attempts: 0, nextAttemptAt: now(), expiresAt: now() + eventTtlMs,
      body: JSON.stringify({ eventId: event.eventId, name: eventName, timestamp: new Date(now()).toISOString(), data, cursor: null }) });
    deliveries.set(key(agentId, event.eventId), item);
    return publicDelivery(item);
  }
  async function deliver(item) {
    item.inFlight = true; running++;
    try {
      if (!await permitted(item)) { finish(item, 'cancelled', 'authorization_revoked'); return; }
      const sub = subscription(item.agentId);
      if (closed || item.status !== 'queued') return;
      if (!isActive(sub) || sub.id !== item.subscriptionId) { finish(item, 'cancelled', 'subscription_inactive'); return; }
      if (item.expiresAt <= now()) { finish(item, 'failed', 'event_expired'); return; }
      item.controller = new AbortController();
      let status, reason;
      item.attempts++;
      try {
        const response = await webhookPost(sub.url, { body: item.body, headers: webhookHeaders(sub, item.eventId, item.body, now()),
          signal: item.controller.signal,
          beforeSend: async () => {
            if (!await permitted(item)) return false;
            const current = subscription(item.agentId);
            return !closed && item.status === 'queued' && item.expiresAt > now() && isActive(current)
              && current.id === sub.id && current.revision === sub.revision;
          } });
        status = response.status;
      } catch (error) { reason = error.reason ?? 'network_failed'; }
      if (closed || item.status !== 'queued') return;
      // A receipt means only webhook delivery; it never proves the agent woke.
      if (status >= 200 && status < 300) { finish(item, 'delivered'); return; }
      if (status === 410) {
        const current = subscription(item.agentId);
        if (isActive(current) && current.id === sub.id && current.revision === sub.revision) {
          store.putSubscription(item.agentId, { ...current, active: false, disabledReason: 'callback_gone' });
          finish(item, 'failed', 'http_410');
          cancel(item.agentId, current.id, 'callback_gone');
          return;
        }
      }
      if (reason === 'cancelled') { finish(item, 'cancelled', 'delivery_state_changed'); return; }
      const retryable = reason ? TRANSIENT.has(reason) : status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || item.attempts >= 4) { finish(item, 'failed', reason ?? `http_${Number.isInteger(status) ? status : 'invalid'}`); return; }
      item.nextAttemptAt = now() + retryBaseMs * 2 ** (item.attempts - 1);
    } catch {
      finish(item, 'cancelled', 'receiver_unavailable');
    } finally { item.inFlight = false; item.controller = undefined; running--; prune(); }
  }
  async function flush() {
    if (closed) return;
    prune();
    const due = [...deliveries.values()].filter(item => item.status === 'queued' && !item.inFlight && item.nextAttemptAt <= now())
      .slice(0, Math.max(0, maxConcurrentDeliveries - running));
    await Promise.all(due.map(deliver));
  }
  const timer = setInterval(() => { void flush().catch(() => {}); }, workerIntervalMs);
  timer.unref();
  return {
    list(agentId) {
      if (!identifier(agentId)) invalid('Invalid authenticated receiver.');
      return { events: [{ name: eventName, description: 'An authorized contact or meeting has activity for this receiver. Retrieve it through authenticated NokNok tools.',
        delivery: ['webhook'], inputSchema: { type: 'object', properties: { recipient_id: { type: 'string', enum: [agentId] } }, required: ['recipient_id'], additionalProperties: false },
        payloadSchema: { type: 'object', properties: { recipient_id: { type: 'string', enum: [agentId] }, kind: { type: 'string', enum: KINDS },
          meeting_id: { type: 'string' }, exchange_id: { type: 'string' } }, required: ['recipient_id', 'kind'], additionalProperties: false } }] };
    },
    subscribe, unsubscribe, notify, flush,
    status(agentId) {
      prune(); const sub = subscription(agentId);
      return { eventName, subscribed: !closed && isActive(sub),
        subscription: sub ? { id: sub.id, active: !closed && isActive(sub), refreshBefore: new Date(sub.expiresAt).toISOString(),
          ...(sub.disabledReason ? { reason: sub.disabledReason } : {}) } : null,
        deliveries: [...deliveries.values()].filter(item => item.agentId === agentId).map(publicDelivery),
        replaySupported: false };
    },
    close() {
      closed = true; clearInterval(timer);
      for (const op of pendingSubscriptions.values()) op.controller.abort();
      pendingSubscriptions.clear();
      for (const item of deliveries.values()) item.controller?.abort();
      deliveries.clear();
    },
  };
}
