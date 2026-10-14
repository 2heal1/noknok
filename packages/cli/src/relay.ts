import type { AddressInfo } from 'node:net';
import { webFile } from './asset-paths.js';
import type { RelayOptions } from './runtime-types.js';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { invitationDetails, invitationUrl, redactInvitations, sessionViewUrl } from './invitation.js';
import { createContactSwitch } from './contact-switch.js';
import { createMeetings } from './meetings.js';

const MAX_BODY_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_EVENTS = 2000;
const MAX_CALL_BYTES = 8 * 1024 * 1024;
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_TYPES = new Set(['message', 'request', 'result', 'progress', 'waiting_for_user']);
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'expired']);
const WEB_ASSETS = new Map([
  ['/view', ['index.html', 'text/html; charset=utf-8']],
  ['/view/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/meeting', ['meeting.html', 'text/html; charset=utf-8']],
  ['/meeting/', ['meeting.html', 'text/html; charset=utf-8']],
  ['/meeting.js', ['meeting.js', 'text/javascript; charset=utf-8']],
  ['/meeting-invitation.js', ['meeting-invitation.js', 'text/javascript; charset=utf-8']],
  ['/meeting.css', ['meeting.css', 'text/css; charset=utf-8']],
]);
const WEB_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
function secret() { return randomBytes(32).toString('base64url'); }
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function bearerToken(req) {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
}
function iso(time) { return new Date(time).toISOString(); }
function stringField(body, key, { required = false, maxBytes = MAX_TEXT_BYTES, fallback }: { required?: boolean; maxBytes?: number; fallback?: string } = {}) {
  const value = body[key];
  if (value === undefined && !required) return fallback;
  if (typeof value !== 'string' || (required && !value.trim()) || Buffer.byteLength(value) > maxBytes) {
    fail(400, 'invalid_request', `${key} must be ${required ? 'a nonempty' : 'a'} string of at most ${maxBytes} bytes.`);
  }
  return value;
}
function fromField(body) {
  const value = stringField(body, 'from', { maxBytes: 256, fallback: '匿名' })!;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) fail(400, 'invalid_request', 'from must be a single-line display name without control characters.');
  return value.trim() || '匿名';
}
function requestId(body) {
  return stringField(body, 'requestId', { maxBytes: 128 });
}
function replyTo(body) {
  if (body.replyTo === undefined) return undefined;
  if (!Number.isSafeInteger(body.replyTo) || body.replyTo < 1) fail(400, 'invalid_request', 'replyTo must be a positive event sequence number.');
  return body.replyTo;
}
function parseInteger(value, fallback, max, label) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    fail(400, 'invalid_request', `${label} must be an integer between 0 and ${max}.`);
  }
  return Number(value);
}
function positiveOption(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}
function validatePublicUrl(value) {
  if (value === undefined) return undefined;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('publicUrl must be an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('publicUrl must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  return url.origin;
}
function summary(call) {
  return {
    id: call.id,
    state: call.state,
    from: call.from,
    purpose: call.purpose,
    context: call.context,
    participants: {
      caller: { name: call.caller.name },
      callee: call.callee ? { name: call.callee.name } : null,
    },
    createdAt: iso(call.createdAt),
    expiresAt: iso(call.expiresAt),
    ...(call.connectedAt === undefined ? {} : { connectedAt: iso(call.connectedAt) }),
    ...(call.closedAt === undefined ? {} : { closedAt: iso(call.closedAt) }),
    ...(call.reason === undefined ? {} : { reason: call.reason }),
    doneBy: [...call.doneBy],
  };
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    fail(413, 'body_too_large', 'Request body exceeds 128 KiB.');
  }
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const parts: Buffer[] = [];
    let length = 0;
    function detach() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    }
    function onError(error) { detach(); reject(error); }
    function onAborted() { onError(new Error('Request aborted.')); }
    function onEnd() { detach(); resolve(parts); }
    function onData(chunk) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        detach();
        parts.length = 0;
        req.resume();
        reject(new HttpError(413, 'body_too_large', 'Request body exceeds 128 KiB.'));
      } else parts.push(chunk);
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (body === null || Array.isArray(body) || typeof body !== 'object') fail(400, 'invalid_request', 'Request body must be a JSON object.');
  return body;
}

