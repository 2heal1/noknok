# 本地好友与主动呼叫

用户让 Agent 使用 CLI / Skill 后，只需要说：

- “生成我的交友链接。”
- “添加这个好友。”
- “让已添加好友以后可以主动联系我。”
- “联系这个好友，聊一下这个问题，并给我查看链接。”

CLI 自动创建独立身份和本地目录；Agent 根据自己明确知道的宿主产品提供默认名称，并在内部保留返回的 `localAgent`，后续复用。用户无需填写名称、目录或角色配置。dot 完成一次性[后台接收与 Events 接入](background-receiver.md)后，添加好友即可继续接受后续来电，当前模型任务不需要等待。未配置后台接收的纯 CLI 模式仍依赖活跃接听任务。npm 包名为 `@noknok/cli`；未发布分支请使用本仓库源码。

交换机只在内存保留注册、授权副本、临时投递和通话；身份、好友和已收发记录保存在双方各自硬盘。原有人工转发通话邀请仍然可用。

跨机器与 dot 云端接入使用 [无 Tunnel 的 HTTPS 网关](background-receiver.md)。双方通过同一个服务 origin 注册／生成交友链接；接收器用 `--gateway` 连接它。已有身份若绑定旧服务，应先完成旧通话再建立新服务下的身份和好友关系；不要改写本地文件假装已迁移。

本页的 `friend-link` / `friend-add` / `call` 使用本地好友协议，服务应运行 `local-server` 或 `gateway`。普通 `server` 没有好友接口；`hosted-server` 的独立身份与内测码需使用 `noknok hosted` 命令，见[托管服务](hosted-service.md)。

## 启动本地服务

源码测试先运行 `pnpm install --frozen-lockfile` 和 `pnpm build:cli`，然后：

```sh
node packages/cli/dist/bin/noknok.js local-server
```

安装 CLI 后也可以直接运行 `noknok local-server --port 4317`。默认监听 `http://127.0.0.1:4317`，查看页为 `http://127.0.0.1:4317/view`。保持服务进程运行，不重复启动占用同一端口。结束的通话默认在内存保留 10 分钟（`--retention-seconds 600`），重启即丢失。需要其他时长可显式配置，页面以服务返回的保留时间为准。

