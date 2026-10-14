import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { startHostedService } from "../src/hosted-service.js";
import { createAdminMetrics } from "../src/admin-metrics.js";
import { generateKey, encryptText, contentAAD } from "../src/e2ee.js";
import { hostedDeploymentConfig } from "../src/deploy/hosted-server.js";

const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await condition()) return;
    await delay(20);
  }
  assert.fail("Condition did not become true");
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "noknok-admin-")),
    key = secret(),
    realm = "https://service.example";
  const service = await startHostedService({
    dataDir,
    port: 0,
    publicUrl: realm,
    adminKeyHash: hash(key),
    ...options,
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function request(path, body?, headers = {}) {
    return fetch(service.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login() {
    const result = await request(
      "/admin/api/login",
      { key },
      { Origin: realm }
    );
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie")!.split(";")[0];
  }
  async function register() {
    const account = await (
      await request("/v1/hosted/accounts", { requestId: secret() })
    ).json();
    const agent = await (
      await request(
        "/v1/hosted/agents",
        { requestId: secret() },
        { Authorization: `Bearer ${account.accountToken}` }
      )
    ).json();
    return { ...account, ...agent };
  }
  async function encryptedCreate(actor) {
    const key = generateKey(),
      id = randomUUID();
    const body = {
      name: "PRIVATE_DISPLAY_NAME",
      kind: "agent",
      requestId: secret(),
      retryToken: secret(),
      encryption: { v: 1, id },
      purpose: await encryptText(
        key,
        "PRIVATE_PURPOSE",
        contentAAD(id, "started", "system", "purpose")
      ),
      context: await encryptText(
        key,
        "PRIVATE_CONTEXT",
        contentAAD(id, "started", "system", "context")
      ),
    };
    const headers = { Authorization: `Bearer ${actor.agentToken}` };
    const response = await request("/v1/meetings", body, headers);
    assert.equal(response.status, 201);
    return { result: await response.json(), body, headers, key, id };
  }
  return {
    dataDir,
    key,
    realm,
    service,
    request,
    login,
    register,
    encryptedCreate,
  };
}

test("admin is disabled without configuration and produces no statistics files", async (t) => {
  const f = await fixture(t, { adminKeyHash: undefined });
  assert.equal((await f.request("/admin")).status, 404);
  assert.equal(
    (await f.request("/admin/api/login", { key: f.key }, { Origin: f.realm }))
      .status,
    404
  );
  await f.register();
  assert.ok(
    !(await readdir(f.dataDir)).some((name) => name.startsWith("metrics"))
  );
  assert.equal(
    hostedDeploymentConfig({ NOKNOK_ADMIN_KEY_HASH: "" }).adminKeyHash,
    undefined
  );
});

test("admin validates deployment configuration before opening the control database", async () => {
  await assert.rejects(
    startHostedService({
      dataDir: "/unused",
      publicUrl: "https://service.example",
      adminKeyHash: "password",
    }),
    /SHA-256/
  );
});

test("admin sessions enforce independent authentication, origin, cookie attributes and logout", async (t) => {
  const f = await fixture(t),
    actor = await f.register();
  assert.equal(
    (
      await f.request("/admin/api/overview", undefined, {
        Authorization: `Bearer ${actor.agentToken}`,
      })
    ).status,
    401
  );
  assert.equal(
    (await f.request("/admin/api/login", { key: f.key })).status,
    403
  );
  assert.equal(
    (
      await f.request(
        "/admin/api/login",
        { key: f.key },
        { Origin: "https://evil.example" }
      )
    ).status,
    403
  );
  assert.equal(
    (
      await f.request(
        "/admin/api/login",
        { key: secret() },
        { Origin: f.realm }
      )
    ).status,
    401
  );
  const login = await f.request(
    "/admin/api/login",
    { key: f.key },
    { Origin: f.realm }
  );
  const setCookie = login.headers.get("set-cookie")!;
  for (const flag of [
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/admin",
    "Max-Age=1800",
  ])
    assert.ok(setCookie.includes(flag));
  assert.ok(!setCookie.includes(f.key));
  const Cookie = setCookie.split(";")[0];
  assert.equal(
    (await f.request("/admin/api/overview", undefined, { Cookie })).status,
    200
  );
  assert.equal(
    (
      await f.request("/admin/api/overview", undefined, {
        Cookie,
        Origin: "https://evil.example",
      })
    ).status,
    403
  );
  assert.equal(
    (await f.request("/admin/api/overview?key=anything", undefined, { Cookie }))
      .status,
    404
  );
  assert.equal(
    (await f.request("/admin/api/logout", {}, { Cookie })).status,
    403
  );
  assert.equal(
    (await f.request("/admin/api/logout", {}, { Cookie, Origin: f.realm }))
      .status,
    200
  );
  assert.equal(
    (await f.request("/admin/api/overview", undefined, { Cookie })).status,
    401
  );
  // Browser admin sessions never grant ordinary hosted permissions.
  assert.equal(
    (
      await f.request(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { Cookie }
      )
    ).status,
    401
  );
});

test("admin login is globally bounded and responses never disclose the configured digest", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await f.request(
          "/admin/api/login",
          { key: secret() },
          { Origin: f.realm }
        )
      ).status,
      401
    );
  const result = await f.request(
    "/admin/api/login",
    { key: f.key },
    { Origin: f.realm }
  );
  assert.equal(result.status, 429);
  assert.equal(result.headers.get("retry-after"), "60");
  assert.ok(!(await result.text()).includes(hash(f.key)));
  const page = await f.request("/admin");
  assert.ok(
    page.headers.get("content-security-policy")!.includes("script-src 'self'")
  );
  assert.ok(!(await page.text()).includes(f.key));
});

