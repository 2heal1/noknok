import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { api, decodeInvitation, fail, normalizeServer, newRequestId } from './client.js';
import { Store } from './store.js';
import { startRelay } from './relay.js';
import { startViewer } from './viewer.js';
import { sessionViewUrl } from './invitation.js';
import { contactCommand, decodeContactLink } from './contacts.js';
import { resolveAgentProfile } from './profiles.js';
import { meetingCommand, decodeMeetingLink } from './meeting-client.js';
import { packageFile, executablePath } from './asset-paths.js';
import type { CliOptions, ApiOptions } from './runtime-types.js';
import type { KnownFailure } from './mcp-types.js';
import { hostedCommand, decodeHostedContact } from './hosted-client.js';

const PACKAGE = JSON.parse(await readFile(packageFile('package.json'), 'utf8'));
const DEFAULT_SERVER = 'http://127.0.0.1:4317';
const SKILL_PATH = fileURLToPath(packageFile('skills/noknok/SKILL.md'));

const HELP = `${PACKAGE.name} ${PACKAGE.version} — lightweight meetings for agents and people (Node.js >=22.13)

Hosted beta (contacts plus optional native MCP Events):
  noknok hosted setup --server URL --code-file FILE [--product PRODUCT]
  noknok hosted friend-link|friends|inbox|subscription-status --agent HANDLE
  noknok hosted friend-add LINK --agent HANDLE
  noknok hosted friend-remove PEER --agent HANDLE
  noknok hosted call PEER --purpose TEXT --agent HANDLE
  noknok hosted accept INVITATION_ID --agent HANDLE
  noknok hosted create --purpose TEXT --agent HANDLE
  noknok hosted config --agent HANDLE  (prints private MCP credentials)
Hosted setup stores credentials locally. Keep localAgent; never guess a profile.
Friend addition returns immediately. Native Events subscription is a separate action.
Hosted call/accept/create return am_ sessions compatible with meeting send/receive.

Invitation meetings (basic relay creation; hosted creation uses hosted create):
  noknok meeting create --purpose TEXT [--context TEXT|--context-file FILE] [--product PRODUCT] [--server URL]
  noknok meeting join LINK [--product PRODUCT] [--name NAME]
  noknok meeting send SESSION --text TEXT [--type request|message|result|progress|waiting_for_user] [--to PARTICIPANT] [--reply-to SEQ]
  noknok meeting receive SESSION [--timeout 45]
  noknok meeting status|history|view SESSION
  noknok meeting ready SESSION [--ready true|false]
  noknok meeting end SESSION [--text SUMMARY] [--reason TEXT]
  noknok meeting leave SESSION
  noknok meeting sessions

Meetings default to http://127.0.0.1:4317 or NOKNOK_SERVER. Creation returns a reusable
invitation for agents or browser guests, a private read-only view link, and your am_ session.
Save localAgent and use --agent HANDLE for later commands; profiles are created automatically.
Only the host may end a meeting. ready signals agreement but never closes the meeting itself.
Messages are public to all meeting participants; --to requests a response, not private delivery.
Local meeting history survives relay expiry/restart. Bodies are saved locally before receipt
acknowledgement; the relay deletes acknowledged bodies and expires undelivered bodies after 5 minutes.
Read history through your own agent; the server view is not a transcript archive.

Service commands:
  noknok server [--host 127.0.0.1] [--port 4317] [--public-url URL] [--retention-seconds 600] [--meeting-ttl-seconds 7200]
  noknok local-server [--port 4317] [--retention-seconds 600] [--meeting-ttl-seconds 7200]
  noknok gateway [--host 127.0.0.1] [--port 4317] [--public-url HTTPS_ORIGIN]

Two-party calls and local contacts:
  noknok identity [--agent HANDLE] [--product PRODUCT] [--name NAME] [--server URL]
  noknok friend-link [--agent HANDLE] [--product PRODUCT] [--name NAME] [--server URL]
  noknok friend-add LINK [--agent HANDLE] [--product PRODUCT] [--name NAME]
  noknok friends --agent HANDLE
  noknok friend-remove CONTACT --agent HANDLE
  noknok listen --agent HANDLE [--timeout 45]
  noknok call CONTACT --agent HANDLE --purpose TEXT [--context TEXT]
  noknok mcp [--agent HANDLE] [--product PRODUCT]
  noknok receiver start|status|stop --agent HANDLE [--port PORT] [--gateway HTTPS_ORIGIN]
  noknok ui [--port 4318] [--state-dir DIR]
  noknok invite --name NAME --purpose TEXT [--from OWNER] [--context-file FILE] [--server URL]
  noknok accept INVITATION --name NAME
  noknok wait SESSION [--timeout 300]
  noknok receive SESSION [--timeout 60]
  noknok send SESSION [--type message|request|result|progress|waiting_for_user] --text TEXT
  noknok finish SESSION --text SUMMARY
  noknok hangup SESSION [--reason TEXT]
  noknok status SESSION
  noknok view SESSION
  noknok history SESSION
  noknok sessions

Agent setup:
  noknok skill [--path]
  noknok skill        Print the bundled noknok skill and instructions
  noknok --skill      Alias for noknok skill
  noknok skill --path Print the installed SKILL.md path (references live beside it)

The skill and its references ship with @noknok/cli; no separate download is needed.
Installing the CLI does not register skills automatically in every agent host.

Options:
  --agent HANDLE        Reuse the localAgent handle returned on first use (managed storage)
  --product PRODUCT     Known agent product, e.g. dot or doubaowork; default name agent-PRODUCT
  --state-dir DIR        Local credentials/transcript directory (default: ~/.noknok)
  --file FILE            Read send/finish text from a UTF-8 file; '-' reads stdin
  --context TEXT         Inline context for invite (alternative to --context-file)
  --from OWNER           Owner's known display name; defaults to anonymous (not agent --name)
  --request-id ID        Idempotency key for invite/accept/send/finish/hangup retries
  --timeout SECONDS      Wait duration, not the lifetime of the call (0–3600)
  --retention-seconds N   Server keeps ended meeting metadata/legacy calls for N seconds (default: 600)
  --meeting-ttl-seconds N Absolute meeting lifetime in seconds (default: 7200; reads do not extend it)
  --help, --version      Show help/version

Hosted service operator commands (Node.js 22.13+):
  noknok hosted-server --data-dir DIR --public-url ORIGIN [--host 127.0.0.1] [--port 4317]
  noknok beta-code --data-dir DIR --public-url ORIGIN [--uses 1] [--output-file PRIVATE_FILE]
  noknok revoke-agent --data-dir DIR --public-url ORIGIN --agent-id ID

Environment:
  NOKNOK_DATA_DIR        Persistent hosted control state, never chat transcripts
  NOKNOK_PUBLIC_URL      Canonical hosted HTTPS origin (HTTP loopback for tests)
  NOKNOK_DELIVERY_TTL_SECONDS Hosted pending-body deadline (default: 300, maximum: 3600)
  NOKNOK_SERVER       Override the default relay (${DEFAULT_SERVER})
  NOKNOK_HOME         Local state directory
  NOKNOK_AGENT        Optional identity binding, equivalent to --agent HANDLE
  NOKNOK_PRODUCT      Agent product supplied by the host; --product overrides it
  NOKNOK_SERVER_KEY   Optional relay key; gates invitation creation

Call/server results are JSON; help and skill commands print text.
Errors are JSON on stderr with a nonzero exit code.

Two-party invite/accept details (not meeting invitations):
Invitations expire after 5 minutes. Each participant gets a DIFFERENT local SESSION.
Use invite, display its invitationText as one copyable block immediately, then wait.
invitationText is a short invitation; its invitationUrl serves plain-text setup, Skill and task details.
Its shared viewSession and viewUrl allow read-only viewing; keep sharing limited to intended viewers.
accept supports invitationUrl and the noknok:// invitation field.
CLI / stdio tools do not wake an idle model by themselves.
For dot event-triggered work, receiver start runs independently of this task.
Use receiver start --gateway HTTPS_ORIGIN, connect its private mcpUrl as a plugin and subscribe to noknok.activity once.
The local receiver connects outward to a fixed NokNok gateway; no Tunnel is needed.
Only subscribed:true and receiving:true mean background transport is enabled; real dot replies still need host verification.
Local contacts: friend-link and friend-add automatically create a separate identity on first use.
The agent supplies its known product; --name overrides the default. Without a product, the name is agent.
Storage is managed by the CLI. Keep localAgent and add --agent HANDLE on later commands.
Never choose another agent's profile by looking for the latest or only local identity.
local-server enables the memory-only contact switch on loopback; identity/contacts stay on each client disk.
Create friend-link, share it once, friend-add on the other agent, then friends to synchronize both disks.
friend-add only adds the contact; run listen separately when the user asks to wait for calls.
The recipient must be actively running listen; call prints session/viewUrl before you wait or chat.
identity also returns MCP configuration pinned to its managed profile. mcp does not provide MCP Events.
`;

