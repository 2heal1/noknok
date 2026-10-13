import http from 'node:http';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redactInvitations } from './invitation.mjs';

const SESSION_NAME = /^ac_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATES = new Set(['waiting', 'connected', 'completed', 'cancelled', 'expired']);
const TYPES = new Set(['joined', 'message', 'request', 'result', 'progress', 'waiting_for_user', 'done', 'closed']);
const ROLES = new Set(['caller', 'callee']);
const MAX_SESSIONS = 1000;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_EVENTS = 20_000;
const MAX_HISTORY_LINES = 100_000;
const MAX_WARNINGS = 1000;
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function text(value, limit = 32768) {
  if (typeof value !== 'string') return undefined;
  return redactInvitations(value).slice(0, limit);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function relayAddress(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return parsed.href.replace(/\/+$/, '');
  } catch { return undefined; }
}
function participantNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const participants = {};
  for (const role of ROLES) {
    if (value[role] === null) participants[role] = null;
    else if (value[role] && typeof value[role] === 'object') {
      const name = text(value[role].name, 256);
      if (name?.trim()) participants[role] = { name };
    }
  }
  return Object.keys(participants).length ? participants : undefined;
}
function cleanData(value) {
  const data = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return data;
  if (typeof value.text === 'string') data.text = text(value.text);
  if (Number.isSafeInteger(value.replyTo) && value.replyTo > 0) data.replyTo = value.replyTo;
  if (STATES.has(value.state)) data.state = value.state;
  if (typeof value.reason === 'string') data.reason = text(value.reason, 4096);
  const participants = participantNames(value.participants);
  if (participants) data.participants = participants;
  return data;
}
function timeValue(value) { return value ? Date.parse(value) : 0; }

