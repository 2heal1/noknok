# MCP Events 最小验证（实验）

这个独立 PoC 用两个固定身份 A / B 验证 MCP 工具与事件投递。它不修改现有 NokNok 交换机，不是完整通讯录或生产用认证服务。

**本地协议测试、公网可达、ChatGPT 实际识别、dot 自动回复是四项不同的结果。只有观察到 dot 收到事件后实际调用 `send_message` 才能确认自动回复；webhook 的 2xx 只确认收件。**

## 验证状态

当前仅提供可在本地重复运行的协议、合成消息和签名回调测试。实际公网入口、真实 dot 插件订阅及没有新人工输入时的自动回复仍未验证。状态文件和客户端配置由每个测试者在私有目录生成，不随仓库分发。

## 已实现的最小范围

- A / B 各有一个随机 256 位 capability URL，身份由 URL 绑定，不能靠参数冒充对方。
- `whoami`、`read_inbox`、`send_message` 三个工具。
- `agentcall.message.created` 事件，每个身份只能订阅自己的收件箱。
- `server/discover` 声明 `2026-07-28` 版本和 `tools/events` 能力；保留 `initialize` 入口。
- 回调 challenge 验证、Standard Webhooks HMAC 签名、订阅过期与取消、有限重试。
- 原子保存消息、订阅和投递状态；发送使用 `request_id` 幂等键。
- 只允许 `agentcall-poc: ping`、`agentcall-poc: pong`、`agentcall-poc: ack`，单条消息只能有一个回复，最多三条组成回复链，总消息数最多 100。

这两个 URL 都是凭据，保存在权限为 0600 的本地状态文件里，不应提交到 Git、日志、工单或截图。PoC 可在 ChatGPT 中使用 **No authentication** 配置，因为访问能力已经在随机 URL 内；这不是经过验证的用户身份，也不能用于真实业务。正式版应采用 OAuth 与明确的联系人授权。

## 启动和本地检查

Node.js 22+，无额外依赖：

```sh
npm run poc:mcp-events -- --state .agentcall-mcp-poc/live/state.json --port 8788
```

默认只监听 `127.0.0.1`。状态目录符合现有 `.gitignore` 规则。启动日志不包含身份 URL、回调 URL 或签名密钥。

在另一终端验证工具与事件发现：

```sh
node scripts/probe-mcp-events.mjs \
  --state .agentcall-mcp-poc/live/state.json \
  --server http://127.0.0.1:8788

node poc/mcp-events/status.mjs .agentcall-mcp-poc/live/state.json

node --test test/mcp-events-poc.test.mjs
```

probe 是普通合成测试客户端，输出始终标注 `dot_execution_verified: false`。它不自动回复消息，也不会把模拟器伪装成 dot。

## 接入通用部署入口

通用 `deploy/server.mjs` 入口可同时提供 relay/viewer 和实验 `/mcp/<token>`。仅在隔离测试环境启用，使用自己部署且宿主可达的 HTTPS origin。

| 环境变量 | 含义 |
| --- | --- |
| `AGENTCALL_MCP_POC_ENABLED=1` | 启用实验 MCP 路由；默认关闭 |
| `AGENTCALL_MCP_AGENT_A_TOKEN` | A 的 32 随机字节 base64url 凭据，43 字符 |
| `AGENTCALL_MCP_AGENT_B_TOKEN` | B 的独立凭据，格式同上，两者必须不同 |
| `AGENTCALL_MCP_STATE_PATH` | 状态文件路径，默认 `/tmp/agentcall-mcp-poc/state.json` |

两份凭据通过平台环境变量注入，不加入构建产物；已有状态与配置的身份不一致时启动失败，避免悄悄切换身份。临时盘重建时，环境变量可保留身份地址，但订阅和消息会丢失，需重新订阅。这是单实例开发验证配置，不能当作长期可靠存储。

两个独立测试客户端分别使用 A 和 B。工具可达只证明通信入口可访问，仍需观察真实宿主的订阅和自动回复。

## 接入真实 dot

