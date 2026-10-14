import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHostedService, type HostedServiceOptions } from '../src/hosted-service.js';
import type { McpDiagnosticRecord } from '../src/mcp-diagnostics.js';
import { authorizeOAuth } from './oauth-helper.js';

const MARKER = 'private-diagnostic-test-marker';
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: MARKER, version: '1' }, progressToken: MARKER };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(t: TestContext, options: Pick<HostedServiceOptions, 'webhookPost' | 'diagnostic' | 'maxAccountDailyEgressBytes'> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'noknok-diagnostics-'));
  const records: McpDiagnosticRecord[] = [];
  let callbacks = 0;
  const service = await startHostedService({ dataDir, port: 0, publicUrl: 'http://127.0.0.1:4317',
    maxAccountDailyEgressBytes: options.maxAccountDailyEgressBytes,
    eventOptions: { workerIntervalMs: 60_000 },
    diagnostic: record => { records.push(record); options.diagnostic?.(record); },
    webhookPost: async (url, request) => {
      callbacks++;
      if (options.webhookPost) return options.webhookPost(url, request);
      assert.equal(await request.beforeSend?.(), true);
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(request.body).challenge }) };
    } });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function post(path: string, input: unknown, token?: string, headers: Record<string, string> = {}) {
    const response = await fetch(service.origin + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `private=${MARKER}`, 'X-Request-ID': MARKER,
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(input) });
    return { status: response.status, requestId: response.headers.get('x-request-id'), body: await response.json() };
  }
  const account = await post('/v1/hosted/accounts', { requestId: randomBytes(32).toString('base64url') });
  assert.equal(account.status, 200);
  const registered = await post('/v1/hosted/agents', { requestId: randomBytes(32).toString('base64url') }, account.body.accountToken);
  assert.equal(registered.status, 200);
  const agent = registered.body;
  const credentials = [account.body.accountToken, agent.agentToken, agent.agentId];
  async function authorize(scope?: string) {
    const authorization = await authorizeOAuth({ baseUrl: service.origin, realm: service.store.realm, agentToken: agent.agentToken, scope });
    credentials.push(authorization.tokens.access_token, authorization.tokens.refresh_token);
    for (const grant of service.store.db.prepare('SELECT id FROM oauth_grants').all()) credentials.push(grant.id as string);
    return authorization.tokens.access_token as string;
  }
  const token = await authorize();
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const callbackUrl = `https://receiver.example/${MARKER}?private=${MARKER}`;
  const params = () => ({ name: 'noknok.activity', arguments: { recipient_id: agent.agentId },
    delivery: { mode: 'webhook', url: callbackUrl, secret }, cursor: null, maxAgeMs: 300_000, _meta: META });
  const rpc = (method: string, value: unknown = {}, accessToken: string | undefined = token, headers = {}) =>
    post('/mcp', { jsonrpc: '2.0', id: MARKER, method, params: value }, accessToken,
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...headers });
  function trace(requestId: string | null) {
    assert.ok(requestId); assert.match(requestId, UUID); assert.notEqual(requestId, MARKER);
    const entries = records.filter(record => record.requestId === requestId);
    assert.equal(entries[0]?.event, 'request');
    assert.equal(entries.at(-1)?.event, 'response');
    assert.equal(entries.filter(record => record.event === 'response').length, 1);
    for (const entry of entries) {
      assert.equal(entry.component, 'noknok.mcp');
      assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    }
    assert.ok(entries.at(-1)!.durationMs! >= 0);
    return entries;
  }
  function assertPrivate(extra: string[] = []) {
    const serialized = JSON.stringify(records);
    for (const privateValue of [MARKER, callbackUrl, secret, ...credentials, ...extra].filter(Boolean)) {
      assert.equal(serialized.includes(privateValue), false, 'diagnostics must exclude private values');
    }
  }
  return { service, records, agent, token, authorize, params, rpc, post, trace, assertPrivate, get callbacks() { return callbacks; } };
}

