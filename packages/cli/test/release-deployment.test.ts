import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchRelease, stableVersion, verifyMetadata, verifyIntegrity } from '../../../deploy/release/fetch-package.js';

const version = '0.1.0';
const bytes = Buffer.from('synthetic release package');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const metadata = { name: '@noknok/cli', version, dist: { tarball: `https://registry.npmjs.org/@noknok/cli/-/cli-${version}.tgz`, integrity } };

test('deployment only accepts exact stable versions and fixed npm package metadata', () => {
  assert.equal(stableVersion(version), version);
  for (const value of ['latest', '^1.2.3', '01.2.3', '1.2.3-preview.1', '1.2.3+build', '1.2.3;id', '1.2.3\n', '../1.2.3', '1.2']) {
    assert.throws(() => stableVersion(value));
  }
  assert.deepEqual(verifyMetadata(metadata, version), metadata.dist);
  for (const change of [{ name: '@other/cli' }, { version: '0.2.0' }, { dependencies: { another: '1.0.0' } },
    { dist: { ...metadata.dist, tarball: 'https://attacker.test/package.tgz' } }, { dist: { ...metadata.dist, integrity: 'sha1-unsafe' } }]) {
    assert.throws(() => verifyMetadata({ ...metadata, ...change }, version));
  }
  verifyIntegrity(bytes, integrity);
  assert.throws(() => verifyIntegrity(Buffer.from('modified'), integrity), /integrity/);
});

test('download uses fixed HTTPS registry URLs without redirects and rejects tampered bytes before writing', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), redirect: options?.redirect });
    return calls.length === 1 ? Response.json(metadata) : new Response('corrupt bytes');
  };
  try {
    await assert.rejects(fetchRelease(version), /integrity verification failed/);
    assert.deepEqual(calls, [{ url: `https://registry.npmjs.org/@noknok%2fcli/${version}`, redirect: 'error' },
      { url: metadata.dist.tarball, redirect: 'error' }]);
  } finally { globalThis.fetch = original; }
});

test('deployment transactions, rollback, isolation, locking and forced SSH validation pass offline', () => {
  execFileSync('python3', [fileURLToPath(new URL('../../../deploy/release/test_release_deploy.py', import.meta.url))], { encoding: 'utf8', timeout: 30_000 });
});
