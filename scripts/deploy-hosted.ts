import { execFile } from 'node:child_process';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function deploymentConfig(env: NodeJS.ProcessEnv) {
  const version = env.NOKNOK_DEPLOY_VERSION || '';
  const host = env.NOKNOK_DEPLOY_HOST || '';
  const port = env.NOKNOK_DEPLOY_PORT || '22';
  const key = env.NOKNOK_DEPLOY_SSH_KEY || '';
  const knownHosts = env.NOKNOK_DEPLOY_KNOWN_HOSTS || '';
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) throw new Error('A canonical stable release version is required.');
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) || host.length > 253) throw new Error('NOKNOK_DEPLOY_HOST must be a hostname or IPv4 address.');
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Invalid deployment SSH port.');
  if (!key.includes('PRIVATE KEY-----') || !knownHosts.trim()) throw new Error('Deployment SSH key and pinned known_hosts secrets are required.');
  let origin: URL;
  try { origin = new URL(env.NOKNOK_PUBLIC_URL || ''); }
  catch { throw new Error('NOKNOK_PUBLIC_URL must be an HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('NOKNOK_PUBLIC_URL must be an HTTPS origin without credentials.');
  return { version, host, port, key, knownHosts, origin: origin.origin };
}

type Runner = (command: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<void>;
const run: Runner = (command, args, options) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, error => {
    // Never include command/environment contents in an error: they contain credentials.
    if (error) reject(new Error('Deployment SSH command failed; inspect the deployment job output.'));
    else resolve();
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
});

export async function deployHosted(env: NodeJS.ProcessEnv, dependencies: { run?: Runner; fetch?: typeof fetch } = {}) {
  const config = deploymentConfig(env);
  const directory = await mkdtemp(join(tmpdir(), 'noknok-deploy-'));
  try {
    await chmod(directory, 0o700);
    const keyPath = join(directory, 'identity');
    const knownHostsPath = join(directory, 'known_hosts');
    await writeFile(keyPath, config.key.trimEnd() + '\n', { mode: 0o600 });
    await writeFile(knownHostsPath, config.knownHosts.trimEnd() + '\n', { mode: 0o600 });
    await (dependencies.run || run)('ssh', [
      '-F', '/dev/null', '-T', '-i', keyPath, '-p', config.port,
      '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
      `noknok-deploy@${config.host}`, `deploy ${config.version}`,
    ], { timeout: 20 * 60_000, env: { PATH: env.PATH, HOME: env.HOME, LANG: 'C.UTF-8' } });
    const response = await (dependencies.fetch || fetch)(`${config.origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Public HTTPS health verification failed.');
    const health = await response.json() as { ok?: unknown; mode?: unknown; transcriptStorage?: unknown } | null;
    if (health?.ok !== true || health?.mode !== 'hosted' || health?.transcriptStorage !== 'memory') throw new Error('Public endpoint does not report a healthy hosted service.');
    return { version: config.version, origin: config.origin };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await deployHosted(process.env);
    console.log(`Deployed @noknok/cli@${result.version}; public HTTPS health check passed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Deployment failed.');
    process.exitCode = 1;
  }
}
