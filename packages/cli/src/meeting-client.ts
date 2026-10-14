import type { LocalMeetingSession, MeetingEvent } from './runtime-types.js';
import type { CliOptions, CommandContext, ApiOptions } from './runtime-types.js';
import { mkdir, readFile, writeFile, rename, unlink, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { api, fail, normalizeServer } from './client.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HANDLE = /^am_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TYPES = ['message', 'request', 'result', 'progress', 'waiting_for_user'];
const MAX_EVENTS = 20000;
const publicParticipant = ({ token, ...participant }) => participant;

export function decodeMeetingLink(value, capability = 'invite') {
  try {
    if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/u.test(value)) throw new Error();
    const url = new URL(value), params = new URLSearchParams(url.hash.slice(1));
    const id = params.get('id'), token = params.get(capability);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/meeting' || url.search
      || !UUID.test(id || '') || !/^[A-Za-z0-9_-]{16,512}$/.test(token || '')
      || params.size !== 2 || !params.has('id')) throw new Error();
    return { server: url.origin, id, token };
  } catch { throw fail('INVALID_INVITATION', `Expected a complete meeting link with an ${capability} capability in its fragment.`); }
}

function displayName(options) {
  let product = options.product ?? process.env.NOKNOK_PRODUCT;
  if (product !== undefined) {
    if (typeof product !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(product)) throw fail('INVALID_ARGUMENT', 'Invalid product name.');
    product = product.trim().toLowerCase().replace(/[ _]+/g, '-');
    product = ({ 'codex-dot': 'dot', 'doubao-work': 'doubaowork', '豆包工作': 'doubaowork' })[product] || product;
    if (product.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product)) throw fail('INVALID_ARGUMENT', 'Use a product name such as codex, dot or doubaowork.');
  }
  const name = options.name ?? (product ? `agent-${product}` : 'agent');
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) throw fail('INVALID_ARGUMENT', 'Use a display name of 1–256 UTF-8 bytes without control characters.');
  return name.trim();
}

