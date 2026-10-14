import type { MeetingRecord, ConversationEvent, MeetingLink } from './types.js';
import { meetingInvitationText, meetingJoinInstructions } from './meeting-invitation.js';
import { validKey, contentAAD, decryptText, encryptText, isEncryptedText } from './e2ee.js';
import { avatarIdentity } from './avatar-catalog.js';
interface MeetingElements {
  'notice': HTMLElement;
  'storage-warning': HTMLElement;
  'landing': HTMLElement;
  'saved-empty': HTMLElement;
  'saved-rooms': HTMLElement;
  'invitation': HTMLElement;
  'invite-purpose': HTMLElement;
  'invite-context': HTMLElement;
  'invite-facts': HTMLElement;
  'join-form': HTMLFormElement;
  'join-name': HTMLInputElement;
  'return-to-room': HTMLButtonElement;
  'agent-join-help': HTMLDetailsElement;
  'agent-prompt': HTMLTextAreaElement;
  'copy-agent-prompt': HTMLButtonElement;
  'room': HTMLElement;
  'toggle-details': HTMLButtonElement;
  'room-details': HTMLElement;
  'room-number': HTMLElement;
  'room-status': HTMLElement;
  'room-purpose': HTMLElement;
  'room-expiry': HTMLElement;
  'connection-state': HTMLElement;
  'participant-count': HTMLElement;
  'participants': HTMLElement;
  'event-count': HTMLElement;
  'timeline': HTMLElement;
  'jump-latest': HTMLButtonElement;
  'message-form': HTMLFormElement;
  'composer-name': HTMLElement;
  'reply-strip': HTMLElement;
  'reply-text': HTMLElement;
  'cancel-reply': HTMLButtonElement;
  'message-to': HTMLSelectElement;
  'message-text': HTMLTextAreaElement;
  'read-only-note': HTMLElement;
  'room-context': HTMLElement;
  'copy-invite': HTMLButtonElement;
  'copy-view': HTMLButtonElement;
  'export-room': HTMLButtonElement;
  'local-save-state': HTMLElement;
  'clear-local': HTMLButtonElement;
  'host-controls': HTMLElement;
  'open-end': HTMLButtonElement;
  'summary-block': HTMLElement;
  'room-summary': HTMLElement;
  'end-dialog': HTMLDialogElement;
  'end-form': HTMLFormElement;
  'end-summary': HTMLTextAreaElement;
  'cancel-end': HTMLButtonElement;
}
const STORAGE_KEY = 'noknok.meetings.v1';
const MAX_ROOMS = 20;
const MAX_LOCAL_BYTES = 4 * 1024 * 1024;
const MAX_ROOM_EVENTS = 3000;
const ROOM_KEY_PREFIX = `${STORAGE_KEY}.room.`;
const CLEAR_KEY_PREFIX = `${STORAGE_KEY}.cleared.`;
const REQUEST_KEY_PREFIX = `${STORAGE_KEY}.requests.`;
const MESSAGE_TYPES = new Set(['message', 'request', 'result', 'progress', 'waiting_for_user']);
const TYPE_NAMES = { request: '请协助', result: '结论', progress: '进展', waiting_for_user: '待用户确认' };

