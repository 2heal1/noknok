import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// An explicit synthetic test client, not a dot or a substitute for a dot run.
const args = process.argv.slice(2);
const options: { state?: string; server?: string; sendPing?: boolean } = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--send-ping') options.sendPing = true;
  else if (['--state', '--server'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error('Usage: node scripts/probe-mcp-events.ts --state PATH --server ORIGIN [--send-ping]');
}
if (!options.state || !options.server) throw new Error('--state and --server are required.');
const origin = new URL(options.server);
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('--server must be an HTTP(S) origin.');
const state = JSON.parse(await readFile(options.state, 'utf8'));
const report: { test_client: string; origin: string; dot_execution_verified: boolean; checks: Array<{ identity: string; discovery?: string; tools?: string; event_catalog?: string; inbox_count?: number }>; sent?: { sender: string; recipient: string; message_id?: string; request_id: string } } = { test_client: 'synthetic-cli', origin: origin.origin, dot_execution_verified: false, checks: [] as Array<{ identity: string; discovery?: string; tools?: string; event_catalog?: string; inbox_count?: number }> };
async function rpc(identity: string, method: string, params: Record<string, unknown> = {}) {
  const token = state.agents?.[identity]?.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid local PoC identity.');
  let response;
  try {
    response = await fetch(`${origin.origin}/mcp/${token}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  } catch { throw new Error(`Request failed for identity ${identity}, method ${method}; endpoint omitted.`); }
  if (!response.ok) throw new Error(`HTTP ${response.status} for identity ${identity}, method ${method}.`);
  const result = await response.json();
  if (result.error) throw new Error(`RPC ${result.error.code} for identity ${identity}, method ${method}.`);
  return result.result;
}
for (const identity of ['A', 'B']) {
  const discovery = await rpc(identity, 'server/discover');
  if (!discovery.supportedVersions?.includes('2026-07-28') || !discovery.capabilities?.events) throw new Error('Event discovery failed.');
  const tools = await rpc(identity, 'tools/list');
  if (!['whoami', 'read_inbox', 'send_message'].every(name => tools.tools?.some(tool => tool.name === name))) throw new Error('Missing PoC tools.');
  const who = await rpc(identity, 'tools/call', { name: 'whoami', arguments: {} });
  if (who.structuredContent?.agent_id !== identity) throw new Error('Identity isolation failed.');
  const events = await rpc(identity, 'events/list');
  if (!events.events?.some(event => event.name === 'noknok.message.created')) throw new Error('Missing PoC event.');
  report.checks.push({ identity, discovery: 'passed', tools: 'passed', event_catalog: 'passed' });
}
if (options.sendPing) {
  const requestId = `probe_${randomUUID().replaceAll('-', '')}`;
  const result = await rpc('A', 'tools/call', { name: 'send_message', arguments: { recipient_id: 'B', text: 'noknok-poc: ping', request_id: requestId } });
  report.sent = { sender: 'A', recipient: 'B', message_id: result.structuredContent?.message?.id, request_id: requestId };
}
for (const identity of ['A', 'B']) {
  const result = await rpc(identity, 'tools/call', { name: 'read_inbox', arguments: {} });
  report.checks.push({ identity, inbox_count: result.structuredContent?.messages?.length });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
