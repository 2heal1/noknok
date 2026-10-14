import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveAgentProfile } from '../src/profiles.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, home: join(directory, 'home') };
}

test('fresh managed profiles stay separate in the same home and working directory', async t => {
  const { home } = await fixture(t);
  const [first, second] = await Promise.all([
    resolveAgentProfile({ home, create: true }), resolveAgentProfile({ home, create: true }),
  ]);
  assert.match(first.handle, /^ap_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first.handle, second.handle);
  assert.notEqual(first.directory, second.directory);
  assert.equal(first.directory, join(home, 'profiles', first.handle));
  assert.equal(first.created, true);
  const manifest = JSON.parse(await readFile(join(first.directory, 'profile.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['createdAt', 'handle', 'v']);
  assert.equal(manifest.handle, first.handle);
  assert.equal(manifest.v, 1);
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
  assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(first.directory, 'profile.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(first.directory), ['profile.json']);
});

test('explicit handles reuse a profile without modifying its files or selecting a neighbor', async t => {
  const { home } = await fixture(t);
  const first = await resolveAgentProfile({ home, create: true });
  await resolveAgentProfile({ home, create: true });
  const manifestPath = join(first.directory, 'profile.json');
  const before = await stat(manifestPath);
  const manifest = await readFile(manifestPath, 'utf8');
  const existing = await resolveAgentProfile({ home, agent: first.handle, create: true });
  assert.deepEqual(existing, { ...first, created: false });
  assert.equal(await readFile(manifestPath, 'utf8'), manifest);
  assert.equal((await stat(manifestPath)).mtimeMs, before.mtimeMs);
  assert.equal(await resolveAgentProfile({ home }), undefined);
  assert.equal((await readdir(join(home, 'profiles'))).length, 2);
});

test('no selector has no default or latest profile and does not create the home', async t => {
  const { home } = await fixture(t);
  assert.equal(await resolveAgentProfile({ home }), undefined);
  await assert.rejects(stat(home), { code: 'ENOENT' });
  await mkdir(home);
  await writeFile(join(home, 'contacts.json'), '{"token":"do-not-adopt"}');
  await writeFile(join(home, 'latest'), `ap_${randomUUID()}`);
  const fresh = await resolveAgentProfile({ home, create: true });
  assert.deepEqual(await readdir(fresh.directory), ['profile.json']);
  assert.equal(await resolveAgentProfile({ home }), undefined);
});

test('missing handles are never silently created, including with create enabled', async t => {
  const { home } = await fixture(t);
  const missing = `ap_${randomUUID()}`;
  await assert.rejects(resolveAgentProfile({ home, agent: missing, create: true }), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(stat(home), { code: 'ENOENT' });
  await resolveAgentProfile({ home, create: true });
  await assert.rejects(resolveAgentProfile({ home, agent: missing, create: true }), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(stat(join(home, 'profiles', missing)), { code: 'ENOENT' });
});

test('invalid handles, traversal, and conflicting selectors are rejected before filesystem mutation', async t => {
  const { home } = await fixture(t);
  for (const agent of ['', '..', '../other', 'ap_../../other', 'ap_00000000-0000-1000-8000-000000000000', 'ap_00000000-0000-4000-0000-000000000000', 1]) {
    await assert.rejects(resolveAgentProfile({ home, agent, create: true }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(resolveAgentProfile({ home, agent: `ap_${randomUUID()}`, stateDir: 'other' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('explicit legacy state directories are resolved without creation or managed metadata', async t => {
  const { directory, home } = await fixture(t);
  const stateDir = join(directory, 'explicit');
  assert.deepEqual(await resolveAgentProfile({ home, stateDir, create: true }), { handle: undefined, directory: resolve(stateDir), created: false });
  await assert.rejects(stat(stateDir), { code: 'ENOENT' });
  await assert.rejects(stat(home), { code: 'ENOENT' });
  await assert.rejects(resolveAgentProfile({ stateDir: '' }), { code: 'INVALID_ARGUMENT' });
});

test('managed profiles reject symlink directories and manifest files without following them', async t => {
  const { directory, home } = await fixture(t);
  const selected = await resolveAgentProfile({ home, create: true });
  const alias = `ap_${randomUUID()}`;
  await symlink(selected.directory, join(home, 'profiles', alias));
  await assert.rejects(resolveAgentProfile({ home, agent: alias }), { code: 'INVALID_AGENT_PROFILE' });
  const manifestPath = join(selected.directory, 'profile.json');
  const target = join(directory, 'external.json');
  const original = await readFile(manifestPath, 'utf8');
  await writeFile(target, original);
  await unlink(manifestPath);
  await symlink(target, manifestPath);
  await assert.rejects(resolveAgentProfile({ home, agent: selected.handle }), { code: 'INVALID_AGENT_PROFILE' });
  assert.equal(await readFile(target, 'utf8'), original);
});

test('profile manifests must match the selected handle and be valid regular files', async t => {
  const { home } = await fixture(t);
  const selected = await resolveAgentProfile({ home, create: true });
  const manifestPath = join(selected.directory, 'profile.json');
  for (const contents of ['{', '{}', JSON.stringify({ v: 1, handle: `ap_${randomUUID()}`, createdAt: new Date().toISOString() })]) {
    await writeFile(manifestPath, contents);
    await assert.rejects(resolveAgentProfile({ home, agent: selected.handle }), { code: 'INVALID_AGENT_PROFILE' });
  }
  await unlink(manifestPath);
  await assert.rejects(resolveAgentProfile({ home, agent: selected.handle }), { code: 'INVALID_AGENT_PROFILE' });
  await mkdir(manifestPath);
  await assert.rejects(resolveAgentProfile({ home, agent: selected.handle }), { code: 'INVALID_AGENT_PROFILE' });
});

test('managed profile roots cannot be symlinks or regular files', async t => {
  const { directory, home } = await fixture(t);
  const other = join(directory, 'other');
  await mkdir(other);
  await symlink(other, home);
  await assert.rejects(resolveAgentProfile({ home, create: true }), { code: 'INVALID_AGENT_PROFILE' });
  assert.deepEqual(await readdir(other), []);
  await unlink(home);
  await mkdir(home);
  await symlink(other, join(home, 'profiles'));
  await assert.rejects(resolveAgentProfile({ home, create: true }), { code: 'INVALID_AGENT_PROFILE' });
  assert.deepEqual(await readdir(other), []);
  await unlink(join(home, 'profiles'));
  await writeFile(join(home, 'profiles'), 'invalid');
  await assert.rejects(resolveAgentProfile({ home, create: true }), { code: 'INVALID_AGENT_PROFILE' });
});
