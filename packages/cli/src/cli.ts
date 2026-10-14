import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { api, fail } from './client.js';
import { startRelay } from './relay.js';
import { resolveAgentProfile } from './profiles.js';
import { meetingCommand, decodeMeetingLink } from './meeting-client.js';
import { packageFile } from './asset-paths.js';
import type { CliOptions } from './runtime-types.js';
import { hostedCommand, decodeHostedContact, selectedMeetingService } from './hosted-client.js';
import { DEFAULT_HOSTED_SERVER } from './service-config.js';

const PACKAGE = JSON.parse(await readFile(packageFile('package.json'), 'utf8'));
const SKILL_PATH = fileURLToPath(packageFile('skills/noknok/SKILL.md'));

const HELP = `${PACKAGE.name} ${PACKAGE.version} — lightweight meetings for agents and people (Node.js >=22.13)

Hosted service (automatic first-use identity plus optional native MCP Events):
  noknok hosted setup [--server URL] [--product PRODUCT]
  noknok hosted friend-link [--agent HANDLE] [--server URL] [--product PRODUCT]
  noknok hosted friend-add LINK [--agent HANDLE] [--product PRODUCT]
  noknok hosted friends|inbox|subscription-status --agent HANDLE
  noknok hosted friend-remove PEER --agent HANDLE
  noknok hosted call PEER --purpose TEXT --agent HANDLE
  noknok hosted accept INVITATION_ID --agent HANDLE
  noknok hosted create --purpose TEXT --agent HANDLE
  noknok hosted config --agent HANDLE  (prints private MCP credentials)
Hosted setup stores credentials locally. Keep localAgent; never guess a profile.
Friend addition returns immediately. Native Events subscription is a separate action.
Hosted call/accept/create return am_ sessions compatible with meeting send/receive.

Invitation meetings (automatic hosted setup; private relays also supported):
  noknok meeting create --purpose TEXT [--context TEXT|--context-file FILE] [--product PRODUCT] [--server URL]
  noknok meeting join LINK [--product PRODUCT] [--name NAME]
  noknok meeting send SESSION --text TEXT [--type request|message|result|progress|waiting_for_user] [--to PARTICIPANT] [--reply-to SEQ]
  noknok meeting receive SESSION [--timeout 45]
  noknok meeting status|history|view SESSION
  noknok meeting ready SESSION [--ready true|false]
  noknok meeting end SESSION [--text SUMMARY] [--reason TEXT]
  noknok meeting leave SESSION
  noknok meeting sessions

Meetings default to https://api.noknok.cloud or NOKNOK_SERVER. Creation returns a reusable
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

Local MCP:
  noknok mcp [--agent HANDLE] [--product PRODUCT]

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
  --file FILE            Read meeting send/end text from a UTF-8 file; '-' reads stdin
  --context TEXT         Meeting background (alternative to --context-file)
  --request-id ID        Reuse for safe retries of the same meeting or hosted operation
  --timeout SECONDS      Receive wait duration, not the meeting lifetime (0–3600)
  --retention-seconds N   Server keeps ended meeting metadata for N seconds (default: 600)
  --meeting-ttl-seconds N Absolute meeting lifetime in seconds (default: 7200; reads do not extend it)
  --help, --version      Show help/version

Hosted service operator commands (Node.js 22.13+):
  noknok hosted-server --data-dir DIR --public-url ORIGIN [--host 127.0.0.1] [--port 4317]
  noknok revoke-agent --data-dir DIR --public-url ORIGIN --agent-id ID

Environment:
  NOKNOK_DATA_DIR        Persistent hosted control state, never chat transcripts
  NOKNOK_PUBLIC_URL      Canonical hosted HTTPS origin (HTTP loopback for tests)
  NOKNOK_DELIVERY_TTL_SECONDS Hosted pending-body deadline (default: 300, maximum: 3600)
  NOKNOK_SERVER       Override the default meeting/hosted service (${DEFAULT_HOSTED_SERVER})
  NOKNOK_HOME         Local state directory
  NOKNOK_AGENT        Optional identity binding, equivalent to --agent HANDLE
  NOKNOK_PRODUCT      Agent product supplied by the host; --product overrides it
  NOKNOK_SERVER_KEY   Optional relay authorization key; gates meeting creation

Meeting/server results are JSON; help and skill commands print text.
Errors are JSON on stderr with a nonzero exit code.

Encrypted meetings:
Use meeting create and display its complete invitation and read-only view link immediately.
Each participant uses its own am_ session. Links contain the content key in their fragment;
share complete links only with intended readers. Browser participation requires HTTPS or localhost.
Use meeting ready to signal completion and meeting end as the host to close the meeting.
CLI / stdio tools do not wake an idle model by themselves.
Hosted config provides local stdio MCP for endpoint encryption plus separate remote Events credentials.
Remote MCP accepts ciphertext only. Authorize native noknok.activity subscriptions separately;
delivery is not proof that a host ran its agent. Plaintext remote-tool fallback is unavailable.
`;

const COMMAND_OPTIONS: Record<string, string[]> = {
  'hosted-server': ['host', 'port', 'public-url', 'data-dir'],
  'revoke-agent': ['public-url', 'data-dir', 'agent-id'],
  server: ['host', 'port', 'public-url', 'retention-seconds', 'meeting-ttl-seconds'],
  'local-server': ['port', 'retention-seconds', 'meeting-ttl-seconds'],
  meeting: [], hosted: [],
  mcp: ['name', 'product', 'server'], skill: ['path'],
};