const COMMAND_OPTIONS: Record<string, string[]> = {
  'hosted-server': ['host', 'port', 'public-url', 'data-dir'],
  'beta-code': ['public-url', 'data-dir', 'uses', 'expires-hours', 'output-file'],
  'revoke-agent': ['public-url', 'data-dir', 'agent-id'],
  server: ['host', 'port', 'public-url', 'retention-seconds', 'meeting-ttl-seconds'],
  'local-server': ['port', 'retention-seconds', 'meeting-ttl-seconds'],
  gateway: ['host', 'port', 'public-url', 'retention-seconds', 'meeting-ttl-seconds'],
  meeting: [], hosted: [],
  identity: ['name', 'product', 'server'],
  'friend-link': ['name', 'product', 'server', 'request-id'],
  'friend-add': ['name', 'product', 'request-id'], friends: [], 'friend-remove': [],
  listen: ['timeout'], call: ['purpose', 'context', 'context-file', 'request-id'],
  mcp: ['name', 'product', 'server'],
  receiver: ['port', 'public-url', 'gateway'], 'receiver-run': ['port', 'gateway'],
  ui: ['port'],
  invite: ['server', 'name', 'from', 'purpose', 'context', 'context-file', 'request-id'],
  accept: ['name', 'request-id'],
  wait: ['timeout'], receive: ['timeout'],
  send: ['text', 'file', 'type', 'reply-to', 'request-id'],
  finish: ['text', 'file', 'request-id'], hangup: ['reason', 'request-id'],
  status: [], view: [], history: [], sessions: [], skill: ['path'],
};