async function readCalls(directory) {
  const source = { directory, readOnly: true };
  const warnings = [];
  const groups = new Map();
  let bytesRead = 0;
  let eventCount = 0;
  let historyLines = 0;
  let evidenceOrder = 0;
  function warn(code, message, session) {
    if (warnings.length < MAX_WARNINGS) warnings.push({ code, message, ...(session ? { session } : {}) });
  }
  async function readRegular(path, maxBytes, session, kind, optional = false) {
    let handle;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        warn('unsafe_file', `${kind} is not a regular file and was skipped.`, session);
        return undefined;
      }
      if (stat.size > maxBytes || bytesRead + stat.size > MAX_TOTAL_BYTES) {
        warn('read_limit', `${kind} exceeds the viewer read limit and was skipped.`, session);
        return undefined;
      }
      // O_NOFOLLOW closes the lstat/open race for a replaced final path component.
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        warn('unsafe_file', `${kind} changed while being opened and was skipped.`, session);
        return undefined;
      }
      const chunks = [];
      let size = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
        const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, null);
        if (!count) break;
        size += count;
        bytesRead += count;
        if (size > maxBytes || bytesRead > MAX_TOTAL_BYTES) {
          warn('read_limit', `${kind} grew beyond the viewer read limit and was skipped.`, session);
          return undefined;
        }
        chunks.push(buffer.subarray(0, count));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (optional && error.code === 'ENOENT') return undefined;
      warn(error.code === 'ELOOP' ? 'unsafe_file' : 'unreadable_file', `${kind} could not be read and was skipped.`, session);
      return undefined;
    } finally { await handle?.close(); }
  }

  let files;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      warn('unsafe_directory', 'The state directory is not a regular directory; no records were read.');
      return { groups, warnings, source };
    }
    files = (await readdir(directory)).filter(name => name.endsWith('.json') && SESSION_NAME.test(name.slice(0, -5))).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') warn('unreadable_directory', 'The state directory could not be read.');
    return { groups, warnings, source };
  }
  if (files.length > MAX_SESSIONS) warn('session_limit', `Only the first ${MAX_SESSIONS} local sessions are shown.`);

  function activity(group, at) {
    if (at && timeValue(at) > timeValue(group.lastActivityAt)) group.lastActivityAt = at;
  }
  function creation(group, at) {
    if (at && (!group.createdAt || timeValue(at) < timeValue(group.createdAt))) group.createdAt = at;
  }
  function stateEvidence(group, state, at, order, seq) {
    if (!STATES.has(state)) return;
    // A call cannot reconnect after closing. Local recordedAt and relay event.at
    // may use different clocks, so timestamps must not undo proven progress.
    const phase = state === 'waiting' ? 0 : state === 'connected' ? 1 : 2;
    const rank = [phase, seq ?? -1, timeValue(at), order];
    const different = group.stateRank ? rank.findIndex((value, index) => value !== group.stateRank[index]) : -1;
    if (!group.stateRank || (different !== -1 && rank[different] > group.stateRank[different])) {
      group.state = state;
      group.stateRank = rank;
    }
  }
  function namesEvidence(group, names, at, order) {
    if (!names) return;
    for (const role of ROLES) {
      const name = names[role]?.name;
      if (!name) continue;
      const previous = group.nameRanks[role];
      const rank = [timeValue(at), order];
      if (!previous || rank[0] > previous[0] || (rank[0] === previous[0] && rank[1] > previous[1])) {
        group.participants[role] = { name };
        group.nameRanks[role] = rank;
      }
    }
  }

  for (const filename of files.slice(0, MAX_SESSIONS)) {
    const id = filename.slice(0, -5);
    const raw = await readRegular(join(directory, filename), MAX_METADATA_BYTES, id, 'Session metadata');
    if (raw === undefined) continue;
    let metadata;
    try { metadata = JSON.parse(raw); } catch { warn('invalid_session', 'Session metadata is not valid JSON and was skipped.', id); continue; }
    const server = relayAddress(metadata?.server);
    if (!metadata || metadata.id !== id || !server || !ROLES.has(metadata.role) || typeof metadata.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.callId)) {
      warn('invalid_session', 'Session metadata has missing or invalid public fields and was skipped.', id);
      continue;
    }
    const key = createHash('sha256').update(JSON.stringify([server, metadata.callId])).digest('hex');
    let group = groups.get(key);
    if (!group) {
      group = {
        key, callId: metadata.callId, server, from: text(metadata.from, 256) || '匿名', purpose: text(metadata.purpose, 8192) || '', context: '',
        participants: { caller: { name: 'Caller' }, callee: null }, nameRanks: {},
        state: 'unknown', createdAt: null, lastActivityAt: null, sessions: [], bySeq: new Map(),
      };
      groups.set(key, group);
    }
    const createdAt = timestamp(metadata.createdAt);
    group.sessions.push({ id, role: metadata.role, createdAt });
    if (metadata.role === 'callee' && !group.participants.callee) group.participants.callee = { name: 'Callee' };
    if (!group.purpose) group.purpose = text(metadata.purpose, 8192) || '';
    activity(group, createdAt);
    creation(group, createdAt);
    const history = await readRegular(join(directory, `${id}.ndjson`), MAX_HISTORY_BYTES, id, 'Session history', true);
    if (history === undefined) continue;
    let lineStart = 0;
    let index = -1;
    while (lineStart < history.length) {
      index++;
      if (++historyLines > MAX_HISTORY_LINES) {
        warn('history_line_limit', `Only the first ${MAX_HISTORY_LINES} history lines are read.`, id);
        break;
      }
      const lineEnd = history.indexOf('\n', lineStart);
      const finalLine = lineEnd === -1;
      const line = history.slice(lineStart, finalLine ? history.length : lineEnd);
      lineStart = finalLine ? history.length : lineEnd + 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch {
        warn(finalLine ? 'partial_history_line' : 'invalid_history_line', `History line ${index + 1} is incomplete or invalid and was skipped.`, id);
        continue;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        warn('invalid_history_line', `History line ${index + 1} is not an object and was skipped.`, id);
        continue;
      }
      const order = ++evidenceOrder;
      const recordedAt = timestamp(record.recordedAt);
      const snapshot = record.call;
      if (snapshot && typeof snapshot === 'object' && snapshot.id === metadata.callId) {
        const at = recordedAt || timestamp(snapshot.closedAt) || timestamp(snapshot.connectedAt) || timestamp(snapshot.createdAt);
        stateEvidence(group, snapshot.state, at, order);
        namesEvidence(group, participantNames(snapshot.participants), at, order);
        creation(group, timestamp(snapshot.createdAt));
        activity(group, at);
        if (typeof snapshot.from === 'string') group.from = text(snapshot.from, 256);
        if (typeof snapshot.context === 'string' && (!group.contextRank || timeValue(at) >= group.contextRank)) {
          group.context = text(snapshot.context, 65536);
          group.contextRank = timeValue(at);
        }
      }
      if (record.direction === 'sent') {
        stateEvidence(group, record.callState, recordedAt, order);
        activity(group, recordedAt);
        // A locally recorded hangup is state evidence, not a second system event.
        if (record.action === 'hangup' && !record.event && record.callState === 'cancelled') stateEvidence(group, 'cancelled', recordedAt, order);
      }
      if (!record.event) continue;
      const input = record.event;
      if (!Number.isSafeInteger(input.seq) || input.seq < 1 || !TYPES.has(input.type) || (!ROLES.has(input.from) && input.from !== 'system')) {
        warn('invalid_event', `History line ${index + 1} has an invalid event and was skipped.`, id);
        continue;
      }
      const at = timestamp(input.at) || recordedAt;
      const cleaned = { seq: input.seq, type: input.type, from: input.from, at, data: cleanData(input.data) };
      const previous = group.bySeq.get(input.seq);
      if (previous) {
        if (!previous.observedBy.includes(id)) previous.observedBy.push(id);
        const { observedBy, ...priorEvent } = previous;
        if (JSON.stringify(priorEvent) !== JSON.stringify(cleaned)) {
          warn('event_conflict', `Event ${input.seq} has conflicting local copies; the first copy is shown.`, id);
          continue;
        }
      } else if (eventCount < MAX_EVENTS) {
        group.bySeq.set(input.seq, { ...cleaned, observedBy: [id] });
        eventCount++;
      } else {
        warn('event_limit', `Only the first ${MAX_EVENTS} distinct events are shown.`, id);
        continue;
      }
      activity(group, at);
      if (cleaned.from === 'system' && cleaned.type === 'joined') {
        namesEvidence(group, cleaned.data.participants, at, order);
        stateEvidence(group, 'connected', at, order, cleaned.seq);
      }
      if (cleaned.from === 'system' && cleaned.type === 'closed') stateEvidence(group, cleaned.data.state, at, order, cleaned.seq);
    }
  }
  for (const group of groups.values()) {
    group.events = [...group.bySeq.values()].sort((a, b) => a.seq - b.seq);
    const roles = new Set(group.sessions.map(session => session.role));
    const latestText = [...group.events].reverse().find(event => event.from !== 'system' && event.data.text)?.data.text;
    group.summary = {
      key: group.key, callId: group.callId, server: group.server, from: group.from, purpose: group.purpose,
      participants: group.participants, state: group.state, createdAt: group.createdAt, lastActivityAt: group.lastActivityAt,
      messageCount: group.events.filter(event => event.from !== 'system').length,
      eventCount: group.events.length, localSessionCount: group.sessions.length,
      coverage: roles.size > 1 ? 'both' : [...roles][0], preview: latestText?.slice(0, 240) || '',
    };
  }
  return { groups, warnings, source };
}

