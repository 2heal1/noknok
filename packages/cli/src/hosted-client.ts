import type { CliOptions, CommandContext } from './runtime-types.js';
import type { LocalHostedState } from './hosted-types.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { api, fail, normalizeServer } from './client.js';
import { MeetingStore, decodeMeetingLink, acknowledgeMeeting, archivedMeetingResult } from './meeting-client.js';
import { meetingInvitationText } from '../web/meeting-invitation.js';

const secret = () => randomBytes(32).toString('base64url');
const credential = value => typeof value === 'string' && /^[A-Za-z0-9_.~-]{16,16384}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function hostedOrigin(value: string): string {
  const server = normalizeServer(value);
  const url = new URL(server);
  if (url.pathname !== '/' || (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw fail('INVALID_SERVER', 'Hosted service must use an HTTPS origin. HTTP is allowed only on localhost for development.');
  }
  return url.origin;
}

export function decodeHostedContact(value: unknown) {
  try {
    if (typeof value !== 'string' || value.length > 20000 || /[\s\\]/u.test(value)) throw new Error();
    const url = new URL(value), params = new URLSearchParams(url.hash.slice(1));
    if (url.pathname !== '/contact' || url.search || url.username || url.password || params.size !== 1 || !credential(params.get('offer'))) throw new Error();
    return { server: hostedOrigin(url.origin), offer: params.get('offer') };
  } catch { throw fail('INVALID_CONTACT', 'Use a complete NokNok contact link with an offer in its fragment.'); }
}

function nameFrom(options: CliOptions): string {
  let product = options.product ?? process.env.NOKNOK_PRODUCT;
  if (product !== undefined) {
    if (typeof product !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(product)) throw fail('INVALID_ARGUMENT', 'Invalid product name.');
    product = product.trim().toLowerCase().replace(/[ _]+/g, '-');
    product = ({ 'codex-dot': 'dot', 'doubao-work': 'doubaowork', '豆包工作': 'doubaowork' })[product] || product;
    if (product.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product)) throw fail('INVALID_ARGUMENT', 'Use a product name such as codex, dot or doubaowork.');
  }
  const name = options.name ?? (product ? `agent-${product}` : 'agent');
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) throw fail('INVALID_ARGUMENT', 'Invalid agent display name.');
  return name.trim();
}

class HostedStore {
  directory: string;
  path: string;
  meetings: MeetingStore;
  constructor(directory: string | undefined) {
    if (!directory) throw fail('AGENT_REQUIRED', 'Run hosted setup first, then reuse its exact --agent handle.');
    this.directory = directory;
    this.path = join(directory, 'hosted.json');
    this.meetings = new MeetingStore(directory);
  }
  async locked<T>(operation: (state: LocalHostedState | undefined, save: (state: LocalHostedState) => Promise<void>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('INVALID_LOCAL_STATE', 'Hosted state directory must not be a symbolic link.');
    const release = await this.meetings.lock(`${this.path}.lock`, signal);
    try {
      let state: LocalHostedState | undefined;
      try {
        const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await file.stat()).isFile()) throw fail('INVALID_LOCAL_STATE', 'Hosted state must be a regular file.');
          state = JSON.parse(await file.readFile('utf8'));
        } finally { await file.close(); }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (state && (state.v !== 1 || !state.contacts || !Array.isArray(state.offers))) throw fail('INVALID_LOCAL_STATE', 'Invalid hosted profile. Restore a trusted local backup.');
      return await operation(state, async value => {
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.path);
        } finally { await unlink(temporary).catch(() => {}); }
      });
    } finally { await release(); }
  }
}

