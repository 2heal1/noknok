import test from 'node:test';
import { viewerBrandAssets } from '../src/viewer-assets.js';
import assert from 'node:assert/strict';
import { startRelay } from '../src/relay.js';

async function fixture(t, options = {}) {
  const relay = await startRelay({ port: 0, ...options });
  t.after(() => relay.close());
  return relay;
}

test('public URL validation and bind failures reject startup cleanly', async t => {
  for (const publicUrl of ['file:///tmp/relay', 'http://user:pass@localhost', 'https://relay.test?key=x', 'https://relay.test/path', 'https://relay.test/#x']) {
    await assert.rejects(startRelay({ port: 0, publicUrl }), TypeError);
  }
  const f = await fixture(t);
  await assert.rejects(startRelay({ port: f.server.address().port }), { code: 'EADDRINUSE' });
  const external = await startRelay({ port: 0, publicUrl: 'https://relay.example/' });
  t.after(() => external.close());
  assert.equal(external.url, 'https://relay.example');
  const response = await fetch(`http://127.0.0.1:${external.server.address().port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: 1 });
});

test('relay serves only encrypted meeting assets with restrictive browser headers', async t => {
  const f = await fixture(t);
  for (const [path, type] of [['/meeting', 'text/html'], ['/meeting/', 'text/html'], ['/meeting.js', 'text/javascript'], ['/meeting-invitation.js', 'text/javascript'], ['/e2ee.js', 'text/javascript'], ['/meeting.css', 'text/css'], ...viewerBrandAssets.map(([path, [, type]]) => [path, type])]) {
    const response = await fetch(f.url + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    const head = await fetch(f.url + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  for (const path of ['/', '/index.html']) {
    const redirect = await fetch(f.url + path, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/meeting');
  }
  for (const path of ['/view', '/app.js', '/styles.css', '/src/relay.js', '/package.json', '/.noknok', '/%2e%2e%2fsrc/relay.js']) {
    assert.equal((await fetch(f.url + path)).status, 404);
  }
  assert.equal((await fetch(f.url + '/meeting', { method: 'POST' })).status, 405);
});