const HOSTED_OPTIONS: Record<string, string[]> = {
  setup: ['server', 'code-file', 'name', 'product'],
  identity: [], 'friend-link': [], 'friend-add': [], friends: [], 'friend-remove': [],
  call: ['purpose', 'context', 'context-file', 'name', 'request-id'],
  create: ['purpose', 'context', 'context-file', 'name', 'request-id'],
  accept: ['name', 'request-id'], inbox: [], 'subscription-status': [], config: [],
};

const MEETING_OPTIONS: Record<string, string[]> = {
  create: ['purpose', 'context', 'context-file', 'name', 'product', 'server', 'request-id'],
  join: ['name', 'product', 'request-id'],
  send: ['text', 'file', 'type', 'to', 'reply-to', 'request-id'],
  receive: ['timeout'], status: [], history: [], view: [], sessions: [],
  ready: ['ready', 'request-id'], leave: ['request-id'], end: ['text', 'file', 'reason', 'request-id'],
};

interface ParsedCommand { command?: string; args: string[]; options: CliOptions; flags: { help?: boolean; version?: boolean; skill?: boolean; path?: boolean } }
export interface RunOptions { signal?: AbortSignal; emit?: (value: unknown) => unknown; localAgent?: string }
function parse(argv: string[]): ParsedCommand {
  const options: CliOptions = {}, positional: string[] = [];
  const flags: ParsedCommand['flags'] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
    if (arg === '-v' || arg === '--version') { flags.version = true; continue; }
    if (arg === '--skill') { flags.skill = true; continue; }
    if (arg === '--path') { flags.path = true; continue; }
    if (arg.startsWith('--')) {
      const equal = arg.indexOf('=');
      const key = arg.slice(2, equal < 0 ? undefined : equal);
      const value = equal < 0 ? argv[++i] : arg.slice(equal + 1);
      if (value === undefined || (equal < 0 && value.startsWith('--'))) throw fail('INVALID_ARGUMENT', `Missing value for --${key}.`);
      if (Object.hasOwn(options, key)) throw fail('INVALID_ARGUMENT', `Duplicate --${key}.`);
      options[key] = value;
    } else positional.push(arg);
  }
  let [command, ...args] = positional;
  if (flags.skill) {
    if (command && command !== 'skill') throw fail('INVALID_ARGUMENT', '--skill cannot be combined with another command.');
    command = 'skill';
    delete flags.skill;
  }
  if (!flags.help && !flags.version && command && command !== 'help') {
    if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw fail('INVALID_COMMAND', `Unknown command '${command}'. Run noknok --help.`);
    if (command === 'meeting' && !Object.hasOwn(MEETING_OPTIONS, args[0])) throw fail('INVALID_COMMAND', 'Use noknok meeting create|join|send|receive|status|ready|end|leave|history|view|sessions.');
    if (command === 'hosted' && !Object.hasOwn(HOSTED_OPTIONS, args[0])) throw fail('INVALID_COMMAND', 'Use noknok hosted setup|identity|friend-link|friend-add|friends|friend-remove|call|create|accept|inbox|subscription-status|config.');
    const allowed = new Set([...(command === 'hosted' ? HOSTED_OPTIONS[args[0]] : command === 'meeting' ? MEETING_OPTIONS[args[0]] : COMMAND_OPTIONS[command]), 'state-dir', ...(['server', 'local-server', 'gateway', 'skill'].includes(command) ? [] : ['agent'])]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw fail('INVALID_ARGUMENT', `Unknown option --${key} for ${command}.`);
  }
  if (flags.path && command !== 'skill' && !flags.help && !flags.version) throw fail('INVALID_ARGUMENT', `Unknown option --path for ${command}.`);
  return { command, args, options, flags };
}

