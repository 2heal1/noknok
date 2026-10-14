import type { ApiOptions } from './runtime-types.js';
import { randomUUID } from 'node:crypto';

export function fail(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function normalizeServer(value: string) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_SERVER', 'Expected an http:// or https:// relay address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw fail('INVALID_SERVER', 'Relay URLs must use HTTP(S), without credentials, query parameters, or fragments.');
  }
  return url.href.replace(/\/$/, '');
}

export async function api(server, path, { method = 'GET', body, token, key, signal, timeoutMs = 35000 }: ApiOptions = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['X-Noknok-Key'] = key;
  const requestId = body?.requestId;
  // A mutation is retried only with the SAME idempotency key, never a new action.
  const attempts = requestId ? 2 : 1;
  for (let i = 0; i < attempts; i++) {
    let response;
    try {
      response = await fetch(`${normalizeServer(server)}${path}`, {
        method, headers, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) throw Object.assign(error, { requestId });
      if (i + 1 < attempts) continue;
      throw Object.assign(fail('CONNECTION_FAILED', `Cannot reach relay ${new URL(server).origin}. Check that it is running and reachable.`), { requestId });
    }
    let data;
    try { data = await response.json(); } catch {
      throw Object.assign(fail('INVALID_RESPONSE', `Relay returned a non-JSON response (HTTP ${response.status}).`), { requestId });
    }
    if (!response.ok) {
      throw Object.assign(fail(data.error?.code || 'RELAY_ERROR', data.error?.message || `HTTP ${response.status}`), { requestId });
    }
    return data;
  }
}

export const newRequestId = () => randomUUID();