// randomUUID requires a secure context in browsers; getRandomValues is also
// available on plain HTTP LAN deployments and still provides secure randomness.
export function randomId(provider = globalThis.crypto) {
  if (typeof provider?.randomUUID === 'function') return provider.randomUUID();
  if (typeof provider?.getRandomValues !== 'function') throw new Error('浏览器不支持安全随机数，请使用现代浏览器打开会议。');
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomRetryToken(provider = globalThis.crypto) {
  const bytes = provider.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Each meeting has an independent key, so saving one tab cannot overwrite other
// tabs' archives. A separate clear marker invalidates every older writer.
export class MeetingCache {
  backing: Storage;
  constructor(backing: Storage) { this.backing = backing; }
  generation(id) { return this.backing.getItem(`${CLEAR_KEY_PREFIX}${id}`) || ''; }
  roomKey(id, generation) { return `${ROOM_KEY_PREFIX}${id}:${generation || 'initial'}`; }
  read() {
    const metadata = JSON.parse(this.backing.getItem(STORAGE_KEY) || 'null');
    const rooms: MeetingRecord[] = [];
    for (let index = 0; index < this.backing.length; index++) {
      const key = this.backing.key(index);
      if (!key?.startsWith(ROOM_KEY_PREFIX)) continue;
      const room = JSON.parse(this.backing.getItem(key) || 'null');
      if (room?.meeting?.id && Array.isArray(room.events) && room.cacheGeneration === this.generation(room.meeting.id)) rooms.push(room);
    }
    rooms.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    return { version: 2, name: typeof metadata?.name === 'string' ? metadata.name : '', rooms };
  }
  save(record: MeetingRecord, generation: string, name = '') {
    const id = record.meeting.id;
    if (this.generation(id) !== generation) return { cleared: true };
    const key = this.roomKey(id, generation);
    const latest = JSON.parse(this.backing.getItem(key) || 'null');
    for (const [digest, sequence] of Object.entries(record.encryptedEvents || {})) {
      if (latest?.encryptedEvents?.[digest] !== undefined && latest.encryptedEvents[digest] !== sequence) encryptionFailure();
    }
    const copy = {
      ...latest, ...record,
      meeting: (latest?.snapshotCursor || 0) > (record.snapshotCursor || 0) ? { ...record.meeting, ...latest.meeting } : { ...latest?.meeting, ...record.meeting },
      encryptedEvents: { ...latest?.encryptedEvents, ...record.encryptedEvents },
      access: { ...latest?.access, ...Object.fromEntries(Object.entries(record.access || {}).filter(([, value]) => value !== undefined)) },
      events: mergeEvents(latest?.events, record.events),
      cursor: Math.max(latest?.cursor || 0, record.cursor || 0),
      snapshotCursor: Math.max(latest?.snapshotCursor || 0, record.snapshotCursor || 0),
      cacheGeneration: generation,
      savedAt: new Date().toISOString(),
    };
    if (copy.events.length > MAX_ROOM_EVENTS) { copy.events = copy.events.slice(-MAX_ROOM_EVENTS); copy.partial = true; }
    const others = this.read().rooms.filter((room) => room.meeting.id !== id);
    let removed = 0;
    let encoded = JSON.stringify(copy);
    while (encoded.length * 2 > MAX_LOCAL_BYTES && copy.events.length > 1) {
      copy.events = copy.events.slice(Math.max(1, Math.floor(copy.events.length / 10)));
      copy.partial = true;
      encoded = JSON.stringify(copy);
    }
    if (encoded.length * 2 > MAX_LOCAL_BYTES) throw new Error('local limit');
    let otherBytes = others.reduce((total, room) => total + JSON.stringify(room).length * 2, 0);
    while ((others.length >= MAX_ROOMS || encoded.length * 2 + otherBytes > MAX_LOCAL_BYTES) && others.length) {
      const oldest = others.pop()!;
      this.backing.removeItem(this.roomKey(oldest.meeting.id, oldest.cacheGeneration));
      otherBytes -= JSON.stringify(oldest).length * 2;
      removed++;
    }
    // The generation is also in the key: a clear racing this write cannot make
    // an old record visible, or cause cleanup to delete a newly joined identity.
    if (this.generation(id) !== generation) return { cleared: true };
    this.backing.setItem(key, encoded);
    if (this.generation(id) !== generation) { this.backing.removeItem(key); return { cleared: true }; }
    this.backing.setItem(STORAGE_KEY, JSON.stringify({ version: 2, name }));
    return { cleared: false, removed, partial: Boolean(copy.partial), rooms: this.read().rooms };
  }
  clear(id) {
    const oldKey = this.roomKey(id, this.generation(id));
    this.backing.setItem(`${CLEAR_KEY_PREFIX}${id}`, randomId());
    this.backing.removeItem(oldKey);
    for (let index = this.backing.length - 1; index >= 0; index--) {
      const key = this.backing.key(index);
      if (key?.startsWith(`${REQUEST_KEY_PREFIX}${id}:`)) this.backing.removeItem(key);
    }
  }
}

// Save random request IDs and exact ciphertext before sending. Reloading or a
// lost response must reuse that same wire body, including its random GCM nonce.
export class MeetingRequestCache {
  constructor(private backing: Storage) {}
  async prepare(scope: string, operation: string, body, create: () => Promise<Record<string, unknown>>) {
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([operation, body]))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const key = `${REQUEST_KEY_PREFIX}${scope}`;
    let requests = JSON.parse(this.backing.getItem(key) || '{}');
    if (!requests[fingerprint]) {
      const wire = await create();
      // Another tab may have prepared this request while encryption was running.
      requests = JSON.parse(this.backing.getItem(key) || '{}');
      if (!requests[fingerprint]) requests[fingerprint] = wire;
      if (Object.keys(requests).length > 50) throw new Error('待确认的操作过多，请先确认已有操作的会议状态。');
    }
    this.backing.setItem(key, JSON.stringify(requests));
    return { fingerprint, key, body: requests[fingerprint] };
  }
  complete(request: { key: string; fingerprint: string }) {
    const requests = JSON.parse(this.backing.getItem(request.key) || '{}');
    delete requests[request.fingerprint];
    if (Object.keys(requests).length) this.backing.setItem(request.key, JSON.stringify(requests));
    else this.backing.removeItem(request.key);
  }
}

function redactedExport(value, secrets) {
  if (typeof value === 'string') {
    let result = value.replace(/(?:https?:\/\/[^\s"'<>]*)?\/meeting\/?#[^\s"'<>]*/gi, (candidate) => {
      const parameters = new URLSearchParams(candidate.slice(candidate.indexOf('#') + 1));
      return parameters.has('invite') || parameters.has('view') ? '[已移除会议访问链接]' : candidate;
    });
    result = result
      .replace(/(?:https?:\/\/[^\s"'<>]*)?\/contact#offer=[^\s"'<>]*/gi, '[已移除交友链接]')
      .replace(/\bnk_(?:agent|account|beta)_[A-Za-z0-9_-]{24,256}\b/g, '[已移除访问凭证]')
      .replace(/\bnk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[已移除联系凭证]')
      .replace(/\bwhsec_[A-Za-z0-9+/]+={0,2}/g, '[已移除回调密钥]');
    for (const secret of secrets) result = result.replaceAll(secret, '[已移除访问凭证]');
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactedExport(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactedExport(key, secrets), redactedExport(item, secrets)]));
  return value;
}

// Only public meeting data is exported. Access capabilities never belong in a transcript.
export function transcriptOf(record: MeetingRecord) {
  const secrets = [...new Set(Object.values(record.access || {})
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap((value) => [value, encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  return redactedExport({
    format: 'noknok-meeting-transcript-v1',
    exportedAt: new Date().toISOString(),
    source: record.archived ? 'local-copy' : 'client-copy',
    partial: Boolean(record.partial) || hasIncompleteHistory(record),
    meeting: record.meeting,
    events: record.events || [],
  }, secrets);
}

export function mergeEvents(previous: ConversationEvent[] = [], incoming: ConversationEvent[] = []) {
  const events = new Map(previous.filter((e) => Number.isInteger(e.seq)).map((e) => [e.seq, e]));
  for (const event of incoming) if (Number.isInteger(event.seq)) {
    const old = events.get(event.seq);
    events.set(event.seq, { ...old, ...event, ...(old?.data && !event.data ? { data: old.data } : {}),
      ...(old?.bodyState && old.bodyState !== 'pending' && event.bodyState === 'pending' ? { bodyState: old.bodyState } : {}) });
  }
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

export function hasIncompleteHistory(record: Pick<MeetingRecord, 'events' | 'cursor' | 'snapshotCursor'>) {
  if (!record.events?.length) return true;
  let cursor = 0;
  for (const event of record.events || []) {
    if (event.seq !== cursor + 1 || !event.data) return true;
    cursor = event.seq;
  }
  return cursor < (record.snapshotCursor || record.cursor || 0);
}

// The save callback returns the actual durable copy: browser quota handling may
// trim it, so only receipts whose bodies survived that save can be acknowledged.
export async function saveAndAcknowledge(record: MeetingRecord, { save, acknowledge }: {
  save: (record: MeetingRecord) => MeetingRecord | null | undefined | Promise<MeetingRecord | null | undefined>;
  acknowledge: (receipts: Array<{ seq: number; token: string }>) => Promise<{ acknowledged?: number[] }>;
}) {
  const saved = await save(record);
  if (!saved || record.mode !== 'participant') return false;
  const events = new Map((saved.events || []).map(event => [event.seq, event]));
  const receipts = (record.pendingDeliveryReceipts || []).filter(receipt => events.get(receipt.seq)?.data);
  for (let offset = 0; offset < receipts.length; offset += 256) {
    const batch = receipts.slice(offset, offset + 256);
    let result;
    try { result = await acknowledge(batch); }
    catch (error) { error.deliveryAckFailed = true; throw error; }
    const acknowledged = new Set(result.acknowledged || []);
    record.pendingDeliveryReceipts = (record.pendingDeliveryReceipts || []).filter(receipt =>
      !batch.some(sent => sent.seq === receipt.seq && sent.token === receipt.token && acknowledged.has(receipt.seq)));
    await save(record);
  }
  return true;
}

const ENCRYPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseMeetingLink(hash: string): MeetingLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const id = params.get('id');
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return null;
  for (const field of ['id', 'view', 'invite', 'key', 'e2ee']) if (params.getAll(field).length > 1) return null;
  if (!params.has('view') && !params.has('invite')) return params.size === 1 ? { id, mode: 'saved' } : null;
  const key = params.get('key'), encryptionId = params.get('e2ee');
  if (!key || !validKey(key) || !encryptionId || !ENCRYPTION_ID.test(encryptionId)) return null;
  // An explicit read-only link remains read-only even in a browser that has joined before.
  const mode = params.has('view') ? 'view' : 'invite';
  const token = params.get(mode);
  return token ? { id, mode, token, key, encryptionId } : null;
}

/** Invitations put the shared meeting ID in the path; secrets stay in the fragment. */
export function parseMeetingLocation(pathname: string, hash: string): MeetingLink | null {
  const inviteId = /^\/invite\/([a-f0-9-]+)$/.exec(pathname)?.[1];
  if (!inviteId) return pathname === '/meeting' || pathname === '/meeting/' ? parseMeetingLink(hash) : null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.has('id') || !params.has('invite') || params.has('view') || params.size !== 3) return null;
  params.set('id', inviteId);
  return parseMeetingLink(params.toString());
}

function encryptionFailure(): never {
  throw Object.assign(new Error('无法验证会议的端到端加密内容。请使用包含完整密钥的原始邀请或只读链接；本次内容未保存或确认接收。'), { encryptionFailed: true });
}

// Validate and decrypt the entire response before returning anything the caller
// could persist or acknowledge. Opaque field digests prevent cross-sequence replay.
export async function decryptMeetingPayload(payload, { id, key, encryptionId, encryptedEvents = {} }: {
  id: string; key?: string; encryptionId?: string; encryptedEvents?: Record<string, number>;
}) {
  if (!validKey(key) || typeof encryptionId !== 'string' || !ENCRYPTION_ID.test(encryptionId) || !payload.meeting || payload.meeting.id !== id
    || payload.meeting.encryption?.v !== 1 || payload.meeting.encryption.id !== encryptionId) encryptionFailure();
  const result = structuredClone(payload);
  const seen = { ...encryptedEvents };
  async function decode(value, type, from, field, to?, replyTo?) {
    if (!isEncryptedText(value)) encryptionFailure();
    try { return await decryptText(key!, value, contentAAD(encryptionId!, type, from, field, to, replyTo)); }
    catch { encryptionFailure(); }
  }
  for (const field of ['purpose', 'context']) if (result.meeting[field] !== undefined) {
    result.meeting[field] = await decode(result.meeting[field], 'started', 'system', field);
  }
  for (const [field, wireField] of [['summary', 'text'], ['reason', 'reason']]) if (result.meeting[field] !== undefined) {
    if (field === 'reason' && result.meeting.state === 'expired' && result.meeting[field] === 'meeting_timeout') continue;
    result.meeting[field] = await decode(result.meeting[field], 'closed', result.meeting.hostId, wireField);
  }
  for (const event of [...(result.events || []), ...(result.event ? [result.event] : [])]) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) encryptionFailure();
    if (!event.data) continue;
    if (MESSAGE_TYPES.has(event.type) && !isEncryptedText(event.data.text)) encryptionFailure();
    if (event.type === 'started' && (!isEncryptedText(event.data.purpose) || !isEncryptedText(event.data.context))) encryptionFailure();
    if (event.type === 'closed' && event.from !== 'system' && !isEncryptedText(event.data.reason)) encryptionFailure();
    for (const field of ['purpose', 'context', 'text', 'reason']) if (event.data[field] !== undefined) {
      if (event.type === 'closed' && event.from === 'system' && event.data.state === 'expired' && field === 'reason' && event.data[field] === 'meeting_timeout') continue;
      const wire = event.data[field];
      event.data[field] = await decode(wire, event.type, event.from, field, event.data.to, event.data.replyTo);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wire)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (seen[digest] !== undefined && seen[digest] !== event.seq) encryptionFailure();
      seen[digest] = event.seq;
    }
  }
  return { payload: result, encryptedEvents: seen };
}

if (typeof document !== 'undefined') startMeetingApp();

function startMeetingApp() {
  const initialHash = location.hash;
  let parsed = parseMeetingLocation(location.pathname, initialHash);
  const previousInvitation = history.state?.noknokInvitation;
  if (parsed?.mode === 'saved' && previousInvitation && previousInvitation.id === parsed.id) {
    const recovered = parseMeetingLink(new URLSearchParams({ id: previousInvitation.id, invite: previousInvitation.token, key: previousInvitation.key, e2ee: previousInvitation.encryptionId }).toString());
    if (recovered?.mode === 'invite') parsed = recovered;
  }
  // Remove key and capability fragments before any network request or rendering.
  if (initialHash) history.replaceState(parsed?.mode === 'invite' ? { noknokInvitation: parsed } : null, '', parsed ? `/meeting#${new URLSearchParams({ id: parsed.id })}` : '/meeting');
  function $<K extends keyof MeetingElements>(id: K): MeetingElements[K];
  function $(id: string): HTMLElement;
  function $(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing NokNok page element: ${id}`);
    return element;
  }
  let storage: { version: number; rooms: MeetingRecord[]; name: string } = { version: 2, rooms: [], name: '' };
  let cache: MeetingCache;
  let currentGeneration = '';
  let current: MeetingRecord;
  let polling: AbortController | null = null;
  let pollTimer: number | undefined;
  let expiryTimer: number | undefined;
  let pollVersion = 0;
  let online = false;
  let replyTo: number | null = null;
  let mutationPending = false;
  let timelineVersion = '';
  let noticeTimer: number | undefined;
  let storageAvailable = true;
  let persistencePaused = false;
  let pendingInvitation: MeetingLink;
  let requests: MeetingRequestCache;

  async function requestFor(operation, body) {
    const joining = operation.endsWith('/join');
    if (!requests || (!joining && persistencePaused)) throw new Error('无法保存本次操作的重试凭据，请恢复浏览器本地存储后重试。');
    const id = joining ? pendingInvitation.id : current.meeting.id;
    const generation = cache.generation(id);
    const scope = `${id}:${generation}:${joining ? 'join' : current.participantId}`;
    const request = await requests.prepare(scope, operation, body, async () => {
      const wire = { ...body };
      if (operation.endsWith('/messages') || operation.endsWith('/end')) {
        const type = operation.endsWith('/messages') ? body.type || 'message' : 'closed';
        const encryptionId = current.access.encryptionId, key = current.access.key;
        if (!key || !encryptionId || !current.participantId) encryptionFailure();
        for (const field of ['text', 'reason']) if (wire[field] !== undefined) wire[field] = await encryptText(key, wire[field], contentAAD(encryptionId, type, current.participantId!, field, body.to, body.replyTo));
      }
      return { ...wire, requestId: randomId(), ...(joining ? { retryToken: randomRetryToken() } : {}) };
    });
    if (cache.generation(id) !== generation || (!joining && persistencePaused)) {
      requests.complete(request);
      throw new Error('本地副本已清除，本次操作尚未发送。');
    }
    return request;
  }

  function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, value?: unknown) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    return element;
  }

  function announce(message, error = false, sticky = false) {
    clearTimeout(noticeTimer);
    $('notice').textContent = message;
    $('notice').className = `notice${error ? ' error' : ''}`;
    $('notice').hidden = !message;
    if (!error && !sticky) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
  }

  function storageWarning(message) {
    $('storage-warning').textContent = message;
    $('storage-warning').hidden = !message;
  }

  try {
    cache = new MeetingCache(localStorage);
    requests = new MeetingRequestCache(localStorage);
    storage = cache.read();
  } catch {
    storageAvailable = false;
    storageWarning('无法读取浏览器的本地记录。你仍可加入会议；请及时下载记录，刷新后可能无法恢复身份。');
  }
  if (!storage.name) storage.name = `访客-${randomId().slice(0, 4)}`;
  $('join-name').value = storage.name;

  function persist() {
    if (persistencePaused) {
      $('local-save-state').textContent = '已清除此会议的本地副本。本页继续使用内存中的记录，刷新后不恢复。';
      return false;
    }
    try {
      const result = cache.save(current, currentGeneration, storage.name);
      if (result.cleared) {
        persistencePaused = true;
        storage.rooms = cache.read().rooms;
        storageWarning('此会议的本地副本已在另一个页面清除。本页不再自动保存，仍可下载当前内存中的记录。');
        return persist();
      }
      storage.rooms = result.rooms ?? [];
      storageAvailable = true;
      const { removed, partial } = result;
      if (removed || partial) storageWarning(`${removed ? `本地空间有限，已移除 ${removed} 场较早的会议副本。` : ''}${partial ? '此会议的本地缓存仅保留最近部分记录；需要完整记录时，请在本页关闭前下载。' : ''}`);
      $('local-save-state').textContent = partial ? '最近记录已保存在此浏览器；当前页面仍可下载已读取的完整记录。' : '已保存到此浏览器。服务清除后，仍可打开本地副本。';
      return true;
    } catch (error) {
      if (error.encryptionFailed) throw error;
      storageAvailable = false;
      storageWarning('浏览器未能保存会议记录和入会身份（可能空间不足或已禁用存储）。请下载记录；刷新或关闭页面可能丢失当前身份。');
      $('local-save-state').textContent = '本地保存失败，请下载记录。';
      return false;
    }
  }

  function visible(page) {
    for (const id of ['landing', 'invitation', 'room']) $(id).hidden = id !== page;
  }

  function time(at, full = false) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', full ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function link(mode, token) {
    if (!current.access.key || !current.access.encryptionId) encryptionFailure();
    const params = new URLSearchParams({ [mode]: token, key: current.access.key, e2ee: current.access.encryptionId });
    if (mode === 'invite') return `${location.origin}/invite/${current.meeting.id}#${params}`;
    params.set('id', current.meeting.id);
    return `${location.origin}/meeting#${params}`;
  }

  function stopPolling() {
    pollVersion++;
    clearTimeout(pollTimer);
    clearTimeout(expiryTimer);
    polling?.abort();
    polling = null;
  }

  function accessToken() {
    return current?.mode === 'view' ? current.access.view : current?.access.participant;
  }

  async function api(path: string, { token, body, signal }: { token?: string; body?: Record<string, unknown>; signal?: AbortSignal } = {}) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw Object.assign(new Error('无法连接会议服务。请检查网络，页面会保留已收到的记录。'), { network: true });
    }
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const description = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      throw Object.assign(new Error(description || `会议服务返回错误（${response.status}）。`), { status: response.status });
    }
    return payload;
  }

  function basePath() { return `/v1/meetings/${encodeURIComponent(current.meeting.id)}`; }
  function self() { return current?.meeting.participants?.find((p) => p.id === current.participantId); }
  function canSpeak() { return online && current?.mode === 'participant' && current.meeting.state === 'active' && self() && !self()?.leftAt && !current.archived; }
  function isHost() { return current?.mode === 'participant' && current?.participantId === current?.meeting.hostId; }
  function person(id) { return current?.meeting.participants?.find((p) => p.id === id); }
  function nameOf(id) {
    const participant = person(id);
    return participant ? `${participant.name}（${participant.kind === 'human' ? '人' : 'Agent'}）` : '参会者';
  }

  function renderLanding() {
    stopPolling();
    try { storage.rooms = cache.read().rooms; } catch { /* Existing storage warning remains visible. */ }
    visible('landing');
    document.title = 'NokNok · 会议';
    $('saved-rooms').replaceChildren();
    $('saved-empty').hidden = storage.rooms.length > 0;
    for (const record of storage.rooms) {
      const button = make('button', 'saved-room');
      button.type = 'button';
      button.append(make('strong', '', record.meeting.purpose || '会议'), make('span', '', `${time(record.savedAt || record.meeting.createdAt, true)} · ${record.archived ? '本地副本' : record.meeting.state === 'active' ? '上次仍在进行' : '已结束'}${record.partial ? ' · 部分记录' : ''}`));
      button.addEventListener('click', () => openSaved(record.meeting.id));
      $('saved-rooms').append(button);
    }
  }

  async function openSaved(id) {
    try { storage.rooms = cache.read().rooms; } catch { /* Retain readable in-memory records if storage is unavailable. */ }
    const record = storage.rooms.find((r) => r.meeting.id === id);
    if (!record) { announce('此浏览器没有这场会议的入会信息。请重新打开邀请或只读链接。', true); renderLanding(); return; }
    await openRoom(structuredClone(record));
  }

  async function openRoom(record, authenticated = false) {
    stopPolling();
    current = record;
    current.events ||= [];
    current.access ||= {};
    current.cursor ||= 0;
    try { currentGeneration = cache.generation(current.meeting.id); } catch { currentGeneration = ''; }
    persistencePaused = false;
    online = false;
    replyTo = null;
    timelineVersion = '';
    visible('room');
    history.replaceState(null, '', `/meeting#${new URLSearchParams({ id: current.meeting.id })}`);
    renderRoom();
    if (authenticated && !persist()) throw new Error('入会身份未能保存，请保留邀请并重试。');
    if (!accessToken()) { archive('此浏览器只保留了会议副本，无法连接实时会议。'); return; }
    await refresh();
  }

  async function absorb(payload) {
    const opened = current;
    const decrypted = await decryptMeetingPayload(payload, { id: opened.meeting.id, key: opened.access.key, encryptionId: opened.access.encryptionId, encryptedEvents: opened.encryptedEvents });
    if (current !== opened) return false;
    // A concurrent poll and mutation may have decrypted against an older map.
    for (const [digest, sequence] of Object.entries(decrypted.encryptedEvents)) {
      if (current.encryptedEvents?.[digest] !== undefined && current.encryptedEvents[digest] !== sequence) encryptionFailure();
    }
    current.encryptedEvents = { ...current.encryptedEvents, ...decrypted.encryptedEvents };
    payload = decrypted.payload;
    if (payload.meeting && (payload.nextCursor || 0) >= (current.snapshotCursor || 0)) {
      current.meeting = { ...current.meeting, ...payload.meeting };
      current.snapshotCursor = payload.nextCursor || 0;
    }
    if (payload.events) current.events = mergeEvents(current.events, payload.events);
    if (payload.event) current.events = mergeEvents(current.events, [payload.event]);
    // A mutation may return only its own event. Advancing the read cursor here would
    // skip messages that other participants sent immediately before that event.
    if (Array.isArray(payload.events)) current.cursor = Math.max(current.cursor || 0, payload.nextCursor || 0);
    current.partial = hasIncompleteHistory(current);
    if (current.mode === 'participant' && payload.deliveryReceipts) {
      const receipts = new Map((current.pendingDeliveryReceipts || []).map(receipt => [receipt.seq, receipt]));
      for (const receipt of payload.deliveryReceipts) receipts.set(receipt.seq, receipt);
      current.pendingDeliveryReceipts = [...receipts.values()];
    }
    current.archived = false;
    online = true;
    renderRoom();
    try {
      await saveAndAcknowledge(opened, {
        save: () => current === opened && persist() ? storage.rooms.find(room => room.meeting.id === opened.meeting.id) : null,
        acknowledge: receipts => api(`/v1/meetings/${encodeURIComponent(opened.meeting.id)}/ack`, { token: opened.access.participant, body: { receipts } }),
      });
    } catch (error) {
      if (!error.deliveryAckFailed) throw error;
      // The business mutation already succeeded and its content is saved.
      // Retry only confirmation; never leave the composer inviting a duplicate.
      if (current === opened) {
        announce('记录已保存在此浏览器，接收确认暂未完成。页面会自动重试，无需重复发送。', true);
        clearTimeout(pollTimer);
        pollTimer = setTimeout(refresh, 5000);
      }
      return false;
    }
    return true;
  }

  function archive(message) {
    stopPolling();
    online = false;
    current.archived = true;
    persist();
    renderRoom();
    announce(message, false, true);
  }

  async function refresh() {
    const opened = current;
    try {
      const payload = await api(basePath(), { token: accessToken() });
      if (current !== opened) return;
      const confirmed = await absorb(payload);
      if (confirmed && current.meeting.state === 'active') pollTimer = setTimeout(poll, 100);
    } catch (error) {
      if (current !== opened) return;
      handleReadFailure(error);
    }
  }

  function handleReadFailure(error) {
    if (error.name === 'AbortError') return;
    if (error.encryptionFailed) { stopPolling(); online = false; renderRoom(); announce(error.message, true); return; }
    if (error.status === 404 || error.status === 410) {
      archive('服务中的会议已不可用（可能到期或服务已重启）。这里显示的是此浏览器保存的本地副本。');
    } else if (error.status === 401 || error.status === 403) {
      archive('当前访问凭证不可用。这里只显示已保存的本地副本；实时访问需要有效邀请或只读链接。');
    } else {
      online = false;
      renderRoom();
      announce(error.message, true);
      pollTimer = setTimeout(refresh, 5000);
    }
  }

  async function poll() {
    if (!current || current.archived || current.meeting.state !== 'active') return;
    const opened = current;
    const version = pollVersion;
    const controller = new AbortController();
    polling = controller;
    const timeout = setTimeout(() => controller.abort(), 32000);
    try {
      const payload = await api(`${basePath()}/events?after=${current.cursor || 0}&waitMs=25000`, { token: accessToken(), signal: controller.signal });
      clearTimeout(timeout);
      if (current !== opened || version !== pollVersion) return;
      const confirmed = await absorb(payload);
      if (confirmed && current.meeting.state === 'active') pollTimer = setTimeout(poll, 100);
    } catch (error) {
      clearTimeout(timeout);
      if (current !== opened || version !== pollVersion) return;
      if (error.name === 'AbortError') pollTimer = setTimeout(refresh, 1000);
      else handleReadFailure(error);
    }
  }

  function participantAvatar(participant: { name: string; kind: string }) {
    const identity = avatarIdentity(participant.name);
    const avatar = make('span', `avatar ${participant.kind === 'human' ? 'human' : 'agent'}`, identity.initials);
    avatar.dataset.tone = identity.tone;
    avatar.setAttribute('aria-hidden', 'true');
    if (participant.kind !== 'human' && identity.icon) {
      const image = make('img', '');
      image.alt = '';
      image.addEventListener('error', () => {
        avatar.classList.remove('has-logo');
        avatar.replaceChildren(document.createTextNode(identity.initials));
      }, { once: true });
      image.src = identity.icon;
      avatar.classList.add('has-logo');
      avatar.replaceChildren(image);
    }
    return avatar;
  }

  function renderParticipants() {
    const members = current.meeting.participants || [];
    const ready = new Set(current.meeting.readyBy || []);
    const joined = members.filter((p) => !p.leftAt);
    const agents = joined.filter((p) => p.kind === 'agent').length;
    const humans = joined.filter((p) => p.kind === 'human').length;
    $('participant-count').textContent = `${agents} 个 Agent · ${humans} 人`;
    $('participants').replaceChildren();
    const selected = $('message-to').value;
    $('message-to').replaceChildren(new Option('所有参会者', ''));
    for (const participant of joined) {
      const mine = current.mode === 'participant' && participant.id === current.participantId;
      const card = make('div', `participant${mine ? ' is-self' : ''}`);
      const avatar = participantAvatar(participant);
      const info = make('div', 'participant-info');
      info.append(make('div', 'participant-name', `${participant.name}${mine ? ' · 我' : ''}`));
      const details = make('div', 'participant-details');
      details.append(make('span', `kind-badge ${participant.kind}`, participant.kind === 'human' ? '人' : 'Agent'));
      if (participant.id === current.meeting.hostId) details.append(make('span', '', '发起者'));
      if (ready.has(participant.id)) details.append(make('span', 'ready-marker', '✓ 已完成'));
      info.append(details); card.append(avatar, info); $('participants').append(card);
      if (!mine) $('message-to').append(new Option(nameOf(participant.id), participant.id));
    }
    if ([...$('message-to').options].some((o) => o.value === selected)) $('message-to').value = selected;
  }

  function setReply(event) {
    replyTo = event.seq;
    $('reply-text').textContent = `回复 ${nameOf(event.from)}：${event.data.text.slice(0, 140)}`;
    $('reply-strip').hidden = false;
    $('message-text').focus();
    $('message-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function clearReply() { replyTo = null; $('reply-strip').hidden = true; }

  function renderTimeline() {
    const version = `${current.events.length}:${current.events.at(-1)?.seq}:${current.meeting.state}:${canSpeak()}:${current.partial}`;
    if (version === timelineVersion) return;
    const timeline = $('timeline');
    const follow = timelineVersion === '' || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
    const oldScroll = timeline.scrollTop;
    timelineVersion = version;
    timeline.replaceChildren();
    if (current.partial) timeline.append(make('div', 'local-history-note', '此本地副本只包含部分会议记录。'));
    for (const event of current.events) {
      if (!event.data) {
        const state = event.bodyState === 'expired' ? '未确认投递的内容已过期' : '服务端已删除正文';
        timeline.append(make('div', 'local-history-note', `记录 #${event.seq}：${state}。此设备没有副本，请向参会 Agent 查看其本地记录。`));
        continue;
      }
      if (MESSAGE_TYPES.has(event.type)) {
        const author = person(event.from) || { name: '参会者', kind: 'agent' };
        const row = make('article', `message${author.kind === 'human' ? ' is-human' : ''}${event.from === current.participantId && current.mode === 'participant' ? ' is-self' : ''}`);
        row.id = `message-${event.seq}`;
        row.append(participantAvatar(author));
        const body = make('div', 'message-body');
        const head = make('div', 'message-head');
        head.append(make('span', 'message-name', author.name), make('span', `kind-badge ${author.kind}`, author.kind === 'human' ? '人工补充' : 'Agent'));
        if (TYPE_NAMES[event.type]) head.append(make('span', 'message-type', TYPE_NAMES[event.type]));
        if (event.data.to) head.append(make('span', 'message-target', `→ ${nameOf(event.data.to)}`));
        const stamp = make('time', '', time(event.at)); stamp.dateTime = event.at; head.append(stamp);
        body.append(head);
        if (event.data.replyTo) {
          const replyTo = event.data.replyTo;
          const original = current.events.find((e) => e.seq === replyTo);
          const reference = make('button', 'reply-reference', original ? `回复 ${nameOf(original.from)} · ${original.data?.text?.slice(0, 140) || ''}` : `回复消息 #${event.data.replyTo}`);
          reference.type = 'button';
          reference.addEventListener('click', () => {
            const target = document.getElementById(`message-${replyTo}`);
            if (!target) { announce('被回复的消息不在当前本地记录中。'); return; }
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.add('highlight'); setTimeout(() => target.classList.remove('highlight'), 1800);
          });
          body.append(reference);
        }
        body.append(make('div', 'message-text', event.data.text));
        if (canSpeak()) {
          const reply = make('button', 'reply-action', '回复这条消息'); reply.type = 'button';
          reply.addEventListener('click', () => setReply(event)); body.append(reply);
        }
        row.append(body); timeline.append(row);
      } else {
        let description = '';
        if (event.type === 'started') description = `${nameOf(event.from === 'system' ? current.meeting.hostId : event.from)} 发起会议`;
        if (event.type === 'joined') description = `${nameOf(event.data.participant?.id || event.from)} 加入会议`;
        if (event.type === 'left') description = `${nameOf(event.data.participant?.id || event.from)} 离开会议`;
        if (event.type === 'ready') description = `${nameOf(event.from)}${event.data.ready ? ' 已讨论完成' : ' 继续讨论'}`;
        if (event.type === 'closed') description = event.data.state === 'expired' ? '会议已到期' : '发起者结束会议';
        if (!description) continue;
        const system = make('div', 'system-event');
        const stamp = make('time', '', time(event.at)); stamp.dateTime = event.at;
        system.append(make('span', '', description), stamp); timeline.append(system);
      }
    }
    if (follow) { timeline.scrollTop = timeline.scrollHeight; $('jump-latest').hidden = true; }
    else { timeline.scrollTop = oldScroll; $('jump-latest').hidden = false; }
  }

  function renderRoom() {
    if (!current?.meeting) return;
    const meeting = current.meeting;
    document.title = `${(meeting.purpose || '会议').slice(0, 50)} · NokNok`;
    $('room-number').textContent = `会议 / ${meeting.id.slice(0, 8)}`;
    $('room-purpose').textContent = meeting.purpose || '会议目标已从服务端删除';
    const archived = current.archived;
    const terminal = meeting.state !== 'active';
    clearTimeout(expiryTimer);
    if (online && terminal && !archived && meeting.purgeAt) {
      expiryTimer = setTimeout(refresh, Math.min(2147483647, Math.max(100, new Date(meeting.purgeAt).getTime() - Date.now() + 100)));
    }
    $('room-status').textContent = archived ? '本地副本' : !online ? '连接中断' : meeting.state === 'ended' ? '已结束' : meeting.state === 'expired' ? '已到期' : '讨论中';
    $('room-status').className = `status-pill${archived || !online ? ' offline' : terminal ? ' ended' : ''}`;
    $('room-expiry').textContent = archived ? `创建于 ${time(meeting.createdAt, true)}` : terminal ? `会议状态保留至 ${time(meeting.purgeAt, true)}` : `会议有效至 ${time(meeting.idleExpiresAt && (!meeting.expiresAt || meeting.idleExpiresAt < meeting.expiresAt) ? meeting.idleExpiresAt : meeting.expiresAt, true)}`;
    $('connection-state').textContent = archived ? '服务状态不可用 · 仅显示本地保存内容' : !online ? '正在连接服务…' : current.mode === 'view' ? '只读查看 · 端到端加密' : self()?.leftAt ? '你已离开 · 可查看记录' : '已连接 · 端到端加密';
    $('connection-state').className = !online ? 'disconnected' : '';
    $('room-context').textContent = meeting.context || '此设备没有保存背景内容；服务端不提供完整历史。';
    const messageCount = current.events.filter((e) => MESSAGE_TYPES.has(e.type)).length;
    $('event-count').textContent = `${messageCount} 条发言`;
    renderParticipants();
    renderTimeline();
    const speak = canSpeak();
    $('message-form').hidden = !speak;
    $('read-only-note').hidden = Boolean(speak);
    $('read-only-note').textContent = archived ? '这是本地会议副本，无法继续发言。你可以下载保存，或清除本地副本。' : !online ? '连接恢复后可以继续发言。已输入的内容会留在本页。' : terminal ? '会议已结束。这里只显示此设备保存的记录。' : current.mode === 'view' ? '你正在只读查看。已删除的正文只能在各参会 Agent 的本地记录中查看；发言需要打开邀请并加入。' : '你已离开会议，可继续查看此设备保存的记录。';
    $('host-controls').hidden = !speak || !isHost();
    $('composer-name').textContent = self()?.name || '';
    $('copy-invite').hidden = !current.access.invite || current.mode === 'view' || archived || terminal;
    $('copy-view').hidden = !current.access.view || Boolean(archived);
    $('summary-block').hidden = !meeting.summary;
    $('room-summary').textContent = meeting.summary || '';
    if (!storageAvailable) $('local-save-state').textContent = '本地保存失败，请下载记录。';
  }

  async function mutate(action, body = {}) {
    if (!canSpeak() || mutationPending) return null;
    mutationPending = true;
    const buttons = [...$('room').querySelectorAll('button'), ...$('end-dialog').querySelectorAll('button')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const request = await requestFor(`${basePath()}/${action}`, body);
      const payload = await api(`${basePath()}/${action}`, { token: accessToken(), body: request.body });
      await absorb(payload);
      requests.complete(request);
      return payload;
    } catch (error) {
      announce(`${error.message} 操作未确认，请保留内容并检查会议状态后重试。`, true);
      if (error.status === 404 || error.status === 410) archive('会议已不可用。页面保留本地记录。');
      return null;
    } finally {
      mutationPending = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); announce('已复制。'); }
    catch {
      const field = make('textarea', ''); field.value = text; field.style.position = 'fixed'; field.style.top = '0'; field.style.left = '0';
      document.body.append(field); field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Show a useful fallback below. */ }
      if (copied) { field.remove(); announce('已复制。'); }
      else {
        field.setAttribute('aria-label', '请手动复制内容');
        field.style.cssText = 'position:fixed;left:5vw;top:100px;width:90vw;height:180px;z-index:20;background:white';
        field.addEventListener('blur', () => field.remove(), { once: true });
        announce('浏览器未授予剪贴板权限。已选中内容，请手动复制；移开焦点后会关闭。', true);
      }
    }
  }

  async function previewInvitation(parsed) {
    stopPolling();
    visible('invitation');
    pendingInvitation = parsed;
    $('join-form').hidden = true;
    $('agent-join-help').hidden = true;
    try {
      const payload = await api(`/v1/meetings/${encodeURIComponent(parsed.id)}/invitation`, { token: parsed.token });
      const { payload: decrypted } = await decryptMeetingPayload(payload, { id: parsed.id, key: parsed.key, encryptionId: parsed.encryptionId });
      const meeting = decrypted.meeting;
      $('invite-purpose').textContent = meeting.purpose || '会议目标已从服务端删除';
      $('invite-context').textContent = meeting.context || '加入后接收新消息。历史内容请向参会 Agent 查看其本地记录。';
      $('invite-facts').replaceChildren(make('span', '', `${meeting.participants?.filter((p) => !p.leftAt).length || 1} 位参与者`), make('span', '', `有效至 ${time(meeting.idleExpiresAt && (!meeting.expiresAt || meeting.idleExpiresAt < meeting.expiresAt) ? meeting.idleExpiresAt : meeting.expiresAt, true)}`));
      $('join-form').hidden = meeting.state !== 'active';
      $('return-to-room').hidden = !storage.rooms.some((r) => r.meeting.id === parsed.id && r.access?.participant);
      const invitationUrl = `${location.origin}/invite/${parsed.id}#${new URLSearchParams({ invite: parsed.token, key: parsed.key, e2ee: parsed.encryptionId })}`;
      $('agent-instructions').textContent = meetingJoinInstructions(invitationUrl);
      $('agent-prompt').value = meetingInvitationText(invitationUrl);
      $('agent-join-help').hidden = meeting.state !== 'active';
      if (meeting.state !== 'active') announce('这场会议已经结束，不能再加入。', true);
    } catch (error) {
      $('invite-purpose').textContent = '无法打开这份邀请';
      $('invite-context').textContent = error.status === 404 || error.status === 410 ? '会议可能已到期，或服务已重启。请向发起者获取新的邀请。' : error.message;
      announce(error.message, true);
    }
  }

  $('join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('join-form').querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try {
      storage.name = $('join-name').value.trim() || storage.name;
      const joinPath = `/v1/meetings/${encodeURIComponent(pendingInvitation.id)}/join`;
      const request = await requestFor(joinPath, { token: pendingInvitation.token, name: storage.name, kind: 'human' });
      const payload = await api(joinPath, { body: request.body });
      const decrypted = await decryptMeetingPayload(payload, { id: pendingInvitation.id, key: pendingInvitation.key, encryptionId: pendingInvitation.encryptionId });
      const view = new URLSearchParams(new URL(payload.viewUrl, location.origin).hash.slice(1)).get('view');
      await openRoom({ meeting: decrypted.payload.meeting, participantId: payload.participant.id, mode: 'participant', access: { participant: payload.participant.token, invite: pendingInvitation.token, view, key: pendingInvitation.key, encryptionId: pendingInvitation.encryptionId }, encryptedEvents: decrypted.encryptedEvents, events: decrypted.payload.events || [], pendingDeliveryReceipts: payload.deliveryReceipts || [], cursor: 0 }, true);
      requests.complete(request);
      announce('已加入会议。你可以随时补充信息。');
    } catch (error) { announce(error.message, true); }
    finally { button.disabled = false; }
  });
  $('return-to-room').addEventListener('click', () => {
    const record = storage.rooms.find((r) => r.meeting.id === pendingInvitation.id && r.access?.participant);
    if (record) openRoom({ ...structuredClone(record), mode: 'participant' });
  });
  $('copy-agent-prompt').addEventListener('click', () => copy($('agent-prompt').value));
  $('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message-text').value.trim();
    if (!text) return;
    const body: { text: string; replyTo?: number; to?: string } = { text };
    if (replyTo) body.replyTo = replyTo;
    if ($('message-to').value) body.to = $('message-to').value;
    if (await mutate('messages', body)) {
      if ($('message-text').value.trim() === text) $('message-text').value = '';
      if (replyTo === body.replyTo || (!replyTo && !body.replyTo)) clearReply();
      $('timeline').scrollTop = $('timeline').scrollHeight;
    }
  });
  $('message-text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('message-form').requestSubmit(); } });
  $('cancel-reply').addEventListener('click', clearReply);
  $('toggle-details').addEventListener('click', () => {
    const open = Boolean($('room-details').hidden);
    $('room-details').hidden = !open;
    $('room').classList.toggle('details-open', open);
    $('toggle-details').setAttribute('aria-expanded', String(open));
  });
  $('open-end').addEventListener('click', () => $('end-dialog').showModal());
  $('cancel-end').addEventListener('click', () => $('end-dialog').close());
  $('end-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (await mutate('end', { text: $('end-summary').value.trim(), reason: 'host_decision' })) { $('end-dialog').close(); stopPolling(); await refresh(); announce('会议已结束，记录已留在此浏览器。'); }
  });
  $('copy-invite').addEventListener('click', () => copy(meetingInvitationText(link('invite', current.access.invite), current.access.view ? link('view', current.access.view) : undefined)));
  $('copy-view').addEventListener('click', () => copy(link('view', current.access.view)));
  $('export-room').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(transcriptOf(current), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = make('a', ''); anchor.href = url; anchor.download = `noknok-meeting-${current.meeting.id.slice(0, 8)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('clear-local').addEventListener('click', () => {
    if (!confirm('清除此浏览器保存的会议记录及入会身份？当前页面仍可继续使用，刷新后不会恢复。其他参与者和服务上的记录不受影响。')) return;
    try {
      cache.clear(current.meeting.id);
      history.replaceState(null, '', `/meeting#${new URLSearchParams({ id: current.meeting.id })}`);
      storage.rooms = cache.read().rooms;
      persistencePaused = true;
      persist();
      announce('已清除此会议的本地副本。此页后续内容只保存在内存中。', false, true);
    } catch { storageWarning('清除失败：浏览器无法访问本地存储。请通过浏览器的网站数据设置清除。'); }
  });
  $('jump-latest').addEventListener('click', () => { $('timeline').scrollTop = $('timeline').scrollHeight; $('jump-latest').hidden = true; });
  $('timeline').addEventListener('scroll', () => { if ($('timeline').scrollHeight - $('timeline').scrollTop - $('timeline').clientHeight < 100) $('jump-latest').hidden = true; });
  window.addEventListener('beforeunload', stopPolling);
  window.addEventListener('hashchange', () => location.reload());
  window.addEventListener('online', () => { if (current && !current.archived) { stopPolling(); refresh(); } });
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith(STORAGE_KEY)) return;
    try {
      storage.rooms = cache.read().rooms;
      if (current && cache.generation(current.meeting.id) !== currentGeneration) {
        persistencePaused = true;
        storageWarning('此会议的本地副本已在另一个页面清除。本页不再自动保存，仍可下载当前内存中的记录。');
        persist();
      }
      if (!$('landing').hidden) renderLanding();
    } catch { storageWarning('浏览器未能同步其他页面保存的会议记录。请下载当前记录。'); }
  });

  if (!parsed) { renderLanding(); if (initialHash) announce('会议链接缺少有效的端到端加密密钥或访问凭证，请获取完整链接。', true); }
  else if (parsed.mode === 'invite') previewInvitation(parsed);
  else if (parsed.mode === 'saved') openSaved(parsed.id);
  else {
    const existing = storage.rooms.find((r) => r.meeting.id === parsed.id);
    openRoom({ ...(existing ? structuredClone(existing) : {}), meeting: existing?.meeting || { id: parsed.id, participants: [], state: 'active' }, events: existing?.events || [], mode: 'view', access: { ...(existing?.access || {}), view: parsed.token, key: parsed.key, encryptionId: parsed.encryptionId }, cursor: 0 });
  }
}