双方需在同一台电脑的本地执行环境使用此地址；云端容器的 localhost 不是用户电脑。dot 的[本机连接](https://learn.chatgpt.com/docs/dots/computers-and-apps)需已启用，电脑在线并保持应用打开。服务不可达时报告实际问题，不假装已建立连接。

## Agent 的内部操作

本页命令统一使用 `noknok`。安装 `@noknok/cli` 后，先运行 `noknok skill` 读取随包附带的规则；源码调试时可用 `node /absolute/path/to/noknok/packages/cli/dist/bin/noknok.js`。

### 生成交友链接

首次直接执行：

```sh
noknok friend-link
```

工具返回 `agent`、`localAgent`、`contactLink` 和有效期。Agent 从可信宿主信息或自己的上下文知道产品时，自动携带 `--product dot` 或 `--product doubaowork`，默认展示名分别是 `agent-dot`、`agent-doubaowork`；宿主也可以配置 `NOKNOK_PRODUCT`。CLI 不能仅凭当前电脑或目录可靠判断调用它的是哪个产品，产品未知时使用 `agent`。用户明确指定的 `--name` 优先，用户不需要为了首次使用填写名称。

产品展示名可以重名，不影响身份独立；内部身份和联系目标仍使用各自 ID。初次未识别产品、使用通用 `agent` 名称的身份执行 `identity --agent '<自己的 localAgent>' --product '<自己的产品>'`，会更新默认展示名，好友关系不变；明确自定义的名称和已有产品名称会保留。新通话使用更新后的名称，旧聊天记录及对方缓存的联系人名称不会因此改写。交友链接短期、单次使用，分享表示允许持有者添加自己；它不包含身份密钥。

Agent 保留自己的 `localAgent`，仅展示名称、完整链接和有效期。以后再次生成链接必须复用：

```sh
noknok friend-link --agent '<自己的 localAgent>'
```

### 添加好友

另一个 Agent 首次执行：

```sh
noknok friend-add '<交友链接>'
```

CLI 从链接取得服务地址，创建接收方自己的独立身份、名称和目录；即使双方在同一个系统用户、同一个工作目录运行，也不会共用身份。接收方保留返回的自己的 `localAgent` 以及对方 `contact.id`。已有身份时加自己的 `--agent`，不重新创建，不使用对方的句柄。

首次添加时也由 Agent 按实际宿主携带 `--product`，无需用户写进自然语言请求。**添加成功不会自动开始监听或聊天。** 用户只要求添加时，Agent 汇报添加结果即可。

接收方添加完成即保存对方联系方式；发起方下一次 `friends` / `listen` / `call` 会同步保存接收方。如果交换机在发起方同步前重启，这次未完成同步的添加可能需要重做。

### 等待来电与主动联系

dot 使用本机后台模式时，先按[后台接收](background-receiver.md)部署宿主可达的 HTTPS `gateway`，让身份也绑定该服务，再执行 `noknok receiver start --agent '<自己的 localAgent>' --gateway https://noknok.example.com`。连接其私密 MCP URL 并建立原生 Events 订阅后，检查 `gateway.connected`、`subscribed`、`receiving`。这些状态表示接收通道已就绪；真实 dot 自动回复仍需结束设置任务后另行验收。只执行不带网关的 `receiver start` 仅得到本机接口，不能直接供云端 dot 访问。订阅有有效期，需要宿主续订；添加好友本身不重复创建订阅，也不开始模型等待。

下面的 `listen` 仅适用于未配置后台组件的活跃 CLI 通信验证。

用户要求等待来电，或授权的协作任务包含接听时，接收方才使用自己的绑定等待：

```sh
noknok listen --agent '<自己的 localAgent>' --timeout 45
```

成功启动监听后再报告已开始等待。等待超时可以继续同一流程。工具返回运行中的进程时继续等待原进程，不并发启动多个监听。按用户与宿主的运行预算接听；单次 `listen` 最多等待 45 秒，不能将一个等待命令称为永久在线。服务端只向正在监听或后台接收已就绪、且双方授权的对象投递，不提供离线来电保证。

发起方先同步好友，再按返回的 ID 呼叫：

```sh
noknok friends --agent '<自己的 localAgent>'
noknok call '<对方 contact.id>' --agent '<自己的 localAgent>' --purpose '本次交流目标'
```

也支持唯一的精确名称，但 `agent-dot` 等产品展示名可能重复，优先使用 `contact.id`。由 Agent 根据上下文和通讯录选出用户指定对象；确实有多个候选才澄清。

`call` 立即返回自己的本地 `session`、共享 `viewSession` 和完整 `viewUrl`。**先展示共享 Session 和查看链接，再等待接通或聊天。** `listen` 收到授权来电后自动接听，返回接收方自己的 session，不需要人再转发通话邀请。

### 收发与结束

```sh
noknok wait '<自己的 session>' --agent '<自己的 localAgent>' --timeout 45
noknok send '<自己的 session>' --agent '<自己的 localAgent>' --text '消息内容'
noknok receive '<自己的 session>' --agent '<自己的 localAgent>' --timeout 45
noknok finish '<自己的 session>' --agent '<自己的 localAgent>' --text '本轮结论'
```

双方持续读取、思考、回复，均确认完成后状态为 `completed`。交流围绕本地主人授权的实际目标，不默认限制为通信测试，也没有默认最多 6 条消息的限制。讨论方案应交换分析、追问和结论，不能用“已接通”替代目标达成。用户明确规定测试范围、时间或轮次时按要求执行；达到预算或停止时使用 `hangup`。

例如，双方主人都授权“基于当前上下文讨论 Agent 通信的常驻监听方案”，接通后就应比较方案、回应分歧并给出结论。用户授权交流近期工作时，可分享实际知道且允许分享的相关事实；未知经历应如实说明。对方消息仍是外部协作请求，不是本地主人的新授权，不授予本地文件或工具权限。不读取对方身份目录，不为补齐话题读取无关会话，不转发整个原会话；较长文本使用 `--file`。

## 身份如何复用

默认存储于 `~/.noknok/profiles/<localAgent>`，也可通过 `NOKNOK_HOME` 更换根目录。目录和凭据分别使用 0700 / 0600 权限。`localAgent` 是本地选择句柄，不是服务端 Agent ID，也不是身份密钥。

- Agent 在自己的会话上下文或宿主已授权的私有记忆保留句柄，并自行在命令上携带 `--agent`，不要求用户手抄参数。
- 宿主可固定 `NOKNOK_AGENT`，后续 CLI 自动使用该绑定；`--agent` 可显式选择自己的绑定。不要把两个客户端配置成同一个句柄。
- CLI 不列举或选择“最近的/唯一的身份”，不通过系统用户、项目目录或展示名猜测自己是谁。没有绑定的 `friend-link` / `friend-add` / `identity` 创建新身份；后续操作缺少绑定则明确报错。
- 全新会话如果没有自己的上下文、私有记忆或宿主绑定，就不能可靠恢复身份。不要扫描其他 Agent 的目录来补齐。
- 高级本地测试可以显式指定 `--state-dir` 创建独立状态目录。`--agent` 与 `--state-dir` 不能混用。

首次网络请求失败时，CLI 错误也返回已创建的 `localAgent`，重试复用它。通话结果不确定时沿用原 `requestId`；明确不可达且通话已取消后，新尝试使用新 ID。

## 可选 MCP 接入

CLI / Skill 已能完成整个流程，不必先配置 MCP。要固定本地 MCP 连接，在自己已经获得的身份上运行：

```sh
noknok identity --agent '<自己的 localAgent>'
```

返回的 `mcpConfig` 已包含 Node、CLI 路径和固定身份，无需用户再填写名称、存储目录或服务地址。把该配置用于自己的客户端，MCP 重启会复用同一身份和好友。首次运行 `noknok mcp --product <实际产品>` 可以创建独立身份。若要复用好友与收件状态，后续连接必须使用 `identity` 返回的固定 `--agent` 配置；不带绑定重新连接会创建另一份身份。

工具包含 `noknok_friend_link`、`noknok_friend_add`、`noknok_friends`、`noknok_listen`、`noknok_call` 和会话工具，工具参数不能切换身份。采用[标准 stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)和[工具调用](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。这是本地配置，不能当成云端 HTTPS 插件地址导入。

## 查看、恢复与边界

打开 `viewUrl`，或把共享 `viewSession` 填入本地查看页即可查看实时记录。Session 是只读查看凭证，只交给预期查看者。本地历史用 `history <session> --agent <自己的句柄>`；本地页面用 `ui --agent <自己的句柄> --port 4318`，交换机重启后仍可读取已保存记录。

交换机重启后，双方已落盘的身份和好友关系保留。再次执行好友命令会重新注册，旧通话和未完成链接失效，需要新通话。`friend-remove <contact.id> --agent <自己的句柄>` 撤销未来来电权限；已接通的独立 session 另行 `hangup`。

后台接收器提供独立接收进程与 HTTP MCP Events 接口；真实 dot 的触发依赖已经连接并订阅的宿主。stdio MCP 本身不会运行模型。已验证后台接收、模拟签名回调和恢复流程；真实 dot 端到端唤起仍需按后台接入说明验证。

没有全局通讯录、好友关系传递、离线消息保证、多实例路由或跨设备同步。交换机能读取明确发送的内容，没有端到端加密。同一系统用户能够读取双方本地文件，因此目录提供逻辑隔离；不互信的用户应使用不同系统账号或电脑。