/** Serve a read-only view of local NokNok records. Never connects to a relay. */
export async function startViewer({ port = 4318, directory = process.env.AGENTCALL_HOME || join(homedir(), '.agentcall') } = {}) {
  const stateDirectory = resolve(directory);
  let allowedHosts;
  let allowedOrigins;
  let reading;
  function records() {
    if (!reading) reading = readCalls(stateDirectory).finally(() => { reading = undefined; });
    return reading;
  }
  function send(req, res, status, body, contentType = 'application/json; charset=utf-8') {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      'Content-Type': contentType, 'Content-Length': payload.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    });
    res.end(req.method === 'HEAD' ? undefined : payload);
  }
  const server = http.createServer((req, res) => {
    (async () => {
      if (!allowedHosts.has(req.headers.host)) return send(req, res, 403, { error: { code: 'invalid_host', message: 'Only the local viewer address is allowed.' } });
      if (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) return send(req, res, 403, { error: { code: 'invalid_origin', message: 'Cross-origin access is not allowed.' } });
      if (!['GET', 'HEAD'].includes(req.method)) return send(req, res, 405, { error: { code: 'method_not_allowed', message: 'The viewer is read-only.' } });
      const pathname = req.url.split('?')[0];
      if (pathname === '/health') return send(req, res, 200, { ok: true, readOnly: true });
      if (pathname === '/api/calls' || /^\/api\/calls\/[a-f0-9]{64}$/.test(pathname)) {
        const data = await records();
        if (pathname === '/api/calls') {
          const calls = [...data.groups.values()].map(group => group.summary).sort((a, b) => timeValue(b.lastActivityAt) - timeValue(a.lastActivityAt) || a.key.localeCompare(b.key));
          return send(req, res, 200, { calls, warnings: data.warnings, source: data.source });
        }
        const group = data.groups.get(pathname.slice('/api/calls/'.length));
        if (!group) return send(req, res, 404, { error: { code: 'call_not_found', message: 'No local records match this call.' } });
        const ids = new Set(group.sessions.map(session => session.id));
        return send(req, res, 200, {
          call: { ...group.summary, context: group.context }, sessions: group.sessions, events: group.events,
          warnings: data.warnings.filter(warning => !warning.session || ids.has(warning.session)), source: data.source,
        });
      }
      const asset = STATIC.get(pathname);
      if (asset) {
        let handle;
        try {
          const path = join(WEB_ROOT, asset[0]);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return send(req, res, 404, { error: { code: 'not_found', message: 'Viewer asset is unavailable.' } });
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          return send(req, res, 200, await handle.readFile(), asset[1]);
        } catch (error) {
          if (['ENOENT', 'ELOOP'].includes(error.code)) return send(req, res, 404, { error: { code: 'not_found', message: 'Viewer asset is unavailable.' } });
          throw error;
        } finally { await handle?.close(); }
      }
      return send(req, res, 404, { error: { code: 'not_found', message: 'Route not found.' } });
    })().catch(() => {
      if (!res.headersSent && !res.destroyed) send(req, res, 500, { error: { code: 'viewer_error', message: 'Local records could not be read.' } });
      else if (!res.destroyed) res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListening(); });
  });
  const actualPort = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  allowedOrigins = new Set([...allowedHosts].map(host => `http://${host}`));
  let closing;
  function close() {
    if (!closing) closing = new Promise((resolveClosed, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolveClosed());
      server.closeIdleConnections();
    });
    return closing;
  }
  return { url: `http://127.0.0.1:${actualPort}`, server, close };
}