export async function hostedTool(server: string, token: string, name: string, args: Record<string, unknown> = {}, { signal }: { signal?: AbortSignal } = {}) {
  const id = randomUUID();
  const response = await api(server, '/mcp', { method: 'POST', token, signal,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });
  if (response.id !== id || response.jsonrpc !== '2.0') throw fail('INVALID_RESPONSE', 'Hosted MCP returned an invalid response.');
  if (response.error) throw fail(response.error.data?.code || 'MCP_ERROR', response.error.message || 'Hosted MCP request failed.');
  const result = response.result;
  if (!result || typeof result !== 'object') throw fail('INVALID_RESPONSE', 'Hosted MCP returned no tool result.');
  let data = result.structuredContent;
  if (!data) {
    try { data = JSON.parse(result.content?.find(item => item.type === 'text')?.text); }
    catch { throw fail('INVALID_RESPONSE', 'Hosted MCP returned an invalid tool result.'); }
  }
  if (result.isError) throw fail(data.error?.code || data.code || 'HOSTED_ERROR', data.error?.message || data.message || 'Hosted operation failed.');
  return data;
}

function contactFrom(result) {
  const contact = result.contact;
  if (!contact || !identifier(contact.peerId) || !credential(contact.capability)) throw fail('INVALID_RESPONSE', 'Hosted service returned an invalid contact.');
  if (result.issuedCapability !== undefined && !credential(result.issuedCapability)) throw fail('INVALID_RESPONSE', 'Hosted service returned an invalid revocation credential.');
  return { peerId: contact.peerId, capability: contact.capability, ...(result.issuedCapability ? { issuedCapability: result.issuedCapability } : {}), addedAt: new Date().toISOString(), ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}) };
}

function publicContacts(state: LocalHostedState) {
  return Object.values(state.contacts).map(({ peerId, addedAt, expiresAt }) => ({ peerId, addedAt, ...(expiresAt ? { expiresAt } : {}) }));
}

async function archiveMeeting(store, state, result, pending, signal) {
  if (!result.meeting || !result.participant || !credential(result.participant.token) || !identifier(result.participant.id)) throw fail('INVALID_RESPONSE', 'Hosted service returned an invalid meeting.');
  const view = decodeMeetingLink(result.viewUrl, 'view');
  if (view.id !== result.meeting.id || view.server !== state.server) throw fail('INVALID_RESPONSE', 'Hosted service returned an inconsistent meeting view.');
  if (result.invitationUrl) {
    const invitation = decodeMeetingLink(result.invitationUrl);
    if (invitation.id !== result.meeting.id || invitation.server !== state.server) throw fail('INVALID_RESPONSE', 'Hosted service returned an inconsistent meeting invitation.');
  }
  const { saved, restored } = await store.meetings.create(pending.session, state.server, result, signal);
  await acknowledgeMeeting(store.meetings, await store.meetings.archive(saved.id, { ...result, events: result.events || [] }, { signal }), { signal });
  const initial = await api(state.server, `/v1/meetings/${saved.meetingId}/events?after=0&waitMs=0`, { token: saved.token, signal });
  const local = await acknowledgeMeeting(store.meetings, await store.meetings.archive(saved.id, initial, { signal }), { signal });
  const archived = archivedMeetingResult(initial, local);
  return { session: saved.id, meetingId: saved.meetingId, requestId: pending.requestId, restored, participant: saved.participant,
    meeting: archived.meeting, viewUrl: result.viewUrl, ...(result.invitationUrl ? { invitationUrl: result.invitationUrl, invitationText: meetingInvitationText(result.invitationUrl, result.viewUrl) } : {}),
    ...(result.invitationId ? { invitationId: result.invitationId } : {}), ...(result.notification ? { notification: result.notification } : {}), events: archived.events,
    next: 'Show invitationText as one complete copyable block when forwarding an invitation; show the session and viewUrl now. Continue with meeting send/receive using this same --agent profile. History is saved locally; the relay deletes acknowledged content. Only the host ends the meeting.' };
}

