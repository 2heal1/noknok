export interface Participant {
  id: string;
  name: string;
  kind: string;
  role: string;
  joinedAt?: string;
  leftAt?: string;
}
export interface Meeting {
  id: string;
  purpose?: string;
  participants: Participant[];
  state: string;
  hostId?: string;
  context?: string;
  createdAt?: string;
  expiresAt?: string;
  purgeAt?: string;
  readyBy?: string[];
  summary?: string;
}
export interface EventData {
  purpose?: string;
  context?: string;
  text?: string;
  state?: string;
  reason?: string;
  to?: string;
  replyTo?: number;
  ready?: boolean;
  participant?: Participant;
  participants?: Record<string, { name: string } | null>;
}
export interface ConversationEvent {
  seq: number;
  type: string;
  from: string;
  at: string;
  bodyState?: 'pending' | 'delivered' | 'expired' | 'recipient_unavailable';
  bodyExpiresAt?: string;
  data?: EventData;
  observedBy?: string[];
}
export interface MeetingRecord {
  meeting: Meeting;
  access: Record<string, string | undefined>;
  events: ConversationEvent[];
  mode?: string;
  participantId?: string;
  archived?: boolean;
  partial?: boolean;
  savedAt?: string;
  cursor?: number;
  snapshotCursor?: number;
  cacheGeneration?: string;
  pendingDeliveryReceipts?: Array<{ seq: number; token: string }>;
}
export interface MeetingLink { id: string; mode: string; token?: string }
export interface CallSummary {
  key: string;
  callId: string;
  purpose: string;
  context?: string;
  preview?: string;
  state: string;
  createdAt: string;
  expiresAt?: string;
  lastActivityAt?: string;
  messageCount?: number;
  eventCount?: number;
  localSessionCount?: number;
  coverage?: string;
  participants: Record<string, { name: string } | null>;
}
export interface CallDetails {
  call: CallSummary;
  events: ConversationEvent[];
  sessions: Array<{ id: string; role: string }>;
  warnings?: Array<{ code?: string; message?: string }>;
  source?: { retentionMs?: number; availableUntil?: string };
}
export interface ViewAccess { callId: string; token: string; kind: string; hash: string }
