import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayOrigin, gatewayRequest, object } from './gateway-contract.mjs';
import { gatewayMcpToken } from './gateway.mjs';

export async function gatewayConfig(directory, origin, write) {
  const path = join(directory, 'gateway.json');
  let saved;
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved) {
    if (saved.v !== 1 || gatewayOrigin(saved.origin) !== saved.origin) throw new Error('Invalid local gateway configuration.');
    gatewayMcpToken(saved.token);
    if (origin !== undefined && gatewayOrigin(origin) !== saved.origin) throw new Error('Receiver gateway differs from its saved configuration.');
    return saved;
  }
  if (origin === undefined) return undefined;
  saved = { v: 1, origin: gatewayOrigin(origin), token: randomBytes(32).toString('base64url') };
  await write(path, saved);
  return saved;
}

/** Outbound-only business consumer. The server cannot choose a local target or executable. */
export function startGatewayClient({ config, dispatch, signal, onState = () => {}, concurrency = 8,
  retryMs = 1000, fetcher = fetch } = {}) {
  if (!config || typeof dispatch !== 'function' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError('Invalid gateway consumer.');
  const origin = gatewayOrigin(config.origin);
  const mcpUrl = origin + '/mcp/' + gatewayMcpToken(config.token);
  const lifetime = new AbortController(), running = new Set();
  let connected = false, state = { configured: true, connected: false, mcpUrl, lastError: null }, closed = false;
  const publish = (value, error = null) => { connected = value; state = { ...state, connected, lastError: error, ...(value ? { lastConnectedAt: new Date().toISOString() } : {}) }; onState(state); };
  async function rpc(body, customSignal = lifetime.signal) {
    const response = await fetcher(origin + '/v1/gateway', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token,
        ...(process.env.AGENTCALL_SERVER_KEY ? { 'X-Agentcall-Key': process.env.AGENTCALL_SERVER_KEY } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([customSignal, AbortSignal.timeout(35000)]) });
    const parts = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1048576) { await reader.cancel(); throw new Error('gateway_response_limit'); }
          parts.push(Buffer.from(chunk.value));
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(parts).toString('utf8');
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('gateway_invalid_response'); }
    if (!response.ok) { const error = new Error(result.error?.code || 'gateway_unavailable'); error.status = response.status; throw error; }
    return result;
  }
  async function processJob(job) {
    let response;
    try {
      if (!object(job) || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Invalid gateway job.');
      const params = gatewayRequest(job.method, job.params);
      response = { result: await dispatch(job.method, params) };
      if (Buffer.byteLength(JSON.stringify(response)) > 900000) response = { error: { code: -32000, message: 'NokNok result exceeds the gateway limit.' } };
    } catch (e) { response = { error: { code: Number.isInteger(e.code) ? e.code : -32602, message: Number.isInteger(e.code) ? e.message : 'Rejected NokNok operation.' } }; }
    // No automatic operation retry: dispatch may already have caused a side effect.
    try { await rpc({ op: 'respond', id: job.id, response }); }
    catch (e) { if (!lifetime.signal.aborted && e.status !== 410) publish(false, 'gateway_response_failed'); }
  }
  const abort = () => lifetime.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) lifetime.abort();
  const task = (async () => {
    while (!lifetime.signal.aborted) {
      try {
        if (!connected) { await rpc({ op: 'register' }); publish(true); }
        if (running.size >= concurrency) { await Promise.race(running); continue; }
        const result = await rpc({ op: 'poll', capacity: concurrency - running.size, waitMs: 25000 });
        if (!Array.isArray(result.jobs) || result.jobs.length > concurrency - running.size) throw new Error('gateway_invalid_jobs');
        publish(true);
        for (const job of result.jobs) {
          const operation = processJob(job).finally(() => running.delete(operation));
          running.add(operation);
        }
      } catch {
        publish(false, 'gateway_disconnected');
        if (!lifetime.signal.aborted) await delay(retryMs, undefined, { signal: lifetime.signal }).catch(() => {});
      }
    }
  })();
  return {
    mcpUrl, status: () => state,
    async close() {
      if (closed) return;
      closed = true; lifetime.abort(); signal?.removeEventListener('abort', abort);
      await task; await Promise.allSettled([...running]);
      await rpc({ op: 'unregister' }, AbortSignal.timeout(3000)).catch(() => {});
      publish(false);
    },
  };
}