test('HTTP MCP 2 subscription metadata survives create, refresh and unsubscribe with correlated safe diagnostics', async t => {
  const f = await fixture(t);
  const discover = await f.rpc('server/discover', { _meta: META });
  assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28']);
  const listing = await f.rpc('events/list', { _meta: META });
  assert.equal(listing.body.result.events[0].name, 'noknok.activity');
  const agentPing = await f.rpc('ping', {}, f.agent.agentToken);
  const agentTrace = f.trace(agentPing.requestId).at(-1)!;
  assert.equal(agentTrace.authentication, 'agent'); assert.equal(agentTrace.canManageEvents, false);

  const created = await f.rpc('events/subscribe', f.params());
  assert.equal(created.status, 200); assert.ok(created.body.result.id);
  const firstTrace = f.trace(created.requestId);
  assert.deepEqual(firstTrace.filter(record => record.event === 'subscription').map(record => record.stage),
    ['verification_started', 'callback_response', 'subscription_stored']);
  assert.deepEqual(firstTrace.at(-1), { ...firstTrace.at(-1), method: 'events/subscribe', stage: 'subscription_stored',
    authentication: 'oauth', canManageEvents: true, recipientMatches: true, unknownParameterCount: 0, httpStatus: 200, outcome: 'success' });
  assert.deepEqual(firstTrace.at(-1)!.parameterFields, ['name', 'arguments', 'delivery', 'cursor', 'maxAgeMs', '_meta']);

  const refreshed = await f.rpc('events/subscribe', { ...f.params(), maxAgeMs: 0, _meta: { ...META, progressToken: 7 } });
  assert.equal(refreshed.body.result.id, created.body.result.id);
  assert.notEqual(refreshed.requestId, created.requestId);
  assert.deepEqual(f.trace(refreshed.requestId).filter(record => record.event === 'subscription').map(record => record.stage),
    ['verification_cached', 'subscription_stored']);
  assert.equal(f.callbacks, 1);
  assert.equal(f.service.events.status(f.agent.agentId).subscriptions.length, 1);

  const current = f.params();
  const removed = await f.rpc('events/unsubscribe', { name: current.name, arguments: current.arguments,
    delivery: { mode: current.delivery.mode, url: current.delivery.url }, _meta: META });
  assert.deepEqual(removed.body.result, {});
  assert.equal(f.trace(removed.requestId).at(-1)!.outcome, 'success');
  assert.equal(f.service.events.status(f.agent.agentId).subscriptions.length, 0);
  f.assertPrivate([created.body.result.id]);
});

test('HTTP diagnostics distinguish Origin, authentication, scope and parameter rejection before callbacks', async t => {
  const f = await fixture(t);
  for (const origin of ['null', `https://${MARKER}.example`]) {
    const rejected = await f.rpc('events/subscribe', f.params(), f.token, { Origin: origin });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.requestId, rejected.requestId);
    const last = f.trace(rejected.requestId).at(-1)!;
    assert.equal(last.stage, 'origin'); assert.equal(last.reason, 'origin_denied'); assert.equal(last.outcome, 'error');
    assert.equal(last.origin, origin === 'null' ? 'null' : 'other');
  }
  const unauthenticated = await f.post('/mcp', { jsonrpc: '2.0', id: MARKER, method: 'events/subscribe', params: f.params() });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.requestId, unauthenticated.requestId);
  const noAuth = f.trace(unauthenticated.requestId).at(-1)!;
  assert.equal(noAuth.stage, 'authentication'); assert.equal(noAuth.outcome, 'error');
  assert.equal(noAuth.authentication, undefined);

  const narrow = await f.authorize('noknok:events:read');
  const cases = [
    { token: narrow, params: f.params(), code: -32001, reason: 'insufficient_scope', canManageEvents: false },
    { token: f.token, params: { ...f.params(), [MARKER]: MARKER }, code: -32602, reason: 'invalid_params', canManageEvents: true },
  ];
  for (const scenario of cases) {
    const rejected = await f.rpc('events/subscribe', scenario.params, scenario.token);
    assert.equal(rejected.status, 200, 'JSON-RPC failures still use HTTP 200');
    assert.equal(rejected.body.error.code, scenario.code);
    assert.equal(rejected.body.error.data.requestId, rejected.requestId);
    const entries = f.trace(rejected.requestId), last = entries.at(-1)!;
    assert.equal(last.stage, 'dispatch'); assert.equal(last.httpStatus, 200); assert.equal(last.rpcCode, scenario.code);
    assert.equal(last.reason, scenario.reason); assert.equal(last.outcome, 'error');
    assert.equal(last.canManageEvents, scenario.canManageEvents);
    assert.equal(entries.some(record => record.event === 'subscription'), false);
    if (scenario.code === -32602) assert.equal(last.unknownParameterCount, 1);
  }
  assert.equal(f.callbacks, 0);
  assert.equal(f.service.events.status(f.agent.agentId).subscriptions.length, 0);
  assert.equal(f.service.store.db.prepare("SELECT COUNT(*) n FROM quotas WHERE bucket LIKE 'events.subscribe%'").get().n, 0);
  // Unknown methods and query strings must not escape the same logging boundary.
  const unknown = await f.rpc(MARKER, { [MARKER]: MARKER });
  assert.equal(f.trace(unknown.requestId).at(-1)!.method, 'other');
  const deniedTool = await f.rpc('tools/call', { name: 'noknok_meeting_create', arguments: {} });
  assert.equal(deniedTool.body.result.isError, true);
  const deniedTrace = f.trace(deniedTool.requestId).at(-1)!;
  assert.equal(deniedTrace.outcome, 'error'); assert.equal(deniedTrace.reason, 'insufficient_scope');
  assert.equal(deniedTrace.rpcCode, undefined, 'tool business errors are not JSON-RPC errors');
  await f.post(`/mcp?private=${MARKER}`, { jsonrpc: '2.0', id: MARKER, method: 'ping' }, f.token);
  f.assertPrivate();
});

