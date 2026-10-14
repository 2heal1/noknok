import type { LookupAddress } from 'node:dns';
import type { HostedSubscription, SecureWebhookOptions, WebhookPost, WebhookResponse } from './hosted-types.js';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createHmac } from 'node:crypto';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as [string, number][]) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as [string, number][]) denied.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export class CallbackError extends Error {
  reason: string;
  constructor(reason: string) {
    super('Callback endpoint verification or delivery failed.');
    this.reason = reason;
  }
}

export function callbackUrl(value: unknown): URL {
  let url;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { throw new CallbackError('invalid_url'); }
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' ||
      url.username || url.password || url.hash) throw new CallbackError('invalid_url');
  return url;
}

export function signingKey(secret: unknown): Buffer {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
    throw new CallbackError('invalid_secret');
  }
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new CallbackError('invalid_secret');
  }
  return key;
}

export function webhookHeaders(subscription: Pick<HostedSubscription, 'id' | 'secret' | 'previousSecret' | 'rotateUntil'>, id: string, body: string, now = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const keys = [subscription.secret];
  if (subscription.previousSecret && (subscription.rotateUntil ?? 0) > now) keys.push(subscription.previousSecret);
  const signatures = keys.map(secret => `v1,${createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`);
  return {
    'Content-Type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '),
    'X-MCP-Subscription-Id': subscription.id,
  };
}

// Dependency injection is for unit tests; the executable always uses real DNS and HTTPS.
export function createSecureWebhookPost({ resolve = lookup, request = https.request, timeoutMs = 10_000 }: SecureWebhookOptions = {}): WebhookPost {
  return async function post(value, { headers, body, signal, beforeSend }) {
    const url = callbackUrl(value);
    if (Buffer.byteLength(body) > 262_144) throw new CallbackError('payload_too_large');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const timeout = AbortSignal.timeout(timeoutMs);
    const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
    if (deadline.aborted) throw new CallbackError('cancelled');
    let addresses: LookupAddress[];
    try {
      addresses = await Promise.race([
        isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : resolve(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new CallbackError('timeout')), { once: true })),
      ]);
    } catch (error) {
      if (error instanceof CallbackError) throw error;
      throw new CallbackError('dns_failed');
    }
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new CallbackError('address_not_public');
    const pinned = addresses[0];
    // Authorization may change while DNS resolves. Recheck before any socket
    // opens, without permitting the callback to change the pinned destination.
    if (beforeSend && !await beforeSend()) throw new CallbackError('cancelled');
    if (deadline.aborted) throw new CallbackError(signal?.aborted ? 'cancelled' : 'timeout');
    return new Promise<WebhookResponse>((resolveResult, reject) => {
      const req = request(url, {
        method: 'POST', headers, agent: false, signal: deadline,
        // Pin the TCP destination while keeping URL hostname for Host and TLS identity.
        lookup(_hostname, options, done) {
          if (options.all) done(null, [pinned]);
          else done(null, pinned.address, pinned.family);
        },
      }, res => {
        let size = 0;
        const parts: Buffer[] = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 16_384) res.destroy(new CallbackError('response_too_large'));
          else parts.push(chunk);
        });
        res.on('error', () => reject(new CallbackError('response_failed')));
        res.on('end', () => resolveResult({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
      });
      // HTTPS request does not follow redirects.
      req.on('error', () => reject(new CallbackError(signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'network_failed')));
      req.end(body);
    });
  };
}

export type { WebhookPost } from './hosted-types.js';
