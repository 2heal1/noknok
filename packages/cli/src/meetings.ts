import type { MeetingOptions, MeetingRoom, MeetingRequest, MeetingParticipant, MeetingEvent } from './runtime-types.js';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { redactInvitations } from './invitation.js';
import { isEncryptedText } from './e2ee.js';
import { readFile } from 'node:fs/promises';
import { webFile } from './asset-paths.js';

const MAX_BODY_BYTES = 128 * 1024;
// AES-GCM adds a 16-byte tag, a 12-byte IV and base64url framing.
const wireBytes = (bytes: number) => 24 + Math.ceil((bytes + 16) * 4 / 3);
const MAX_TEXT_BYTES = wireBytes(32 * 1024);
const CLOSE_RESERVE_BYTES = MAX_TEXT_BYTES + wireBytes(4096) + 8192;
const MAX_PARTICIPANTS = 32;
const MAX_EVENTS = 2000;
const MAX_ROOM_BYTES = 8 * 1024 * 1024;
const MAX_MUTATIONS = 4096;
const MESSAGE_TYPES = new Set(['message', 'request', 'result', 'progress', 'waiting_for_user']);
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

class MeetingError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status: number, code: string, message: string): never { throw new MeetingError(status, code, message); }
function secret() { return randomBytes(32).toString('base64url'); }
function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function token(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}
function positive(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive integer.`);
  return result;
}
function string(body, field, { required = false, max = MAX_TEXT_BYTES, fallback }: { required?: boolean; max?: number; fallback?: string } = {}) {
  const value = body[field];
  if (value === undefined && !required) return fallback;
  if (typeof value !== 'string' || (required && !value.trim()) || Buffer.byteLength(value) > max) {
    fail(400, 'invalid_request', `${field} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} bytes.`);
  }
  return value;
}
function encryptedString(body, field, { required = false, nonempty = false, max = 32 * 1024 }: { required?: boolean; nonempty?: boolean; max?: number } = {}) {
  const value = string(body, field, { required, max: wireBytes(max) });
  if (value !== undefined && !isEncryptedText(value, max)) fail(400, 'encryption_required', `${field} must be an authenticated end-to-end encrypted string.`);
  if (value !== undefined && nonempty && Buffer.from(value.split('.')[2], 'base64url').length === 16) fail(400, 'invalid_request', `${field} cannot be empty.`);
  return value;
}
function encryption(body) {
  const value = body.encryption;
  if (!value || value.v !== 1 || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)) {
    fail(400, 'encryption_required', 'Meeting creation requires encryption version 1 and a client-generated UUID v4 encryption id.');
  }
  return { v: 1 as const, id: value.id };
}
function identity(body) {
  const name = string(body, 'name', { required: true, max: 256 })!.trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) fail(400, 'invalid_request', 'name must be a single-line display name without control characters.');
  const kind = body.kind === undefined ? 'agent' : body.kind;
  if (!['agent', 'human'].includes(kind)) fail(400, 'invalid_request', 'kind must be agent or human.');
  return { name, kind };
}
function requestId(body) { return string(body, 'requestId', { required: body.requestId !== undefined, max: 128 }); }
function retryTokenHash(body, id) {
  const value = body.retryToken;
  if (id === undefined && value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value
    || equal(value, body.token) || equal(value, id)) {
    fail(400, 'invalid_request', 'Idempotent creation or joining requires a separate private 32-byte base64url retryToken.');
  }
  return createHash('sha256').update(value).digest('hex');
}
function integerParam(parsed, name, fallback, max) {
  const values = parsed.searchParams.getAll(name);
  if (!values.length) return fallback;
  if (values.length !== 1 || !/^\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0])) || Number(values[0]) > max) {
    fail(400, 'invalid_request', `${name} must be an integer between 0 and ${max}.`);
  }
  return Number(values[0]);
}
function iso(time) { return new Date(time).toISOString(); }
function publicParticipant(participant) {
  const { token: unused, authId: unusedAuth, ...result } = participant;
  return result;
}
function write(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(body));
}
function fingerprint(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    fail(413, 'body_too_large', 'Request body exceeds 128 KiB.');
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    function detach() { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); }
    function error(cause) { detach(); reject(cause); }
    function aborted() { error(new Error('Request aborted.')); }
    function end() { detach(); resolve(Buffer.concat(parts)); }
    function data(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        detach(); parts.length = 0; req.resume();
        reject(new MeetingError(413, 'body_too_large', 'Request body exceeds 128 KiB.'));
      } else parts.push(chunk);
    }
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
  let result;
  try { result = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (!result || Array.isArray(result) || typeof result !== 'object') fail(400, 'invalid_request', 'Request body must be a JSON object.');
  return result;
}

/** Capability-authenticated, invitation-based meeting relay. All state lives in memory. */
export function createMeetings(options: MeetingOptions) {
  if (typeof options.getUrl !== 'function') throw new TypeError('getUrl is required.');
  const meetingTtlMs = positive(options.meetingTtlMs, 7_200_000, 'meetingTtlMs');
  const retentionMs = positive(options.retentionMs, 600_000, 'retentionMs');
  const deliveryTtlMs = positive(options.deliveryTtlMs, 300_000, 'deliveryTtlMs');
  const maxMeetings = positive(options.maxMeetings, 1000, 'maxMeetings');
  if (options.serverKey !== undefined && (typeof options.serverKey !== 'string' || !options.serverKey)) throw new TypeError('serverKey must be a nonempty string.');
  const maxParticipants = positive(options.maxParticipants, MAX_PARTICIPANTS, 'maxParticipants');
  const maxRoomBytes = positive(options.maxRoomBytes, MAX_ROOM_BYTES, 'maxRoomBytes');
  const maxTotalBytes = positive(options.maxTotalBytes, Number.MAX_SAFE_INTEGER, 'maxTotalBytes');
  const maxEvents = positive(options.maxEvents, MAX_EVENTS, 'maxEvents');
  const maxOwnerMeetings = positive(options.maxOwnerMeetings, maxMeetings, 'maxOwnerMeetings');
  const rooms = new Map<string, MeetingRoom>();
  const creations = new Map();
  let closing = false;

  function reply(res, status, value) {
    try { options.beforeWrite?.(value, Buffer.byteLength(JSON.stringify(value))); }
    catch (error) { return write(res, error.status || 503, { error: { code: error.code || 'response_budget', message: error.status ? error.message : 'Response budget reached.' } }); }
    return write(res, status, value);
  }

  function summary(room) {
    const started = room.invitationContent;
    const closed = room.state === 'active' ? undefined : [...room.events].reverse().find(event => event.type === 'closed')?.data;
    return {
      id: room.id, encryption: room.encryption, ...(started ? { purpose: started.purpose, context: started.context } : {}), state: room.state, hostId: room.hostId,
      participants: [...room.participants.values()].map(publicParticipant), readyBy: [...room.readyBy],
      createdAt: iso(room.createdAt), expiresAt: iso(room.expiresAt),
      ...(room.closedAt === undefined ? {} : { closedAt: iso(room.closedAt) }),
      purgeAt: iso((room.closedAt ?? room.expiresAt) + retentionMs), retentionMs, deliveryTtlMs,
      ...(closed?.reason === undefined ? {} : { reason: closed.reason }),
      ...(closed?.text === undefined ? {} : { summary: closed.text }),
    };
  }
  function result(room, after = 0) {
    return { meeting: summary(room), events: room.events.filter(event => event.seq > after), nextCursor: room.seq };
  }
  function readableResult(room, after, participant) {
    const value = result(room, after);
    if (participant.id !== 'viewer') return withReceipts(room, value, participant);
    const credentials = [room.inviteToken, ...[...room.participants.values()].map(item => item.token)];
    function redact(item) {
      if (typeof item === 'string') return credentials.reduce((text, credential) => text.replaceAll(credential, '[redacted credential]'), item);
      if (Array.isArray(item)) return item.map(redact);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child)]));
      return item;
    }
    return redact(redactInvitations(value));
  }
  function receiptToken(room, seq, participantId) {
    return createHmac('sha256', room.receiptKey).update(`${seq}:${participantId}`).digest('base64url');
  }
  function withReceipts(room, value, participant) {
    const events = [...(value.events || []), ...(value.event ? [value.event] : [])];
    const deliveryReceipts = events.filter(event => event.data !== undefined && room.deliveries.get(event.seq)?.claims.get(participant.id) === 'pending')
      .map(event => ({ seq: event.seq, token: receiptToken(room, event.seq, participant.id) }));
    return { ...value, deliveryReceipts };
  }
  function eraseBody(room, event, state) {
    if (event.data === undefined) return;
    const before = Buffer.byteLength(JSON.stringify(event));
    delete event.data;
    event.bodyState = state;
    room.bytes += Buffer.byteLength(JSON.stringify(event)) - before;
    room.deliveries.get(event.seq).awaitFirstPeer = false;
  }
  function settleDelivery(room, event) {
    const delivery = room.deliveries.get(event.seq)!;
    if (event.data === undefined || delivery.awaitFirstPeer || [...delivery.claims.values()].includes('pending')) return;
    eraseBody(room, event, delivery.unavailable || [...delivery.claims.values()].includes('unavailable') ? 'recipient_unavailable' : 'delivered');
  }
  function releaseParticipant(room, participantId) {
    for (const event of room.events) {
      const delivery = room.deliveries.get(event.seq)!;
      if (delivery.claims.get(participantId) === 'pending') delivery.claims.set(participantId, 'unavailable');
      if (participantId === room.hostId && delivery.awaitFirstPeer) { delivery.awaitFirstPeer = false; delivery.unavailable = true; }
      settleDelivery(room, event);
    }
  }
  function cleanDeliveries(room, now) {
    for (const participant of room.participants.values()) {
      if (participant.leftAt !== undefined || options.isParticipantAvailable?.(room, participant) === false) releaseParticipant(room, participant.id);
    }
    for (const event of room.events) {
      if (event.data !== undefined && now >= room.deliveries.get(event.seq).expiresAt) eraseBody(room, event, 'expired');
    }
  }
  function append(room: MeetingRoom, type: string, from: string, data: NonNullable<MeetingEvent['data']>, at = Date.now()) {
    const event: MeetingEvent = { seq: ++room.seq, type, from, at: iso(at), data, bodyState: 'pending', bodyExpiresAt: iso(at + deliveryTtlMs) };
    const recipients = [...room.participants.values()].filter(participant => participant.leftAt === undefined && options.isParticipantAvailable?.(room, participant) !== false);
    room.deliveries.set(event.seq, { expiresAt: at + deliveryTtlMs, claims: new Map(recipients.map(participant => [participant.id, 'pending'])), awaitFirstPeer: !room.hadPeer && room.state === 'active' });
    room.events.push(event);
    room.bytes += Buffer.byteLength(JSON.stringify(event)) + 96 + recipients.length * 96;
    options.onEvent?.(room, event);
    return event;
  }
  function wake(room) { for (const poll of [...room.polls]) poll.finish(); }
  function closeRoom(room, state, reason, text, at = Date.now(), from = 'system') {
    if (room.state !== 'active') return;
    room.state = state;
    room.closedAt = at;
    if (room.invitationContent) {
      room.bytes -= Buffer.byteLength(JSON.stringify(room.invitationContent));
      delete room.invitationContent;
    }
    // Invitation content is retained only while active, including its delivery copy.
    if (room.events[0]?.data) eraseBody(room, room.events[0], 'expired');
    for (const event of room.events) {
      const delivery = room.deliveries.get(event.seq)!;
      if (delivery.awaitFirstPeer) { delivery.awaitFirstPeer = false; delivery.unavailable = true; settleDelivery(room, event); }
    }
    return append(room, 'closed', from, { state, reason, ...(text === undefined ? {} : { text }) }, at);
  }
  function expire(room, now = Date.now()) {
    // Expiry is anchored to creation, even if no requests arrive for hours.
    if (room.state === 'active' && now >= room.expiresAt) {
      closeRoom(room, 'expired', 'meeting_timeout', undefined, room.expiresAt);
      wake(room);
    }
  }
  function cleanup() {
    const now = Date.now();
    for (const [id, room] of rooms) {
      expire(room, now);
      cleanDeliveries(room, now);
      if (room.closedAt !== undefined && now >= room.closedAt + retentionMs) {
        wake(room);
        rooms.delete(id);
        if (room.creationId !== undefined) creations.delete(room.creationId);
      }
    }
  }
  function getRoom(id) {
    cleanup();
    const room = rooms.get(id);
    if (!room) fail(404, 'meeting_not_found', 'Meeting does not exist or its retention period has elapsed.');
    options.authorizeRoom?.(room);
    return room;
  }
  function authenticate(req, room, allowView = false) {
    const credential = token(req);
    for (const participant of room.participants.values()) if (equal(credential, participant.token)) {
      options.authorizeParticipant?.(room, participant);
      return participant;
    }
    if (allowView && equal(credential, room.viewToken)) return { id: 'viewer' };
    fail(401, 'unauthorized', `A valid ${allowView ? 'participant or read-only viewer' : 'participant'} Bearer token is required.`);
  }
  function active(room) {
    expire(room);
    if (room.state !== 'active') fail(409, 'meeting_closed', `Meeting is ${room.state}.`);
  }
  function capacity(room, payload, key: string | undefined = undefined, extraMetadataBytes = 0) {
    // Reserve one event and enough bytes for a final summary, even when full.
    const extra = Buffer.byteLength(JSON.stringify(payload)) + CLOSE_RESERVE_BYTES + extraMetadataBytes;
    const total = [...rooms.values()].reduce((sum, item) => sum + item.bytes + CLOSE_RESERVE_BYTES, 0);
    if (room.events.length >= maxEvents - 1 || room.bytes + extra > maxRoomBytes || total + extra > maxTotalBytes) {
      fail(429, 'meeting_capacity_exceeded', 'Meeting message limit reached; the host can end it and start a new meeting.');
    }
    if (key !== undefined && room.mutations.size >= MAX_MUTATIONS) fail(429, 'meeting_capacity_exceeded', 'Meeting request limit reached.');
  }
  function replay(room, key, payload, recoveryHash: string | undefined = undefined) {
    if (key === undefined || !room.mutations.has(key)) return undefined;
    const saved = room.mutations.get(key);
    // requestId identifies an operation, not an identity. Only a client that
    // holds the private recovery capability may recover participant credentials.
    if (saved.retryTokenHash !== undefined && !equal(saved.retryTokenHash, recoveryHash)) fail(401, 'invalid_retry_token', 'A valid private retryToken is required to recover this operation.');
    if (saved.fingerprint !== fingerprint(payload)) fail(409, 'idempotency_conflict', 'requestId was already used with different input.');
    return { ...saved.response, meeting: summary(room), ...(saved.response.participant ? { events: room.events } : {}), nextCursor: room.seq };
  }
  function save(room, key, payload, response, recoveryHash: string | undefined = undefined) {
    // Event objects are shared with the bounded transcript. Do not cache a full
    // growing participant list for every message or readiness update.
    const { meeting: unused, events: unusedEvents, deliveryReceipts: unusedReceipts, ...compact } = response;
    if (key !== undefined) room.mutations.set(key, { fingerprint: fingerprint(payload), response: compact, ...(recoveryHash === undefined ? {} : { retryTokenHash: recoveryHash }) });
    return response;
  }
  function mutationResult(room, event) { return { meeting: summary(room), ...(event ? { event } : {}), nextCursor: room.seq }; }
  function viewUrl(room) { return `${options.getUrl()}/meeting#id=${room.id}&view=${room.viewToken}`; }

  async function route(req: MeetingRequest, res, parsed) {
    if (closing) fail(503, 'relay_closing', 'Relay is shutting down.');
    if (parsed.pathname === '/v1/meetings') {
      if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Use POST to create a meeting.');
      if (options.serverKey !== undefined && !equal(req.headers['x-noknok-key'], options.serverKey)) fail(401, 'unauthorized', 'A valid X-Noknok-Key is required to create meetings.');
      const body = await readBody(req);
      if (closing) fail(503, 'relay_closing', 'Relay is shutting down.');
      const payload = { ...identity(body), encryption: encryption(body), purpose: encryptedString(body, 'purpose', { required: true, nonempty: true, max: 8192 }), context: encryptedString(body, 'context', { required: true, max: 64 * 1024 }) };
      const actor = options.authorizeCreate?.(req, body);
      const rawId = requestId(body);
      const id = rawId === undefined ? undefined : actor ? `${actor.accountId}:${rawId}` : rawId;
      const recoveryHash = retryTokenHash(body, rawId);
      cleanup();
      if (id !== undefined && creations.has(id)) {
        const room = getRoom(creations.get(id));
        const response = replay(room, 'create', payload, recoveryHash);
        return reply(res, 200, withReceipts(room, response, response.participant));
      }
      if (rooms.size >= maxMeetings) fail(503, 'relay_capacity_exceeded', 'Relay meeting limit reached; retry after meetings expire.');
      if (actor && [...rooms.values()].filter(room => room.ownerId === actor.accountId && room.state === 'active').length >= maxOwnerMeetings) fail(429, 'owner_meeting_limit', 'Account has too many open meetings.');
      const invitationContent = { purpose: payload.purpose!, context: payload.context! };
      const invitationBytes = Buffer.byteLength(JSON.stringify(invitationContent));
      const creationBytes = Buffer.byteLength(JSON.stringify(payload)) + invitationBytes + 4096;
      const totalBytes = [...rooms.values()].reduce((sum, room) => sum + room.bytes + CLOSE_RESERVE_BYTES, 0);
      if (creationBytes + CLOSE_RESERVE_BYTES > maxRoomBytes || totalBytes + creationBytes + CLOSE_RESERVE_BYTES > maxTotalBytes) fail(503, 'relay_memory_limit', 'Relay memory budget reached.');
      options.beforeCreate?.(actor);
      const now = Date.now();
      const participant: MeetingParticipant = { id: randomUUID(), name: payload.name, kind: payload.kind, role: 'host', joinedAt: iso(now), token: secret(), ...(actor ? { authId: actor.agentId } : {}) };
      const room: MeetingRoom = {
        id: randomUUID(), encryption: payload.encryption, state: 'active', hostId: participant.id, ...(actor ? { ownerId: actor.accountId, ownerAgentId: actor.agentId } : {}),
        participants: new Map([[participant.id, participant]]), inviteToken: secret(), viewToken: secret(),
        createdAt: now, expiresAt: now + meetingTtlMs, readyBy: new Set(),
        events: [], seq: 0, bytes: Buffer.byteLength(JSON.stringify(publicParticipant(participant))), polls: new Set(), mutations: new Map(), creationId: id,
        deliveries: new Map(), receiptKey: secret(), hadPeer: false, invitationContent,
      };
      room.bytes += invitationBytes;
      append(room, 'started', 'system', { participant: publicParticipant(participant), purpose: payload.purpose, context: payload.context }, now);
      rooms.set(room.id, room);
      const invitationUrl = `${options.getUrl()}/invite/${room.id}#invite=${room.inviteToken}`;
      const response = {
        ...result(room), participant: { ...participant },
        invitationUrl, viewUrl: viewUrl(room),
      };
      if (id !== undefined) { creations.set(id, room.id); save(room, 'create', payload, response, recoveryHash); }
      return reply(res, 201, withReceipts(room, response, participant));
    }
    const match = /^\/v1\/meetings\/([a-zA-Z0-9-]+)(?:\/(invitation|join|events|messages|ready|leave|end|ack))?$/.exec(parsed.pathname);
    if (!match) fail(404, 'not_found', 'Route not found.');
    const [, meetingId, operation] = match;
    const room = getRoom(meetingId);
    if (operation === 'invitation') {
      if (!equal(token(req), room.inviteToken)) fail(401, 'invalid_invitation', 'A valid invitation Bearer token is required.');
      if (req.method !== 'GET') fail(405, 'method_not_allowed', 'Invitation details are read-only.');
      return reply(res, 200, { meeting: summary(room) });
    }
    if (operation === 'join') {
      if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Use POST to join a meeting.');
      const body = await readBody(req);
      getRoom(meetingId);
      if (!equal(string(body, 'token', { required: true, max: 256 }), room.inviteToken)) fail(401, 'invalid_invitation', 'Invitation token is invalid.');
      const payload = identity(body);
      const id = requestId(body);
      const recoveryHash = retryTokenHash(body, id);
      const key = id === undefined ? undefined : `join:${id}`;
      const repeated = replay(room, key, payload, recoveryHash);
      if (repeated) return reply(res, 200, withReceipts(room, repeated, repeated.participant));
      active(room);
      if (room.participants.size >= maxParticipants) fail(429, 'meeting_full', `At most ${maxParticipants} participants can join a meeting.`);
      const firstPeerClaimBytes = room.hadPeer ? 0 : [...room.deliveries.values()].filter(delivery => delivery.awaitFirstPeer).length * 96;
      capacity(room, payload, key, firstPeerClaimBytes);
      const participant: MeetingParticipant = { id: randomUUID(), ...payload, role: 'participant', joinedAt: iso(Date.now()), token: secret(), ...(req.noknokActor ? { authId: req.noknokActor.agentId } : {}) };
      options.authorizeParticipant?.(room, participant);
      room.participants.set(participant.id, participant);
      if (!room.hadPeer) {
        room.hadPeer = true;
        for (const event of room.events) {
          const delivery = room.deliveries.get(event.seq)!;
          if (event.data !== undefined && delivery.awaitFirstPeer) { delivery.awaitFirstPeer = false; delivery.claims.set(participant.id, 'pending'); room.bytes += 96; }
        }
      }
      room.readyBy.clear();
      append(room, 'joined', 'system', { participant: publicParticipant(participant) });
      const response = save(room, key, payload, { ...result(room), participant: { ...participant }, viewUrl: viewUrl(room) }, recoveryHash);
      wake(room);
      return reply(res, 200, withReceipts(room, response, participant));
    }

    const readable = req.method === 'GET' && (operation === undefined || operation === 'events');
    const participant = authenticate(req, room, readable);
    if (readable && operation === undefined) return reply(res, 200, readableResult(room, 0, participant));
    if (readable && operation === 'events') {
      const after = integerParam(parsed, 'after', 0, Number.MAX_SAFE_INTEGER);
      const waitMs = integerParam(parsed, 'waitMs', 25_000, 25_000);
      if (after > room.seq) fail(400, 'invalid_cursor', 'after is beyond the last event sequence.');
      // A waiting poll must not keep a snapshot of purpose/context alive after
      // the corresponding pending body has been acknowledged or expired.
      if (room.events.some(event => event.seq > after) || waitMs === 0 || room.state !== 'active') return reply(res, 200, readableResult(room, after, participant));
      if (room.polls.size >= 64 || [...room.polls].filter(poll => poll.participantId === participant.id).length >= 4) fail(429, 'too_many_polls', 'At most four simultaneous waits per credential and 64 per meeting are allowed.');
      let timer;
      const poll = {
        participantId: participant.id,
        finish() {
          if (!room.polls.delete(poll)) return;
          clearTimeout(timer); res.off('close', disconnected);
          if (closing) reply(res, 503, { error: { code: 'relay_closing', message: 'Relay is shutting down.' } });
          else if (Date.now() >= (room.closedAt ?? room.expiresAt) + retentionMs) reply(res, 404, { error: { code: 'meeting_not_found', message: 'Meeting does not exist or its retention period has elapsed.' } });
          else {
            try { getRoom(meetingId); authenticate(req, room, true); reply(res, 200, readableResult(room, after, participant)); }
            catch (error) { reply(res, error.status || 500, { error: { code: error.code || 'internal_error', message: error.status ? error.message : 'Meeting access failed.' } }); }
          }
        },
      };
      function disconnected() { room.polls.delete(poll); clearTimeout(timer); }
      room.polls.add(poll);
      res.once('close', disconnected);
      const waitDeadline = performance.now() + waitMs;
      function timeout() {
        if (!room.polls.has(poll)) return;
        const remaining = Math.min(waitDeadline - performance.now(), room.expiresAt - Date.now());
        // Timer delivery can precede the wall-clock expiry by a millisecond.
        // Keep waiting until expiry or the monotonic request deadline is reached.
        if (remaining > 0) { timer = setTimeout(timeout, Math.ceil(remaining)); return; }
        expire(room);
        poll.finish();
      }
      timeout();
      return;
    }

    if (operation === 'ack') {
      if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Use POST to acknowledge delivery.');
      const body = await readBody(req);
      getRoom(meetingId);
      authenticate(req, room, false);
      if (!Array.isArray(body.receipts) || body.receipts.length > maxEvents) fail(400, 'invalid_request', `receipts must be an array of at most ${maxEvents} delivery receipts.`);
      // Validate the entire batch before changing claims. A receipt is scoped to
      // an event and participant, and only returned together with that body.
      for (const receipt of body.receipts) {
        if (!receipt || !Number.isSafeInteger(receipt.seq) || receipt.seq < 1 || !room.deliveries.get(receipt.seq)?.claims.has(participant.id)
          || !equal(receipt.token, receiptToken(room, receipt.seq, participant.id))) fail(400, 'invalid_receipt', 'A delivery receipt for this participant and event is required.');
      }
      const acknowledged = [...new Set<number>(body.receipts.map(receipt => receipt.seq))];
      for (const seq of acknowledged) {
        const delivery = room.deliveries.get(seq)!;
        if (delivery.claims.get(participant.id) === 'pending') delivery.claims.set(participant.id, 'acknowledged');
        settleDelivery(room, room.events[seq - 1]);
      }
      return reply(res, 200, { meeting: summary(room), acknowledged, nextCursor: room.seq });
    }

    if (req.method !== 'POST' || !['messages', 'ready', 'leave', 'end'].includes(operation)) fail(405, 'method_not_allowed', 'Method is not supported for this route.');
    if (operation === 'end' && participant.role !== 'host') fail(403, 'host_required', 'Only the meeting host can end the meeting.');
    if (operation === 'leave' && participant.role === 'host') fail(409, 'host_must_end', 'The host must end the meeting instead of leaving.');
    const body = await readBody(req);
    getRoom(meetingId);
    authenticate(req, room, false); // A revocation may happen while the request body arrives.
    const id = requestId(body);
    const key = id === undefined ? undefined : `${participant.id}:${operation}:${id}`;
    let payload;
    if (operation === 'messages') {
      const type = body.type === undefined ? 'message' : body.type;
      if (!MESSAGE_TYPES.has(type)) fail(400, 'invalid_request', `type must be one of: ${[...MESSAGE_TYPES].join(', ')}.`);
      payload = { type, text: encryptedString(body, 'text', { required: true, nonempty: true }) };
      if (body.replyTo !== undefined) {
        if (!Number.isSafeInteger(body.replyTo) || body.replyTo < 1) fail(400, 'invalid_request', 'replyTo must reference an existing message sequence.');
        payload.replyTo = body.replyTo;
      }
      if (body.to !== undefined) payload.to = string(body, 'to', { required: true, max: 128 });
    } else if (operation === 'ready') {
      if (typeof body.ready !== 'boolean') fail(400, 'invalid_request', 'ready must be a boolean.');
      payload = { ready: body.ready };
    } else if (operation === 'end') {
      payload = { text: encryptedString(body, 'text'), reason: encryptedString(body, 'reason', { required: true, max: 4096 }) };
    } else payload = {};
    const repeated = replay(room, key, payload);
    if (repeated) return reply(res, 200, withReceipts(room, repeated, participant));
    active(room);
    if (participant.leftAt !== undefined) fail(403, 'participant_left', 'A participant who has left can read but cannot change the meeting.');
    if (operation !== 'end') capacity(room, payload, key);
    options.beforeMutation?.(room, participant, operation);
    let event;
    if (operation === 'messages') {
      if (payload.replyTo !== undefined && !MESSAGE_TYPES.has(room.events.find(item => item.seq === payload.replyTo)?.type ?? '')) fail(400, 'invalid_request', 'replyTo must reference an existing message sequence.');
      if (payload.to !== undefined) {
        const target = room.participants.get(payload.to);
        if (!target || target.leftAt !== undefined) fail(400, 'invalid_request', 'to must identify a current meeting participant.');
      }
      room.readyBy.clear();
      const { type, ...data } = payload;
      event = append(room, type, participant.id, data);
    } else if (operation === 'ready') {
      if (payload.ready) room.readyBy.add(participant.id); else room.readyBy.delete(participant.id);
      event = append(room, 'ready', participant.id, payload);
    } else if (operation === 'leave') {
      participant.leftAt = iso(Date.now());
      releaseParticipant(room, participant.id);
      room.readyBy.clear();
      event = append(room, 'left', 'system', { participant: publicParticipant(participant) });
    } else event = closeRoom(room, 'ended', payload.reason, payload.text, Date.now(), participant.id);
    const response = save(room, key, payload, mutationResult(room, event));
    wake(room);
    return reply(res, 200, withReceipts(room, response, participant));
  }

  const timer = setInterval(cleanup, Math.max(10, Math.min(1000, meetingTtlMs, retentionMs, deliveryTtlMs)));
  timer.unref();
  return {
    async handle(req, res, parsed) {
      if (/^\/invite\/[a-zA-Z0-9-]+$/.test(parsed.pathname) && ['GET', 'HEAD'].includes(req.method)) {
        // Static setup instructions contain no room credentials or plaintext goal.
        // The browser retrieves encrypted details using the fragment capability.
        const asset = await readFile(webFile('meeting.html'));
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Frame-Options': 'DENY' });
        res.end(req.method === 'HEAD' ? undefined : asset);
        return true;
      }
      if (parsed.pathname !== '/v1/meetings' && !parsed.pathname.startsWith('/v1/meetings/')) return false;
      try { await route(req, res, parsed); }
      catch (error) {
        if (error instanceof MeetingError || (Number.isInteger(error.status) && error.status >= 400 && error.status < 600)) reply(res, error.status, { error: { code: error.code, message: error.message } });
        else reply(res, 500, { error: { code: 'internal_error', message: 'Unexpected meeting relay error.' } });
      }
      return true;
    },
    inspect(id) { cleanup(); const room = rooms.get(id); return room ? { ...summary(room), ownerId: room.ownerId, ownerAgentId: room.ownerAgentId } : undefined; },
    stats() { cleanup(); return { rooms: rooms.size, bytes: [...rooms.values()].reduce((n, room) => n + room.bytes, 0) }; },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      for (const room of rooms.values()) wake(room);
      rooms.clear(); creations.clear();
    },
  };
}
