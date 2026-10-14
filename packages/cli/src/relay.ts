import type { AddressInfo } from 'node:net';
import type { RelayOptions } from './runtime-types.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { webFile } from './asset-paths.js';
import { viewerBrandAssets } from './viewer-assets.js';
import { createMeetings } from './meetings.js';

const WEB_ASSETS = new Map([
  ...viewerBrandAssets,
  ['/meeting', ['meeting.html', 'text/html; charset=utf-8']],
  ['/meeting/', ['meeting.html', 'text/html; charset=utf-8']],
  ['/meeting.js', ['meeting.js', 'text/javascript; charset=utf-8']],
  ['/meeting-invitation.js', ['meeting-invitation.js', 'text/javascript; charset=utf-8']],
  ['/e2ee.js', ['e2ee.js', 'text/javascript; charset=utf-8']],
  ['/meeting.css', ['meeting.css', 'text/css; charset=utf-8']],
]);
const WEB_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};

function validatePublicUrl(value?: string) {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('publicUrl must be an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('publicUrl must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

/** Start an in-memory encrypted meeting relay. Closing resolves active long polls. */
export async function startRelay(options: RelayOptions = {}) {
  const publicUrl = validatePublicUrl(options.publicUrl);
  if (options.serverKey !== undefined && (typeof options.serverKey !== 'string' || !options.serverKey)) throw new TypeError('serverKey must be a nonempty string.');
  let url = '';
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const meetings = createMeetings({ getUrl: () => url, meetingTtlMs: options.meetingTtlMs, retentionMs: options.retentionMs, maxMeetings: options.maxMeetings, serverKey: options.serverKey });

  function write(res: http.ServerResponse, status: number, value: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...WEB_HEADERS });
    res.end(JSON.stringify(value));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (closing) return write(res, 503, { error: { code: 'relay_closing', message: 'Relay is shutting down.' } });
    const parsed = new URL(req.url!, 'http://relay.invalid');
    if (parsed.pathname.startsWith('/invite/') || parsed.pathname === '/v1/meetings' || parsed.pathname.startsWith('/v1/meetings/')) {
      if (await meetings.handle(req, res, parsed)) return;
    }
    if (req.method === 'GET' && parsed.pathname === '/health') return write(res, 200, { ok: true, version: 1 });
    if (['GET', 'HEAD'].includes(req.method!) && ['/', '/index.html'].includes(parsed.pathname)) {
      res.writeHead(302, { Location: '/meeting', ...WEB_HEADERS });
      return res.end();
    }
    if (WEB_ASSETS.has(parsed.pathname)) {
      if (!['GET', 'HEAD'].includes(req.method!)) {
        req.resume();
        return write(res, 405, { error: { code: 'method_not_allowed', message: 'Meeting assets are read-only.' } });
      }
      const [filename, contentType] = WEB_ASSETS.get(parsed.pathname)!;
      const asset = await readFile(webFile(filename));
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': asset.length, ...WEB_HEADERS });
      return res.end(req.method === 'HEAD' ? undefined : asset);
    }
    req.resume();
    write(res, 404, { error: { code: 'not_found', message: 'Route not found.' } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => write(res, 500, { error: { code: 'internal_error', message: 'Unexpected relay error.' } }));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(error => {
    meetings.close();
    throw error;
  });
  const address = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';
  const accessibleHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  url = publicUrl ?? `http://${accessibleHost}:${address.port}`;
  function stopPolling() {
    closing = true;
    meetings.close();
  }
  server.once('close', stopPolling);
  function close() {
    if (closePromise) return closePromise;
    stopPolling();
    closePromise = new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    return closePromise;
  }
  return { url, server, close };
}
