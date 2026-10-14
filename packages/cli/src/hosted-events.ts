import type { ActivityEvent, Delivery, DeliveryAuthorization, DeliveryStatus, DeliverySummary, DeliveryView, EventsOptions, HostedSubscription, SubscriptionArguments, SubscriptionAuthorization, SubscriptionDiagnostic, SubscriptionVerificationFailure } from './hosted-types.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CallbackError, callbackUrl, signingKey, webhookHeaders, createSecureWebhookPost } from './webhook.js';

const DAY = 86_400_000;
const KINDS = ['incoming_meeting', 'meeting_activity', 'friend_added', 'meeting_ended'];
const TRANSIENT = new Set(['timeout', 'dns_failed', 'network_failed', 'response_failed']);
const VERIFICATION_FAILURES = new Set<SubscriptionVerificationFailure>(['invalid_url', 'invalid_secret', 'payload_too_large',
  'cancelled', 'timeout', 'dns_failed', 'address_not_public', 'network_failed', 'response_failed', 'response_too_large', 'challenge_failed']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class HostedEventError extends Error {
  code: number; data: unknown; status: number;
  constructor(code: number, message: string, data?: unknown, status = 400) { super(message); this.code = code; this.data = data; this.status = status; }
}
function invalid(message: string): never { throw new HostedEventError(-32602, message); }

/**
 * Persistent subscriptions, transient delivery queue. The caller authenticates
 * agentId; it must never come from the request's recipient_id or display name.
 * The store encrypts subscription records at rest. No event content is saved.
 */
export function createHostedEvents({ store: suppliedStore, webhookPost = createSecureWebhookPost(), now = Date.now,
  validateDelivery = () => true, validateSubscription = () => true, eventName = 'noknok.activity', ttlMs = DAY,
  rotationWindowMs = 300_000, retryBaseMs = 1000, workerIntervalMs = 250,
  eventTtlMs = 300_000, maxPending = 128, maxPendingPerAgent = 16,
  maxHistory = 128, maxConcurrentDeliveries = 4, maxConcurrentVerifications = 4, maxSubscriptionsPerAgent = 8,
  subscriptionLimit = 30, dailySubscriptionLimit = 60, notificationLimit = 120, dailyNotificationLimit = 200 }: EventsOptions = {}) {
  if (!suppliedStore || typeof suppliedStore.getSubscription !== 'function' || typeof suppliedStore.putSubscription !== 'function'
    || typeof suppliedStore.listSubscriptions !== 'function' || typeof suppliedStore.deleteSubscription !== 'function' || typeof suppliedStore.consumeQuota !== 'function') {
    throw new TypeError('A persistent hosted control store is required.');
  }
  const store = suppliedStore;
  for (const [name, value] of Object.entries({ ttlMs, rotationWindowMs, retryBaseMs, workerIntervalMs, eventTtlMs,
    maxPending, maxPendingPerAgent, maxHistory, maxConcurrentDeliveries, maxConcurrentVerifications, maxSubscriptionsPerAgent, subscriptionLimit, dailySubscriptionLimit, notificationLimit, dailyNotificationLimit })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  }
  if (ttlMs > 31 * DAY) throw new TypeError('Subscription lifetime cannot exceed 31 days.');
  const pendingSubscriptions = new Map<string, { id: string; agentId: string; owner: string; controller: AbortController }>();
  const deliveries = new Map<string, Delivery>();
  let closed = false;
  let running = 0;
  let verifying = 0;
  const isActive = (subscription: HostedSubscription | null | undefined): subscription is HostedSubscription => !!subscription && subscription.active === true && Number.isFinite(subscription.expiresAt) && subscription.expiresAt > now();
  const subscription = (agentId: string, id: string) => store.getSubscription(agentId, id);
  const key = (agentId: string, subscriptionId: string, eventId: string) => `${agentId}:${subscriptionId}:${eventId}`;
  const allowed = (agentId: string, owner: string) => {
    try { return validateSubscription(agentId, owner) === true; } catch { return false; }
  };
  function authorizeOwner(agentId: string, owner: string) {
    if (!identifier(owner) || !allowed(agentId, owner)) throw new HostedEventError(-32001, 'Subscription authorization is no longer active.', undefined, 403);
  }
  function ensureCapacity(agentId: string, id: string) {
    const ids = new Set(store.listSubscriptions(agentId).map(sub => sub.id));
    for (const op of pendingSubscriptions.values()) if (op.agentId === agentId) ids.add(op.id);
    if (!ids.has(id) && ids.size >= maxSubscriptionsPerAgent) throw new HostedEventError(-32000, 'Subscription limit reached. Unsubscribe an existing destination first.', undefined, 429);
  }
  const publicDelivery = (item: Delivery): DeliveryView => ({ eventId: item.eventId, subscriptionId: item.subscriptionId, status: item.status, attempts: item.attempts,
    ...(item.reason ? { reason: item.reason } : {}) });
  function summarize(eventId: string, results: DeliveryView[]): DeliverySummary | undefined {
    if (!results.length) return undefined;
    if (results.length === 1) return results[0];
    // "delivered" means at least one callback accepted this event, not that
    // every destination received it or that any agent processed it. Include
    // individual receipts so partial failures remain observable.
    const priority: DeliveryStatus[] = ['delivered', 'queued', 'coalesced', 'unavailable', 'failed', 'cancelled', 'unknown'];
    const summary = [...results].sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0];
    return { eventId, status: summary.status, ...(summary.reason ? { reason: summary.reason } : {}), deliveries: results };
  }
  function ensureOpen() { if (closed) throw new HostedEventError(-32000, 'Event delivery is stopped.', undefined, 503); }
  function finish(item: Delivery, status: DeliveryStatus, reason?: string) {
    item.status = status; item.reason = reason; item.finishedAt = now(); item.controller?.abort();
  }
  function cancel(agentId, subscriptionId, reason) {
    for (const item of deliveries.values()) {
      if (item.agentId === agentId && item.subscriptionId === subscriptionId && item.status === 'queued') finish(item, 'cancelled', reason);
    }
  }
  function prune() {
    const terminal: string[] = [];
    for (const [id, item] of deliveries) {
      if (item.status === 'queued' && item.expiresAt <= now()) finish(item, 'failed', 'event_expired');
      if (item.status !== 'queued') {
        if ((item.finishedAt ?? 0) + eventTtlMs <= now()) deliveries.delete(id);
        else terminal.push(id);
      }
    }
    for (const id of terminal.slice(0, Math.max(0, terminal.length - maxHistory))) deliveries.delete(id);
  }
  function validateParams(agentId: string, params: SubscriptionArguments, withSecret: boolean, owner: string) {
    if (!identifier(agentId)) invalid('Invalid authenticated receiver.');
    if (!object(params, withSecret ? ['name', 'arguments', 'delivery', 'cursor', 'maxAgeMs', 'ttlMs', '_meta'] : ['name', 'arguments', 'delivery', '_meta'])) invalid('Invalid subscription arguments.');
    if ('_meta' in params && (!params._meta || typeof params._meta !== 'object' || Array.isArray(params._meta))) invalid('_meta must be an object.');
    if (params.name !== eventName) invalid('Unknown event.');
    if (!object(params.arguments, ['recipient_id']) || params.arguments.recipient_id !== agentId) {
      throw new HostedEventError(-32001, 'Only the authenticated receiver may manage its subscription.', undefined, 403);
    }
    if (!object(params.delivery, withSecret ? ['mode', 'url', 'secret'] : ['mode', 'url']) || params.delivery.mode !== 'webhook') invalid('Webhook delivery is required.');
    if (params.cursor != null) invalid('This event has no replay cursor.');
    // The Events protocol permits this replay bound even for sources without replay.
    // Validate it, then ignore it: metadata and replay hints do not change subscription identity.
    if (params.maxAgeMs !== undefined && (!Number.isSafeInteger(params.maxAgeMs) || params.maxAgeMs < 0)) invalid('maxAgeMs must be a non-negative integer.');
    if (params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 1000)) invalid('ttlMs must be at least 1000 milliseconds.');
    try { callbackUrl(params.delivery.url); if (withSecret) signingKey(params.delivery.secret); }
    catch (error) { throw new HostedEventError(-32015, 'Invalid callback configuration.', { reason: error.reason }); }
    return 'sub_' + createHash('sha256').update(JSON.stringify([owner, params.delivery.url, eventName, { recipient_id: agentId }])).digest('hex').slice(0, 32);
  }
  async function subscribe(agentId: string, params: SubscriptionArguments, { owner, report }: SubscriptionAuthorization) {
    const diagnose = (event: SubscriptionDiagnostic) => { try { report?.(event); } catch { /* Diagnostics must not change subscription outcomes. */ } };
    ensureOpen(); authorizeOwner(agentId, owner);
    const id = validateParams(agentId, params, true, owner);
    ensureCapacity(agentId, id);
    if (verifying >= maxConcurrentVerifications) throw new HostedEventError(-32000, 'Callback verification capacity reached.', undefined, 429);
    store.consumeQuota(agentId, 'events.subscribe', { limit: subscriptionLimit, windowMs: 60_000 });
    store.consumeQuota(agentId, 'events.subscribe.daily', { limit: dailySubscriptionLimit, windowMs: DAY, scope: 'account' });
    const operation = { id, agentId, owner, controller: new AbortController() };
    pendingSubscriptions.get(id)?.controller.abort();
    pendingSubscriptions.set(id, operation);
    const candidate: HostedSubscription = { id, owner, name: eventName, arguments: { recipient_id: agentId },
      url: params.delivery.url, secret: params.delivery.secret, active: true,
      revision: randomUUID(), expiresAt: now() + Math.min(params.ttlMs ?? ttlMs, ttlMs) };
    verifying++;
    try {
      const previous = subscription(agentId, id);
      // Refreshes may reuse a recent proof only for this principal, endpoint,
      // filter and signing key. Preserve its original timestamp so refreshing
      // cannot extend the cache indefinitely, including across restarts.
      const verifiedAt = previous?.verifiedAt;
      if (isActive(previous) && previous.id === id && previous.secret === candidate.secret
        && verifiedAt !== undefined && verifiedAt <= now() && verifiedAt + 300_000 > now()) {
        candidate.verifiedAt = verifiedAt;
        diagnose({ stage: 'verification_cached' });
      } else {
        const challenge = randomBytes(32).toString('base64url');
        const body = JSON.stringify({ type: 'verification', challenge });
        const started = now();
        diagnose({ stage: 'verification_started' });
        try {
          const response = await webhookPost(candidate.url, { body,
            headers: webhookHeaders(candidate, `msg_verification_${randomUUID()}`, body, now()),
            signal: operation.controller.signal,
            beforeSend: () => !closed && allowed(agentId, owner) && pendingSubscriptions.get(id) === operation });
          diagnose({ stage: 'callback_response', httpStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0 });
          let answer;
          try { answer = JSON.parse(response.body); } catch { throw new CallbackError('challenge_failed'); }
          if (!answer || typeof answer !== 'object' || Array.isArray(answer) || response.status < 200 || response.status >= 300
            || now() - started > 10_000 || !same(challenge, answer.challenge)) throw new CallbackError('challenge_failed');
        } catch (error) {
          diagnose({ stage: 'verification_failed', reason: VERIFICATION_FAILURES.has(error?.reason) ? error.reason : 'internal_error' });
          throw error;
        }
        candidate.verifiedAt = now();
      }
      if (closed || pendingSubscriptions.get(id) !== operation) throw new HostedEventError(-32009, 'Subscription changed during verification.');
      authorizeOwner(agentId, owner);
      ensureCapacity(agentId, id);
      if (previous?.id === id && isActive(previous)) {
        if (previous.secret !== candidate.secret) {
          candidate.previousSecret = previous.secret; candidate.rotateUntil = now() + rotationWindowMs;
        } else if ((previous.rotateUntil ?? 0) > now()) {
          candidate.previousSecret = previous.previousSecret; candidate.rotateUntil = previous.rotateUntil;
        }
      }
      candidate.expiresAt = now() + Math.min(params.ttlMs ?? ttlMs, ttlMs);
      // Commit only this identity after verification; other destinations remain active.
      try { store.putSubscription(agentId, candidate); }
      catch (error) { diagnose({ stage: 'subscription_store_failed' }); throw error; }
      diagnose({ stage: 'subscription_stored' });
      return { id, refreshBefore: new Date(candidate.expiresAt).toISOString(), cursor: null, truncated: false };
    } catch (error) {
      if (error instanceof HostedEventError || error?.status === 429) throw error;
      throw new HostedEventError(-32015, 'Callback verification failed.', { reason: error.reason ?? 'network_failed' });
    } finally {
      verifying--;
      if (pendingSubscriptions.get(id) === operation) pendingSubscriptions.delete(id);
    }
  }
  function unsubscribe(agentId: string, params: SubscriptionArguments, { owner }: SubscriptionAuthorization) {
    ensureOpen(); authorizeOwner(agentId, owner);
    const id = validateParams(agentId, params, false, owner);
    const pending = pendingSubscriptions.get(id);
    if (pending?.id === id) { pending.controller.abort(); pendingSubscriptions.delete(id); }
    store.deleteSubscription(agentId, id);
    cancel(agentId, id, 'unsubscribed');
    return {};
  }
  async function permitted(item: Pick<Delivery, 'agentId' | 'data' | 'authorize'>) {
    try { return await validateDelivery(item.agentId, item.data) !== false && await item.authorize() !== false; }
    catch { return false; }
  }
  async function notify(agentId: string, event: ActivityEvent, { authorize = () => true }: DeliveryAuthorization = {}): Promise<DeliverySummary> {
    ensureOpen(); prune();
    if (!identifier(agentId) || !object(event, ['eventId', 'kind', 'meetingId', 'exchangeId']) || !identifier(event.eventId)
      || !KINDS.includes(event.kind) || (event.meetingId !== undefined && !identifier(event.meetingId))
      || (event.exchangeId !== undefined && !identifier(event.exchangeId)) || typeof authorize !== 'function') invalid('Invalid activity notification.');
    const data = { recipient_id: agentId, kind: event.kind,
      ...(event.meetingId ? { meeting_id: event.meetingId } : {}), ...(event.exchangeId ? { exchange_id: event.exchangeId } : {}) };
    const authorization = { agentId, eventId: event.eventId, data, authorize };
    if (!await permitted(authorization)) return { eventId: event.eventId, status: 'cancelled', reason: 'authorization_revoked' };
    if (closed) return { eventId: event.eventId, status: 'cancelled', reason: 'stopped' };
    const subscriptions = store.listSubscriptions(agentId).filter(sub => isActive(sub) && allowed(agentId, sub.owner));
    if (!subscriptions.length) return { eventId: event.eventId, status: 'unavailable', reason: 'no_active_subscription' };
    for (const duplicate of deliveries.values()) {
      if (duplicate.agentId === agentId && duplicate.eventId === event.eventId && JSON.stringify(duplicate.data) !== JSON.stringify(data)) {
        throw new HostedEventError(-32009, 'eventId already identifies another activity.');
      }
    }
    const results: DeliveryView[] = [];
    let charged = false;
    for (const sub of subscriptions) {
      const duplicate = deliveries.get(key(agentId, sub.id, event.eventId));
      if (duplicate) { results.push(publicDelivery(duplicate)); continue; }
      const pending = [...deliveries.values()].filter(entry => entry.status === 'queued');
      const coalesced = event.meetingId && pending.find(entry => entry.agentId === agentId && entry.subscriptionId === sub.id
        && entry.data.meeting_id === event.meetingId && entry.data.kind === event.kind && !entry.inFlight);
      if (coalesced) { results.push({ ...publicDelivery(coalesced), status: 'coalesced' }); continue; }
      if (pending.length >= maxPending || pending.filter(entry => entry.agentId === agentId).length >= maxPendingPerAgent) {
        results.push({ eventId: event.eventId, subscriptionId: sub.id, status: 'unavailable', reason: 'queue_full' }); continue;
      }
      // Charge once per logical event; fanout is bounded independently by the
      // subscription cap and by the global/per-agent pending delivery caps.
      if (!charged) {
        store.consumeQuota(agentId, 'events.notify', { limit: notificationLimit, windowMs: 60_000 });
        store.consumeQuota(agentId, 'events.notify.daily', { limit: dailyNotificationLimit, windowMs: DAY, scope: 'account' });
        charged = true;
      }
      const item: Delivery = { ...authorization, owner: sub.owner, subscriptionId: sub.id, status: 'queued', attempts: 0,
        nextAttemptAt: now(), expiresAt: now() + eventTtlMs,
        body: JSON.stringify({ eventId: event.eventId, name: eventName, timestamp: new Date(now()).toISOString(), data, cursor: null }) };
      deliveries.set(key(agentId, sub.id, event.eventId), item);
      results.push(publicDelivery(item));
    }
    return summarize(event.eventId, results)!;
  }
  async function deliver(item: Delivery) {
    item.inFlight = true; running++;
    try {
      if (!allowed(item.agentId, item.owner) || !await permitted(item)) { finish(item, 'cancelled', 'authorization_revoked'); return; }
      const sub = subscription(item.agentId, item.subscriptionId);
      if (closed || item.status !== 'queued') return;
      if (!isActive(sub) || sub.id !== item.subscriptionId) { finish(item, 'cancelled', 'subscription_inactive'); return; }
      if (item.expiresAt <= now()) { finish(item, 'failed', 'event_expired'); return; }
      item.controller = new AbortController();
      let status = 0; let reason: string | undefined;
      item.attempts++;
      try {
        const response = await webhookPost(sub.url, { body: item.body, headers: webhookHeaders(sub, item.eventId, item.body, now()),
          signal: item.controller.signal,
          beforeSend: async () => {
            if (!allowed(item.agentId, item.owner) || !await permitted(item)) return false;
            const current = subscription(item.agentId, item.subscriptionId);
            return !closed && allowed(item.agentId, item.owner) && item.status === 'queued' && item.expiresAt > now() && isActive(current)
              && current.id === sub.id && current.revision === sub.revision;
          } });
        status = response.status;
      } catch (error) { reason = error.reason ?? 'network_failed'; }
      if (closed || item.status !== 'queued') return;
      if (!allowed(item.agentId, item.owner)) { finish(item, 'cancelled', 'authorization_revoked'); return; }
      // A receipt means only webhook delivery; it never proves the agent woke.
      if (status >= 200 && status < 300) { finish(item, 'delivered'); return; }
      if (status === 410) {
        const current = subscription(item.agentId, item.subscriptionId);
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
    list(agentId: string) {
      if (!identifier(agentId)) invalid('Invalid authenticated receiver.');
      return { events: [{ name: eventName, description: 'An authorized contact or meeting has activity for this receiver. Retrieve it through authenticated NokNok tools.',
        delivery: ['webhook'], inputSchema: { type: 'object', properties: { recipient_id: { type: 'string', enum: [agentId] } }, required: ['recipient_id'], additionalProperties: false },
        payloadSchema: { type: 'object', properties: { recipient_id: { type: 'string', enum: [agentId] }, kind: { type: 'string', enum: KINDS },
          meeting_id: { type: 'string' }, exchange_id: { type: 'string' } }, required: ['recipient_id', 'kind'], additionalProperties: false } }] };
    },
    subscribe, unsubscribe, notify, flush,
    // The service exposes this operation only to the authenticated CLI owner.
    // It intentionally works after an individual OAuth grant has expired.
    stop(agentId: string, subscriptionId: string) {
      ensureOpen();
      if (!identifier(agentId) || !identifier(subscriptionId)) invalid('Invalid subscription identity.');
      const pending = pendingSubscriptions.get(subscriptionId);
      if (pending?.agentId === agentId) { pending.controller.abort(); pendingSubscriptions.delete(subscriptionId); }
      store.deleteSubscription(agentId, subscriptionId);
      cancel(agentId, subscriptionId, 'unsubscribed');
      return {};
    },
    deliveryStatus(agentId: string, eventId: string, owner?: string) {
      prune();
      return summarize(eventId, [...deliveries.values()].filter(item => item.agentId === agentId && item.eventId === eventId
        && (owner === undefined || item.owner === owner)).map(publicDelivery)) ?? null;
    },
    revokeOwner(agentId: string, owner: string) {
      for (const [id, operation] of pendingSubscriptions) {
        if (operation.agentId === agentId && operation.owner === owner) { operation.controller.abort(); pendingSubscriptions.delete(id); }
      }
      for (const item of deliveries.values()) {
        if (item.agentId === agentId && item.owner === owner && item.status === 'queued') finish(item, 'cancelled', 'authorization_revoked');
      }
      let subscriptions: HostedSubscription[];
      try { subscriptions = store.listSubscriptions(agentId); }
      catch (error) {
        // Administrative agent revocation already removes its persistent
        // subscriptions. Still cancel in-memory work above, and let OAuth
        // revocation remain idempotent for previously issued credentials.
        if (error.code === 'AGENT_UNAVAILABLE') return;
        throw error;
      }
      for (const sub of subscriptions) if (sub.owner === owner) {
        store.deleteSubscription(agentId, sub.id);
      }
    },
    status(agentId: string, owner?: string) {
      prune();
      const subscriptions = store.listSubscriptions(agentId).filter(sub => owner === undefined || sub.owner === owner).map(sub => ({
        id: sub.id, active: !closed && isActive(sub) && allowed(agentId, sub.owner), refreshBefore: new Date(sub.expiresAt).toISOString(),
        ...(sub.disabledReason ? { reason: sub.disabledReason } : !allowed(agentId, sub.owner) ? { reason: 'authorization_revoked' } : {}) }));
      return { eventName, subscribed: subscriptions.some(sub => sub.active),
        subscriptions,
        deliveries: [...deliveries.values()].filter(item => item.agentId === agentId && (owner === undefined || item.owner === owner)).map(publicDelivery),
        replaySupported: false, processingAcknowledged: false };
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
