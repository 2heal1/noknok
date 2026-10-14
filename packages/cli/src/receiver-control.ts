import type { ReceiverCommandOptions, ReceiverStatus } from './runtime-types.js';
import { executablePath } from './asset-paths.js';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { fail } from './client.js';
import { gatewayOrigin } from './gateway-contract.js';

async function inspect(directory, agent): Promise<ReceiverStatus> {
  let state, runtime;
  try {
    state = JSON.parse(await readFile(join(directory, 'receiver-state.json'), 'utf8'));
    runtime = JSON.parse(await readFile(join(directory, 'receiver-runtime.json'), 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return { backgroundRunning: false, subscribed: false, receiving: false }; throw e; }
  if (!/^[A-Za-z0-9_-]{43}$/.test(state.token) || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) throw fail('INVALID_RECEIVER_STATE', 'Invalid receiver runtime.');
  const origin = 'http://127.0.0.1:' + runtime.port;
  try {
    const response = await fetch(origin + '/control/' + state.token + '/status', { redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error();
    const status = await response.json() as ReceiverStatus;
    if (status.agent !== agent) throw fail('RECEIVER_CONFLICT', 'Receiver belongs to another profile.');
    return { ...status, localMcpUrl: origin + '/mcp/' + state.token, origin, token: state.token };
  } catch (e) {
    if (e.code === 'RECEIVER_CONFLICT') throw e;
    return { backgroundRunning: false, subscribed: false, receiving: false };
  }
}
function display(status, publicUrl) {
  const { origin, token, ...result } = status;
  if (status.gateway?.mcpUrl) result.mcpUrl = status.gateway.mcpUrl;
  if (publicUrl && status.localMcpUrl) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('INVALID_ARGUMENT', '--public-url must be an HTTPS origin for your own proxy.');
    result.mcpUrl = url.origin + '/mcp/' + token;
  }
  return { ...result, setupRequired: !status.subscribed,
    next: status.subscribed
      ? 'Background reception is configured. Keep this computer, receiver and HTTPS gateway online; no model-side wait loop is needed.'
      : result.mcpUrl ? 'Connect mcpUrl as dot’s custom MCP plugin and authorize its native noknok.activity subscription. No Tunnel is needed. Starting this receiver alone does not wake dot.'
        : 'For dot, start reception with --gateway HTTPS_ORIGIN and connect its mcpUrl as a custom MCP Events plugin. Do not install a Tunnel. The local endpoint alone cannot wake cloud dot.' };
}
export async function receiverCommand(action, { directory, agent, port, publicUrl, gateway, signal }: ReceiverCommandOptions) {
  if (!agent) throw fail('AGENT_REQUIRED', 'Receiver requires this agent’s managed localAgent binding.');
  if (!['start', 'status', 'stop'].includes(action)) throw fail('INVALID_ARGUMENT', 'Use receiver start, status, or stop.');
  if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535)) throw fail('INVALID_ARGUMENT', 'Invalid receiver port.');
  if (gateway !== undefined) gateway = gatewayOrigin(gateway);
  if (gateway && publicUrl) throw fail('INVALID_ARGUMENT', 'Use --gateway or --public-url, not both.');
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('INVALID_ARGUMENT', '--public-url must be an HTTPS origin.');
  }
  const store = new Store(directory);
  await store.init();
  const unlock = await store.lockPath(join(directory, 'receiver-start.lock'));
  try {
    const existing = await inspect(directory, agent);
    if (action === 'status') return display(existing, publicUrl);
    if (action === 'stop') {
      if (existing.backgroundRunning) await fetch(existing.origin + '/control/' + existing.token + '/stop', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) });
      for (let i = 0; i < 150 && (await inspect(directory, agent)).localMcpUrl; i++) await delay(100, undefined, { signal });
      if ((await inspect(directory, agent)).localMcpUrl) throw fail('RECEIVER_BUSY', 'Receiver is still stopping; retry status.');
      return { backgroundRunning: false, stopped: true };
    }
    if (existing.backgroundRunning) {
      if (gateway && existing.gateway?.mcpUrl?.split('/mcp/')[0] !== gateway) throw fail('RECEIVER_CONFLICT', 'Stop this receiver before changing its gateway.');
      return display(existing, publicUrl);
    }
    await readFile(join(directory, 'contacts.json'), 'utf8').catch(() => { throw fail('IDENTITY_NOT_FOUND', 'Generate a friend link or add a friend before starting reception.'); });
    const log = await open(join(directory, 'receiver.log'), 'a', 0o600);
    let child;
    try {
      let chosenPort = port;
      if (chosenPort === undefined) {
        try { chosenPort = JSON.parse(await readFile(join(directory, 'receiver-runtime.json'), 'utf8')).port; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      child = spawn(process.execPath, [executablePath,
        'receiver-run', '--agent', agent, '--port', String(chosenPort ?? 0), ...(gateway ? ['--gateway', gateway] : [])],
        { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env, cwd: directory });
      child.unref();
    } finally { await log.close(); }
    let launchError;
    child.on('error', e => { launchError = e; });
    for (let i = 0; i < 100; i++) {
      signal?.throwIfAborted();
      if (launchError || child.exitCode !== null) throw fail('RECEIVER_START_FAILED', 'Background receiver failed to start; inspect this profile’s receiver.log.');
      const current = await inspect(directory, agent);
      if (current.backgroundRunning) return display(current, publicUrl);
      await delay(100, undefined, { signal });
    }
    throw fail('RECEIVER_START_FAILED', 'Receiver has not become ready; inspect this profile’s receiver.log.');
  } finally { await unlock(); }
}
