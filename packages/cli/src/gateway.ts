import type { GatewayJob } from './runtime-types.js';
import type { GatewayOptions } from './runtime-types.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { gatewayRequest, object, RECEIVER_TOOLS } from './gateway-contract.js';
import { RpcError } from './mcp-stdio.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const canonicalToken = value => typeof value === 'string' && TOKEN.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
export function gatewayMcpToken(ownerToken) {
  if (!canonicalToken(ownerToken)) throw new TypeError('Invalid gateway owner credential.');
  return createHmac('sha256', Buffer.from(ownerToken, 'base64url')).update('noknok.gateway.mcp.v1').digest('base64url');
}
class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/** A bounded, memory-only queue for the closed NokNok contract. No sockets, URLs or shell dispatch. */
export function createGateway({ leaseMs = 90_000, requestTimeoutMs = 30_000, maxAgents = 256,
  maxPending = 16, maxBytes = 8 * 1024 * 1024, now = Date.now, serverKey }: GatewayOptions = {}) {
  const agents = new Map(), endpoints = new Map();
  let stopped = false, bytes = 0;
  const positive = n => Number.isSafeInteger(n) && n > 0;
  if (![leaseMs, requestTimeoutMs, maxAgents, maxPending, maxBytes].every(positive)) throw new TypeError('Gateway limits must be positive integers.');
  const send = (res, status, value: unknown = undefined) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  };
  async function body(req, limit = 262144) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new GatewayError(415, 'json_required');
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > limit) throw new GatewayError(413, 'body_too_large');
      parts.push(part);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new GatewayError(400, 'invalid_json'); }
    if (!object(value)) throw new GatewayError(400, 'invalid_object');
    return value;
  }
  function expire() {
    for (const [key, agent] of agents) {
      if (agent.expiresAt > now()) continue;
      agent.poll?.finish([]);
      for (const job of [...agent.jobs.values()]) job.finish({ error: { code: -32001, message: 'Receiver disconnected; verify the operation before retrying.', data: { requestId: job.id, mayHaveExecuted: job.delivered } } });
      agents.delete(key); endpoints.delete(agent.endpoint);
    }
  }
  function take(agent, capacity) {
    const selected: GatewayJob[] = []; let batchBytes = 0;
    for (const job of agent.jobs.values()) {
      if (job.delivered) continue;
      const size = Buffer.byteLength(JSON.stringify({ id: job.id, method: job.method, params: job.params }));
      if (selected.length >= capacity || batchBytes + size > 524288) break;
      selected.push(job); batchBytes += size;
    }
    for (const job of selected) job.delivered = true;
    return selected.map(j => ({ id: j.id, method: j.method, params: j.params }));
  }
  function wake(agent) {
    if (agent.poll && [...agent.jobs.values()].some(j => !j.delivered)) agent.poll.finish(take(agent, agent.poll.capacity));
  }
  async function control(req, res) {
    if (req.method !== 'POST') throw new GatewayError(405, 'post_required');
    const credential = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!canonicalToken(credential)) throw new GatewayError(401, 'unauthorized');
    const input = await body(req, 1024 * 1024);
    expire();
    const key = digest(credential);
    let agent = agents.get(key);
    if (input.op === 'register') {
      if (Object.keys(input).some(k => k !== 'op')) throw new GatewayError(400, 'invalid_register');
      if (serverKey !== undefined && digest(String(req.headers['x-noknok-key'] ?? '')) !== digest(serverKey)) throw new GatewayError(401, 'registration_key_required');
      if (!agent) {
        if (agents.size >= maxAgents) throw new GatewayError(503, 'gateway_capacity');
        agent = { endpoint: digest(gatewayMcpToken(credential)), jobs: new Map(), expiresAt: 0, poll: null };
        agents.set(key, agent); endpoints.set(agent.endpoint, agent);
      }
      agent.expiresAt = now() + leaseMs;
      return send(res, 200, { registered: true, leaseMs });
    }
    if (!agent) throw new GatewayError(409, 'registration_required');
    agent.expiresAt = now() + leaseMs;
    if (input.op === 'unregister') {
      if (Object.keys(input).some(k => k !== 'op')) throw new GatewayError(400, 'invalid_unregister');
      agent.expiresAt = 0; expire();
      return send(res, 200, { stopped: true });
    }
    if (input.op === 'respond') {
      if (Object.keys(input).some(k => !['op', 'id', 'response'].includes(k)) || !object(input.response)
        || (Object.hasOwn(input.response, 'result') === Object.hasOwn(input.response, 'error'))
        || Object.keys(input.response).some(k => !['result', 'error'].includes(k))) throw new GatewayError(400, 'invalid_response');
      const job = agent.jobs.get(input.id);
      if (!job || !job.delivered) throw new GatewayError(410, 'request_expired');
      job.finish(input.response);
      return send(res, 200, { accepted: true });
    }
    if (input.op !== 'poll' || Object.keys(input).some(k => !['op', 'capacity', 'waitMs'].includes(k))) throw new GatewayError(400, 'invalid_operation');
    const capacity = input.capacity ?? 8, waitMs = input.waitMs ?? 25000;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) throw new GatewayError(400, 'invalid_poll');
    if (agent.poll) throw new GatewayError(429, 'receiver_already_polling');
    const jobs = take(agent, capacity);
    if (jobs.length || !waitMs) return send(res, 200, { jobs });
    let timer;
    const poll = { capacity, finish(items) {
      if (agent.poll !== poll) return;
      agent.poll = null; clearTimeout(timer); res.off('close', disconnect);
      send(res, 200, { jobs: items });
    } };
    const disconnect = () => { if (agent.poll === poll) agent.poll = null; clearTimeout(timer); };
    agent.poll = poll; res.once('close', disconnect);
    timer = setTimeout(() => poll.finish([]), waitMs);
  }
  async function mcp(req, res, token) {
    expire();
    const agent = canonicalToken(token) ? endpoints.get(digest(token)) : undefined;
    if (!agent) throw new GatewayError(404, 'endpoint_unavailable');
    if (req.method !== 'POST') throw new GatewayError(405, 'post_required');
    const rpc = await body(req);
    const reply = result => send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, ...result });
    try {
      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.id !== undefined && rpc.id !== null && typeof rpc.id !== 'string' && !Number.isFinite(rpc.id))) throw new RpcError(-32600, 'Invalid RPC request.');
      if (rpc.id === undefined) {
        if (!['notifications/initialized', 'notifications/cancelled'].includes(rpc.method)) throw new RpcError(-32601, 'Unsupported notification.');
        return send(res, 202);
      }
      const params = gatewayRequest(rpc.method, rpc.params);
      if (agent.jobs.size >= maxPending) throw new RpcError(-32000, 'Receiver request capacity exceeded.');
      const id = randomUUID();
      // Give mutations a recoverable key even when the host omitted one.
      const schema = RECEIVER_TOOLS.find(t => t.name === params.name)?.inputSchema;
      if (rpc.method === 'tools/call' && (schema && 'request_id' in schema.properties) && params.arguments?.request_id === undefined) params.arguments = { ...params.arguments, request_id: id };
      const size = Buffer.byteLength(JSON.stringify(params));
      if (bytes + size > maxBytes) throw new RpcError(-32000, 'Gateway memory capacity exceeded.');
      bytes += size;
      let timer;
      const job = { id, method: rpc.method, params, delivered: false, finish(response) {
        if (!agent.jobs.delete(id)) return;
        bytes -= size; clearTimeout(timer); res.off('close', disconnect);
        reply(response);
      } };
      const disconnect = () => { if (agent.jobs.delete(id)) { bytes -= size; clearTimeout(timer); } };
      agent.jobs.set(id, job); res.once('close', disconnect);
      timer = setTimeout(() => job.finish({ error: { code: -32001, message: 'Receiver operation timed out. Do not blindly repeat a write.', data: { requestId: params.arguments?.request_id ?? id, mayHaveExecuted: job.delivered } } }), requestTimeoutMs);
      wake(agent);
    } catch (e) {
      reply({ error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof RpcError ? e.message : 'Gateway error.' } });
    }
  }
  const cleanup = setInterval(expire, Math.min(1000, leaseMs)); cleanup.unref();
  return {
    async handle(req, res, parsed) {
      if (parsed.pathname !== '/v1/gateway' && !parsed.pathname.startsWith('/mcp/')) return false;
      try {
        if (stopped) throw new GatewayError(503, 'gateway_stopped');
        if (req.headers.origin !== undefined || parsed.search || parsed.hash) throw new GatewayError(403, 'request_not_allowed');
        if (parsed.pathname === '/v1/gateway') await control(req, res);
        else await mcp(req, res, parsed.pathname.slice('/mcp/'.length));
      } catch (e) { send(res, e instanceof GatewayError ? e.status : 500, { error: { code: e instanceof GatewayError ? e.code : 'gateway_error' } }); }
      return true;
    },
    status: () => ({ agents: agents.size, pending: [...agents.values()].reduce((n, a) => n + a.jobs.size, 0), bytes, storage: 'memory' }),
    close() { stopped = true; clearInterval(cleanup); for (const agent of agents.values()) agent.expiresAt = 0; expire(); },
  };
}
