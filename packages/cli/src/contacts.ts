import type { ContactActivity } from './runtime-types.js';
import type { CliOptions, CommandContext } from './runtime-types.js';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { api, decodeInvitation, fail, normalizeServer } from './client.js';
import { sessionViewUrl } from './invitation.js';

const PROFILE_FILE = 'contacts.json';
const DEFAULT_SERVER = 'http://127.0.0.1:4317';
const AGENT_ID = /^ag_[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const contactId = token => `ag_${createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex')}`;
const publicAgent = profile => ({ id: profile.id, name: profile.name });

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw fail('INVALID_ARGUMENT', 'Provide a single display name of 1–256 UTF-8 bytes with --name.');
  }
  return name.trim();
}

function normalizeProduct(product) {
  if (product === undefined) return undefined;
  if (typeof product !== 'string' || !product.trim() || Buffer.byteLength(product) > 128
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(product)) {
    throw fail('INVALID_ARGUMENT', 'Provide a product name such as dot or doubaowork with --product.');
  }
  const value = product.trim().toLowerCase().replace(/[ _]+/g, '-');
  const aliases: Record<string, string> = { 'codex-dot': 'dot', 'doubao-work': 'doubaowork', '豆包工作': 'doubaowork' };
  const normalized = Object.hasOwn(aliases, value) ? aliases[value] : value;
  if (normalized.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw fail('INVALID_ARGUMENT', 'Use a product name of 1–64 lowercase letters, digits, and hyphens, such as dot or doubaowork.');
  }
  return normalized;
}

function checkContact(value) {
  if (!value || !AGENT_ID.test(value.id) || typeof value.name !== 'string') throw fail('INVALID_RESPONSE', 'Switch returned an invalid contact.');
  return { id: value.id, name: checkName(value.name) };
}