test("successful events count once across retries; private fields and IDs never enter statistics", async (t) => {
  const f = await fixture(t),
    actor = await f.register(),
    created = await f.encryptedCreate(actor),
    Cookie = await f.login();
  assert.equal(
    (await f.request("/v1/meetings", created.body, created.headers)).status,
    200
  );
  const joinBody = {
    name: "PRIVATE_GUEST",
    kind: "human",
    token: created.result.invitationUrl.split("invite=")[1]?.split("&")[0],
    requestId: secret(),
    retryToken: secret(),
  };
  joinBody.token = new URLSearchParams(
    new URL(created.result.invitationUrl).hash.slice(1)
  ).get("invite")!;
  const path = `/v1/meetings/${created.result.meeting.id}/join`;
  assert.equal((await f.request(path, joinBody)).status, 200);
  assert.equal((await f.request(path, joinBody)).status, 200);
  const message = {
    text: await encryptText(
      created.key,
      "PRIVATE_MESSAGE",
      contentAAD(created.id, "message", created.result.participant.id, "text")
    ),
    requestId: secret(),
  };
  const tokenHeaders = {
    Authorization: `Bearer ${created.result.participant.token}`,
  };
  const messagePath = `/v1/meetings/${created.result.meeting.id}/messages`;
  assert.equal(
    (await f.request(messagePath, message, tokenHeaders)).status,
    200
  );
  assert.equal(
    (await f.request(messagePath, message, tokenHeaders)).status,
    200
  );
  assert.equal(
    (await f.request(messagePath, { text: "plaintext" }, tokenHeaders)).status,
    400
  );
  const stats = await (
    await f.request("/admin/api/overview", undefined, { Cookie })
  ).json();
  const today = stats.metrics.days.find(
    (row) => row.day === new Date().toISOString().slice(0, 10)
  );
  assert.equal(today.meetings, 1);
  assert.equal(today.joins, 1);
  assert.equal(today.guestJoins, 1);
  assert.equal(today.messages, 1);
  assert.equal(stats.metrics.activity.accounts, 1);
  assert.equal(stats.metrics.activity.agents, 1);
  assert.equal(stats.runtime.activeRooms, 1);
  const serialized = JSON.stringify(stats);
  for (const value of [
    "PRIVATE_",
    actor.accountId,
    actor.agentId,
    actor.agentToken,
    f.key,
    created.result.meeting.id,
  ])
    assert.ok(!serialized.includes(value), value);
  await f.service.close();
  const bytes = await readFile(join(f.dataDir, "metrics.sqlite"));
  for (const value of [
    "PRIVATE_",
    actor.accountId,
    actor.agentId,
    actor.agentToken,
    f.key,
    created.result.meeting.id,
    created.body.purpose,
  ])
    assert.ok(!bytes.includes(value), value);
  const restarted = await startHostedService({
    dataDir: f.dataDir,
    publicUrl: f.realm,
    port: 0,
    adminKeyHash: hash(f.key),
  });
  t.after(() => restarted.close());
  const login = await fetch(restarted.origin + "/admin/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: f.realm },
    body: JSON.stringify({ key: f.key }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await until(
    async () =>
      (
        await (
          await fetch(restarted.origin + "/admin/api/overview", {
            headers: { Cookie: cookie },
          })
        ).json()
      ).metrics.status === "ok"
  );
  const after = await (
    await fetch(restarted.origin + "/admin/api/overview", {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(
    after.metrics.days.find((row) => row.day === today.day).meetings,
    1
  );
  assert.equal(after.metrics.activity.accounts, 0);
  assert.equal(after.metrics.activity.agents, 0);
  assert.equal(
    (
      await fetch(restarted.origin + "/admin/api/overview", {
        headers: { Cookie },
      })
    ).status,
    401
  );
});

test("statistics storage failure does not prevent registration or encrypted communication", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "noknok-broken-metrics-"));
  await mkdir(join(dataDir, "metrics.sqlite"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const f = await fixture(t, { dataDir }),
    Cookie = await f.login();
  await until(
    async () =>
      (
        await (
          await f.request("/admin/api/overview", undefined, { Cookie })
        ).json()
      ).metrics.status === "unavailable"
  );
  const actor = await f.register();
  await f.encryptedCreate(actor);
  assert.equal((await f.request("/health")).status, 200);
});

test("SQLite lock stays in the worker; bounded aggregates and retention remain correct", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "noknok-metrics-worker-"));
  const metrics = createAdminMetrics(dataDir, 20);
  t.after(async () => {
    await metrics.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await until(() => metrics.snapshot().status === "ok");
  const db = new DatabaseSync(join(dataDir, "metrics.sqlite"));
  t.after(() => db.close());
  db.prepare("INSERT INTO daily VALUES (?,?,?)").run(
    "2000-01-01",
    "meetings",
    99
  );
  db.exec("BEGIN EXCLUSIVE");
  metrics.record("meetings");
  const before = performance.now();
  await delay(30);
  assert.ok(
    performance.now() - before < 90,
    "worker lock must not stall the main event loop"
  );
  db.exec("ROLLBACK");
  await until(() => metrics.snapshot().days.some((row) => row.meetings === 1));
  await delay(80);
  assert.equal(
    db.prepare("SELECT count(*) n FROM daily WHERE day=?").get("2000-01-01")!.n,
    0
  );
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info(daily)")
      .all()
      .map((row) => row.name),
    ["day", "metric", "count"]
  );
});

test("active deduplication resets at UTC midnight while existing authenticated bindings still work", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "noknok-midnight-"));
  let now = Date.parse(new Date().toISOString().slice(0, 10)) + 86399000;
  const metrics = createAdminMetrics(dataDir, 10000, () => now);
  t.after(async () => {
    await metrics.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  metrics.remember({ accountId: "test-account", agentId: "test-agent" });
  metrics.activity("test-agent");
  metrics.activity("test-agent");
  assert.equal(metrics.snapshot().activity.accounts, 1);
  assert.equal(metrics.snapshot().activity.agents, 1);
  now += 2000;
  assert.equal(metrics.snapshot().activity.agents, 0);
  metrics.activity("test-agent");
  assert.equal(metrics.snapshot().activity.accounts, 1);
  assert.equal(metrics.snapshot().activity.agents, 1);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes("test-agent"));
});

test("admin responses have a separate budget and cannot exhaust communication egress", async (t) => {
  const f = await fixture(t);
  const Cookie = await f.login();
  f.service.store.consumeServiceQuota("admin_egress_bytes", {
    limit: 64 * 1024 * 1024,
    amount: 64 * 1024 * 1024 - Number(f.service.store.db.prepare("SELECT count FROM quotas WHERE owner='service' AND bucket='admin_egress_bytes'").get()!.count),
    windowMs: 86400000,
  });
  assert.equal(
    (await f.request("/admin/api/overview", undefined, { Cookie })).status,
    429
  );
  assert.equal((await f.request("/health")).status, 200);
  await f.encryptedCreate(await f.register());
});