const HOSTED_OPTIONS: Record<string, string[]> = {
  setup: ['server', 'name', 'product'],
  identity: [], 'friend-link': ['server', 'product', 'name'], 'friend-add': ['server', 'product', 'name'], friends: [], 'friend-remove': [],
  call: ['purpose', 'context', 'context-file', 'name', 'request-id'],
  create: ['purpose', 'context', 'context-file', 'name', 'product', 'server', 'request-id'],
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
    const allowed = new Set([...(command === 'hosted' ? HOSTED_OPTIONS[args[0]] : command === 'meeting' ? MEETING_OPTIONS[args[0]] : COMMAND_OPTIONS[command]), 'state-dir', ...(['server', 'local-server', 'skill'].includes(command) ? [] : ['agent'])]);
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

export async function main(argv: string[], { signal, emit }: RunOptions = {}) {
  const parsed = parse(argv);
  const { command, args, options, flags } = parsed;
  if (flags.help || flags.version || !command || ['help', 'skill', 'server', 'local-server', 'hosted-server', 'revoke-agent'].includes(command)) {
    return execute(parsed, { signal, emit });
  }
  if (command === 'meeting' && args[0] === 'join') {
    expectArgs(args, 2);
    decodeMeetingLink(args[1]);
  }
  if (command === 'hosted' && args[0] === 'friend-add') { expectArgs(args, 2); decodeHostedContact(args[1]); }
  if ((command === 'meeting' || command === 'hosted') && args[0] === 'create' && !options.purpose?.trim()) throw fail('INVALID_ARGUMENT', 'Provide --purpose with the meeting goal.');
  const binding = await resolveAgentProfile({
    agent: options.agent ?? process.env.NOKNOK_AGENT,
    stateDir: options['state-dir'], create: (command === 'hosted' && ['setup', 'create', 'friend-link', 'friend-add'].includes(args[0])) || command === 'mcp' || (command === 'meeting' && ['create', 'join'].includes(args[0])),
  });
  if (!binding && command === 'hosted') throw fail('AGENT_REQUIRED', 'Run hosted setup first, then reuse its exact --agent handle. Do not choose another agent profile from disk.');
  if (!binding && command === 'mcp') throw fail('AGENT_REQUIRED', 'Reuse the localAgent returned by meeting create/join or hosted setup.');
  const localAgent = binding?.handle;
  const output = emit || (value => new Promise<void>((resolveOutput, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, error => error ? reject(error) : resolveOutput());
  }));
  const boundOutput = (value: unknown) => {
    if (!localAgent) return output(value);
    const result: Record<string, unknown> = { ...(value as Record<string, unknown>), localAgent };
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
  if (['hosted-server', 'revoke-agent'].includes(command)) {
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
    } finally { control.close(); }
  }
  const directory = options['state-dir'] || process.env.NOKNOK_HOME || join(homedir(), '.noknok');
  if (command === 'hosted') return output(await hostedCommand(args[0], args.slice(1), options, { signal, textInput }));
  if (command === 'meeting' && args[0] === 'create') {
    const server = await selectedMeetingService(options, signal);
    if (new URL(server).pathname !== '/') throw fail('INVALID_SERVER', 'Meeting service must use an HTTP(S) origin without a path prefix.');
    const discovery = await api(server, '/health', { method: 'GET', signal });
    if (discovery.mode === 'hosted') return output(await hostedCommand('create', [], { ...options, server }, { signal, textInput }));
    if (server === DEFAULT_HOSTED_SERVER) throw fail('INVALID_RESPONSE', 'Official service did not report hosted mode.');
    return output(await meetingCommand('create', [], { ...options, server }, { signal, textInput }));
  }
  if (command === 'meeting') return output(await meetingCommand(args[0], args.slice(1), options, { signal, textInput }));
  if (command === 'mcp') {
    expectArgs(args, 0);
    const { startStdioMcp } = await import('./mcp-stdio.js');
    return startStdioMcp({ directory, agent: localAgent!, name: options.name, product: options.product, server: options.server, signal, run: main });
  }
  if (['server', 'local-server'].includes(command)) {
    expectArgs(args, 0);
    const port = number(options.port, 4317, '--port', 65535);
    if (!Number.isInteger(port)) throw fail('INVALID_ARGUMENT', '--port must be an integer.');
    const retentionSeconds = number(options['retention-seconds'], 600, '--retention-seconds', 604800);
    if (!Number.isInteger(retentionSeconds) || retentionSeconds < 1) throw fail('INVALID_ARGUMENT', '--retention-seconds must be an integer between 1 and 604800.');
    const meetingTtlSeconds = number(options['meeting-ttl-seconds'], 7200, '--meeting-ttl-seconds', 604800);
    if (!Number.isInteger(meetingTtlSeconds) || meetingTtlSeconds < 1) throw fail('INVALID_ARGUMENT', '--meeting-ttl-seconds must be an integer between 1 and 604800.');
    const serverKey = process.env.NOKNOK_SERVER_KEY || undefined;
    const relay = await startRelay({ host: options.host || '127.0.0.1', port, publicUrl: options['public-url'], serverKey, retentionMs: retentionSeconds * 1000, meetingTtlMs: meetingTtlSeconds * 1000 });
    await output({ event: 'listening', url: relay.url, meetingTtlSeconds, retentionSeconds, storage: 'memory', creationKeyRequired: !!serverKey });
    try {
      if (!signal?.aborted) {
        if (signal) await once(signal, 'abort');
        else await once(relay.server, 'close');
      }
    } finally { await relay.close(); }
    return;
  }
  throw fail('INVALID_COMMAND', `Unknown command '${command}'. Run noknok --help.`);
}