export function decodeContactLink(link) {
  try {
    if (typeof link !== 'string' || link.length > 16384 || !link.startsWith('noknok://contact/')) throw new Error();
    const encoded = link.slice('noknok://contact/'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (value.v !== 1 || typeof value.inviteId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.inviteId)
      || !TOKEN.test(value.token) || Buffer.from(value.token, 'base64url').toString('base64url') !== value.token
      || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error();
    const server = normalizeServer(value.server);
    if (new URL(server).pathname !== '/') throw new Error();
    return { v: 1, server, inviteId: value.inviteId, token: value.token, expiresAt: value.expiresAt };
  } catch { throw fail('INVALID_CONTACT_LINK', 'Expected a complete noknok://contact/... friend invitation.'); }
}

async function saveProfile(store, profile) {
  const path = join(store.directory, PROFILE_FILE), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(profile)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function loadProfile(store) {
  try {
    const profile = JSON.parse(await readFile(join(store.directory, PROFILE_FILE), 'utf8'));
    if (profile.v !== 1 || !TOKEN.test(profile.token) || contactId(profile.token) !== profile.id
      || !Array.isArray(profile.contacts) || !Array.isArray(profile.pendingCalls) || !profile.requests
      || !Number.isSafeInteger(profile.cursor) || profile.cursor < 0) throw new Error('Invalid local contact profile.');
    return profile;
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('IDENTITY_NOT_FOUND', 'Create an identity, friend link, or accept a friend link using this local profile first.');
    throw error;
  }
}

function findContact(profile, value) {
  const matches = profile.contacts.filter(contact => contact.id === value || contact.name === value);
  if (matches.length !== 1) throw fail('CONTACT_NOT_FOUND', matches.length ? 'Several contacts use that name; use the exact Agent ID from friends.' : 'Contact not found. Run friends to synchronize an accepted friend invitation.');
  return matches[0];
}

const rpc = (profile, operation, body, signal, timeoutMs: number | undefined = undefined) => api(profile.server, '/v1/contacts', {
  method: 'POST', token: profile.token, body: { op: operation, ...body }, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

async function register(store, profile, signal) {
  const result = await rpc(profile, 'register', { name: profile.name, contacts: profile.contacts.map(contact => contact.id) }, signal);
  if (result.agent?.id !== profile.id) throw fail('INVALID_RESPONSE', 'Switch returned an inconsistent local identity.');
  if (typeof result.instanceId !== 'string' || !result.instanceId) throw fail('INVALID_RESPONSE', 'Switch did not identify its running instance.');
  if (result.instanceId !== profile.instanceId) {
    profile.instanceId = result.instanceId;
    profile.cursor = 0;
    await saveProfile(store, profile);
  }
  return result;
}

async function acceptCall(store, profile, event, signal) {
  const friend = profile.contacts.find(contact => contact.id === event.from?.id);
  if (!friend) return { seq: event.seq, outcome: 'rejected', reason: 'sender_not_a_contact' };
  let invitation;
  try { invitation = decodeInvitation(event.invitation); }
  catch { return { seq: event.seq, outcome: 'rejected', reason: 'invalid_invitation' }; }
  if (invitation.server !== profile.server) return { seq: event.seq, outcome: 'rejected', reason: 'different_switch' };
  const existing = profile.pendingCalls.find(call => call.callId === invitation.callId);
  if (existing) return existing;
  // Contact display names may improve after the first join attempt. The
  // already persisted join payload still owns this single-use invitation.
  const pending = await store.acceptance(event.invitation, profile.name, undefined, { reuseName: true });
  try {
    let result;
    try {
      result = await api(profile.server, `/v1/calls/${encodeURIComponent(invitation.callId)}/join`, {
        method: 'POST', body: { token: invitation.token, name: pending.name, requestId: pending.requestId }, signal,
      });
    } catch (error) {
      // Terminal relay responses cannot become successful by replaying the event.
      if (['call_closed', 'call_not_found', 'not_found', 'invalid_invitation', 'invitation_expired', 'invitation_unavailable', 'already_joined'].includes(error.code)) {
        return { seq: event.seq, outcome: 'missed', from: friend, reason: error.code, callId: invitation.callId };
      }
      throw error;
    }
    if (result.call?.id !== invitation.callId || result.participant?.role !== 'callee') throw fail('INVALID_RESPONSE', 'Switch returned an inconsistent accepted call.');
    let session;
    try {
      session = await store.load(pending.session);
      if (session.server !== profile.server || session.callId !== invitation.callId || session.token !== result.participant.token || session.role !== 'callee') {
        throw fail('SESSION_CONFLICT', 'Saved accepted session differs from this contact call.');
      }
    } catch (error) {
      if (error.code !== 'SESSION_NOT_FOUND') throw error;
      session = await store.create(profile.server, result.call, result.participant, pending.session);
    }
    return {
      seq: event.seq, outcome: 'incoming_call', from: friend, session: session.id, callId: session.callId,
      viewSession: session.callId, viewUrl: sessionViewUrl(profile.server, session.callId), call: result.call,
    };
  } finally { await pending.release(); }
}

async function processEvents(store, profile, result, signal) {
  if (!Array.isArray(result.events) || !Number.isSafeInteger(result.nextCursor) || result.nextCursor < profile.cursor) throw fail('INVALID_RESPONSE', 'Switch returned an invalid event cursor.');
  let contactsChanged = false;
  for (const event of result.events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= profile.cursor || event.seq > result.nextCursor) throw fail('INVALID_RESPONSE', 'Switch returned an invalid event sequence.');
    if (event.type === 'contact_added') {
      const contact = checkContact(event.contact);
      if (contact.id === profile.id) throw fail('INVALID_RESPONSE', 'Switch returned self as a friend.');
      const prior = profile.contacts.findIndex(entry => entry.id === contact.id);
      if (prior < 0) profile.contacts.push(contact); else profile.contacts[prior] = contact;
      contactsChanged = true;
    } else if (event.type === 'incoming_call') {
      const activity = await acceptCall(store, profile, event, signal);
      if (!profile.pendingCalls.some(entry => entry.seq === event.seq && entry.instanceId === profile.instanceId)) {
        profile.pendingCalls.push({ ...activity, instanceId: profile.instanceId });
      }
    } else throw fail('INVALID_RESPONSE', 'Switch returned an unsupported contact event.');
    // Persist each accepted session/contact before advancing the switch's cursor.
    profile.cursor = event.seq;
    await saveProfile(store, profile);
  }
  if (result.events.length && profile.cursor !== result.nextCursor) throw fail('INVALID_RESPONSE', 'Switch returned an inconsistent final event cursor.');
  await rpc(profile, 'ack', { through: profile.cursor }, signal);
  if (contactsChanged) await register(store, profile, signal);
}

async function synchronize(store, profile, signal) {
  await register(store, profile, signal);
  const result = await rpc(profile, 'poll', { after: profile.cursor, waitMs: 0 }, signal);
  await processEvents(store, profile, result, signal);
}

async function pendingActivity(store, profile, signal) {
  const active: ContactActivity[] = [];
  for (const entry of profile.pendingCalls) {
    if (entry.outcome !== 'incoming_call') { active.push(entry); continue; }
    const session = await store.load(entry.session);
    try {
      const result = await api(profile.server, `/v1/calls/${encodeURIComponent(entry.callId)}`, { token: session.token, signal });
      if (['waiting', 'connected'].includes(result.call.state)) active.push({ ...entry, call: result.call });
    } catch (error) {
      if (!['not_found', 'call_not_found'].includes(error.code)) throw error;
    }
  }
  const terminal = active.filter(entry => entry.outcome !== 'incoming_call');
  profile.activityHistory = [...(profile.activityHistory || []), ...terminal].slice(-100);
  profile.pendingCalls = active.filter(entry => entry.outcome === 'incoming_call');
  await saveProfile(store, profile);
  return active.map(({ instanceId, seq, ...entry }) => entry);
}

async function callContact(store, profile, args, options, signal) {
  const contact = findContact(profile, args[0]);
  if (typeof options.purpose !== 'string' || !options.purpose.trim()) throw fail('INVALID_ARGUMENT', 'Provide --purpose with a concrete collaboration goal.');
  if (options.context !== undefined && options['context-file'] !== undefined) throw fail('INVALID_ARGUMENT', 'Use either --context or --context-file.');
  if (options['context-file'] === '-') throw fail('INVALID_ARGUMENT', 'For contact calls, --context-file must name a UTF-8 file.');
  const context = options['context-file'] === undefined ? options.context : await readFile(options['context-file'], { encoding: 'utf8', signal });
  const requestId = options['request-id'] || randomUUID();
  if (typeof requestId !== 'string' || !requestId.trim() || Buffer.byteLength(requestId) > 128) throw fail('INVALID_ARGUMENT', '--request-id must contain 1–128 UTF-8 bytes.');
  const payload = { recipientId: contact.id, purpose: options.purpose, ...(context === undefined ? {} : { context }) };
  const fingerprint = JSON.stringify(payload);
  let receipt = Object.hasOwn(profile.requests, requestId) ? profile.requests[requestId] : undefined;
  if (receipt && receipt.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'This request ID was already used for a different contact call.');
  if (receipt?.failure) throw fail(receipt.failure.code, receipt.failure.message);
  if (receipt?.output) return receipt.output;
  if (!receipt) {
    receipt = { fingerprint, name: profile.name, inviteRequestId: randomUUID(), deliverRequestId: randomUUID(), cancelRequestId: randomUUID(), session: `ac_${randomUUID()}` };
    Object.defineProperty(profile.requests, requestId, { value: receipt, enumerable: true, writable: true, configurable: true });
    await saveProfile(store, profile);
  }
  if (!receipt.created) {
    const result = await api(profile.server, '/v1/calls', {
      method: 'POST', body: { name: receipt.name ?? profile.name, purpose: options.purpose, context, requestId: receipt.inviteRequestId },
      key: process.env.NOKNOK_SERVER_KEY, signal,
    });
    const invitation = decodeInvitation(result.invitation);
    if (invitation.server !== profile.server || result.call?.id !== invitation.callId || result.participant?.role !== 'caller'
      || result.viewSession !== invitation.callId || result.viewUrl !== sessionViewUrl(profile.server, invitation.callId)) throw fail('INVALID_RESPONSE', 'Switch returned an inconsistent contact-call invitation.');
    receipt.created = result;
    await saveProfile(store, profile);
  }
  const created = receipt.created;
  let session;
  try {
    session = await store.load(receipt.session);
    if (session.server !== profile.server || session.callId !== created.call.id || session.token !== created.participant.token || session.role !== 'caller') throw fail('SESSION_CONFLICT', 'Saved outgoing session differs from this contact call.');
  }
  catch (error) {
    if (error.code !== 'SESSION_NOT_FOUND') throw error;
    session = await store.create(profile.server, created.call, created.participant, receipt.session);
  }
  try {
    await rpc(profile, 'deliver', { recipientId: contact.id, invitation: created.invitation, requestId: receipt.deliverRequestId }, signal);
  } catch (error) {
    if (['contact_unavailable', 'recipient_unavailable', 'unavailable', 'not_a_contact', 'contact_not_found', 'forbidden', 'not_connected'].includes(error.code)) {
      // A definite refusal has no recipient side effect, so cancel the unused call.
      const cancelled = await api(profile.server, `/v1/calls/${encodeURIComponent(session.callId)}/hangup`, {
        method: 'POST', token: session.token, body: { reason: 'Contact is unavailable; invitation was not delivered.', requestId: receipt.cancelRequestId }, signal,
      });
      await store.record(session.id, { direction: 'sent', action: 'hangup', reason: 'contact_unavailable', requestId: receipt.cancelRequestId, callState: cancelled.call.state });
      receipt.failure = { code: 'CONTACT_UNAVAILABLE', message: 'Contact is not listening or has not authorized this identity. Ask it to run listen in its local environment, then start a new call with a new request ID. The unused call was cancelled.' };
      await saveProfile(store, profile);
      throw fail(receipt.failure.code, receipt.failure.message);
    }
    // A transport failure may have delivered already. Preserve the receipt so a
    // retry with the same request ID never creates or delivers a second call.
    throw Object.assign(error, { requestId });
  }
  receipt.output = {
    session: session.id, callId: session.callId, contact, requestId,
    viewSession: session.callId, viewUrl: sessionViewUrl(profile.server, session.callId), outcome: 'delivered',
    next: 'Show viewSession and viewUrl now. Then use wait/send/receive/finish with this local session to converse.',
  };
  await saveProfile(store, profile);
  return receipt.output;
}

/** One local identity per state directory. No private credential is returned. */
export async function contactCommand(command: string, args: string[] = [], options: CliOptions = {}, { signal }: CommandContext = {}) {
  const expected = ['friend-add', 'friend-remove', 'call'].includes(command) ? 1 : 0;
  if (args.length !== expected) throw fail('INVALID_ARGUMENT', `Expected ${expected} positional argument(s) for ${command}.`);
  if (!['identity', 'friend-link', 'friend-add', 'friend-remove', 'friends', 'listen', 'call'].includes(command)) throw fail('INVALID_COMMAND', 'Unknown contact command.');
  // Validate bootstrap input before creating any identity on disk. In
  // particular, a friend invitation supplies its own switch address.
  const invitation = command === 'friend-add' ? decodeContactLink(args[0]) : undefined;
  const requestedName = options.name === undefined ? undefined : checkName(options.name);
  const requestedProduct = normalizeProduct(options.product ?? process.env.NOKNOK_PRODUCT);
  const requestedServer = options.server === undefined ? undefined : normalizeServer(options.server);
  if (requestedServer !== undefined && new URL(requestedServer).pathname !== '/') throw fail('INVALID_SERVER', 'Contact switch must use an HTTP(S) origin without a path prefix.');
  if (invitation && requestedServer !== undefined && requestedServer !== invitation.server) throw fail('DIFFERENT_SWITCH', 'The specified switch differs from the friend invitation.');
  if (options['request-id'] !== undefined && (typeof options['request-id'] !== 'string' || !options['request-id'].trim() || Buffer.byteLength(options['request-id']) > 128)) {
    throw fail('INVALID_ARGUMENT', '--request-id must contain 1–128 UTF-8 bytes.');
  }
  const store = new Store(options['state-dir']);
  await store.init();
  const unlock = await store.lockPath(join(store.directory, 'contacts.lock'));
  try {
    let profile;
    try { profile = await loadProfile(store); }
    catch (error) {
      if (error.code !== 'IDENTITY_NOT_FOUND' || !['identity', 'friend-link', 'friend-add'].includes(command)) throw error;
      const server = requestedServer || invitation?.server || normalizeServer(process.env.NOKNOK_SERVER || DEFAULT_SERVER);
      if (new URL(server).pathname !== '/') throw fail('INVALID_SERVER', 'Contact switch must use an HTTP(S) origin without a path prefix.');
      const token = randomBytes(32).toString('base64url');
      const id = contactId(token);
      const name = requestedName || (requestedProduct ? `agent-${requestedProduct}` : 'agent');
      profile = {
        v: 1, id, name, nameSource: requestedName === undefined ? 'default' : 'explicit',
        ...(requestedProduct === undefined ? {} : { product: requestedProduct }),
        server, token, contacts: [], cursor: 0, pendingCalls: [], requests: {}, createdAt: new Date().toISOString(),
      };
      await saveProfile(store, profile);
    }
    if (requestedServer !== undefined && requestedServer !== profile.server) throw fail('IDENTITY_CONFLICT', 'This state directory already belongs to another switch. Use its saved server or a separate --state-dir.');
    if (requestedName !== undefined && requestedName !== profile.name) throw fail('IDENTITY_CONFLICT', 'This state directory already belongs to another name. Use its saved identity or a separate --state-dir.');
    if (invitation && invitation.server !== profile.server) throw fail('DIFFERENT_SWITCH', 'This friend invitation belongs to a different switch. Use a separate identity/state directory for that switch.');
    // Product hints improve generated placeholders once; they never rename an
    // explicit name or change an already identified product on a later host.
    const genericDefault = profile.nameSource === 'default' && profile.name === 'agent' && profile.product === undefined;
    if (requestedName === undefined && requestedProduct !== undefined && genericDefault) {
      profile.name = `agent-${requestedProduct}`;
      profile.nameSource = 'default';
      profile.product = requestedProduct;
      await saveProfile(store, profile);
    }
    if (command === 'identity') {
      await synchronize(store, profile, signal);
      return { agent: publicAgent(profile), server: profile.server, storage: 'local', directory: store.directory };
    }
    if (command === 'friend-add' && invitation) {
      await synchronize(store, profile, signal);
      const requestId = options['request-id'] || `add-${createHash('sha256').update(`${invitation.inviteId}:${invitation.token}`).digest('hex')}`;
      const result = await rpc(profile, 'add', { inviteId: invitation.inviteId, inviteToken: invitation.token, requestId }, signal);
      const contact = checkContact(result.contact);
      if (contact.id === profile.id) throw fail('INVALID_RESPONSE', 'Cannot add your own identity.');
      const index = profile.contacts.findIndex(entry => entry.id === contact.id);
      if (index < 0) profile.contacts.push(contact); else profile.contacts[index] = contact;
      await saveProfile(store, profile);
      await synchronize(store, profile, signal);
      return { agent: publicAgent(profile), contact, outcome: 'added', remoteSyncPending: true, next: 'Contact added; no listener was started. An already configured background receiver continues receiving. For persistent dot reception use receiver start and a native MCP Events subscription once; do not run a model-side wait loop. Active CLI-only tests can use listen only when the user asks to receive calls. The inviter persists this contact when it next runs friends, listen, or call.' };
    }
    await synchronize(store, profile, signal);
    if (command === 'friend-link') {
      const result = await rpc(profile, 'invite', { requestId: options['request-id'] || randomUUID() }, signal);
      const invitation = decodeContactLink(result.contactLink);
      if (invitation.server !== profile.server || result.agent?.id !== profile.id) throw fail('INVALID_RESPONSE', 'Switch returned an inconsistent friend invitation.');
      return { agent: publicAgent(profile), server: profile.server, contactLink: result.contactLink, expiresAt: result.expiresAt, next: 'Share this one-use friend invitation only with the intended agent. Creating and redeeming it authorizes mutual calls.' };
    }
    if (command === 'friends') return { agent: publicAgent(profile), server: profile.server, contacts: profile.contacts, pendingCalls: profile.pendingCalls.filter(entry => entry.outcome === 'incoming_call').length };
    if (command === 'friend-remove') {
      const contact = findContact(profile, args[0]);
      profile.contacts = profile.contacts.filter(entry => entry.id !== contact.id);
      await saveProfile(store, profile);
      await register(store, profile, signal);
      return { contact, outcome: 'removed', next: 'Future contact calls from this agent are denied. Existing accepted call sessions remain separate.' };
    }
    if (command === 'call') {
      const requestId = options['request-id'] || randomUUID();
      try { return await callContact(store, profile, args, { ...options, 'request-id': requestId }, signal); }
      catch (error) { throw Object.assign(error, { requestId }); }
    }
    const timeout = options.timeout === undefined ? 45 : Number(options.timeout);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 45 || String(options.timeout ?? '').trim() === '' && options.timeout !== undefined) throw fail('INVALID_ARGUMENT', '--timeout must be between 0 and 45 seconds.');
    const deadline = Date.now() + timeout * 1000;
    do {
      const activity = await pendingActivity(store, profile, signal);
      if (activity.length) return { agent: publicAgent(profile), outcome: 'activity', calls: activity, next: 'Use each incoming call local session with send/receive/finish. Calls are retained here until closed; do not start duplicate work.' };
      const waitMs = Math.min(25000, Math.max(0, Math.floor(deadline - Date.now())));
      if (!waitMs) break;
      const result = await rpc(profile, 'poll', { after: profile.cursor, waitMs }, signal, waitMs + 10000);
      await processEvents(store, profile, result, signal);
    } while (Date.now() < deadline);
    const activity = await pendingActivity(store, profile, signal);
    return { agent: publicAgent(profile), outcome: activity.length ? 'activity' : 'timeout', calls: activity, next: 'Run listen again to keep receiving. Listening does not wake an idle model or continue after the host ends the tool call.' };
  } finally { await unlock(); }
}
