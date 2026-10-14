import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteServer } from '../scripts/website.mjs';

const homepage = '<h1>Noknok · 你好</h1>';
const secret = 'PRIVATE: never serve this';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'noknok-website-'));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'website');
  await mkdir(root);
  await writeFile(path.join(root, 'index.html'), homepage);
  await writeFile(path.join(root, 'app.js'), 'export const ready = true;');
  await writeFile(path.join(root, '.env'), secret);
  await writeFile(path.join(directory, 'secret.txt'), secret);
  await symlink(path.join(directory, 'secret.txt'), path.join(root, 'linked-file.txt'));
  await symlink(directory, path.join(root, 'linked-directory'));
  server = await createWebsiteServer({ rootDir: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  // http.request preserves raw paths, unlike fetch's URL normalization.
  return (requestPath, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: requestPath, method,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

test('website preview serves static GET and HEAD responses with correct MIME and byte length', async (t) => {
  const request = await fixture(t);
  const get = await request('/');
  assert.equal(get.status, 200);
  assert.equal(get.body, homepage);
  assert.equal(get.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(get.headers['content-length'], String(Buffer.byteLength(homepage)));

  const head = await request('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], get.headers['content-type']);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  const script = await request('/app.js?v=1');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  const missing = await request('/missing.html', 'HEAD');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, '');
});

test('website preview does not expose parent files, dotfiles, or symlink targets', async (t) => {
  const request = await fixture(t);
  for (const requestPath of [
    '/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt',
    '/.env', '/%2eenv', '/linked-file.txt', '/linked-directory/secret.txt',
  ]) {
    const response = await request(requestPath);
    assert.equal(response.status, 404, requestPath);
    assert.ok(!response.body.includes(secret), requestPath);
  }
});

test('website preview rejects malformed paths and unsupported methods', async (t) => {
  const request = await fixture(t);
  assert.equal((await request('/%ZZ')).status, 400);
  const unsupported = await request('/', 'POST');
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.allow, 'GET, HEAD');
});
