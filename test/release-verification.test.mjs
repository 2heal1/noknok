import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelease } from '../scripts/verify-npm-release.mjs';

const release = { name: '@noknok/cli', version: '0.0.0-preview-20261014052213', tag: 'preview' };
const visible = { name: release.name, version: release.version, 'dist-tags': { latest: '0.0.1', preview: release.version } };
const failure = code => Object.assign(new Error('Registry query failed.'), { code });

function clock() {
  let at = 0;
  const waits = [];
  return { now: () => at, sleep: async ms => { waits.push(ms); at += ms; }, waits };
}

test('verifies the exact published version and selected tag without changing latest', async () => {
  assert.equal((await verifyRelease({ ...release, read: async () => visible })).attempts, 1);
  assert.equal(visible['dist-tags'].latest, '0.0.1');
});

test('waits through version propagation and then tag propagation without publishing again', async () => {
  const time = clock();
  let attempts = 0;
  const result = await verifyRelease({ ...release, ...time, read: async () => {
    attempts++;
    if (attempts === 1) throw failure('E404');
    if (attempts === 2) return { ...visible, 'dist-tags': { latest: '0.0.1', preview: 'older-preview' } };
    return visible;
  } });
  assert.equal(result.attempts, 3);
  assert.deepEqual(time.waits, [2000, 4000]);
});

test('retries transient registry failures but stops within the configured deadline', async () => {
  const time = clock();
  await assert.rejects(verifyRelease({ ...release, ...time, timeoutMs: 5000, read: async () => { throw failure('ETIMEDOUT'); } }), /timed out.*publication may already have succeeded/);
  assert.equal(time.now(), 5000);
});

test('does not retry authentication or malformed registry responses', async () => {
  for (const error of [failure('E401'), failure('E403'), new Error('Invalid JSON')]) {
    const time = clock();
    await assert.rejects(verifyRelease({ ...release, ...time, read: async () => { throw error; } }), cause => cause === error);
    assert.deepEqual(time.waits, []);
  }
});

test('rejects metadata for the wrong package or version', async () => {
  for (const change of [{ name: '@other/cli' }, { version: '99.0.0' }]) {
    await assert.rejects(verifyRelease({ ...release, read: async () => ({ ...visible, ...change }) }), /identity does not match/);
  }
});

test('does not turn a mismatched dist-tag into success when the deadline expires', async () => {
  const time = clock();
  await assert.rejects(verifyRelease({ ...release, ...time, timeoutMs: 1, read: async () => ({ ...visible, 'dist-tags': { preview: 'older' } }) }), /timed out/);
});
