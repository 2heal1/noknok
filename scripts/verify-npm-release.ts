import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const RETRYABLE = new Set(['E404', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'FETCH_ERROR']);

interface RegistryQuery { name: string; version: string; timeoutMs: number }
interface RegistryMetadata { name: string; version: string; 'dist-tags'?: Record<string, string> }
interface VerifyOptions {
  name: string; version: string; tag: string; timeoutMs?: number;
  read?: (query: RegistryQuery) => Promise<RegistryMetadata>;
  now?: () => number; sleep?: (ms: number) => Promise<unknown>; report?: (line: string) => void;
}
async function readRegistry({ name, version, timeoutMs }: RegistryQuery): Promise<RegistryMetadata> {
  let stdout;
  try {
    ({ stdout } = await exec('npm', ['view', `${name}@${version}`, 'name', 'version', 'dist-tags', '--json', `--registry=${REGISTRY}`, '--prefer-online', '--fetch-retries=0', '--logs-max=0'], {
      timeout: timeoutMs, maxBuffer: 1024 * 1024,
    }));
  } catch (cause) {
    let code = cause.killed ? 'ETIMEDOUT' : cause.code;
    try { code = JSON.parse(cause.stdout).error?.code || code; } catch {}
    // Do not expose npm stderr, which may contain local configuration details.
    const error = new Error('Registry query failed.');
    Object.assign(error, { code });
    throw error;
  }
  try { return JSON.parse(stdout); }
  catch { throw new Error('Registry returned invalid JSON.'); }
}

export async function verifyRelease({ name, version, tag, timeoutMs = 300_000, read = readRegistry, now = () => performance.now(), sleep = delay, report = () => {} }: VerifyOptions) {
  if (name !== '@noknok/cli' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !['latest', 'preview'].includes(tag)) throw new Error('Invalid release identity or tag.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid verification timeout.');
  const deadline = now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const metadata = await read({ name, version, timeoutMs: Math.max(1, Math.min(20_000, deadline - now())) });
      if (metadata?.name !== name || metadata?.version !== version) throw new Error('Registry package identity does not match the release.');
      if (metadata['dist-tags']?.[tag] === version) return { name, version, tag, attempts };
    } catch (error) {
      if (!RETRYABLE.has(error.code)) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Registry verification timed out for ${name}@${version} (${tag}); publication may already have succeeded. Check npm before retrying a publish.`);
    const waitMs = Math.min(remaining, 2000 * 2 ** Math.min(attempts - 1, 4), 30_000);
    report(`Waiting for npm metadata for ${name}@${version} (${tag}); retrying in ${Math.ceil(waitMs / 1000)}s.`);
    await sleep(waitMs);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: pnpm exec tsx scripts/verify-npm-release.ts <latest|preview>');
    const { name, version } = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
    const result = await verifyRelease({ name, version, tag: process.argv[2], report: line => console.log(line) });
    console.log(`Verified npm release: ${result.name}@${result.version} (${result.tag}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
