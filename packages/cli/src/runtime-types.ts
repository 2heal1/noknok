import type { IncomingMessage, ServerResponse } from 'node:http';

/** Parsed CLI flags. Positional arguments are kept separately. */
export interface CliOptions {
  [flag: string]: string | undefined;
}
export interface CommandContext {
  signal?: AbortSignal;
  textInput?: (options: CliOptions, textFlag: string, fileFlag: string, required: boolean, signal?: AbortSignal) => Promise<string | undefined>;
}
export interface ApiOptions {
  method?: string;
  body?: { requestId?: string; [key: string]: unknown };
  token?: string;
  key?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface AgentProfileOptions {
  agent?: string;
  stateDir?: string;
  create?: boolean;
  home?: string;
}
export interface RelayOptions {
  host?: string;
  port?: number;
  publicUrl?: string;
  serverKey?: string;
  retentionMs?: number;
  meetingTtlMs?: number;
  idleTtlMs?: number;
  maxMeetings?: number;
}
export interface MeetingParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  role: 'host' | 'participant';
  joinedAt: string;
  leftAt?: string;
  token: string;
  authId?: string;
}
export interface MeetingEvent {
  seq: number;
  type: string;
  from: string;
  at: string;
  bodyState?: 'pending' | 'delivered' | 'expired' | 'recipient_unavailable';
  bodyExpiresAt?: string;
  data?: { purpose?: string; context?: string; text?: string; reason?: string; state?: string; ready?: boolean; to?: string; replyTo?: number; participant?: Omit<MeetingParticipant, 'token' | 'authId'> };
}
export interface MeetingRoom {
  encryption: { v: 1; id: string };
  id: string;
  state: string;
  hostId: string;
  invitationContent?: { purpose: string; context: string };
  ownerId?: string;
  ownerAgentId?: string;
  participants: Map<string, MeetingParticipant>;
  inviteToken: string;
  viewToken: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  closedAt?: number;
  reason?: string;
  summary?: string;
  readyBy: Set<string>;
  deliveries: Map<number, { expiresAt: number; claims: Map<string, 'pending' | 'acknowledged' | 'unavailable'>; awaitFirstPeer: boolean; unavailable?: boolean }>;
  receiptKey: string;
  hadPeer: boolean;
  events: MeetingEvent[];
  seq: number;
  bytes: number;
  polls: Set<{ participantId: string; finish(): void }>;
  mutations: Map<string, { fingerprint: string; retryTokenHash?: string; response: Record<string, unknown> }>;
  creationId?: string;
}
export interface MeetingActor { accountId: string; agentId: string }
export type MeetingRequest = IncomingMessage & { noknokActor?: MeetingActor };
export interface MeetingOptions {
  getUrl: () => string;
  deliveryTtlMs?: number;
  meetingTtlMs?: number;
  idleTtlMs?: number;
  retentionMs?: number;
  maxMeetings?: number;
  serverKey?: string;
  maxParticipants?: number;
  maxRoomBytes?: number;
  maxTotalBytes?: number;
  maxEvents?: number;
  maxOwnerMeetings?: number;
  beforeWrite?: (value: unknown, bytes: number) => void;
  isParticipantAvailable?: (room: MeetingRoom, participant: MeetingParticipant) => boolean;
  authorizeRoom?: (room: MeetingRoom) => void;
  authorizeParticipant?: (room: MeetingRoom, participant: MeetingParticipant) => void;
  authorizeCreate?: (req: MeetingRequest, body: Record<string, unknown>) => MeetingActor | undefined;
  beforeCreate?: (actor?: MeetingActor) => void;
  beforeMutation?: (room: MeetingRoom, participant: MeetingParticipant, operation: string) => void;
  onEvent?: (room: MeetingRoom, event: MeetingEvent) => void;
}
export interface DeliveryReceipt { seq: number; token: string }
export interface MeetingSnapshot {
  encryption: { v: 1; id: string };
  id: string;
  purpose?: string;
  context?: string;
  summary?: string;
  reason?: string;
  deliveryTtlMs: number;
  state: string;
  hostId: string;
  participants: Array<Omit<MeetingParticipant, 'token' | 'authId'>>;
  readyBy: string[];
  createdAt: string;
  expiresAt: string;
  purgeAt: string;
  retentionMs: number;
}
export interface LocalMeetingSession {
  encryptionKey: string;
  encryption: { v: 1; id: string };
  encryptedEvents?: Record<string, number>;
  outgoing?: Record<string, { fingerprint: string; body: any }>;
  v: number;
  id: string;
  server: string;
  meetingId: string;
  participant: Omit<MeetingParticipant, 'token' | 'authId'>;
  token: string;
  meeting: MeetingSnapshot;
  viewUrl: string;
  invitationUrl?: string;
  pendingDeliveryReceipts?: DeliveryReceipt[];
  missingContentSequences?: number[];
  historyComplete?: boolean;
  archiveCursor: number;
  readCursor: number;
  events: MeetingEvent[];
  createdAt: string;
  revision?: number;
  archivedAt?: string;
}