test('HTTP budget rejection replaces the RPC diagnostic with the response actually sent', async t => {
  const f = await fixture(t, { maxAccountDailyEgressBytes: 1 });
  const rejected = await f.rpc('events/subscribe', { ...f.params(), [MARKER]: MARKER });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.body.error.code, 'account_egress_limit');
  assert.equal(rejected.body.error.requestId, rejected.requestId);
  const last = f.trace(rejected.requestId).at(-1)!;
  assert.equal(last.stage, 'response_budget'); assert.equal(last.httpStatus, 429);
  assert.equal(last.reason, 'account_egress_limit'); assert.equal(last.outcome, 'error');
  assert.equal(last.rpcCode, undefined, 'the prepared JSON-RPC error was not sent');
  assert.equal(f.callbacks, 0);
  f.assertPrivate();
});

test('HTTP callback failures correlate their status and stage without exposing callback bodies', async t => {
  for (const status of [503, 200]) {
    const f = await fixture(t, { webhookPost: async () => ({ status, body: JSON.stringify({ challenge: MARKER, message: MARKER }) }) });
    const rejected = await f.rpc('events/subscribe', f.params());
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.error.code, -32015);
    assert.equal(rejected.body.error.data.reason, 'challenge_failed');
    assert.equal(rejected.body.error.data.requestId, rejected.requestId);
    const entries = f.trace(rejected.requestId);
    const steps = entries.filter(record => record.event === 'subscription');
    assert.deepEqual(steps.map(record => record.stage), ['verification_started', 'callback_response', 'verification_failed']);
    assert.equal(steps[1].httpStatus, status);
    assert.equal(steps[2].reason, 'challenge_failed');
    const last = entries.at(-1)!;
    assert.equal(last.httpStatus, 200); assert.equal(last.rpcCode, -32015);
    assert.equal(last.stage, 'verification_failed'); assert.equal(last.outcome, 'error');
    assert.equal(f.service.events.status(f.agent.agentId).subscriptions.length, 0);
    f.assertPrivate();
  }
});

test('a throwing diagnostic sink cannot change HTTP subscription success or rejection', async t => {
  const f = await fixture(t, { diagnostic: () => { throw new Error(MARKER); } });
  const created = await f.rpc('events/subscribe', f.params());
  assert.equal(created.status, 200); assert.ok(created.body.result.id);
  assert.equal(f.service.events.status(f.agent.agentId).subscriptions.length, 1);
  assert.equal(f.trace(created.requestId).at(-1)!.outcome, 'success');
  const rejected = await f.rpc('events/subscribe', { ...f.params(), _meta: null });
  assert.equal(rejected.status, 200); assert.equal(rejected.body.error.code, -32602);
  assert.equal(rejected.body.error.data.requestId, rejected.requestId);
  assert.equal(f.trace(rejected.requestId).at(-1)!.outcome, 'error');
  assert.equal(f.service.events.status(f.agent.agentId).subscriptions.length, 1);
  f.assertPrivate([created.body.result.id]);
});
