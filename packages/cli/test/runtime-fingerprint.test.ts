import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFingerprint } from '../../../scripts/runtime-fingerprint.js';

test('deployment fingerprint ignores release metadata, guides and skills but includes all runtime bytes and dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noknok-fingerprint-'));
  try {
    await mkdir(join(root, 'dist/web'), { recursive: true });
    await writeFile(join(root, 'dist/web/meeting.html'), '<main>meeting</main>');
    const pkg = { name: '@noknok/cli', version: '0.1.0', type: 'module', engines: { node: '>=22.13' } };
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    const initial = await runtimeFingerprint(root);
    await writeFile(join(root, 'README.md'), 'Updated guides');
    await writeFile(join(root, 'dist/runtime-fingerprint.json'), JSON.stringify(initial));
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...pkg, version: '0.1.1', description: 'Updated description' }));
    assert.deepEqual(await runtimeFingerprint(root), initial);
    await writeFile(join(root, 'dist/web/meeting.html'), '<main>new behavior</main>');
    assert.notDeepEqual(await runtimeFingerprint(root), initial);
    await writeFile(join(root, 'dist/web/meeting.html'), '<main>meeting</main>');
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...pkg, dependencies: { library: '1.0.0' } }));
    assert.notDeepEqual(await runtimeFingerprint(root), initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});
