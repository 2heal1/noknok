import http from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startRelay } from '../src/relay.mjs';
import { startMcpEventsPoc } from '../poc/mcp-events/server.mjs';
import { createGateway } from '../src/gateway.mjs';

function integer(env, name, fallback, maximum) {
  const value = env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return Number(value);
}

export function deploymentConfig(env = process.env) {
  if (!env.AGENTCALL_PUBLIC_URL) {
    throw new Error('Set AGENTCALL_PUBLIC_URL to the reachable service origin (an internal address is supported).');
  }
  if (env.AGENTCALL_MCP_POC_ENABLED !== undefined && !['0', '1'].includes(env.AGENTCALL_MCP_POC_ENABLED)) {
    throw new Error('AGENTCALL_MCP_POC_ENABLED must be 0 or 1.');
  }
  const mcpEnabled = env.AGENTCALL_MCP_POC_ENABLED === '1';
  if (env.AGENTCALL_GATEWAY_ENABLED !== undefined && !['0', '1'].includes(env.AGENTCALL_GATEWAY_ENABLED)) throw new Error('AGENTCALL_GATEWAY_ENABLED must be 0 or 1.');
  const gatewayEnabled = env.AGENTCALL_GATEWAY_ENABLED === '1';
  if (gatewayEnabled && mcpEnabled) throw new Error('Choose the native NokNok gateway or the legacy fixed-identity PoC.');
  if (mcpEnabled && (!env.AGENTCALL_MCP_AGENT_A_TOKEN || !env.AGENTCALL_MCP_AGENT_B_TOKEN)) {
    throw new Error('The MCP PoC requires both AGENTCALL_MCP_AGENT_A_TOKEN and AGENTCALL_MCP_AGENT_B_TOKEN.');
  }
  return {
    port: integer(env, 'PORT', 8080, 65535),
    publicUrl: env.AGENTCALL_PUBLIC_URL,
    retentionMs: integer(env, 'AGENTCALL_RETENTION_SECONDS', gatewayEnabled ? 60 : 600, 604_800) * 1000,
    meetingTtlMs: integer(env, 'AGENTCALL_MEETING_TTL_SECONDS', 7200, 604_800) * 1000,
    maxMeetings: integer(env, 'AGENTCALL_MAX_MEETINGS', 50, 1000),
    maxCalls: integer(env, 'AGENTCALL_MAX_CALLS', 50, 1000),
    serverKey: env.AGENTCALL_SERVER_KEY || undefined,
    gatewayEnabled,
    mcp: mcpEnabled ? {
      statePath: env.AGENTCALL_MCP_STATE_PATH ?? '/tmp/agentcall-mcp-poc/state.json',
      agentTokens: { A: env.AGENTCALL_MCP_AGENT_A_TOKEN, B: env.AGENTCALL_MCP_AGENT_B_TOKEN },
    } : undefined,
  };
}

function endToEndHeaders(headers) {
  const omit = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of String(headers.connection ?? '').split(',')) omit.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !omit.has(name)));
}

/** One exposed HTTP listener, with relay and experimental MCP isolated behind it. */
export async function startDeployment({ env = process.env, port, host = '::', logger = () => {}, mcpOptions = {} } = {}) {
  const config = deploymentConfig(env);
  let relay;
  let mcp;
  let server;
  let closing;
  let gateway;
  try {
    if (config.mcp) mcp = await startMcpEventsPoc({ ...mcpOptions, ...config.mcp, port: 0, host: '127.0.0.1', logger });
    if (config.gatewayEnabled) gateway = createGateway({ serverKey: config.serverKey });
    relay = await startRelay({
      host: '127.0.0.1', port: 0, publicUrl: config.publicUrl,
      retentionMs: config.retentionMs, maxCalls: config.maxCalls, serverKey: config.serverKey,
      meetingTtlMs: config.meetingTtlMs, maxMeetings: config.maxMeetings,
      contacts: config.gatewayEnabled, extension: gateway?.handle, extensionClose: gateway?.close,
    });
    const relayPort = relay.server.address().port;
    const mcpPort = mcp && Number(new URL(mcp.url).port);
    server = http.createServer((req, res) => {
      const isMcp = req.url === '/mcp' || req.url.startsWith('/mcp/');
      if (isMcp && !mcp && !gateway) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Not found.' }));
        req.resume();
        return;
      }
      // Never log the URL, request headers, or forwarding errors: they may contain credentials.
      const upstream = http.request({
        host: '127.0.0.1', port: isMcp && mcp ? mcpPort : relayPort,
        method: req.method, path: req.url, agent: false,
        headers: { ...endToEndHeaders(req.headers), host: `127.0.0.1:${isMcp && mcp ? mcpPort : relayPort}` },
      }, incoming => {
        const headers = endToEndHeaders(incoming.headers);
        if (closing) headers.connection = 'close';
        res.writeHead(incoming.statusCode, headers);
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      upstream.setTimeout(config.gatewayEnabled ? 45_000 : 30_000, () => upstream.destroy());
      upstream.on('error', () => {
        if (res.destroyed) return;
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Service unavailable.' }));
      });
      req.on('aborted', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      res.on('finish', () => { if (closing) server.closeIdleConnections(); });
      req.pipe(upstream);
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(port ?? config.port, host, () => { server.off('error', reject); ready(); });
    });
    const address = server.address();
    const accessibleHost = host === '::' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
    return {
      url: relay.url,
      origin: `http://${accessibleHost}:${address.port}`,
      port: address.port,
      async close() {
        if (!closing) closing = (async () => {
          const listenerClosed = new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
          server.closeIdleConnections();
          // Stop relay long polls before waiting for the public listener to drain.
          await Promise.all([relay.close(), mcp?.close(), listenerClosed]);
        })();
        return closing;
      },
    };
  } catch (error) {
    gateway?.close();
    server?.close();
    await Promise.allSettled([relay?.close(), mcp?.close()]);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startDeployment({ logger: entry => process.stdout.write(`${JSON.stringify(entry)}\n`) });
  process.stdout.write(`${JSON.stringify({ event: 'relay_listening', url: app.url, port: app.port, storage: 'memory', gateway_enabled: process.env.AGENTCALL_GATEWAY_ENABLED === '1', mcp_poc_enabled: process.env.AGENTCALL_MCP_POC_ENABLED === '1', mcp_storage: process.env.AGENTCALL_MCP_POC_ENABLED === '1' ? 'ephemeral-local-file' : null })}\n`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000).unref();
    await app.close();
    clearTimeout(deadline);
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
