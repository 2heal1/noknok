import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sshConfig } from './deploy-hosted.ts';

export function docsRevision(value: string | undefined) {
  if (!value || !/^[a-f0-9]{40}$/.test(value)) throw new Error('A complete Git commit SHA is required.');
  return value;
}

async function main() {
  const revision = docsRevision(process.env.GITHUB_SHA);
  const config = sshConfig(process.env);
  const directory = await mkdtemp(join(tmpdir(), 'noknok-docs-'));
  try {
    await chmod(directory, 0o700);
    const identity = join(directory, 'identity');
    const hosts = join(directory, 'known_hosts');
    const archive = join(directory, 'site.tar.gz');
    await writeFile(identity, config.key.trimEnd() + '\n', { mode: 0o600 });
    await writeFile(hosts, config.knownHosts.trimEnd() + '\n', { mode: 0o600 });
    await promisify(execFile)('tar', ['--format=ustar', '-czf', archive, '-C', fileURLToPath(new URL('../apps/docs/doc_build/', import.meta.url)), '.'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, COPYFILE_DISABLE: '1' }, timeout: 60_000,
    });
    const child = spawn('ssh', ['-F', '/dev/null', '-T', '-i', identity, '-p', config.port,
      '-o', `UserKnownHostsFile=${hosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
      `noknok-docs@${config.host}`, `docs ${revision}`], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, timeout: 180_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const finished = new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Docs SSH could not start.')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Docs upload failed.')));
    });
    await Promise.all([pipeline(createReadStream(archive), child.stdin), finished]);
    const response = await fetch(`${config.origin}/_noknok_deployment.json`, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'Cache-Control': 'no-cache' } });
    const marker = response.ok ? await response.json() as { revision?: unknown } : null;
    if (marker?.revision !== revision) throw new Error('Public docs endpoint does not serve the uploaded revision.');
    const summary = `Docs deployed: ${config.origin} (${revision}); HTTPS revision verified.`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Docs deployment failed; inspect the fixed deployment output and DNS/HTTPS.'); process.exitCode = 1; });
}
