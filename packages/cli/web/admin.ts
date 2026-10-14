export {};
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let overview: any,
  fetching = false;
const number = (n: number = 0) => n.toLocaleString("zh-CN");
const bytes = (n: number = 0) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
    ? `${(n / 1024).toFixed(1)} KiB`
    : `${(n / 1048576).toFixed(1)} MiB`;
const text = (id: string, value: string | number) => {
  element(id).textContent = String(value);
};
function loginView() {
  overview = undefined;
  element("login").hidden = false;
  element("dashboard").hidden = true;
  element("logout").hidden = true;
}
async function api(path: string, body?: object) {
  const response = await fetch(`/admin/api/${path}`, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    loginView();
    throw new Error(
      path === "login"
        ? "密钥不正确，请检查后重试。"
        : "登录已过期，请重新输入管理密钥。"
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "请求过于频繁，请一分钟后重试。"
        : "暂时无法读取后台，请检查服务配置或稍后重试。"
    );
  return response.json();
}
function list(id: string, values: Array<[string, string]>) {
  const target = element(id);
  target.replaceChildren();
  for (const [label, value] of values) {
    const row = document.createElement("div");
    row.className = "dl-row";
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    target.append(row);
  }
}
function chart() {
  if (!overview) return;
  const canvas = element<HTMLCanvasElement>("chart"),
    ctx = canvas.getContext("2d")!;
  const metric = element<HTMLSelectElement>("metric").value;
  const metrics = overview.metrics,
    days = new Map<string, any>(metrics.days.map((row) => [row.day, row]));
  const today = new Date().toISOString().slice(0, 10),
    end = Date.parse(today),
    dates = Array.from({ length: 30 }, (_, i) =>
      new Date(end - (29 - i) * 86400000).toISOString().slice(0, 10)
    );
  const start = metrics.startedAt?.slice(0, 10);
  const values = dates.map((day) =>
    day < start || !start ? undefined : days.get(day)?.[metric] || 0
  );
  const max = Math.max(
    1,
    ...values.filter((n): n is number => n !== undefined)
  );
  const width = canvas.clientWidth,
    height = canvas.clientHeight,
    ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.scale(ratio, ratio);
  ctx.font = "12px sans-serif";
  const bottom = height - 55,
    column = (width - 64) / 30;
  for (let i = 0; i < 3; i++) {
    const y = 15 + ((bottom - 15) * i) / 2;
    ctx.strokeStyle = "#dce5eb";
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(width - 16, y);
    ctx.stroke();
    ctx.fillStyle = "#647886";
    ctx.fillText(
      new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(
        Math.round(max * (1 - i / 2))
      ),
      0,
      y + 4
    );
  }
  values.forEach((value, i) => {
    const x = 48 + (i + 0.2) * column;
    ctx.fillStyle = value === undefined ? "#dce5eb" : "#147b79";
    const h =
      value === undefined ? 2 : Math.max(2, (value / max) * (bottom - 15));
    ctx.fillRect(x, bottom - h, column * 0.6, h);
    if ((width < 500 ? [0, 14, 29] : [0, 7, 14, 21, 29]).includes(i)) {
      ctx.fillStyle = "#647886";
      ctx.textAlign = "center";
      ctx.fillText(dates[i].slice(5), 48 + (i + 0.5) * column, bottom + 23);
      ctx.textAlign = "left";
    }
  });
  ctx.fillStyle = "#647886";
  ctx.fillText("浅灰：采集前无数据", 48, height - 4);
}
function render(data) {
  overview = data;
  element("login").hidden = true;
  element("dashboard").hidden = false;
  element("logout").hidden = false;
  const { identities: ids, runtime, metrics } = data;
  const today =
    metrics.days.find(
      (row) => row.day === new Date().toISOString().slice(0, 10)
    ) || {};
  text("accounts", number(ids.accounts));
  text(
    "accounts-caption",
    `可用 ${number(ids.enabledAccounts)} · Agent ${number(ids.enabledAgents)}`
  );
  text("active-accounts", number(metrics.activity.accounts));
  text("active-agents", number(metrics.activity.agents));
  text(
    "activity-caption",
    `自 ${new Date(metrics.activity.since).toLocaleString("zh-CN")} 起`
  );
  text("meetings", number(today.meetings));
  text("rooms", number(runtime.activeRooms));
  text(
    "room-caption",
    `${runtime.rooms} 个保留房间 / 上限 ${runtime.maxMeetings}`
  );
  element<HTMLProgressElement>("room-progress").max = runtime.maxMeetings;
  element<HTMLProgressElement>("room-progress").value = runtime.rooms;
  text("pending", bytes(runtime.pendingBytes));
  text(
    "memory-caption",
    `中继占用 ${bytes(runtime.bytes)} / ${bytes(runtime.maxTotalBytes)}`
  );
  element<HTMLProgressElement>("memory-progress").max = runtime.maxTotalBytes;
  element<HTMLProgressElement>("memory-progress").value = runtime.bytes;
  const note = element("collection-note");
  note.className =
    metrics.status === "ok" && !metrics.dropped && !metrics.activity.truncated
      ? "notice"
      : "notice warning";
  note.textContent =
    metrics.status === "ok"
      ? `按 UTC 日统计；活跃量只覆盖本次启动以来的当日活动。汇总最多延迟 ${
          metrics.flushIntervalMs / 1000
        } 秒落盘，异常退出可能丢失未落盘部分。`
      : "统计存储暂不可用或正在初始化，当前数据可能不完整。通信服务继续运行。";
  if (metrics.dropped || metrics.activity.truncated)
    note.textContent +=
      " 已达到统计容量或发生数据丢失，请勿将当前数据视为完整统计。";
  list("delivery", [
    ["已确认保存", number(today.delivered)],
    ["保留期限到期", number(today.expired)],
    ["接收方不可用", number(today.unavailable)],
    ["游客加入次数", number(today.guestJoins)],
  ]);
  list("runtime", [
    ["今日业务请求", number(today.requests)],
    ["4xx / 5xx", `${number(today.errors4xx)} / ${number(today.errors5xx)}`],
    [
      "限流 / MCP 业务错误",
      `${number(today.limited)} / ${number(today.businessErrors)}`,
    ],
    [
      "平均响应时间",
      today.latencySamples
        ? `${Math.round(today.latencyMs / today.latencySamples)} ms`
        : "暂无样本",
    ],
    [
      "响应 <100 / <1000 / ≥1000 ms",
      `${number(today.latencyUnder100)} / ${number(
        today.latencyUnder1000
      )} / ${number(today.latencyOver1000)}`,
    ],
    [
      "进程内存 / 运行时长",
      `${bytes(runtime.memoryBytes)} / ${Math.floor(
        runtime.uptimeSeconds / 60
      )} min`,
    ],
    ["有效订阅", number(ids.subscriptions)],
    ["今日服务响应字节", bytes(ids.serviceResponseBytesToday)],
  ]);
  const table = element("history");
  table.replaceChildren();
  for (const row of metrics.days.slice(-30).reverse()) {
    const tr = document.createElement("tr");
    for (const value of [
      row.day,
      number(row.meetings),
      number(row.messages),
      number(row.joins),
      number(row.guestJoins),
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    table.append(tr);
  }
  if (!metrics.days.length) {
    const tr = document.createElement("tr"),
      td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "尚无使用数据。首次成功创建会议后开始记录。";
    tr.append(td);
    table.append(tr);
  }
  text("updated", `更新于 ${new Date().toLocaleTimeString("zh-CN")}`);
  text(
    "version",
    `NokNok ${data.version} · 开始采集：${
      metrics.startedAt || "初始化中"
    } · 汇总保留 ${metrics.retentionDays} 天`
  );
  chart();
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  element<HTMLButtonElement>("refresh").disabled = true;
  try {
    render(await api("overview"));
    text("error", "");
  } catch (error) {
    text("error", (error as Error).message);
    text("login-error", (error as Error).message);
  } finally {
    fetching = false;
    element<HTMLButtonElement>("refresh").disabled = false;
  }
}
element("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element<HTMLInputElement>("key"),
    button = element<HTMLButtonElement>("submit");
  button.disabled = true;
  text("login-error", "");
  try {
    await api("login", { key: input.value });
    input.value = "";
    await refresh();
  } catch (error) {
    text("login-error", (error as Error).message);
  } finally {
    input.value = "";
    button.disabled = false;
  }
});
element("logout").addEventListener("click", async () => {
  try {
    await api("logout", {});
    loginView();
    text("login-error", "");
  } catch (error) {
    text("error", (error as Error).message);
  }
});
element("refresh").addEventListener("click", refresh);
element("metric").addEventListener("change", chart);
window.addEventListener("resize", chart);
setInterval(() => {
  if (!document.hidden && overview)
    void api("overview")
      .then(render)
      .catch((error: Error) => {
        if (!error.message.includes("登录已过期"))
          text("login-error", error.message);
      });
}, 30000);
void api("overview")
  .then(render)
  .catch((error: Error) => {
    if (!error.message.includes("登录已过期"))
      text("login-error", error.message);
  });
