import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import type { SubscriptionDiagnostic } from './hosted-types.js';

const METHODS = new Set(['initialize', 'ping', 'server/discover', 'tools/list', 'tools/call',
  'events/list', 'events/subscribe', 'events/unsubscribe', 'notifications/initialized', 'notifications/cancelled']);
const PARAMS = ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', 'maxAgeMs', '_meta'];
const REASONS = new Set(['closing', 'concurrency_limit', 'rate_capacity', 'rate_limit', 'invalid_url',
  'origin_denied', 'post_required', 'agent_concurrency', 'json_required', 'body_too_large', 'invalid_json',
  'invalid_notification', 'invalid_token', 'insufficient_scope', 'account_egress_limit', 'service_egress_limit',
  'public_egress_limit', 'invalid_secret', 'payload_too_large', 'cancelled', 'timeout', 'dns_failed',
  'address_not_public', 'network_failed', 'response_failed', 'response_too_large', 'challenge_failed',
  'UNAUTHENTICATED', 'AGENT_UNAVAILABLE', 'QUOTA_EXCEEDED', 'QUOTA_CAPACITY']);
const RPC_REASONS = new Map([[-32600, 'invalid_request'], [-32601, 'method_not_found'], [-32602, 'invalid_params'],
  [-32001, 'not_authorized'], [-32000, 'unavailable'], [-32009, 'subscription_changed']]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface McpDiagnosticRecord {
  component: 'noknok.mcp'; timestamp: string; requestId: string;
  event: 'request' | 'response' | 'subscription'; stage: string;
  method?: string; httpMethod: string; origin: 'absent' | 'null' | 'same-origin' | 'other';
  authentication?: 'oauth' | 'agent'; canManageEvents?: boolean;
  parameterFields?: string[]; unknownParameterCount?: number; recipientMatches?: boolean;
  httpStatus?: number; rpcCode?: number; reason?: string; durationMs?: number;
  outcome?: 'success' | 'error' | 'aborted';
}
export type McpDiagnosticSink = (record: McpDiagnosticRecord) => void;
export function createMcpDiagnosticWriter(output: Writable): McpDiagnosticSink {
  let listening = false, failed = false, ready = true;
  return record => {
    if (!listening) { output.on('error', () => { failed = true; }); listening = true; }
    if (failed || !ready) return;
    try {
      ready = output.write(JSON.stringify(record) + '\n');
      // Best-effort diagnostics must never grow an unbounded queue or delay MCP.
      if (!ready) output.once('drain', () => { ready = true; });
    } catch { failed = true; }
  };
}
export const writeMcpDiagnostic = createMcpDiagnosticWriter(process.stderr);

/** Only fixed field names, enums and numbers leave this boundary. Never log
 * headers, identifiers, paths, params, callback bodies or exception messages. */
export function startMcpDiagnostic(req: IncomingMessage, res: ServerResponse, realm: string, sink: McpDiagnosticSink) {
  const requestId = randomUUID(), started = performance.now();
  const context: Omit<McpDiagnosticRecord, 'component' | 'timestamp' | 'requestId' | 'event'> = {
    stage: 'received', httpMethod: ['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method ?? '') ? req.method! : 'other',
    origin: req.headers.origin === undefined ? 'absent' : req.headers.origin === 'null' ? 'null'
      : req.headers.origin === realm ? 'same-origin' : 'other',
  };
  res.setHeader('X-Request-ID', requestId);
  const emit = (event: McpDiagnosticRecord['event'], fields: Partial<McpDiagnosticRecord> = {}) => {
    try { sink({ ...context, ...fields, component: 'noknok.mcp', timestamp: new Date().toISOString(), requestId, event }); }
    catch { /* Logging must not change authorization, delivery or the response. */ }
  };
  emit('request');
  let finished = false;
  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    emit('response', { ...(res.headersSent ? { httpStatus: res.statusCode } : {}),
      durationMs: Math.round(performance.now() - started),
      outcome: aborted ? 'aborted' : context.rpcCode !== undefined || context.reason !== undefined || res.statusCode >= 400 ? 'error' : 'success' });
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));
  return {
    requestId,
    stage(value: 'admission' | 'origin' | 'authentication' | 'request_body' | 'dispatch' | 'response_budget') { context.stage = value; },
    authenticated(actor: { agentId: string; grantId?: string; scopes?: string[] }) {
      context.authentication = actor.grantId ? 'oauth' : 'agent';
      context.canManageEvents = !!actor.grantId && !!actor.scopes?.includes('noknok:events:manage');
    },
    parsed(input: Record<string, unknown>, agentId: string) {
      context.method = typeof input.method === 'string' && METHODS.has(input.method) ? input.method : 'other';
      if (!['events/subscribe', 'events/unsubscribe'].includes(context.method) || !object(input.params)) return;
      const params = input.params;
      context.parameterFields = PARAMS.filter(key => Object.hasOwn(params, key));
      context.unknownParameterCount = Object.keys(params).filter(key => !PARAMS.includes(key)).length;
      context.recipientMatches = object(params.arguments) && params.arguments.recipient_id === agentId;
    },
    failed(error: { code?: unknown; data?: unknown }, rpcCode?: number) {
      context.rpcCode = rpcCode !== undefined && Number.isSafeInteger(rpcCode) ? rpcCode : undefined;
      const reason = object(error.data) ? error.data.reason : undefined;
      context.reason = typeof reason === 'string' && REASONS.has(reason) ? reason
        : typeof error.code === 'string' && REASONS.has(error.code) ? error.code
        : RPC_REASONS.get(rpcCode!) ?? 'internal_error';
    },
    subscription(event: SubscriptionDiagnostic) {
      context.stage = event.stage;
      emit('subscription', { ...('httpStatus' in event ? { httpStatus: event.httpStatus } : {}),
        ...('reason' in event ? { reason: REASONS.has(event.reason) ? event.reason : 'internal_error' } : {}) });
    },
  };
}
export type McpDiagnostic = ReturnType<typeof startMcpDiagnostic>;
