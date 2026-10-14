import type { LookupAddress } from 'node:dns';
import type https from 'node:https';

export interface HostedIdentity { agentId: string; accountId: string }
export interface HostedSubscription {
  id: string;
  owner: string;
  name: string;
  arguments: { recipient_id: string };
  url: string;
  secret: string;
  active: boolean;
  revision?: string;
  expiresAt: number;
  verifiedAt?: number;
  previousSecret?: string;
  rotateUntil?: number;
  disabledReason?: string;
}
export interface QuotaOptions { limit: number; windowMs: number; amount?: number; scope?: 'agent' | 'account' }
export interface EventStore {
  getSubscription(agentId: string): HostedSubscription | null;
  putSubscription(agentId: string, record: HostedSubscription): HostedSubscription;
  deleteSubscription(agentId: string, subscriptionId?: string): boolean;
  consumeQuota(agentId: string, bucket: string, options: QuotaOptions): { remaining: number; resetAt: number };
}
export interface WebhookOptions {
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  beforeSend?: () => boolean | Promise<boolean>;
}
export interface WebhookResponse { status: number; body: string }
export type WebhookPost = (url: string, options: WebhookOptions) => Promise<WebhookResponse>;
export interface SecureWebhookOptions {
  resolve?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;
  request?: typeof https.request;
  timeoutMs?: number;
}
export type ActivityKind = 'incoming_meeting' | 'meeting_activity' | 'friend_added' | 'friend_request' | 'incoming_call' | 'message' | 'meeting_ended';
export interface ActivityEvent { eventId: string; kind: ActivityKind; meetingId?: string; exchangeId?: string }
export interface ActivityData { recipient_id: string; kind: ActivityKind; meeting_id?: string; exchange_id?: string }
export type DeliveryStatus = 'queued' | 'cancelled' | 'failed' | 'delivered' | 'unavailable' | 'coalesced' | 'unknown';
export interface DeliveryView { eventId: string; status: DeliveryStatus; attempts?: number; reason?: string }
export interface DeliveryAuthorization { authorize?: () => boolean | Promise<boolean> }
export interface Delivery extends DeliveryView {
  agentId: string;
  data: ActivityData;
  authorize: () => boolean | Promise<boolean>;
  subscriptionId: string;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  body: string;
  inFlight?: boolean;
  controller?: AbortController;
  finishedAt?: number;
}
export interface EventsOptions {
  store?: EventStore;
  webhookPost?: WebhookPost;
  now?: () => number;
  validateDelivery?: (agentId: string, data: ActivityData) => boolean | Promise<boolean>;
  eventName?: string;
  ttlMs?: number;
  rotationWindowMs?: number;
  retryBaseMs?: number;
  workerIntervalMs?: number;
  eventTtlMs?: number;
  maxPending?: number;
  maxPendingPerAgent?: number;
  maxHistory?: number;
  maxConcurrentDeliveries?: number;
  maxConcurrentVerifications?: number;
  subscriptionLimit?: number;
  dailySubscriptionLimit?: number;
  notificationLimit?: number;
  dailyNotificationLimit?: number;
}
export interface SubscriptionArguments {
  name: string;
  arguments: { recipient_id: string };
  delivery: { mode: 'webhook'; url: string; secret: string };
  cursor?: null;
  ttlMs?: number | null;
}
export interface LocalHostedContact {
  peerId: string; capability: string; issuedCapability?: string; addedAt: string; expiresAt?: number;
}
export interface LocalHostedState {
  v: 1; server: string; name: string; contacts: Record<string, LocalHostedContact>;
  offers: { offer: string; createdAt: string; claimed?: boolean; expired?: boolean }[];
  redeemRequestId: string; agentRequestId: string; createdAt: string;
  accountId?: string; accountToken?: string; agentId?: string; agentToken?: string;
}