function number(value: string | undefined, fallback: number, label: string, max: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > max) throw fail('INVALID_ARGUMENT', `${label} must be between 0 and ${max}.`);
  return parsed;
}

async function inputFile(path: string, signal?: AbortSignal) {
  if (path !== '-') return readFile(path, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  const abort = () => process.stdin.destroy(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 131072) throw fail('INPUT_TOO_LARGE', 'Input exceeds 128 KiB. Send a focused excerpt.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', abort); }
}

async function textInput(options: CliOptions, inlineKey = 'text', fileKey = 'file', required = true, signal?: AbortSignal) {
  if (options[inlineKey] !== undefined && options[fileKey] !== undefined) throw fail('INVALID_ARGUMENT', `Use either --${inlineKey} or --${fileKey}.`);
  const text = options[fileKey] !== undefined ? await inputFile(options[fileKey]!, signal) : options[inlineKey];
  if (required && (!text || !text.trim())) throw fail('INVALID_ARGUMENT', `Provide --${inlineKey} or --${fileKey}.`);
  return text;
}

function expectArgs(args: string[], count: number) {
  if (args.length !== count) throw fail('INVALID_ARGUMENT', `Expected ${count} positional argument(s). Run noknok --help.`);
}

function invitationText(call: { from?: string; id: string }, invitationUrl: string, viewUrl: string): string {
  const opening = call.from === '匿名' || !call.from
    ? 'An anonymous agent invites your agent to a conversation.'
    : `${call.from}'s agent invites your agent to a conversation.`;
  return `${opening}\nOpen ${invitationUrl} for details and instructions.\nSession: ${call.id}\nView: ${viewUrl}`;
}

function validateSessionView(result, server, callId, urlKey) {
  if (result.viewSession !== callId || result[urlKey] !== sessionViewUrl(server, callId)) {
    throw fail('INVALID_RESPONSE', 'Relay returned an inconsistent read-only session or URL.');
  }
}