function requestId(value) {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 128 || value.includes('\0'))) throw fail('INVALID_ARGUMENT', '--request-id must contain 1–128 UTF-8 bytes.');
  return value || randomUUID();
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Credentials, transcript and archive cursor commit together, never separately. */
export class MeetingStore {
  directory: string;
  constructor(directory = process.env.NOKNOK_HOME || join(homedir(), '.noknok')) { this.directory = join(directory, 'meetings'); }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  path(id) {
    if (!HANDLE.test(id || '')) throw fail('INVALID_SESSION', 'Use your local am_... meeting session handle, not the shared meeting ID.');
    return join(this.directory, `${id}.json`);
  }
  async load(id): Promise<LocalMeetingSession> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail('SESSION_NOT_FOUND', 'Local meeting not found. Use the same --agent or --state-dir and the returned am_... handle.'); throw error; }
  }
  async lock(path, signal) {
    await this.init();
    for (let attempt = 0; attempt < 250; attempt++) {
      signal?.throwIfAborted();
      try {
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid })); } finally { await file.close(); }
        return () => unlink(path).catch(() => {});
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let pid;
        try { pid = JSON.parse(await readFile(path, 'utf8')).pid; } catch {}
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { await unlink(path).catch(() => {}); continue; } }
        }
        await delay(20, undefined, { signal });
      }
    }
    throw fail('SESSION_BUSY', 'Another operation is using this local meeting. Retry shortly.');
  }
  async update(id, change, signal) {
    const unlock = await this.lock(`${this.path(id)}.lock`, signal);
    try {
      const session = await this.load(id);
      await change(session);
      await atomicWrite(this.path(id), session);
      return session;
    } finally { await unlock(); }
  }
  async receipt(identity, name, explicitId, signal, { reuseName = false } = {}) {
    await this.init();
    const path = join(this.directory, `.request-${createHash('sha256').update(identity).digest('hex')}.json`);
    const release = await this.lock(`${path}.lock`, signal);
    try {
      let value;
      try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (value && ((!reuseName && value.name !== name) || (explicitId !== undefined && explicitId !== value.requestId))) {
        throw fail('MEETING_IDENTITY_CONFLICT', 'This invitation already has a local participant with another name or request ID. Reuse the original name or a separate explicitly bound profile/state directory.');
      }
      value ||= { name, requestId: requestId(explicitId), session: `am_${randomUUID()}` };
      // requestId is public retry metadata, not proof of participant ownership.
      // Persist an independent recovery capability before sending any request.
      value.retryToken ??= randomBytes(32).toString('base64url');
      if (!/^[A-Za-z0-9_-]{43}$/.test(value.retryToken) || Buffer.from(value.retryToken, 'base64url').toString('base64url') !== value.retryToken) throw fail('INVALID_LOCAL_RECEIPT', 'The saved meeting retry capability is invalid. Restore this profile from its trusted local backup.');
      await atomicWrite(path, value);
      return { ...value, release };
    } catch (error) { await release(); throw error; }
  }
  async create(id, server, result, signal) {
    const unlock = await this.lock(`${this.path(id)}.lock`, signal);
    try {
      let saved;
      try { saved = await this.load(id); } catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; }
      if (saved) {
        if (saved.server !== server || saved.meetingId !== result.meeting.id || saved.participant.id !== result.participant.id || saved.token !== result.participant.token) throw fail('SESSION_CONFLICT', 'Saved meeting participant does not match the relay response.');
        return { saved, restored: true };
      }
      const session = { v: 1, id, server, meetingId: result.meeting.id, participant: publicParticipant(result.participant), token: result.participant.token,
        meeting: result.meeting, viewUrl: result.viewUrl, ...(result.invitationUrl ? { invitationUrl: result.invitationUrl } : {}),
        archiveCursor: 0, readCursor: 0, events: [], createdAt: new Date().toISOString() };
      await atomicWrite(this.path(id), session);
      return { saved: session, restored: false };
    } finally { await unlock(); }
  }
  async archive(id, result, { delivered = false, signal }: { delivered?: boolean; signal?: AbortSignal } = {}) {
    return this.update(id, session => {
      if (result.meeting?.id !== session.meetingId || !Array.isArray(result.events) || result.events.length > MAX_EVENTS) throw fail('INVALID_RESPONSE', 'Relay returned an invalid meeting event batch.');
      const bySequence = new Map<number, MeetingEvent>(session.events.map(event => [event.seq, event]));
      for (const event of result.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') throw fail('INVALID_RESPONSE', 'Relay returned an invalid meeting event.');
        const previous = bySequence.get(event.seq);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw fail('INVALID_RESPONSE', 'Relay changed an already archived event.');
        bySequence.set(event.seq, event);
      }
      if (bySequence.size > MAX_EVENTS) throw fail('ARCHIVE_LIMIT', 'Meeting exceeds the local event archive limit.');
      session.events = [...bySequence.values()].sort((a, b) => a.seq - b.seq);
      let cursor = 0;
      for (const event of session.events) { if (event.seq !== cursor + 1) break; cursor = event.seq; }
      session.archiveCursor = cursor;
      if (delivered) {
        if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor < 0) throw fail('INVALID_RESPONSE', 'Relay returned an invalid delivery cursor.');
        session.readCursor = Math.max(session.readCursor, Math.min(cursor, result.nextCursor));
      }
      // Concurrent requests can return older snapshots; preserve the latest one.
      const revision = result.nextCursor ?? result.event?.seq ?? result.events.at(-1)?.seq ?? 0;
      if (revision >= (session.revision || 0)) { session.meeting = result.meeting; session.revision = revision; }
      session.archivedAt = new Date().toISOString();
    }, signal);
  }
  async list() {
    await this.init();
    const sessions: Array<{ session: string; meetingId: string; participant: LocalMeetingSession['participant']; purpose: string; lastKnownState: string; server: string; createdAt: string }> = [];
    for (const filename of await readdir(this.directory)) {
      if (!HANDLE.test(filename.replace(/\.json$/, '')) || !filename.endsWith('.json')) continue;
      const value = await this.load(filename.slice(0, -5));
      sessions.push({ session: value.id, meetingId: value.meetingId, participant: value.participant, purpose: value.meeting.purpose, lastKnownState: value.meeting.state, server: value.server, createdAt: value.createdAt });
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function checkResult(result, server, expectedId, creation) {
  if (!result.meeting || !UUID.test(result.meeting.id || '') || (expectedId && result.meeting.id !== expectedId)
    || !result.participant || typeof result.participant.id !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(result.participant.token || '')) throw fail('INVALID_RESPONSE', 'Relay returned an invalid meeting participant.');
  const view = decodeMeetingLink(result.viewUrl, 'view');
  if (view.server !== server || view.id !== result.meeting.id) throw fail('INVALID_RESPONSE', 'Relay returned an inconsistent meeting view link.');
  if (creation) {
    const invitation = decodeMeetingLink(result.invitationUrl);
    if (invitation.server !== server || invitation.id !== result.meeting.id) throw fail('INVALID_RESPONSE', 'Relay returned an inconsistent invitation link.');
  }
}

export async function meetingCommand(command: string, args: string[], options: CliOptions, { signal, textInput }: CommandContext = {}) {
  if (!textInput) throw new TypeError('A CLI text input reader is required.');
  const count = ['create', 'sessions'].includes(command) ? 0 : 1;
  if (args.length !== count) throw fail('INVALID_ARGUMENT', `Expected ${count} argument(s) after meeting ${command}.`);
  const store = new MeetingStore(options['state-dir']);
  if (command === 'sessions') return { sessions: await store.list(), source: 'local' };
  if (command === 'create' || command === 'join') {
    const name = displayName(options), suppliedId = options['request-id'];
    if (suppliedId !== undefined) requestId(suppliedId);
    const invitation = command === 'join' ? decodeMeetingLink(args[0]) : undefined;
    const server = invitation?.server || normalizeServer(options.server || process.env.NOKNOK_SERVER || 'http://127.0.0.1:4317');
    if (new URL(server).pathname !== '/') throw fail('INVALID_SERVER', 'Meeting relay must use an HTTP(S) origin without a path prefix.');
    const purpose = options.purpose;
    if (command === 'create' && !purpose?.trim()) throw fail('INVALID_ARGUMENT', 'Provide --purpose with the meeting goal.');
    const context = command === 'create' ? await textInput(options, 'context', 'context-file', false, signal) : undefined;
    const creationId = suppliedId || randomUUID();
    const identity = invitation ? JSON.stringify(['join', server, invitation.id, invitation.token]) : JSON.stringify(['create', server, creationId]);
    const pending = await store.receipt(identity, name, invitation ? suppliedId : creationId, signal, { reuseName: options.name === undefined && options.product === undefined && process.env.NOKNOK_PRODUCT === undefined });
    try {
      const body = invitation ? { token: invitation.token, name: pending.name, kind: 'agent', requestId: pending.requestId, retryToken: pending.retryToken } : { name: pending.name, kind: 'agent', purpose, context, requestId: pending.requestId, retryToken: pending.retryToken };
      const result = await api(server, invitation ? `/v1/meetings/${invitation.id}/join` : '/v1/meetings', { method: 'POST', body, signal, ...(invitation ? {} : { key: process.env.NOKNOK_SERVER_KEY }) });
      checkResult(result, server, invitation?.id, !invitation);
      const { saved, restored } = await store.create(pending.session, server, result, signal);
      const initial = await api(server, `/v1/meetings/${saved.meetingId}/events?after=0&waitMs=0`, { token: saved.token, signal });
      await store.archive(saved.id, initial, { signal });
      return { session: saved.id, meetingId: saved.meetingId, requestId: pending.requestId, restored, participant: saved.participant,
        meeting: initial.meeting, invitationUrl: result.invitationUrl, viewUrl: result.viewUrl, events: initial.events,
        ...(result.invitationUrl ? { invitationText: `Join this NokNok meeting: ${result.invitationUrl}\nGoal: ${result.meeting.purpose}\nAgents: run noknok skill, then noknok meeting join with this link. People: open it in a browser.\nRead-only view: ${result.viewUrl}` } : {}),
        next: invitation ? 'Read the goal and archived messages, contribute within owner authorization, then receive updates. Only the host ends the meeting.' : 'Display invitationText and the session/view link now. Share the invitation with intended participants. Receive messages and host the discussion until the goal is met.' };
    } catch (error) { throw Object.assign(error, { requestId: pending.requestId, session: pending.session }); }
    finally { await pending.release(); }
  }
  const id = args[0];
  let session = await store.load(id);
  if (command === 'history') return { session: id, source: 'local', meeting: session.meeting, participant: session.participant, events: session.events, archivedAt: session.archivedAt, lastArchivedSequence: session.archiveCursor, liveStateUnknown: true };
  if (command === 'view') return { session: id, viewUrl: session.viewUrl, url: session.viewUrl, source: 'local', next: 'This read-only capability expires with server retention. meeting history remains available locally.' };
  const base = `/v1/meetings/${session.meetingId}`;
  const request = (path, extra = {}) => api(session.server, base + path, { token: session.token, signal, ...extra });
  if (command === 'status') {
    const result = await request('');
    await store.archive(id, result, { signal });
    return { session: id, ...result };
  }
  if (command === 'receive') {
    const seconds = options.timeout === undefined ? 45 : Number(options.timeout);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600 || options.timeout?.trim() === '') throw fail('INVALID_ARGUMENT', '--timeout must be between 0 and 3600 seconds.');
    const release = await store.lock(`${store.path(id)}.receive.lock`, signal);
    try {
      const started = Date.now();
      let result;
      do {
        session = await store.load(id);
        const waitMs = Math.floor(Math.min(25000, Math.max(0, seconds * 1000 - (Date.now() - started))));
        result = await request(`/events?after=${session.readCursor}&waitMs=${waitMs}`, { timeoutMs: waitMs + 10000 });
        await store.archive(id, result, { delivered: true, signal });
        if (result.events.length || result.meeting.state !== 'active') break;
      } while (Date.now() - started < seconds * 1000);
      return { session: id, outcome: result.meeting.state !== 'active' ? 'closed' : result.events.length ? 'events' : 'timeout', ...result };
    } finally { await release(); }
  }
  const mutationId = requestId(options['request-id']);
  let path = `/${command}`;
  const body: { requestId: string; text?: string; type?: string; to?: string; replyTo?: number; ready?: boolean; reason?: string } = { requestId: mutationId };
  if (command === 'send') {
    path = '/messages';
    body.text = await textInput(options, 'text', 'file', true, signal);
    body.type = options.type || 'message';
    if (!TYPES.includes(body.type)) throw fail('INVALID_ARGUMENT', 'Unknown meeting message type.');
    if (options.to !== undefined) body.to = options.to;
    if (options['reply-to'] !== undefined) {
      body.replyTo = Number(options['reply-to']);
      if (!Number.isSafeInteger(body.replyTo) || body.replyTo < 1) throw fail('INVALID_ARGUMENT', '--reply-to must be a positive event sequence number.');
    }
  } else if (command === 'ready') {
    if (options.ready !== undefined && !['true', 'false'].includes(options.ready)) throw fail('INVALID_ARGUMENT', '--ready must be true or false.');
    body.ready = options.ready !== 'false';
  } else if (command === 'end') {
    const text = await textInput(options, 'text', 'file', false, signal);
    if (text !== undefined) body.text = text;
    if (options.reason !== undefined) body.reason = options.reason;
  }
  try {
    const result = await request(path, { method: 'POST', body });
    // Save the acknowledged action before fetching intervening events. Never
    // advance past gaps; concurrent senders' events are merged by sequence.
    session = await store.archive(id, { ...result, events: result.event ? [result.event] : [] }, { signal });
    const batch = await request(`/events?after=${session.archiveCursor}&waitMs=0`);
    await store.archive(id, batch, { signal });
    return { session: id, requestId: mutationId, ...result };
  } catch (error) { throw Object.assign(error, { requestId: mutationId, session: id }); }
}
