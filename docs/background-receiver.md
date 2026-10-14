# 原生 dot 后台接收：无 Tunnel

NokNok 不运行一个新模型。用户现有的 dot 通过原生 MCP Events 接收通知，用自己的工具回应，或按主人授权建立原生工作任务。添加好友后任务可以结束；保持在线的是本机接收器，不是循环等待的模型。

## 架构与前提

- 公网 HTTPS 服务：内存交换机 + 限定的 MCP 业务入口，不保存联系人或聊天文件。
- 用户电脑：接收器向固定公网服务主动取通信操作；本机不开放公网端口，不使用 Tunnel。身份、通讯录、完整历史、订阅及签名密钥保存在自己的本机目录。
- dot：连接自身的私有 MCP URL，由宿主提供回调并保存 `agentcall.activity` 原生订阅。电脑上的接收器将签名事件直接发给该回调。

公网端仍能看到临时转发的业务数据和订阅请求，这不是端到端加密；被控制的公网端也能请求已有通信工具，但本机闭合协议拒绝任意 URL、路径、身份选择、shell 和其他 MCP 工具。详细边界见 [设计](native-agent-design.md)。

官方 [MCP Events](https://developers.openai.com/plugins/build/mcp-events) 支持 dots，要求 MCP 2.0 `2026-07-28`，使用宿主提供的 HTTPS webhook 和签名密钥；仅配置 stdio MCP、读取 Skill、建立好友关系或收到 HTTP 200，都不证明原生唤醒成功。[dot 的事件与任务能力](https://learn.chatgpt.com/docs/dots/tasks-and-memory)由宿主执行，NokNok 不代替宿主调度器。

## 部署公网入口

需要一个 dot 云端能直接访问的域名、服务器和 HTTPS 证书。内网服务不能未经可达性检查就当成公网入口。Node.js 22+；npm 包名为 `@noknok/cli`，未发布分支使用源码。

在自己的服务器取得本仓库，DNS A/AAAA 指向服务器，开放 80/443。服务器有 Docker Compose 时，在仓库根目录执行：

```sh
export AGENTCALL_DOMAIN=agentcall.example.com
docker compose -f deploy/compose.gateway.yaml up -d --build
curl --fail https://agentcall.example.com/health
```

Compose 只向公网开放 Caddy 的 80/443，内部 NokNok 没有映射宿主端口，也没有数据卷。Caddy 的卷只保存 TLS 证书配置。自动 HTTPS 的要求见 [Caddy 官方说明](https://caddyserver.com/docs/automatic-https)。配置不启用访问日志；仍需限制平台、代理错误日志的访问并避免其中记录完整 `/mcp/<凭据>`。私有插件 URL 是凭据，不能发给好友或公开。

自备 TLS 终止代理也可直接启动：

```sh
node bin/agentcall.mjs gateway --host 127.0.0.1 --port 4317 --public-url https://agentcall.example.com
```

将 HTTPS 请求转发到这个进程。`--public-url` 不创建证书或代理。若使用已有 `deploy/server.mjs` 容器入口，设置 `AGENTCALL_GATEWAY_ENABLED=1`、`AGENTCALL_MCP_POC_ENABLED=0`、`AGENTCALL_PUBLIC_URL=https://agentcall.example.com`；两种 MCP 模式不能同时启用。

可选的 `AGENTCALL_SERVER_KEY` 限制交换机创建通话和接收器登记，需在两端通过本机受控环境提供。MCP 仍用每个接收器不同的 URL 凭据。当前是私人验证用的凭据方案，没有面向多租户产品的 OAuth、配额计费或端到端加密。

本次环境没有 Docker/Caddy，因此尚未实测 Compose 构建和公网 TLS。HTTP 应用入口及对应隔离、恢复测试单独验证，不能代替公网部署验收。

## 配置 dot 一次，然后结束任务

1. dot 使用最新版源码 Skill，在自己的本地执行环境初始化或复用自身身份，服务指向上述 HTTPS origin。名称和目录由工具生成，无须用户填写。
2. 执行 `receiver start --agent '<自己的 localAgent>' --gateway https://agentcall.example.com`。返回自身的 `mcpUrl`；接收器独立于当前任务运行。
3. 在对应账号的自定义 MCP 插件设置中连接这个 `mcpUrl`。这个原型的鉴权在 URL 凭据内；设置页如要求选择认证方式，按其 URL 能力凭据方式配置，不再增加 Tunnel。保存入口需由可操作该账号插件设置的人或宿主完成。
4. dot 原生订阅 `agentcall.activity`，过滤参数 `{}`。回调和 secret 来自宿主。调用 `agentcall_inbox` 核对 `receiver.gateway.connected`、`receiver.subscribed`、`receiver.receiving` 都为 true，再结束设置任务。
5. 仅添加好友时立即返回。后续来电由接收器接听、保存活动、发送事件；dot 被唤醒后读取 inbox/history，按用户授权回应。

“已加入通话”证明后台接听成功，不证明 dot 模型处理过。真实验收要观察没有新人工输入时 dot 调工具发出实质回复。

## 可直接复制的提示词

替换服务地址；源码路径以实际安装位置为准。身份句柄、名称和目录由 Agent 自己管理，不让用户指定。

**给豆包工作：生成交友链接**

```text
读取 /absolute/path/to/noknok/skills/noknok/SKILL.md。
CLI 使用 node /absolute/path/to/noknok/bin/agentcall.mjs。
本次服务使用 https://agentcall.example.com。
请生成我的交友链接，自动使用你已知的产品名称并保留自己的身份绑定。
将交友链接给我。这里只生成链接，不等待来电。
```

**给 dot：添加好友并配置未来接收**

```text
读取 /absolute/path/to/noknok/skills/noknok/SKILL.md。
CLI 使用 node /absolute/path/to/noknok/bin/agentcall.mjs，
使用我的本机执行环境。本次服务是 https://agentcall.example.com。
添加这个好友：<豆包工作的交友链接>。
我授权这个好友今后通过 NokNok 联系你：在本机开启独立接收器，
使用 --gateway 连接上述服务。禁止配置 Tunnel。
如果尚未连接插件，给我自身的私有 mcpUrl 和一次性连接步骤。
插件连接后，请由宿主原生订阅 agentcall.activity，并检查接收状态。
收到来电时读取 inbox/history，在本次协作目标内给出实质回应。
需要执行工作的来电，可以使用你的原生任务能力创建可见的工作会话，
保留同一 NokNok session，把任务标识和查看链接回复给对方；不要重复建任务。
这份授权只覆盖好友协作，不允许外传秘密、无关文件或其他对话。
配置完成就结束当前任务，不运行 listen 或模型等待循环。
不要把模拟回调成功说成真实唤醒成功。
```

添加好友后如果插件尚未连好，完成一次性连接再给 dot：

```text
NokNok 的私有 MCP 插件已连接。请保存原生 agentcall.activity 事件监控，
沿用前面授权的好友协作规则，确认 gateway.connected、subscribed、receiving。
完成后结束当前设置任务。
```

**给豆包工作：稍后主动联系并验收**

```text
使用 NokNok 联系刚添加的 dot 好友。创建通话后立即给我共享 Session 和查看链接。
请与 dot 协作验证这个问题：对整数 1 到 100，直接求平方和与公式计算是否一致？
你负责直接求和，请 dot 建立一个原生工作任务独立计算公式结果，并返回任务标识。
双方交流各自证据和结果，核对后共同结束。使用你自己的身份和工具；
我不会再向 dot 人工发送“开始接听”。如果 dot 没有回复，准确报告未通过自动唤醒验收。
```

这个问题让双方有具体工作，而不是限制为仅做连通测试。看完一通，再隔一段时间发起另一通，验证不用重新要求 dot 等待。

## 状态、恢复与兜底

`receiver status --agent '<自己的 localAgent>'` 查询，`receiver stop` 暂停本机接收；取消 dot 订阅停止未来唤醒。仅 stop 不删除本地恢复数据，再 start 复用入口及未过期订阅。`backgroundRunning` 表示进程存在，`gateway.connected` 表示入口已登记，`subscribed` 表示有效订阅，`receiving` 表示接收就绪；`lastError`、`gateway.lastError` 和 `deliveries.failed` 显示传输异常。

`gateway.json` 保存外连配置及 owner 凭据；`receiver-state.json` 保存订阅、活动和投递状态；文件 0600。本机不安装开机服务，重启后需再次 start。公网服务重启丢失内存通话，接收器自动重新登记，新通话继续使用相同入口；旧查看链接不能保证恢复。已领取操作不自动重投，结果未知时先核对本地历史，写操作复用 request_id。

没有唤醒接口、没有公网入口或接收端不在线时，保留最早的 `invite → 人转发 invitationText → accept` 短会话。不要把其他原生产品的 MCP 工具支持等同于 dot 的事件支持。

验收依次检查：公网插件发现与真实订阅 → 设置任务结束后无人工输入的 dot 回复 → dot 建立可见原生任务 → 第二通来电 → 移除好友后拒绝新呼叫。自动化测试只覆盖协议和接收器，不能代替这些宿主行为。
