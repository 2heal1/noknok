import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fail } from './client.mjs';

const HANDLE = /^ap_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const unsafeProfile = () => fail('INVALID_AGENT_PROFILE', 'The selected managed Agent profile is invalid or uses a symbolic link. Use the original profile handle; do not adopt another Agent’s directory.');
const missingProfile = () => fail('AGENT_NOT_FOUND', 'Managed Agent profile not found. Reuse the exact --agent handle returned when this Agent was created, on the same computer and AGENTCALL_HOME.');

async function directoryInfo(path, { create = false, missing = missingProfile } = {}) {
  if (create) {
    try { await mkdir(path, { recursive: true, mode: 0o700 }); }
    catch (error) { if (['EEXIST', 'ENOTDIR'].includes(error.code)) throw unsafeProfile(); throw error; }
  }
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') throw missing(); throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw unsafeProfile();
}

async function loadManifest(directory, handle) {
  let file;
  try {
    const path = join(directory, 'profile.json');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw unsafeProfile();
    // Refuse a final symlink even if the file changes after the directory check.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) throw unsafeProfile();
    const manifest = JSON.parse(await file.readFile('utf8'));
    if (manifest?.v !== 1 || manifest.handle !== handle || typeof manifest.createdAt !== 'string'
      || !Number.isFinite(Date.parse(manifest.createdAt))) throw unsafeProfile();
    return manifest;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) throw unsafeProfile();
    throw error;
  } finally { await file?.close(); }
}

/** Resolve only an explicitly selected profile, or create a fresh isolated one. */
export async function resolveAgentProfile({ agent, stateDir, create = false, home = process.env.AGENTCALL_HOME || join(homedir(), '.agentcall') } = {}) {
  if (agent !== undefined && stateDir !== undefined) throw fail('INVALID_ARGUMENT', 'Use either --agent or --state-dir, not both.');
  if (stateDir !== undefined) {
    if (typeof stateDir !== 'string' || !stateDir.trim()) throw fail('INVALID_ARGUMENT', '--state-dir must name a local directory.');
    return { handle: undefined, directory: resolve(stateDir), created: false };
  }
  if (agent !== undefined && (typeof agent !== 'string' || !HANDLE.test(agent))) {
    throw fail('INVALID_ARGUMENT', 'Use the exact ap_... handle returned when this Agent profile was created.');
  }
  if (agent === undefined && !create) return undefined;
  if (typeof home !== 'string' || !home.trim()) throw fail('INVALID_ARGUMENT', 'AGENTCALL_HOME must name a local directory.');

  const base = resolve(home), profiles = join(base, 'profiles');
  // This module never enumerates existing profiles or guesses a shared default.
  await directoryInfo(base, { create: agent === undefined });
  await directoryInfo(profiles, { create: agent === undefined });
  if (agent !== undefined) {
    const directory = join(profiles, agent);
    await directoryInfo(directory);
    await loadManifest(directory, agent);
    return { handle: agent, directory, created: false };
  }

  const handle = `ap_${randomUUID()}`, directory = join(profiles, handle);
  await mkdir(directory, { mode: 0o700 });
  const temporary = join(directory, `.profile-${randomUUID()}.tmp`);
  try {
    const manifest = { v: 1, handle, createdAt: new Date().toISOString() };
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'profile.json'));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
  return { handle, directory, created: true };
}