async function receive(store: Store, id: string, { timeout, untilConnected, signal }: { timeout: number; untilConnected: boolean; signal?: AbortSignal }) {
  await store.load(id);
  const unlock = await store.lock(id);
  try {
    const session = await store.load(id);
    const start = Date.now();
    const endpoint = `/v1/calls/${encodeURIComponent(session.callId)}`;
    const request = (path: string, options: ApiOptions = {}) => api(session.server, endpoint + path, { token: session.token, signal, ...options });
    if (untilConnected) {
      const result = await request('');
      if (result.call.state !== 'waiting') return { session: id, outcome: result.call.state === 'connected' ? 'connected' : 'closed', call: result.call, events: [] };
    }
    let last;
    do {
      const remaining = Math.max(0, timeout * 1000 - (Date.now() - start));
      const waitMs = Math.min(25000, Math.floor(remaining));
      last = await request(`/events?after=${session.cursor}&waitMs=${waitMs}`, { timeoutMs: waitMs + 10000 });
      for (const event of last.events) await store.record(id, { direction: 'received', event });
      session.cursor = last.nextCursor;
      await store.save(session);
      const terminal = !['waiting', 'connected'].includes(last.call.state);
      if (terminal || (untilConnected && last.call.state === 'connected') || (!untilConnected && last.events.length)) {
        return { session: id, outcome: terminal ? 'closed' : untilConnected ? 'connected' : 'events', ...last };
      }
    } while (Date.now() - start < timeout * 1000);
    return { session: id, outcome: 'timeout', ...last };
  } finally { await unlock(); }
}

const CONTACT_COMMANDS = new Set(['identity', 'friend-link', 'friend-add', 'friends', 'friend-remove', 'listen', 'call']);
const FIRST_USE_COMMANDS = new Set(['identity', 'friend-link', 'friend-add']);

export async function main(argv: string[], { signal, emit }: RunOptions = {}) {
  const parsed = parse(argv);
  const { command, args, options, flags } = parsed;
  if (flags.help || flags.version || !command || ['help', 'skill', 'server', 'local-server', 'gateway', 'hosted-server', 'beta-code', 'revoke-agent'].includes(command)) {
    return execute(parsed, { signal, emit });
  }
  // Invalid invitations must not allocate a profile or follow an arbitrary URL.
  if (FIRST_USE_COMMANDS.has(command)) {
    expectArgs(args, command === 'friend-add' ? 1 : 0);
    if (command === 'friend-add') decodeContactLink(args[0]);
  }
  if (command === 'meeting' && args[0] === 'join') {
    expectArgs(args, 2);
    decodeMeetingLink(args[1]);
  }
  if (command === 'hosted' && args[0] === 'friend-add') { expectArgs(args, 2); decodeHostedContact(args[1]); }
  const binding = await resolveAgentProfile({
    agent: options.agent ?? process.env.NOKNOK_AGENT,
    stateDir: options['state-dir'], create: (command === 'hosted' && args[0] === 'setup') || FIRST_USE_COMMANDS.has(command) || command === 'mcp' || (command === 'meeting' && ['create', 'join'].includes(args[0])),
  });
  if (!binding && command === 'hosted') throw fail('AGENT_REQUIRED', 'Run hosted setup first, then reuse its exact --agent handle. Do not choose another agent profile from disk.');
  if (!binding && (CONTACT_COMMANDS.has(command) || ['mcp', 'receiver', 'receiver-run'].includes(command))) {
    throw fail('AGENT_REQUIRED', 'Reuse the localAgent handle returned by friend-link, friend-add or identity with --agent HANDLE. For first use, run friend-link or friend-add LINK. Never select another agent’s profile from the disk.');
  }
  const localAgent = binding?.handle;
  const output = emit || (value => new Promise<void>((resolveOutput, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, error => error ? reject(error) : resolveOutput());
  }));
  const boundOutput = (value: unknown) => {
    if (!localAgent) return output(value);
    const result: Record<string, unknown> = { ...(value as Record<string, unknown>), localAgent };
    if (command === 'identity') {
      result.mcpConfig = { mcpServers: { noknok: {
        command: process.execPath,
        args: [executablePath, 'mcp', '--agent', localAgent],
        ...(process.env.NOKNOK_HOME ? { env: { NOKNOK_HOME: resolve(process.env.NOKNOK_HOME) } } : {}),
      } } };
    }
    return output(result);
  };
  try {
    return await execute({ ...parsed, options: { ...options, ...(binding ? { 'state-dir': binding.directory } : {}) } }, { signal, emit: boundOutput, localAgent });
  } catch (error) {
    if (localAgent) error.localAgent = localAgent;
    throw error;
  }
}

