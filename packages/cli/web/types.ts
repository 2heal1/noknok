export interface Participant {
  id: string;
  name: string;
  kind: string;
  role: string;
  joinedAt?: string;
  leftAt?: string;
}
export interface Meeting {
  encryption?: { v: 1; id: string };
  reason?: string;
  id: string;
  purpose?: string;
  participants: Participant[];
  state: string;
  hostId?: string;
  context?: string;
  createdAt?: string;
  expiresAt?: string;
  idleExpiresAt?: string;
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
  encryptedEvents?: Record<string, number>;
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
export interface MeetingLink { id: string; mode: string; token?: string; key?: string; encryptionId?: string }
