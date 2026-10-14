import type { HostedSubscription, WebhookPost } from '../../src/hosted-types.js';
export type PocIdentity = 'A' | 'B';
export interface PocMessage {
  id: string; event_id: string; sender_id: PocIdentity; recipient_id: PocIdentity;
  request_id: string; text: string; reply_to: string | null; timestamp: string; depth: number;
}
export interface PocDelivery {
  subscription_id: string; message_id: string; event_id: string;
  status: 'pending' | 'cancelled' | 'failed' | 'delivered';
  attempts: number; nextAttemptAt: number; lastStatus?: number | null; deliveredAt?: string; reason?: string;
}
export interface PocState {
  version: 1;
  agents: Record<PocIdentity, { token: string }>;
  messages: PocMessage[];
  subscriptions: HostedSubscription[];
  deliveries: PocDelivery[];
}
export interface PocOptions {
  statePath?: string;
  agentTokens?: Record<PocIdentity, string>;
  host?: string; port?: number; now?: () => number; retryBaseMs?: number; workerIntervalMs?: number;
  webhookPost?: WebhookPost;
  logger?: (entry: unknown) => void;
}
