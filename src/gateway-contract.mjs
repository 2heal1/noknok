import { TOOLS, RpcError, validateArguments } from './mcp-stdio.mjs';

export const ACTIVITY_EVENT = 'agentcall.activity';
export const MCP_VERSION = '2026-07-28';
export const activityArg = { type: 'string', minLength: 1, maxLength: 64, pattern: '^evt_[a-f0-9]{32}$' };
export const RECEIVER_TOOLS = [
  ...TOOLS.filter(t => !['agentcall_listen', 'agentcall_receive', 'agentcall_wait'].includes(t.name)),
  { name: 'agentcall_inbox', description: 'Read durable activities for this bound agent. Read inbox/history, respond within owner authorization, then acknowledge. No model-side wait loop.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'agentcall_ack_activity', description: 'Acknowledge one processed activity. This does not end the call.', inputSchema: { type: 'object', properties: { activity_id: activityArg }, required: ['activity_id'], additionalProperties: false }, annotations: { readOnlyHint: false, idempotentHint: true } },
  { name: 'agentcall_status', description: 'Read the state of a session owned by this bound agent.', inputSchema: { type: 'object', properties: { session: { type: 'string', pattern: '^ac_[a-f0-9-]{36}$', maxLength: 39 } }, required: ['session'], additionalProperties: false }, annotations: { readOnlyHint: true } },
];
const catalog = new Map(RECEIVER_TOOLS.map(t => [t.name, t]));
const methods = new Set(['ping', 'initialize', 'server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe']);
export const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Both ends enforce this closed contract. Never a generic MCP or URL proxy. */
export function gatewayRequest(method, params = {}) {
  if (!methods.has(method)) throw new RpcError(-32601, 'Only NokNok communication methods are supported.');
  if (!object(params) || (params._meta !== undefined && !object(params._meta))) throw new RpcError(-32602, 'Invalid method parameters.');
  const { _meta, ...input } = params;
  if (method === 'tools/call') {
    if (Object.keys(input).some(k => !['name', 'arguments'].includes(k)) || !catalog.has(input.name)) throw new RpcError(-32602, 'Unknown NokNok tool.');
    validateArguments(catalog.get(input.name).inputSchema, input.arguments === undefined ? {} : input.arguments);
  } else if (method.startsWith('events/') && method !== 'events/list') {
    const keys = ['name', 'arguments', 'delivery', 'cursor', 'ttlMs'];
    if (Object.keys(input).some(k => !keys.includes(k)) || input.name !== ACTIVITY_EVENT
      || !object(input.arguments) || Object.keys(input.arguments).length || !object(input.delivery)) throw new RpcError(-32602, 'Only this agent’s activity event is supported.');
  }
  return input;
}

export function gatewayOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Gateway must be an HTTPS origin, or loopback HTTP for local tests.'); }
  const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('Gateway must be an HTTPS origin, or loopback HTTP for local tests.');
  return url.origin;
}
