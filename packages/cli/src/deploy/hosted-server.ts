import type { HostedServiceOptions } from '../hosted-service.js';
import { startHostedService } from '../hosted-service.js';

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const value = env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new TypeError(`${key} must be between 1 and ${max}.`);
  return Number(value);
}

export function hostedDeploymentConfig(env: NodeJS.ProcessEnv = process.env): HostedServiceOptions {
  return {
    dataDir: env.NOKNOK_DATA_DIR, publicUrl: env.NOKNOK_PUBLIC_URL,
    port: integer(env, 'PORT', 4317, 65535),
    maxAccounts: integer(env, 'NOKNOK_MAX_ACCOUNTS', 10, 1000),
    maxAgentsPerAccount: integer(env, 'NOKNOK_MAX_AGENTS_PER_ACCOUNT', 2, 10),
    maxMeetings: integer(env, 'NOKNOK_MAX_MEETINGS', 5, 100),
    maxOwnerMeetings: integer(env, 'NOKNOK_MAX_OWNER_MEETINGS', 2, 10),
    maxParticipants: integer(env, 'NOKNOK_MAX_PARTICIPANTS', 8, 32),
    maxRoomBytes: integer(env, 'NOKNOK_MAX_ROOM_BYTES', 2 * 1024 * 1024, 8 * 1024 * 1024),
    maxTotalBytes: integer(env, 'NOKNOK_MAX_TOTAL_BYTES', 8 * 1024 * 1024, 128 * 1024 * 1024),
    maxDailyEgressBytes: integer(env, 'NOKNOK_MAX_DAILY_EGRESS_BYTES', 512 * 1024 * 1024, 10 * 1024 * 1024 * 1024),
    maxAccountDailyEgressBytes: integer(env, 'NOKNOK_MAX_ACCOUNT_DAILY_EGRESS_BYTES', 50 * 1024 * 1024, 1024 * 1024 * 1024),
    maxEvents: integer(env, 'NOKNOK_MAX_EVENTS', 500, 2000),
    meetingTtlMs: integer(env, 'NOKNOK_MEETING_TTL_SECONDS', 7200, 86400) * 1000,
    retentionMs: integer(env, 'NOKNOK_RETENTION_SECONDS', 600, 3600) * 1000,
  };
}

export async function startHostedDeployment(options: HostedServiceOptions & { env?: NodeJS.ProcessEnv } = {}) {
  const { env = process.env, ...overrides } = options;
  return startHostedService({ ...hostedDeploymentConfig(env), ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) });
}