1. 使用自己部署且宿主可访问的 HTTPS MCP 入口，不把 localhost 当成云端可达，不自行安装 Tunnel。仅访问成功不能证明 Events 已接通。
2. 在可信本机从 `state.json` 取得 `agents.A.token` / `agents.B.token`，分别组成 `https://<入口>/mcp/<对应 token>`。使用个人或工作区的 **Add custom MCP server** 创建测试插件，不需要公开上架。不要把状态文件本身上传。
3. 确认 ChatGPT 实际发现三个工具与 `agentcall.message.created`。本地发现测试不能证明 MCP 2.0 与当前 ChatGPT 客户端的完整兼容性。
4. 给 B 的 dot 安装身份 B 插件，然后发送下面的测试指令。确认服务端收到 `events/subscribe`，完成 callback verification，且状态检查显示 B 的订阅有效。
5. 先让测试客户端 A 发一个 ping，等待 B 的 dot 自动回 pong。之后才做两个独立 agent 的双向验证。

B 的测试指令：

```text
使用 NokNok PoC B 插件，先调用 whoami 确认你是 B。
订阅 agentcall.message.created，recipient_id 为 B。
只进行这个合成测试，不读取任何其他聊天、项目或个人资料。
收到来自 A 的 agentcall-poc: ping 后，用 read_inbox 读取消息，
调用 send_message 向 A 回复 agentcall-poc: pong；reply_to 使用原消息 ID，
request_id 固定为 reply_ 加原消息 ID，重试时保持一致。
每个 ping 只回复一次，收到 agentcall-poc: ack 后不要回复。
本次授权仅覆盖上述测试回复；测试结束后取消订阅。
```

在 **B 订阅成功后**，测试客户端 A 发起一次请求：

```sh
node scripts/probe-mcp-events.mjs \
  --state .agentcall-mcp-poc/live/state.json \
  --server https://<入口> \
  --send-ping
```

`--send-ping` 每次生成一个新的请求 ID，不要为催促回复反复执行。查看返回的 `message_id`，在本地状态中检查这个消息的投递和回复。

如果有第二个独立 dot，让它使用身份 A 插件并订阅自己的收件箱：收到 pong 时只发送一次 ack，附上对应 `reply_to` 和稳定的 `request_id`，随后停止。一个 dot 同时操作 A/B 两个插件、脚本模拟 B、或两个本地 callback 模拟器，都不能算“两边真实 dot 已接通”。

## 验收证据

| 阶段 | 成功证据 |
| --- | --- |
| MCP 发现 | 真实 ChatGPT 发来 discovery/list 请求，插件页显示工具和事件 |
| 订阅 | B 的订阅请求、challenge 验证及持久化记录 |
| 投递 | 指定 message/event ID 的 webhook 收到 2xx |
| B 自动回复 | 不再给 B 人工输入后，B 实际调用 send_message，pong.reply_to 指向 ping |
| 双方自动往返 | 第二个独立 agent 收到 pong 后调用工具回 ack，随后无新消息 |
| 停止 | 取消订阅后不再投递新事件；停止 PoC 服务 |

仅看到 pong 数据不足以证明它来自 dot；应同时保存 dot 的工具调用记录和服务端同一 message/request ID 的审计记录。对外报告时去掉 capability URL、callback URL 和签名密钥。

## 限制与恢复

- MCP Events 集成当前仅 webhook；这里不实现事件 replay cursor。消息应在订阅成功后发送，订阅前的消息可用 `read_inbox` 读取，但不会补发事件。
- 单进程 PoC，锁文件阻止两个进程覆盖状态。正常 SIGINT / SIGTERM 停机会释放锁；异常退出后先核实锁内 PID 已经停止，再删除对应 `.lock` 文件恢复，不能删除活跃进程的锁。
- 只调用经过 DNS 公网地址验证并固定目标 IP 的 HTTPS 回调；拒绝私网/本机地址和重定向。测试通过依赖注入模拟回调，生产 CLI 没有关闭此防护的开关。
- 临时公网隧道本身不能替代认证。只用于此合成 PoC，验证后停止。Cloudflare Quick Tunnel 不支持 SSE，本 PoC 使用短 HTTP JSON 响应。
- dot 的插件、事件和写工具权限取决于实际账号。不能用修改 `readOnlyHint` 的方式绕过发信审批，也不能用普通 Codex App Server 测试冒充 dot 事件唤起。

## 官方依据

- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Control your dot](https://learn.chatgpt.com/docs/dots/controls)
