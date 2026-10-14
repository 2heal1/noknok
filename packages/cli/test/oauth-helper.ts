import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

/** Exercise the real browser/CLI ceremony over HTTP without bypassing consent storage. */
export async function authorizeOAuth({ baseUrl, realm, agentToken, scope, client, beforeConfirm, exchange = true, cliRequest }: {
  baseUrl: string; realm: string; agentToken: string; scope?: string; client?: any; exchange?: boolean;
  beforeConfirm?: (context: any) => void | Promise<void>;
  cliRequest?: (path: string, method: string, data?: unknown) => Promise<Response>;
}) {
  const request = (path, options: RequestInit = {}) => fetch(`${baseUrl}${path}`, { ...options, redirect: 'manual' });
  const cli = (path, method = 'GET', data?) => cliRequest ? cliRequest(path, method, data) : request(path, { method, headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (!client) {
    const registered = await request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'OAuth integration test', redirect_uris: ['https://chatgpt.com/connector_platform/oauth_redirect'], token_endpoint_auth_method: 'none' }) });
    client = await registered.json(); assert.equal(registered.status, 201, JSON.stringify(client));
  }
  const pairingResponse = await cli('/oauth/pairings', 'POST', {}), pairing = await pairingResponse.json();
  assert.equal(pairingResponse.status, 201, JSON.stringify(pairing));
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', resource: `${realm}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', state: 'oauth-test-state', ...(scope ? { scope } : {}) });
  const authorization = await request(`/oauth/authorize?${params}`), html = await authorization.text();
  assert.equal(authorization.status, 200, html);
  const cookie = authorization.headers.get('set-cookie')!.split(';')[0], csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  const browser = (action: string, more = {}) => request('/oauth/authorize', { method: 'POST', headers: { Cookie: cookie, Origin: realm, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, action, ...more }).toString() });
  const pair = await browser('pair', { user_code: pairing.user_code }); assert.equal(pair.status, 200, await pair.text());
  const consent = await browser('consent'); assert.equal(consent.status, 200, await consent.text());
  const pending = await (await cli(`/oauth/pairings/${pairing.pairing_id}`)).json();
  assert.equal(pending.status, 'awaiting_cli'); assert.ok(pending.confirmation);
  if (beforeConfirm) await beforeConfirm({ client, pairing, pending, cookie, csrf, browser, cli, verifier });
  const confirmation = await cli(`/oauth/pairings/${pairing.pairing_id}/confirm`, 'POST', { confirmation: pending.confirmation });
  assert.equal(confirmation.status, 200, await confirmation.text());
  const finish = await browser('finish'); assert.equal(finish.status, 302, await finish.text());
  const redirect = new URL(finish.headers.get('location')!); assert.equal(redirect.searchParams.get('state'), 'oauth-test-state');
  const exchangeBody = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: `${realm}/mcp`, code: redirect.searchParams.get('code')!, code_verifier: verifier,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}) };
  const tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', ...(client.token_endpoint_auth_method === 'client_secret_basic' ? { Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` } : {}) };
  if (client.token_endpoint_auth_method === 'client_secret_basic') delete exchangeBody.client_secret;
  let tokens: any;
  if (exchange) {
    const exchanged = await request('/oauth/token', { method: 'POST', headers: tokenHeaders, body: new URLSearchParams(exchangeBody).toString() });
    tokens = await exchanged.json(); assert.equal(exchanged.status, 200, JSON.stringify(tokens));
  }
  return { client, pairing, pending, tokens, cookie, csrf, verifier, exchangeBody, browser, cli, request };
}
