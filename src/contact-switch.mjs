import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_AGENTS = 1000;
const MAX_CONTACTS = 100;
const MAX_EVENTS = 100;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_INVITES = 2000;
const MAX_AGENT_INVITES = 16;
const MAX_MUTATIONS = 256;
const AGENT_ID = /^ag_[a-f0-9]{64}$/;
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const FIELDS = {
  register: ['name', 'contacts'], invite: ['requestId'], add: ['inviteId', 'inviteToken', 'requestId'],
  poll: ['after', 'waitMs'], ack: ['through'], ready: ['enabled'], deliver: ['recipientId', 'invitation', 'requestId'],
};

class ContactError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new ContactError(status, code, message); }
function unavailable() { fail(404, 'contact_unavailable', 'Contact is unavailable.'); }
function isToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function equalToken(left, right) {
  return isToken(left) && isToken(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
export function contactAgentId(token) {
  if (!isToken(token)) throw new TypeError('A canonical 32-byte base64url identity token is required.');
  return `ag_${createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex')}`;
}
function write(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(value));
}
function integer(value, fallback, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(400, 'invalid_request', `${field} is invalid.`);
  return value;
}
function string(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) fail(400, 'invalid_request', `${field} is invalid.`);
  return value;
}
function publicAgent(agent) { return { id: agent.id, name: agent.name }; }
function positive(value, fallback, field) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be a positive integer.`);
  return result;
}
async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    fail(413, 'body_too_large', 'Request body exceeds 32 KiB.');
  }
  const bytes = await new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    function detach() { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); }
    function error(cause) { detach(); reject(cause); }
    function aborted() { error(new Error('Request aborted.')); }
    function end() { detach(); resolve(Buffer.concat(parts)); }
    function data(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        detach(); parts.length = 0; req.resume();
        reject(new ContactError(413, 'body_too_large', 'Request body exceeds 32 KiB.'));
      } else parts.push(chunk);
    }
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'invalid_request', 'Request body must be a JSON object.');
  if (!Object.hasOwn(FIELDS, body.op) || Object.keys(body).some(key => key !== 'op' && !FIELDS[body.op].includes(key))) fail(400, 'invalid_request', 'Unsupported contact operation or field.');
  return body;
}

/** In-memory routing only. Identities, contacts and conversation history belong to local clients. */
export function createContactSwitch(options) {
  if (typeof options?.getUrl !== 'function') throw new TypeError('getUrl is required.');
  const now = options.now ?? Date.now;
  const leaseMs = positive(options.leaseMs, 90_000, 'leaseMs');
  const inviteTtlMs = positive(options.inviteTtlMs, 900_000, 'inviteTtlMs');
  const retentionMs = positive(options.retentionMs, 1_800_000, 'retentionMs');
  const instanceId = randomUUID();
  const agents = new Map();
  const invites = new Map();
  let closed = false;

  function cleanup() {
    const time = now();
    for (const [id, invite] of invites) if (invite.expiresAt <= time) invites.delete(id);
    for (const [id, agent] of agents) {
      for (const [key, mutation] of agent.mutations) if (mutation.expiresAt <= time) agent.mutations.delete(key);
      if (agent.lastSeen + retentionMs <= time && agent.polls.size === 0) agents.delete(id);
    }
  }
  function touch(agent) { agent.lastSeen = now(); agent.leaseExpiresAt = agent.lastSeen + leaseMs; }
  function result(agent, after) { return { events: agent.events.filter(item => item.seq > after), nextCursor: agent.seq, ...(closed ? { closed: true } : {}) }; }
  function wake(agent) { for (const poll of [...agent.polls]) poll.finish(); }
  function eventCapacity(agent, value) {
    if (agent.events.length >= MAX_EVENTS || agent.eventBytes + Buffer.byteLength(JSON.stringify(value)) + 128 > MAX_EVENT_BYTES) fail(429, 'contact_capacity_exceeded', 'Contact inbox limit reached.');
  }
  function enqueue(agent, value) {
    const item = { seq: ++agent.seq, ...value };
    agent.events.push(item);
    agent.eventBytes += Buffer.byteLength(JSON.stringify(item));
    wake(agent);
    return item;
  }
  function replay(agent, op, requestId, payload) {
    const key = `${op}:${requestId}`;
    const saved = agent.mutations.get(key);
    if (saved) {
      if (saved.payload !== JSON.stringify(payload)) fail(409, 'idempotency_conflict', 'requestId was already used with different input.');
      return saved.response;
    }
    if (agent.mutations.size >= MAX_MUTATIONS) fail(429, 'contact_capacity_exceeded', 'Contact operation limit reached; retry later.');
    return undefined;
  }
  function save(agent, op, requestId, payload, response, expiresAt = now() + retentionMs) {
    agent.mutations.set(`${op}:${requestId}`, { payload: JSON.stringify(payload), response, expiresAt });
    return response;
  }
  function validateInvitation(value) {
    string(value, 8192, 'invitation');
    try {
      const match = /^agentcall:\/\/invite\/([A-Za-z0-9_-]+)$/.exec(value);
      if (!match) throw new Error();
      const encoded = Buffer.from(match[1], 'base64url');
      if (encoded.toString('base64url') !== match[1]) throw new Error();
      const decoded = JSON.parse(encoded.toString('utf8'));
      if (decoded.v !== 1 || decoded.server !== options.getUrl() || !CALL_ID.test(decoded.callId)
        || !isToken(decoded.token) || !Number.isFinite(Date.parse(decoded.expiresAt)) || Date.parse(decoded.expiresAt) <= now()) throw new Error();
    } catch { fail(400, 'invalid_invitation', 'A current invitation from this relay is required.'); }
  }

  async function execute(req, res) {
    if (closed) fail(503, 'contact_switch_closed', 'Contact switch is shutting down.');
    if (req.headers.origin !== undefined) fail(403, 'origin_not_allowed', 'Browser-origin requests are not allowed.');
    if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Use POST for contact operations.');
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!isToken(token)) fail(401, 'unauthorized', 'A valid identity Bearer token is required.');
    const id = contactAgentId(token);
    const body = await readBody(req);
    cleanup();
    let agent = agents.get(id);
    if (body.op === 'register') {
      const name = string(body.name, 256, 'name').trim();
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) fail(400, 'invalid_request', 'name must be a single-line display name.');
      if (!Array.isArray(body.contacts) || body.contacts.length > MAX_CONTACTS || body.contacts.some(peer => typeof peer !== 'string' || !AGENT_ID.test(peer) || peer === id)) fail(400, 'invalid_request', 'contacts must contain valid peer IDs.');
      if (!agent) {
        if (agents.size >= MAX_AGENTS) fail(503, 'contact_capacity_exceeded', 'Contact registration limit reached.');
        agent = { id, name, generation: randomUUID(), contacts: new Set(), seq: 0, events: [], eventBytes: 0, polls: new Set(), mutations: new Map() };
        agents.set(id, agent);
      }
      agent.name = name;
      // A renewal using the local snapshot can race invitation acceptance. Keep
      // unacknowledged grants until the client has durably saved the new contact.
      const contacts = new Set([...body.contacts, ...agent.events.filter(item => item.type === 'contact_added').map(item => item.contact.id)]);
      if (contacts.size > MAX_CONTACTS) fail(429, 'contact_capacity_exceeded', 'Contact list limit reached.');
      agent.contacts = contacts;
      touch(agent);
      return write(res, 200, { agent: publicAgent(agent), instanceId: `${instanceId}:${agent.generation}`, leaseMs, leaseExpiresAt: new Date(agent.leaseExpiresAt).toISOString() });
    }
    if (!agent) fail(409, 'registration_required', 'Register this identity before using contacts.');
    touch(agent);
    if (body.op === 'ready') {
      if (typeof body.enabled !== 'boolean') fail(400, 'invalid_request', 'enabled must be boolean.');
      agent.receiverReadyUntil = body.enabled ? now() + leaseMs : 0;
      return write(res, 200, { readyUntil: agent.receiverReadyUntil });
    }
    if (body.op === 'poll') {
      const after = integer(body.after, 0, Number.MAX_SAFE_INTEGER, 'after');
      const waitMs = integer(body.waitMs, 0, 25_000, 'waitMs');
      if (after > agent.seq) fail(400, 'invalid_cursor', 'after is beyond the current inbox sequence; register again to check the instance.');
      if (agent.events.some(item => item.seq > after) || waitMs === 0) return write(res, 200, result(agent, after));
      if (agent.polls.size) fail(429, 'too_many_polls', 'Only one active receive wait per identity is allowed.');
      let timer;
      const poll = { finish() {
        if (!agent.polls.delete(poll)) return;
        clearTimeout(timer); res.off('close', disconnect);
        write(res, 200, result(agent, after));
      } };
      function disconnect() { agent.polls.delete(poll); clearTimeout(timer); }
      agent.polls.add(poll);
      res.once('close', disconnect);
      timer = setTimeout(() => poll.finish(), waitMs);
      return;
    }
    if (body.op === 'ack') {
      const through = integer(body.through, undefined, agent.seq, 'through');
      if (through === undefined) fail(400, 'invalid_request', 'through is required.');
      agent.events = agent.events.filter(item => item.seq > through);
      agent.eventBytes = agent.events.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
      return write(res, 200, { ackedThrough: through });
    }
    const requestId = string(body.requestId, 128, 'requestId');
    if (body.op === 'invite') {
      const repeated = replay(agent, body.op, requestId, {});
      if (repeated) return write(res, 200, repeated);
      if (invites.size >= MAX_INVITES || [...invites.values()].filter(item => item.ownerId === id).length >= MAX_AGENT_INVITES) fail(429, 'contact_capacity_exceeded', 'Contact invitation limit reached.');
      const inviteId = randomUUID();
      const inviteToken = randomBytes(32).toString('base64url');
      const expiresAt = now() + inviteTtlMs;
      const encoded = Buffer.from(JSON.stringify({ v: 1, server: options.getUrl(), inviteId, token: inviteToken, expiresAt: new Date(expiresAt).toISOString() })).toString('base64url');
      const response = { contactLink: `agentcall://contact/${encoded}`, expiresAt: new Date(expiresAt).toISOString(), agent: publicAgent(agent) };
      invites.set(inviteId, { ownerId: id, token: inviteToken, expiresAt });
      return write(res, 200, save(agent, body.op, requestId, {}, response, expiresAt));
    }
    if (body.op === 'add') {
      const payload = { inviteId: body.inviteId, inviteToken: body.inviteToken };
      const repeated = replay(agent, body.op, requestId, payload);
      if (repeated) return write(res, 200, repeated);
      const invite = typeof body.inviteId === 'string' ? invites.get(body.inviteId) : undefined;
      const owner = invite ? agents.get(invite.ownerId) : undefined;
      if (!invite || !owner || invite.consumed || owner === agent || !equalToken(body.inviteToken, invite.token)) unavailable();
      if ((!agent.contacts.has(owner.id) && agent.contacts.size >= MAX_CONTACTS) || (!owner.contacts.has(agent.id) && owner.contacts.size >= MAX_CONTACTS)) fail(429, 'contact_capacity_exceeded', 'Contact list limit reached.');
      const event = { type: 'contact_added', contact: publicAgent(agent) };
      eventCapacity(owner, event);
      invite.consumed = true;
      agent.contacts.add(owner.id); owner.contacts.add(agent.id);
      enqueue(owner, event);
      return write(res, 200, save(agent, body.op, requestId, payload, { contact: publicAgent(owner) }));
    }
    if (body.op === 'deliver') {
      const payload = { recipientId: body.recipientId, invitation: body.invitation };
      const repeated = replay(agent, body.op, requestId, payload);
      if (repeated) return write(res, 200, repeated);
      const recipient = typeof body.recipientId === 'string' ? agents.get(body.recipientId) : undefined;
      if (!recipient || !agent.contacts.has(recipient.id) || !recipient.contacts.has(agent.id)
        || recipient.leaseExpiresAt <= now() || (recipient.polls.size === 0 && !(recipient.receiverReadyUntil > now()))) unavailable();
      validateInvitation(body.invitation);
      const event = { type: 'incoming_call', from: publicAgent(agent), invitation: body.invitation };
      eventCapacity(recipient, event);
      enqueue(recipient, event);
      return write(res, 200, save(agent, body.op, requestId, payload, { delivered: true, recipientId: recipient.id }));
    }
  }

  const cleanupTimer = setInterval(cleanup, 1000);
  cleanupTimer.unref();
  return {
    async handle(req, res, url) {
      if (url.pathname !== '/v1/contacts') return false;
      try {
        if (url.search) fail(400, 'invalid_request', 'Contact operations do not accept query parameters.');
        await execute(req, res);
      } catch (error) {
        if (error instanceof ContactError) write(res, error.status, { error: { code: error.code, message: error.message } });
        else write(res, 500, { error: { code: 'internal_error', message: 'Unexpected contact switch error.' } });
      }
      return true;
    },
    close() {
      closed = true;
      clearInterval(cleanupTimer);
      for (const agent of agents.values()) wake(agent);
      agents.clear(); invites.clear();
    },
  };
}