async function execute({ command, args, options, flags }: ParsedCommand, { signal, emit, localAgent }: RunOptions = {}) {
  const output = emit || (value => new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, error => error ? reject(error) : resolve());
  }));
  if (flags.version) return output({ name: PACKAGE.name, version: PACKAGE.version });
  if (flags.help || !command || command === 'help') return process.stdout.write(HELP);
  if (command === 'skill') {
    expectArgs(args, 0);
    if (options.path !== undefined) throw fail('INVALID_ARGUMENT', '--path is a flag and does not take a value.');
    return process.stdout.write(flags.path ? `${SKILL_PATH}\n` : await readFile(SKILL_PATH, 'utf8'));
  }
  if (['hosted-server', 'beta-code', 'revoke-agent'].includes(command)) {
    expectArgs(args, 0);
    const dataDir = options['data-dir'] || process.env.NOKNOK_DATA_DIR;
    const publicUrl = options['public-url'] || process.env.NOKNOK_PUBLIC_URL;
    if (!dataDir || !publicUrl) throw fail('INVALID_ARGUMENT', 'Provide --data-dir and --public-url, or NOKNOK_DATA_DIR/NOKNOK_PUBLIC_URL.');
    if (command === 'hosted-server') {
      const { startHostedDeployment } = await import('./deploy/hosted-server.js');
      const app = await startHostedDeployment({ dataDir, publicUrl, host: options.host || '127.0.0.1', port: options.port === undefined ? undefined : number(options.port, 4317, '--port', 65535) });
      try {
        await output({ event: 'hosted_listening', url: app.url, origin: app.origin, transcriptStorage: 'participant', deliveryStorage: 'pending_memory', controlStorage: 'sqlite' });
        if (!signal?.aborted) { if (signal) await once(signal, 'abort'); else await once(app.server, 'close'); }
      } finally { await app.close(); }
      return;
    }
    const { openHostedStore } = await import('./hosted-store.js');
    const control = openHostedStore({ dataDir, realm: publicUrl });
    try {
      if (command === 'revoke-agent') {
        if (!options['agent-id']) throw fail('INVALID_ARGUMENT', 'Provide --agent-id from the identity to revoke.');
        control.revokeAgent(options['agent-id']); return output({ revoked: true, agentId: options['agent-id'] });
      }
      const uses = number(options.uses, 1, '--uses', 10);
      const hours = number(options['expires-hours'], 168, '--expires-hours', 8760);
      const minted = control.mintCode({ uses, expiresInMs: hours * 3600000 });
      if (options['output-file']) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(options['output-file'], minted.code + '\n', { mode: 0o600, flag: 'wx' });
        return output({ outputFile: resolve(options['output-file']), uses: minted.uses, expiresAt: minted.expiresAt });
      }
      return output(minted);
    } finally { control.close(); }
  }
  const store = new Store(options['state-dir']);
  if (command === 'hosted') return output(await hostedCommand(args[0], args.slice(1), options, { signal, textInput }));
  if (command === 'meeting') return output(await meetingCommand(args[0], args.slice(1), options, { signal, textInput }));
  if (command === 'receiver') {
    expectArgs(args, 1);
    const { receiverCommand } = await import('./receiver-control.js');
    return output(await receiverCommand(args[0], { directory: store.directory, agent: localAgent!,
      port: options.port, publicUrl: options['public-url'], gateway: options.gateway, signal }));
  }
  if (command === 'receiver-run') {
    expectArgs(args, 0);
    const { startReceiver } = await import('./receiver.js');
    const port = number(options.port, 0, '--port', 65535);
    if (!Number.isInteger(port)) throw fail('INVALID_ARGUMENT', 'Receiver port must be an integer.');
    const app = await startReceiver({ directory: store.directory, agent: localAgent!, port, run: main, signal, gateway: options.gateway });
    await app.closed;
    return;
  }
  if (CONTACT_COMMANDS.has(command)) {
    return output(await contactCommand(command, args, options, { signal }));
  }
  if (command === 'mcp') {
    expectArgs(args, 0);
    const { startStdioMcp } = await import('./mcp-stdio.js');
    return startStdioMcp({ directory: store.directory, agent: localAgent!, name: options.name, product: options.product, server: options.server, signal, run: main });
  }
  if (command === 'ui') {
    expectArgs(args, 0);
    const port = number(options.port, 4318, '--port', 65535);
    if (!Number.isInteger(port)) throw fail('INVALID_ARGUMENT', '--port must be an integer.');
    const viewer = await startViewer({ port, directory: store.directory });
    try {
      await output({ event: 'viewer_listening', url: viewer.url, directory: store.directory, readOnly: true });
      if (!signal?.aborted) {
        if (signal) await once(signal, 'abort');
        else await once(viewer.server, 'close');
      }
    } finally { await viewer.close(); }
    return;
  }
  if (['server', 'local-server', 'gateway'].includes(command)) {
    expectArgs(args, 0);
    const port = number(options.port, 4317, '--port', 65535);
    if (!Number.isInteger(port)) throw fail('INVALID_ARGUMENT', '--port must be an integer.');
    const retentionSeconds = number(options['retention-seconds'], command === 'gateway' ? 60 : 600, '--retention-seconds', 604800);
    if (!Number.isInteger(retentionSeconds) || retentionSeconds < 1) throw fail('INVALID_ARGUMENT', '--retention-seconds must be an integer between 1 and 604800.');
    const meetingTtlSeconds = number(options['meeting-ttl-seconds'], 7200, '--meeting-ttl-seconds', 604800);
    if (!Number.isInteger(meetingTtlSeconds) || meetingTtlSeconds < 1) throw fail('INVALID_ARGUMENT', '--meeting-ttl-seconds must be an integer between 1 and 604800.');
    const serverKey = process.env.NOKNOK_SERVER_KEY || undefined;
    const gateway = command === 'gateway' ? (await import('./gateway.js')).createGateway({ serverKey }) : undefined;
    let relay;
    try { relay = await startRelay({ host: options.host || '127.0.0.1', port, publicUrl: options['public-url'], serverKey, retentionMs: retentionSeconds * 1000, meetingTtlMs: meetingTtlSeconds * 1000, contacts: command !== 'server', extension: gateway?.handle, extensionClose: gateway?.close }); }
    catch (e) { gateway?.close(); throw e; }
    await output({ event: 'listening', url: relay.url, inviteTtlSeconds: 300, meetingTtlSeconds, retentionSeconds, storage: 'memory', contacts: command !== 'server', gateway: !!gateway, creationKeyRequired: !!process.env.NOKNOK_SERVER_KEY });
    try {
      if (!signal?.aborted) {
        if (signal) await once(signal, 'abort');
        else await once(relay.server, 'close');
      }
    } finally { await relay.close(); }
    return;
  }
  if (command === 'invite') {
    expectArgs(args, 0);
    if (!options.purpose?.trim()) throw fail('INVALID_ARGUMENT', 'Provide --purpose with a concrete collaboration goal.');
    const server = normalizeServer(options.server || process.env.NOKNOK_SERVER || DEFAULT_SERVER);
    const context = await textInput(options, 'context', 'context-file', false, signal);
    const from = options.from?.trim() || undefined;
    if (options.from !== undefined && (Buffer.byteLength(from || '') > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(options.from))) {
      throw fail('INVALID_ARGUMENT', '--from must be a single display name of 1–256 UTF-8 bytes without control characters.');
    }
    const requestId = options['request-id'] || newRequestId();
    const result = await api(server, '/v1/calls', { method: 'POST', body: { name: options.name || 'Agent', ...(from === undefined ? {} : { from }), purpose: options.purpose, context, requestId }, key: process.env.NOKNOK_SERVER_KEY, signal });
    const invitation = decodeInvitation(result.invitation);
    if (result.call?.id !== invitation.callId) throw fail('INVALID_RESPONSE', 'Relay returned an inconsistent invitation session.');
    if (typeof result.invitationUrl !== 'string') throw fail('INVALID_RESPONSE', 'Relay omitted its invitation URL.');
    {
      const link = decodeInvitation(result.invitationUrl);
      if (link.server !== invitation.server || link.callId !== invitation.callId || link.token !== invitation.token
        || !/^https?:\/\//i.test(result.invitationUrl) || typeof result.call.from !== 'string'
        || !result.call.from.trim() || Buffer.byteLength(result.call.from) > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(result.call.from)) {
        throw fail('INVALID_RESPONSE', 'Relay returned inconsistent invitation details.');
      }
    }
    validateSessionView(result, invitation.server, invitation.callId, 'viewUrl');
    const session = await store.create(invitation.server, result.call, result.participant);
    await output({ session: session.id, callId: session.callId, invitation: result.invitation, invitationUrl: result.invitationUrl, viewSession: result.viewSession, viewUrl: result.viewUrl, invitationText: invitationText(result.call, result.invitationUrl, result.viewUrl), expiresAt: result.call.expiresAt, call: result.call, next: `Display invitationText verbatim as one copyable code block now. Then run: noknok wait ${session.id} --timeout 300` });
    return;
  }
  if (command === 'accept') {
    expectArgs(args, 1);
    const invitation = decodeInvitation(args[0]);
    // The relay, not the client's clock, decides whether an invitation has expired.
    // Persist a random redemption key BEFORE consuming the single-use invitation.
    // If the process dies after the relay accepted it, repeating accept recovers
    // this same participant rather than attempting a second redemption.
    const pending = await store.acceptance(args[0], options.name || 'Agent', options['request-id']);
    try {
      const result = await api(invitation.server, `/v1/calls/${encodeURIComponent(invitation.callId)}/join`, { method: 'POST', body: { token: invitation.token, name: pending.name, requestId: pending.requestId }, signal });
      let session, restored = false;
      try {
        session = await store.load(pending.session);
        restored = true;
        if (session.server !== invitation.server || session.callId !== result.call.id || session.role !== 'callee' || session.token !== result.participant.token) {
          throw fail('SESSION_CONFLICT', 'The saved acceptance does not match this participant. Use a separate --state-dir.');
        }
      }
      catch (error) {
        if (error.code !== 'SESSION_NOT_FOUND') throw error;
        session = await store.create(invitation.server, result.call, result.participant, pending.session);
      }
      await output({ session: session.id, callId: session.callId, restored, call: result.call,
        next: restored ? 'Recovered the existing local participant. Continue with its unchanged cursor; check history before repeating work.' : 'Read purpose/context, send an initial reply, then receive and continue collaborating.' });
    } finally { await pending.release(); }
    return;
  }
  if (command === 'sessions') { expectArgs(args, 0); return output({ sessions: await store.list() }); }
  expectArgs(args, 1);
  const id = args[0];
  if (command === 'history') return output({ session: id, history: await store.history(id) });
  if (command === 'wait' || command === 'receive') {
    const timeout = number(options.timeout, command === 'wait' ? 300 : 60, '--timeout', 3600);
    return output(await receive(store, id, { timeout, untilConnected: command === 'wait', signal }));
  }
  const session = await store.load(id);
  const base = `/v1/calls/${encodeURIComponent(session.callId)}`;
  const request = (path: string, extra: ApiOptions = {}) => api(session.server, base + path, { token: session.token, signal, ...extra });
  if (command === 'status') return output({ session: id, ...await request('') });
  if (command === 'view') {
    const result = await request('/view', { method: 'POST' });
    if (result.callId !== session.callId) throw fail('INVALID_RESPONSE', 'Relay returned an inconsistent view session.');
    validateSessionView(result, session.server, session.callId, 'viewUrl');
    const { viewUrl, ...fields } = result;
    return output({ ...fields, url: viewUrl, session: id });
  }
  const requestId = options['request-id'] || newRequestId();
  let path, body;
  if (command === 'send') {
    path = '/messages';
    body = { text: await textInput(options, 'text', 'file', true, signal), type: options.type || 'message', requestId };
    if (options['reply-to'] !== undefined) {
      body.replyTo = number(options['reply-to'], 0, '--reply-to', Number.MAX_SAFE_INTEGER);
      if (!Number.isInteger(body.replyTo) || body.replyTo < 1) throw fail('INVALID_ARGUMENT', '--reply-to must be a positive event sequence number.');
    }
  } else if (command === 'finish') {
    path = '/finish';
    body = { text: await textInput(options, 'text', 'file', true, signal), requestId };
  } else {
    path = '/hangup';
    body = { reason: options.reason || 'Cancelled by participant', requestId };
  }
  const result = await request(path, { method: 'POST', body });
  await store.record(id, { direction: 'sent', requestId, action: command, ...(result.event ? { event: result.event } : {}), callState: result.call.state, ...(command === 'hangup' ? { reason: body.reason } : {}) });
  await output({ session: id, requestId, ...result });
}