export async function hostedCommand(command: string, args: string[], options: CliOptions, { signal, textInput }: CommandContext = {}) {
  const argumentCount = ['friend-add', 'friend-remove', 'call', 'accept'].includes(command) ? 1 : 0;
  if (args.length !== argumentCount) throw fail('INVALID_ARGUMENT', `Expected ${argumentCount} argument(s) after hosted ${command}.`);
  const store = new HostedStore(options['state-dir']);
  const decoded = command === 'friend-add' ? decodeHostedContact(args[0]) : undefined;
  return store.locked(async (state, save) => {
    if (command === 'setup') {
      const server = hostedOrigin(options.server || process.env.NOKNOK_SERVER || state?.server || 'http://127.0.0.1:4317');
      const name = nameFrom(options);
      if (state && state.server !== server) throw fail('SERVER_MISMATCH', 'This profile is already bound to another service. Use a new hosted setup profile for another service.');
      if (!state) {
        if (!options['code-file']) throw fail('INVALID_ARGUMENT', 'Provide --code-file with a file containing your beta code.');
        state = { v: 1, server, name, contacts: {}, offers: [], redeemRequestId: secret(), agentRequestId: secret(), createdAt: new Date().toISOString() };
        await save(state);
      }
      if (!state.accountToken) {
        if (!options['code-file']) throw fail('INVALID_ARGUMENT', 'Provide the original --code-file to resume beta redemption.');
        const code = (await readFile(options['code-file'], 'utf8')).trim();
        if (!code || code.length > 4096) throw fail('INVALID_ARGUMENT', 'The beta-code file is empty or too large.');
        const result = await api(server, '/v1/hosted/redeem', { method: 'POST', body: { code, requestId: state.redeemRequestId }, signal });
        if (!identifier(result.accountId) || !credential(result.accountToken)) throw fail('INVALID_RESPONSE', 'Hosted service returned an invalid account credential.');
        state.accountId = result.accountId; state.accountToken = result.accountToken;
        await save(state);
      }
      if (!state.agentToken) {
        const result = await api(server, '/v1/hosted/agents', { method: 'POST', token: state.accountToken, body: { requestId: state.agentRequestId }, signal });
        if (!identifier(result.agentId) || !credential(result.agentToken)) throw fail('INVALID_RESPONSE', 'Hosted service returned an invalid agent credential.');
        state.agentId = result.agentId; state.agentToken = result.agentToken;
        await save(state);
      }
      return { agentId: state.agentId, accountId: state.accountId, server: state.server, name: state.name,
        next: 'Keep this localAgent handle. Use hosted friend-link or hosted friend-add with --agent. Adding a friend does not start a wait loop or activate background wakeup. Use hosted config to obtain private MCP connection settings.' };
    }
    if (!state?.agentToken) throw fail('HOSTED_SETUP_REQUIRED', 'Run hosted setup first, or resume setup with this same --agent profile.');
    if (decoded && decoded.server !== state.server) throw fail('SERVER_MISMATCH', 'The contact link belongs to another service. No credentials were sent. Set up a separate profile for that service.');
    const profile = state; const token = state.agentToken;
    const tool = (name: string, parameters: Record<string, unknown> = {}) => hostedTool(profile.server, token, name, parameters, { signal });
    if (command === 'config') return { server: state.server, agentId: state.agentId, private: true, privateMcpUrl: `${state.server}/mcp/${state.agentToken}`,
      mcpConfig: { mcpServers: { noknok: { url: `${state.server}/mcp`, headers: { Authorization: `Bearer ${state.agentToken}` } } } },
      next: 'Treat this configuration as a secret. Configure it privately in the host. Native MCP Events subscription is a separate user-authorized action; adding a friend alone does not subscribe.' };
    if (command === 'identity') return { ...await tool('noknok_identity'), name: state.name, server: state.server };
    if (command === 'subscription-status') return tool('noknok_subscription_status');
    if (command === 'friend-link') {
      const result = await tool('noknok_friend_link');
      const link = decodeHostedContact(result.link);
      if (link.server !== state.server || link.offer !== result.offer) throw fail('INVALID_RESPONSE', 'Hosted service returned an inconsistent contact link.');
      state.offers.push({ offer: result.offer, createdAt: new Date().toISOString() });
      await save(state);
      return { link: result.link, agentId: state.agentId, next: 'Share this contact invitation only with the intended peer. After acceptance, run hosted friends to save the contact locally. No wait loop has started.' };
    }
    if (command === 'friend-add') {
      const result = await tool('noknok_friend_add', { link: args[0] });
      const contact = contactFrom(result);
      state.contacts[contact.peerId] = { ...state.contacts[contact.peerId], ...contact };
      await save(state);
      return { peerId: contact.peerId, added: true, next: 'Friend added. Contact capability is saved locally. Background wakeup requires the recipient’s separate native Events subscription; no wait loop has started.' };
    }
    if (command === 'friends') {
      for (const offer of state.offers.filter(item => !item.claimed && !item.expired)) {
        const result = await tool('noknok_friend_claim', { offer: offer.offer });
        if (result.expired) { offer.expired = true; await save(state); }
        if (result.accepted) {
          const contact = contactFrom(result);
          state.contacts[contact.peerId] = { ...state.contacts[contact.peerId], ...contact };
          offer.claimed = true;
          await save(state);
        }
      }
      return { contacts: publicContacts(state), source: 'local' };
    }
    if (command === 'friend-remove') {
      const contact = state.contacts[args[0]];
      if (!contact) throw fail('CONTACT_NOT_FOUND', 'No contact with that peer ID exists in this profile.');
      if (!contact.issuedCapability) throw fail('MISSING_REVOCATION_CREDENTIAL', 'This contact lacks the local grant credential needed to revoke its access.');
      await tool('noknok_friend_revoke', { capability: contact.issuedCapability });
      delete state.contacts[args[0]];
      await save(state);
      return { peerId: args[0], removed: true, next: 'The peer’s saved contact grant has been revoked. Already-delivered messages cannot be withdrawn.' };
    }
    if (command === 'inbox') return tool('noknok_inbox');
    if (['call', 'create', 'accept'].includes(command)) {
      if (command !== 'accept' && !options.purpose?.trim()) throw fail('INVALID_ARGUMENT', 'Provide --purpose with the meeting goal.');
      const contact = command === 'call' ? state.contacts[args[0]] : undefined;
      if (command === 'call' && !contact) throw fail('CONTACT_NOT_FOUND', 'Run hosted friends to synchronize contacts, then use a returned peer ID.');
      const context = command === 'accept' ? undefined : await textInput!(options, 'context', 'context-file', false, signal);
      const requestId = options['request-id'] || secret();
      const identity = JSON.stringify(['hosted', state.server, state.agentId, command, command === 'accept' ? args[0] : requestId]);
      const pending = await store.meetings.receipt(identity, options.name || state.name, command === 'accept' ? options['request-id'] : requestId, signal, { reuseName: options.name === undefined });
      try {
        const parameters = command === 'accept' ? { invitation_id: args[0], name: pending.name } : { purpose: options.purpose, ...(context === undefined ? {} : { context }), name: pending.name, request_id: pending.requestId,
          ...(contact ? { peer_id: contact.peerId, capability: contact.capability } : {}) };
        const result = await tool(command === 'call' ? 'noknok_call' : command === 'accept' ? 'noknok_meeting_join' : 'noknok_meeting_create', parameters);
        return await archiveMeeting(store, state, result, pending, signal);
      } catch (error) { throw Object.assign(error, { requestId: pending.requestId, session: pending.session }); }
      finally { await pending.release(); }
    }
    throw fail('INVALID_COMMAND', 'Unknown hosted command.');
  }, signal).catch(error => {
    // Setup request IDs are recovery capabilities, never routine error metadata.
    if (command === 'setup') delete error.requestId;
    throw error;
  });
}