/** Start the in-memory NokNok relay. `close()` also resolves active long polls. */
export async function startRelay(options: RelayOptions = {}) {
  const inviteTtlMs = positiveOption(options.inviteTtlMs, 300_000, 'inviteTtlMs');
  const idleTtlMs = positiveOption(options.idleTtlMs, 7_200_000, 'idleTtlMs');
  const retentionMs = positiveOption(options.retentionMs, 600_000, 'retentionMs');
  const maxCalls = positiveOption(options.maxCalls, 1000, 'maxCalls');
  const publicUrl = validatePublicUrl(options.publicUrl);
  if (options.serverKey !== undefined && (typeof options.serverKey !== 'string' || !options.serverKey)) throw new TypeError('serverKey must be a nonempty string.');
  const calls = new Map();
  const creations = new Map();
  let url;
  let closing = false;
  let cleanupTimer;
  const contactSwitch = options.contacts === true ? createContactSwitch({ getUrl: () => url }) : undefined;
  const meetings = createMeetings({ getUrl: () => url, meetingTtlMs: options.meetingTtlMs, retentionMs, maxMeetings: options.maxMeetings, serverKey: options.serverKey });

  function write(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...WEB_HEADERS });
    res.end(JSON.stringify(value));
  }

  function viewSource(call) {
    return {
      kind: 'relay', readOnly: true, storage: 'memory', retentionMs,
      availableUntil: call.closedAt === undefined ? null : iso(call.closedAt + retentionMs),
    };
  }

  function viewDetails(call) {
    return redactInvitations({
      call: {
        ...summary(call), key: call.id, callId: call.id, server: url,
        lastActivityAt: iso(call.closedAt ?? call.lastActiveAt),
        messageCount: call.events.filter(item => item.from !== 'system').length,
        eventCount: call.events.length, localSessionCount: 0, coverage: 'relay',
        preview: [...call.events].reverse().find(item => item.from !== 'system' && item.data.text)?.data.text.slice(0, 240) || '',
      },
      sessions: [], events: call.events, warnings: [], source: viewSource(call),
    });
  }

  function pollResult(call, role, after) {
    return { call: summary(call), events: call.events.filter(event => event.seq > after && event.from !== role), nextCursor: call.seq };
  }

  function wake(call) {
    for (const poll of [...call.polls]) poll.finish();
  }

  function event(call, type, from, data) {
    const item = { seq: ++call.seq, type, from, at: iso(Date.now()), data };
    call.events.push(item);
    call.bytes += Buffer.byteLength(JSON.stringify(item));
    return item;
  }

  function end(call, state, reason, now = Date.now()) {
    if (TERMINAL_STATES.has(call.state)) return;
    call.state = state;
    call.closedAt = now;
    call.reason = reason;
    event(call, 'closed', 'system', { state, reason });
    wake(call);
  }

  function expire(call, now = Date.now()) {
    if (call.state === 'waiting' && now >= call.expiresAt) end(call, 'expired', 'invitation_timeout', now);
    if (call.state === 'connected' && now >= call.lastActiveAt + idleTtlMs) end(call, 'expired', 'idle_timeout', now);
  }

  function cleanup() {
    const now = Date.now();
    for (const [id, call] of calls) {
      expire(call, now);
      if (call.closedAt !== undefined && now >= call.closedAt + retentionMs) {
        wake(call);
        calls.delete(id);
        if (call.creationId !== undefined) creations.delete(call.creationId);
      }
    }
  }

  function getCall(id) {
    const call = calls.get(id);
    if (!call) fail(404, 'call_not_found', 'Call does not exist or its retention period has elapsed.');
    expire(call);
    return call;
  }

  function authenticate(req, call) {
    const token = bearerToken(req);
    if (sameSecret(token, call.caller.token)) return 'caller';
    if (call.callee && sameSecret(token, call.callee.token)) return 'callee';
    fail(401, 'unauthorized', 'A valid participant Bearer token is required.');
  }

  function replay(map, key, payload, call) {
    if (key === undefined || !map.has(key)) return undefined;
    const saved = map.get(key);
    if (saved.payload !== JSON.stringify(payload)) fail(409, 'idempotency_conflict', 'requestId was already used with different input.');
    return { ...saved.response, call: summary(call) };
  }

  function save(map, key, payload, response) {
    if (key !== undefined) map.set(key, { payload: JSON.stringify(payload), response });
    return response;
  }

  function mutationKey(role, operation, id) {
    return id === undefined ? undefined : `${role}:${operation}:${id}`;
  }

  function connected(call) {
    if (call.state !== 'connected') fail(409, 'call_not_connected', `Call is ${call.state}.`);
  }

  function capacity(call, data) {
    if (call.events.length >= MAX_EVENTS || call.bytes + Buffer.byteLength(JSON.stringify(data)) + 512 > MAX_CALL_BYTES) {
      fail(429, 'call_capacity_exceeded', 'Call message limit reached; hang up and start a new call.');
    }
  }

  async function handle(req, res) {
    if (closing) fail(503, 'relay_closing', 'Relay is shutting down.');
    const parsed = new URL(req.url, 'http://relay.invalid');
    if (options.extension && await options.extension(req, res, parsed)) return;
    if (parsed.pathname === '/v1/meetings' || parsed.pathname.startsWith('/v1/meetings/')) {
      await meetings.handle(req, res, parsed);
      return;
    }
    if (contactSwitch && await contactSwitch.handle(req, res, parsed)) return;
    if (req.method === 'GET' && parsed.pathname === '/health') return write(res, 200, { ok: true, version: 1 });
    if (['GET', 'HEAD'].includes(req.method) && ['/', '/index.html'].includes(parsed.pathname)) {
      res.writeHead(302, { Location: '/meeting', ...WEB_HEADERS });
      return res.end();
    }
    if (WEB_ASSETS.has(parsed.pathname)) {
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'method_not_allowed', 'Viewer assets are read-only.');
      const [filename, contentType] = WEB_ASSETS.get(parsed.pathname)!;
      const asset = await readFile(webFile(filename));
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': asset.length, ...WEB_HEADERS });
      return res.end(req.method === 'HEAD' ? undefined : asset);
    }
    const invitationMatch = /^\/invite\/([a-zA-Z0-9-]+)$/.exec(parsed.pathname);
    if (invitationMatch) {
      // Authenticate before revealing call existence or expiry. Fetching details
      // neither redeems the invitation nor refreshes its lifetime.
      const call = calls.get(invitationMatch[1]);
      if (!call || parsed.searchParams.getAll('key').length !== 1 || !sameSecret(parsed.searchParams.get('key'), call.inviteToken)) {
        fail(401, 'invalid_invitation', 'A valid invitation link is required.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'method_not_allowed', 'Invitation details are read-only.');
      expire(call);
      const details = Buffer.from(invitationDetails(call, url));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': details.length, ...WEB_HEADERS });
      return res.end(req.method === 'HEAD' ? undefined : details);
    }
    if (parsed.pathname === '/v1/session-view') {
      if (req.method !== 'GET') fail(405, 'method_not_allowed', 'The viewer is read-only.');
      const session = bearerToken(req);
      const call = typeof session === 'string' && SESSION_PATTERN.test(session) ? calls.get(session) : undefined;
      if (!call) fail(401, 'unauthorized', 'A valid read-only session is required.');
      // Possession of the shared session grants read-only access. Reading never
      // redeems the separate invitation or refreshes conversation activity.
      expire(call);
      return write(res, 200, viewDetails(call));
    }
    const viewMatch = /^\/v1\/views\/([a-zA-Z0-9-]+)$/.exec(parsed.pathname);
    if (viewMatch) {
      const call = getCall(viewMatch[1]);
      if (!sameSecret(bearerToken(req), call.viewToken)) fail(401, 'unauthorized', 'A valid read-only viewer Bearer token is required.');
      if (req.method !== 'GET') fail(405, 'method_not_allowed', 'The viewer is read-only.');
      return write(res, 200, viewDetails(call));
    }
    if (req.method === 'POST' && parsed.pathname === '/v1/calls') {
      if (options.serverKey !== undefined && !sameSecret(req.headers['x-noknok-key'], options.serverKey)) fail(401, 'unauthorized', 'A valid X-Noknok-Key is required to create calls.');
      const body = await readBody(req);
      const payload = {
        name: stringField(body, 'name', { required: true, maxBytes: 256 }),
        from: fromField(body),
        purpose: stringField(body, 'purpose', { required: true, maxBytes: 8192 }),
        context: stringField(body, 'context', { maxBytes: 64 * 1024, fallback: '' }),
      };
      const id = requestId(body);
      cleanup();
      if (id !== undefined && creations.has(id)) {
        const call = getCall(creations.get(id));
        return write(res, 200, replay(call.mutations, 'create', payload, call));
      }
      if (calls.size >= maxCalls) fail(503, 'relay_capacity_exceeded', 'Relay call limit reached; retry after calls expire.');
      const now = Date.now();
      const call = {
        id: randomUUID(), state: 'waiting', ...payload,
        caller: { name: payload.name, token: secret() }, callee: null,
        inviteToken: secret(), viewToken: `acv_${secret()}`, createdAt: now, expiresAt: now + inviteTtlMs,
        lastActiveAt: now, doneBy: new Set(), events: [], polls: new Set(),
        seq: 0, bytes: 0, mutations: new Map(), creationId: id,
      };
      const encoded = Buffer.from(JSON.stringify({ v: 1, server: url, callId: call.id, token: call.inviteToken, expiresAt: iso(call.expiresAt) })).toString('base64url');
      const response = {
        call: summary(call), participant: { role: 'caller', token: call.caller.token },
        invitation: `noknok://invite/${encoded}`, invitationUrl: invitationUrl(url, call),
        viewSession: call.id, viewUrl: sessionViewUrl(url, call.id),
      };
      calls.set(call.id, call);
      if (id !== undefined) {
        creations.set(id, call.id);
        save(call.mutations, 'create', payload, response);
      }
      return write(res, 201, response);
    }

    const match = /^\/v1\/calls\/([a-zA-Z0-9-]+)(?:\/(join|events|messages|finish|hangup|view))?$/.exec(parsed.pathname);
    if (!match) fail(404, 'not_found', 'Route not found.');
    const [, callId, operation] = match;
    const call = getCall(callId);

    if (req.method === 'POST' && operation === 'join') {
      const body = await readBody(req);
      const payload = { token: stringField(body, 'token', { required: true, maxBytes: 256 }), name: stringField(body, 'name', { required: true, maxBytes: 256 }) };
      const id = requestId(body);
      if (!sameSecret(payload.token, call.inviteToken)) fail(401, 'invalid_invitation', 'Invitation token is invalid.');
      const key = mutationKey('callee', 'join', id);
      const repeated = replay(call.mutations, key, payload, call);
      if (repeated) return write(res, 200, repeated);
      expire(call);
      if (call.state !== 'waiting') fail(409, 'invitation_unavailable', `Invitation cannot be accepted because call is ${call.state}.`);
      const now = Date.now();
      call.callee = { name: payload.name, token: secret() };
      call.state = 'connected';
      call.connectedAt = now;
      call.lastActiveAt = now;
      event(call, 'joined', 'system', { participants: summary(call).participants });
      const response = save(call.mutations, key, payload, { call: summary(call), participant: { role: 'callee', token: call.callee.token } });
      wake(call);
      return write(res, 200, response);
    }

    const role = authenticate(req, call);
    if (req.method === 'POST' && operation === 'view') {
      // Requesting another link does not revoke legacy viewer capabilities,
      // consume events, or count as conversation activity.
      const source = viewSource(call);
      return write(res, 200, {
        callId: call.id, viewSession: call.id, viewUrl: sessionViewUrl(url, call.id),
        url: `${url}/view#call=${encodeURIComponent(call.id)}&token=${encodeURIComponent(call.viewToken)}`,
        readOnly: source.readOnly, storage: source.storage, retentionMs, availableUntil: source.availableUntil,
      });
    }
    if (req.method === 'GET' && operation === undefined) return write(res, 200, { call: summary(call), role });
    if (req.method === 'GET' && operation === 'events') {
      const after = parseInteger(parsed.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 'after');
      const waitMs = parseInteger(parsed.searchParams.get('waitMs'), 25_000, 25_000, 'waitMs');
      if (after > call.seq) fail(400, 'invalid_cursor', 'after is beyond the last event sequence.');
      const result = pollResult(call, role, after);
      if (result.events.length || waitMs === 0 || TERMINAL_STATES.has(call.state)) return write(res, 200, result);
      if ([...call.polls].filter(poll => poll.role === role).length >= 4) fail(429, 'too_many_polls', 'At most four simultaneous waits per participant are allowed.');
      let timer;
      const poll = {
        role,
        finish() {
          if (!call.polls.delete(poll)) return;
          clearTimeout(timer);
          res.off('close', disconnected);
          write(res, 200, pollResult(call, role, after));
        },
      };
      function disconnected() { call.polls.delete(poll); clearTimeout(timer); }
      call.polls.add(poll);
      res.once('close', disconnected);
      timer = setTimeout(() => poll.finish(), waitMs);
      return;
    }

    if (req.method === 'POST' && ['messages', 'finish', 'hangup'].includes(operation)) {
      const body = await readBody(req);
      const id = requestId(body);
      const key = mutationKey(role, operation, id);
      let payload;
      if (operation === 'messages') {
        if (!MESSAGE_TYPES.has(body.type)) fail(400, 'invalid_request', `type must be one of: ${[...MESSAGE_TYPES].join(', ')}.`);
        payload = { type: body.type, text: stringField(body, 'text', { required: true }), replyTo: replyTo(body) };
      } else if (operation === 'finish') {
        payload = { text: stringField(body, 'text', { fallback: '' }) };
      } else {
        payload = { reason: stringField(body, 'reason', { maxBytes: 4096, fallback: 'participant_hangup' }) };
      }
      const repeated = replay(call.mutations, key, payload, call);
      if (repeated) return write(res, 200, repeated);
      expire(call);
      if (operation === 'hangup') {
        if (TERMINAL_STATES.has(call.state)) fail(409, 'call_closed', `Call is already ${call.state}.`);
        end(call, 'cancelled', payload.reason);
        return write(res, 200, save(call.mutations, key, payload, { call: summary(call) }));
      }
      connected(call);
      if (operation === 'messages' && payload.replyTo !== undefined && payload.replyTo > call.seq) fail(400, 'invalid_request', 'replyTo does not reference an existing event.');
      if (operation === 'finish' && call.doneBy.has(role)) fail(409, 'already_finished', 'This participant has already proposed completion.');
      capacity(call, payload);
      call.lastActiveAt = Date.now();
      let item;
      if (operation === 'messages') {
        call.doneBy.clear();
        const data = { text: payload.text, ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }) };
        item = event(call, payload.type, role, data);
      } else {
        call.doneBy.add(role);
        item = event(call, 'done', role, payload);
        if (call.doneBy.size === 2) end(call, 'completed', 'both_participants_finished');
      }
      const response = save(call.mutations, key, payload, { call: summary(call), event: item });
      wake(call);
      return write(res, 200, response);
    }
    fail(405, 'method_not_allowed', 'Method is not supported for this route.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (error instanceof HttpError) write(res, error.status, { error: { code: error.code, message: error.message } });
      else write(res, 500, { error: { code: 'internal_error', message: 'Unexpected relay error.' } });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(error => {
    meetings.close();
    contactSwitch?.close();
    throw error;
  });
  const address = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';
  const accessibleHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  url = publicUrl ?? `http://${accessibleHost}:${address.port}`;
  cleanupTimer = setInterval(cleanup, Math.max(10, Math.min(1000, inviteTtlMs, idleTtlMs, retentionMs)));
  cleanupTimer.unref();
  let closePromise;
  function stopPolling() {
    closing = true;
    clearInterval(cleanupTimer);
    options.extensionClose?.();
    meetings.close();
    contactSwitch?.close();
    for (const call of calls.values()) wake(call);
  }
  server.once('close', stopPolling);
  function close() {
    if (closePromise) return closePromise;
    stopPolling();
    closePromise = new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    return closePromise;
  }
  return { url, server, close };
}
