import { Worker } from "node:worker_threads";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";

export const METRICS = [
  "meetings",
  "joins",
  "guestJoins",
  "messages",
  "closed",
  "delivered",
  "expired",
  "unavailable",
  "requests",
  "errors4xx",
  "errors5xx",
  "limited",
  "businessErrors",
  "responseBytes",
  "latencyMs",
  "latencySamples",
  "latencyUnder100",
  "latencyUnder1000",
  "latencyOver1000",
] as const;
export type Metric = (typeof METRICS)[number];
type Batch = Array<[string, Metric, number]>;

export function createAdminMetrics(
  dataDir: string,
  intervalMs = 10000,
  now = Date.now
) {
  const processStartedAt = new Date(now()).toISOString();
  let day = processStartedAt.slice(0, 10),
    key = randomBytes(32);
  const accounts = new Set<string>(),
    agents = new Set<string>(),
    bindings = new Map<string, string>();
  const pending = new Map<string, number>();
  let inFlight: Batch | undefined,
    rows: Array<{ day: string; metric: Metric; count: number }> = [];
  let startedAt: string | undefined,
    ready = false,
    failed = false,
    truncated = false,
    dropped = 0;
  let completedFlushes = 0,
    closed = false;
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./admin-metrics-worker.ts"
        : "./admin-metrics-worker.js",
      import.meta.url
    ),
    {
      workerData: { path: join(dataDir, "metrics.sqlite") },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    }
  );
  worker.unref();
  function rollover() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      accounts.clear();
      agents.clear();
      truncated = false;
    }
  }
  function hash(id: string) {
    return createHmac("sha256", key).update(id).digest("base64url");
  }
  function record(metric: Metric, amount = 1) {
    if (
      closed ||
      !METRICS.includes(metric) ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    )
      return;
    rollover();
    const id = `${day}:${metric}`;
    if (!pending.has(id) && pending.size >= METRICS.length * 2) {
      dropped += amount;
      return;
    }
    pending.set(id, (pending.get(id) || 0) + amount);
  }
  function flush() {
    if (!ready || failed || inFlight || closed) return;
    inFlight = [...pending].map(([id, n]) => [
      id.slice(0, 10),
      id.slice(11) as Metric,
      n,
    ]);
    pending.clear();
    worker.postMessage({ batch: inFlight });
  }
  worker.on("message", (message) => {
    if (message.error) {
      failed = true;
      dropped += (inFlight || []).reduce((n, row) => n + row[2], 0);
      inFlight = undefined;
      return;
    }
    if (message.ready) {
      ready = true;
      flush();
      return;
    }
    rows = message.rows;
    startedAt = message.startedAt;
    inFlight = undefined;
    completedFlushes++;
  });
  worker.on("error", () => {
    failed = true;
  });
  worker.on("exit", () => {
    if (!closed) failed = true;
  });
  const timer = setInterval(flush, intervalMs);
  timer.unref();
  return {
    record,
    remember(actor: { accountId: string; agentId: string }) {
      rollover();
      const agent = hash(actor.agentId);
      if (bindings.has(agent)) return;
      if (bindings.size >= 100000) {
        truncated = true;
        return;
      }
      bindings.set(agent, hash(actor.accountId));
    },
    activity(agentId?: string) {
      if (!agentId) return;
      rollover();
      const agent = hash(agentId);
      if (agents.size >= 100000) {
        truncated = true;
        return;
      }
      agents.add(agent);
      const account = bindings.get(agent);
      if (account) accounts.add(account);
    },
    snapshot() {
      rollover();
      const days = new Map<string, Record<string, number>>();
      for (const { day, metric, count } of rows) {
        if (!days.has(day)) days.set(day, {});
        days.get(day)![metric] = count;
      }
      for (const [date, metric, count] of [
        ...(inFlight || []),
        ...[...pending].map(
          ([id, n]) =>
            [id.slice(0, 10), id.slice(11), n] as [string, string, number]
        ),
      ]) {
        if (!days.has(date)) days.set(date, {});
        days.get(date)![metric] = (days.get(date)![metric] || 0) + count;
      }
      return {
        startedAt,
        processStartedAt,
        timezone: "UTC",
        status: failed ? "unavailable" : !startedAt ? "starting" : "ok",
        dropped,
        retentionDays: 180,
        flushIntervalMs: intervalMs,
        activity: {
          since: new Date(
            Math.max(Date.parse(processStartedAt), Date.parse(day))
          ).toISOString(),
          accounts: accounts.size,
          agents: agents.size,
          truncated,
        },
        days: [...days]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, counts]) => ({ day, ...counts })),
      };
    },
    flush,
    async close() {
      clearInterval(timer);
      // Bounded final flush. Storage failure must not delay service shutdown.
      const target = completedFlushes + (inFlight ? 2 : 1);
      const deadline = Date.now() + 500;
      while (!failed && completedFlushes < target && Date.now() < deadline) {
        flush();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      closed = true;
      bindings.clear();
      accounts.clear();
      agents.clear();
      key.fill(0);
      await worker.terminate();
    },
  };
}
