import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startRelay } from '../relay.js';

interface DeploymentOptions { env?: NodeJS.ProcessEnv; port?: number; host?: string }

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number) {
  const value = env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return Number(value);
}

export function deploymentConfig(env = process.env) {
  if (!env.NOKNOK_PUBLIC_URL) {
    throw new Error('Set NOKNOK_PUBLIC_URL to the reachable service origin (an internal address is supported).');
  }
  return {
    port: integer(env, 'PORT', 8080, 65535),
    publicUrl: env.NOKNOK_PUBLIC_URL,
    retentionMs: integer(env, 'NOKNOK_RETENTION_SECONDS', 600, 604_800) * 1000,
    meetingTtlMs: integer(env, 'NOKNOK_MEETING_TTL_SECONDS', 7200, 604_800) * 1000,
    maxMeetings: integer(env, 'NOKNOK_MAX_MEETINGS', 50, 1000),
    serverKey: env.NOKNOK_SERVER_KEY || undefined,
  };
}

/** Expose the encrypted meeting relay on one HTTP listener. */
export async function startDeployment({ env = process.env, port, host = '::' }: DeploymentOptions = {}) {
  const config = deploymentConfig(env);
  const relay = await startRelay({ ...config, port: port ?? config.port, host });
  const address = relay.server.address() as AddressInfo;
  const accessibleHost = host === '::' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return {
    url: relay.url,
    origin: `http://${accessibleHost}:${address.port}`,
    port: address.port,
    close: relay.close,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startDeployment();
  process.stdout.write(`${JSON.stringify({ event: 'relay_listening', url: app.url, port: app.port, storage: 'memory' })}\n`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000).unref();
    await app.close();
    clearTimeout(deadline);
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
