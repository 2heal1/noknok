> 旧版两方通话/好友实验参考。新会议请使用 [当前说明](../README.md)。npm 包名为 `@noknok/noknok`，未发布分支使用源码。

# NokNok

通过一次性邀请，让两个 agent 在各自原会话中沟通、执行任务、询问各自的主人，并在双方确认后结束。交换机可以本地运行、私有部署或自行托管。

**当前版本：0.5.0。Node.js 22+，无第三方运行时依赖，不需要模型 API Key。** 模型和执行能力由双方已有的 agent 提供。默认使用 HTTP 长轮询；两端都主动连接交换机，不需要向对方暴露本地端口。

**源码新增：本地好友与后台接收。** 使用 `npm run start:local` 启动本地内存交换机。让 Agent 读取 Skill 后，直接说“生成交友链接”“添加这个好友”“联系好友”；Agent 提供已知产品名，CLI 自动生成 `agent-dot`、`agent-doubaowork` 等展示名及独立身份、目录。dot 完成一次性[后台接收与 MCP Events 接入](background-receiver.md)后，独立后台组件接听并保存消息，Events 通知宿主处理；当前模型任务可以结束，添加好友不再需要模型等待。呼叫立即返回 Session 和查看链接。操作见 [本地好友流程](local-contacts.md)。具体可用版本以 npm 发布记录为准；真实 dot 的事件触发需连接对应账号的 Events 插件并验证。

**源码新增：无 Tunnel 的公网通信入口。** `agentcall gateway` 同时提供内存交换机和绑定单个身份的 MCP 入口；本机接收器主动连接公网服务，只处理限定的通信操作。原生助手保留自己的模型与工具。详见 [设计与边界](native-agent-design.md)、[部署和 dot 验收提示词](background-receiver.md)。MCP 工具接入与后台唤醒是两种能力；本地模拟测试不代表真实 dot 已通过验收。

## CLI 和 Skill

在本仓库根目录使用源码，不需要从包源安装依赖：

```sh
node bin/noknok.mjs --help
node bin/noknok.mjs skill
node bin/noknok.mjs skill --path
```

`@noknok/noknok` 是 npm 包名，`noknok` 是 CLI 命令。使用已发布版本时可直接使用邀请中的指令；未发布版本须替换为接听方本地源码 CLI。`agentcall` 作为兼容命令别名，以下示例可替换为 `node /absolute/path/to/noknok/bin/noknok.mjs`。

默认服务是 `http://127.0.0.1:4317`。发起方需自行启动服务，跨机器时通过 `--server URL` 或 `AGENTCALL_SERVER` 使用双方可达的地址；接听端从邀请取得地址。优先级为命令行参数、环境变量、本机默认地址。用 `view <session>` 获取只读页面，示例域名 `relay.example.com` 不提供实际公共服务。

### 把短邀请转交给同事

让 A 读取 Skill 后，直接描述要交流的任务。A 会整理目标和必要背景，存入交换机，并展示包含查看地址的短邀请。复制给同事，同事直接粘贴到自己的 agent 会话即可：

```text
Alex's agent invites your agent to a conversation.
Open https://relay.example.com/invite/<callId>?key=<邀请凭证> for details and instructions.
Session: <callId>
View: https://relay.example.com/view#session=<callId>
```

链接返回纯文本，提供发起人、有效期、目标与背景、固定版本的 npx Skill 和接听命令。Skill 随 CLI 发布，不需要另外安装。读取链接不占接听名额或延长有效期；执行接听命令才加入。网页工具无法访问内网时，agent 可通过自己的本地终端读取链接。已接听或过期后，详情只显示状态。

已知主人的称呼时用 `--from 'Alex'` 提供；没有则显示匿名，不从系统账号或 Git 配置推断。`--name` 仍是 agent 的名称。邀请中的 `Session:` 是服务端共享通话编号，后续收发使用 CLI 返回的各自本地 `session`。

CLI 返回 `invitationUrl`、`viewSession`、`viewUrl` 和精简 `invitationText`；原始 `invitation` 字段继续保留，`accept` 同时支持新链接和旧格式。旧交换机未提供详情链接时，CLI 回退为完整邀请文本。不要转发整个 JSON 或本地身份文件。详情链接默认 5 分钟内可接听；Session / 查看链接在记录保留期间均可只读查看，只交给预期接收者。应用不缓存详情，但邀请 URL 查询凭证可能进入浏览器历史或平台访问日志，应在托管平台限制日志访问并配置脱敏。

## 可选：使用本机交换机测试两个 agent

下面演示自建本机服务的方式。默认没有运营中的公共交换机，需先启动服务。

### 1. 启动交换机

在本仓库目录执行，保持这个终端运行：

```sh
npm start
```

默认地址是 `http://127.0.0.1:4317`。不需要先执行 `npm install`。服务启动会打印 JSON，可通过 `http://127.0.0.1:4317/health` 检查。

### 2. 让 agent A 发起通话

在一个有终端执行能力的 agent 会话中粘贴下面的提示，**将 `/absolute/path/to/noknok` 换成此仓库的绝对路径**：

```text
读取 /absolute/path/to/noknok/skills/agentcall/SKILL.md 并按它操作。
CLI 使用 node /absolute/path/to/noknok/bin/agentcall.mjs。
这次使用自建交换机，发起邀请时加 --server http://127.0.0.1:4317。

请创建一通 NokNok，目标是与另一个 agent 完成一次协作测试。
准备一道需要对方执行一小段程序才能验证的问题，把必要背景放入通话。
立即把 invitationText 原文放进一个可复制代码块让我转交，然后等待对方接听，自动推进协作，
双方确认完成后结束并告诉我结果。
```

如果你已有真实任务，把“协作测试”替换成任务目标，agent 应自行整理已有背景，避免让你重新复述。

### 3. 把邀请交给 agent B

打开另一种 agent，或同一种 agent 的另一个独立会话，粘贴 A 展示的短邀请即可。详情中的 npx 指令只适用于已发布到公开 npm 的版本；若双方使用尚未发布的本地源码测试，让 B 使用自己的 `node /absolute/path/to/noknok/bin/agentcall.mjs` 替代详情中的 npx 前缀，并读取该源码内的 Skill。

邀请在创建后 **5 分钟**过期，且只能接入一名对方。接通后可以持续通话，默认连续 **2 小时没有业务消息**会过期；轮询不延长活跃时间。

两端应使用 CLI 返回的各自 **`session`**。即使两个 agent 使用同一个系统用户、同一个项目，也会获得不同的本地句柄。**共享的 `callId` 不能用来代替本地 `session`。**

第一版依赖双方会话仍可运行工具。CLI 收到消息会以工具结果交给当前 agent；它不能凭空唤醒已经结束的宿主会话。宿主若要求允许终端或网络访问，需要在各自工具权限内启用。代码不自动执行对方发来的命令。

用于验证宿主主动接收事件的独立实验见 [MCP Events 最小验证](mcp-events-poc.md)。该实验与现有邀请流程分开；本地协议测试通过不代表真实 dot 已被唤醒。

## 可选：安装 CLI 和 Skill

可以一直使用 `node /absolute/path/to/noknok/bin/agentcall.mjs`，不必修改全局配置。若希望直接输入 `agentcall`，在仓库目录运行：

```sh
npm install --global .
agentcall --help
```

若 npm 全局安装目录不可写，继续使用 `node` 加绝对路径即可。

可将 `skills/agentcall` 目录复制到所用 agent 的个人 Skills 目录；不同宿主的目录和加载时机不同。最省事的首次测试就是让 agent 直接读取上面的 `SKILL.md`，无需预先安装 Skill。

## 手动 CLI 测试

以下命令假设已全局安装 CLI；未安装时替换命令前缀即可。每条命令输出 JSON。

```sh
agentcall invite --from 'Alex' --name 'Agent A' --purpose '协作检查一个问题' --context '已知背景'
# 将 invitationText 转交对方，保存 A 的本地 session；viewUrl 可立即打开观看。
agentcall wait <A-session> --timeout 300

# 在另一个终端接听，并保存 B 的 session。
agentcall accept '<invitationUrl>' --name 'Agent B'
agentcall send <B-session> --type message --text '已接听，请继续。'

agentcall receive <A-session> --timeout 60
agentcall send <A-session> --type request --text '请验证这个假设……'
agentcall receive <B-session> --timeout 60
agentcall send <B-session> --type result --text '验证结果是……'
agentcall receive <A-session> --timeout 60

agentcall finish <A-session> --text '本方目标已完成，结论是……'
agentcall receive <B-session> --timeout 60
agentcall finish <B-session> --text '确认完成。'
agentcall receive <A-session> --timeout 60
```

`finish` 是完成提议；只有双方都确认才进入 `completed`。在确认期间发送新的业务消息会清除双方完成票，让讨论继续。取消使用 `hangup <session> --reason '原因'`，其状态是 `cancelled`。

消息类型：`message`、`request`、`result`、`progress`、`waiting_for_user`。需要主人补充时，先发 `waiting_for_user` 再在原会话提问，主人回复后继续使用原 session。

长文本或包含 shell 特殊字符的内容使用文件，避免拼接命令：

```sh
agentcall send <session> --type result --file /absolute/path/to/evidence.txt
agentcall invite --name 'Agent A' --purpose '排查问题' --context-file /absolute/path/to/context.txt
```

每条消息最多 32 KiB，初始背景最多 64 KiB；本版不提供文件上传，优先传递必要摘录。`--file -` 可从标准输入读取消息文本。

## 等待、恢复和查看记录

### 远程只读查看链接

在持有本地 session 的环境运行：

```sh
agentcall view ac_你的本地会话句柄
```

邀请中已经附上完整查看地址，无需接通后再获取。打开 `/view#session=<Session>`，或在 [内网查看页](https://relay.example.com/view) 输入邀请中的 Session，即可查看。等待时显示呼叫信号，实际接通后两端合拢一次，随后缩成状态提示，把空间留给双方消息；状态以交换机为准，减少动态效果的系统设置会关闭动画。

服务端 Session 是随机 UUID，同时也是只读查看凭据；知道它的人可在记录保留期间读取背景与消息，即使接听邀请已过期。Session 不能用于接听、发消息或挂断；查看不消费队列、推进本地游标或延长活跃时间。Session 放在 URL fragment，读取时通过 Authorization 请求，不开放全局通话列表。旧的 `#call=...&token=acv_...` 链接仍兼容。

`ac_...` 是 CLI 本地保存的句柄，不能直接填入远程查看页；应使用邀请中的共享 Session，或运行上述命令获取链接。只分享给预期接收者。当前服务端为单实例内存存储，重启会丢失记录。内网交换机配置为结束后保留 24 小时；自建 `agentcall server` 默认保留 10 分钟，可用 `--retention-seconds 86400` 改为 24 小时。页面会显示具体保留时间。本机历史仍可用下面的本地 UI 查看。

### 浏览器查看通话记录

在仓库目录运行：

```sh
npm run ui
```

打开 **http://127.0.0.1:4318**。也可以使用 `agentcall ui`，或 `node bin/agentcall.mjs ui`。交换机不需要同时运行，页面直接读取已有本地记录。

页面会将同一通话的发起端和接听端记录合并，按事件编号去重。双方消息以紫色和青色区分，通话列表默认收起；点击左上角列表图标打开列表，点击双方名称查看目标和背景，右上角搜索图标打开搜索与导出工具。可搜索通话/消息、筛选发言方、复制或下载对话。默认每 2 秒刷新，浏览较早消息时保留阅读位置。本地 UI 与内网查看页使用同一套布局。

自定义本地记录目录或页面端口：

```sh
agentcall ui --state-dir /absolute/path/to/records --port 4318
```

页面只监听本机回环地址，提供只读访问：不会向交换机收取消息、推进游标或更改已有记录，也不会将身份凭证送到浏览器。显示的是本地已保存的记录和最后观察到的状态，不表示对方此刻在线。不同机器上各自运行页面查看自己的记录；本版不会自动收集另一台机器的文件。

### CLI 等待与历史

- `invite` 立即返回，之后才调用 `wait`。避免创建邀请后就被一个阻塞脚本挡住，直到过期才显示邀请。
- `wait` 等接听，默认最多 300 秒；`receive` 等新消息，默认最多 60 秒。程序在内部长轮询，模型无需反复询问。
- 工具返回“进程仍运行”时，继续等待原进程，不要再启动第二个接收命令。宿主不支持长命令时，使用 `--timeout 45` 分段等待。
- `outcome: "timeout"` 只表示本次等待结束；以 `call.state` 判断通话是否仍可用。有效状态是 `waiting / connected / completed / cancelled / expired`。
- 收件游标和记录保存在本地；可以跨 CLI 进程继续。同一 session 同时只能运行一个 `wait/receive`。
- 收取消息后工具输出丢失时，先用 `history` 查看已保存的消息，不要盲目重复执行。
- 接听途中命令被中断时，可在相同本地目录用相同名称再次 `accept` 同一邀请。CLI 会复用预先保存的兑换编号；若已保存本地身份，则返回 `restored: true` 并保留原游标。换一个名称不会静默接管已有接听身份。
- 新版接听恢复不依赖详情页仍可读取，新旧邀请格式归一化为同一次兑换。升级前由 0.3.0 留下的未完成兑换，首次恢复需使用当时的原始邀请，以迁移旧本地记录；之后可切换格式。
- `--request-id` 可用于重试相同的发送操作；同一 ID、同一内容不会重复发送，不同内容会被拒绝。网络异常的 CLI 错误会给出对应 requestId。

```sh
agentcall status <session>
agentcall history <session>
agentcall sessions
```

默认本地目录为 `~/.agentcall`，可通过 `AGENTCALL_HOME` 或每条命令的 `--state-dir DIR` 指定。凭证文件在支持 POSIX 权限的系统上使用 `0600`，目录使用 `0700`；同一个系统用户仍可读这些文件，因此本机多 agent 测试的隔离是逻辑身份隔离。不同信任主体应使用各自系统账号/机器。

## 跨机器和私有部署

通用 Node 与 Docker 配置见 [部署说明](deployment.md)。服务提供交换机和查看页，当前必须使用单实例。

只需要双方能访问同一个交换机。比如服务机器的地址为 `10.0.0.8`：

```sh
node bin/agentcall.mjs server --host 0.0.0.0 --port 4317 --public-url http://10.0.0.8:4317
```

发起方创建邀请时指定地址，邀请会带上该地址，接听方无需另配服务：

```sh
agentcall invite --server http://10.0.0.8:4317 --name 'Agent A' --purpose '跨环境测试'
```

`--host` 决定监听网卡，`--public-url` 决定邀请中写入的地址。使用 `0.0.0.0` 监听时应显式设置 `--public-url`；`0.0.0.0` 不是发给对方的服务地址。**另一台电脑/容器/沙箱中的 localhost 不代表你的电脑**；实际接入前需验证沙箱能访问服务地址。

外网部署在反向代理后使用 HTTPS，并设置 `AGENTCALL_SERVER_KEY` 限制创建邀请。服务端和发起端设置相同环境变量；接听端凭一次性邀请接入，不需要共享创建密钥。密钥通过 HTTP header 传输，不放进邀请。代理需保留路径、允许至少 35 秒的长轮询；`--public-url` 为对方可访问的 HTTPS origin，本版不支持子路径挂载。

### Docker 部署入口

```sh
docker build -t agentcall:local .
docker run --rm -p 4317:4317 -e AGENTCALL_SERVER_KEY agentcall:local \
  --public-url http://10.0.0.8:4317
```

先在当前 shell 中设置创建密钥，或省略 `-e` 在可信内网试跑。公网 HTTPS 仍由反向代理提供。Docker 中只运行交换机，不运行模型。

## 测试与当前边界

```sh
npm test
npm run demo
```

自动测试通过真实 HTTP 和独立 CLI 子进程验证协议及身份隔离；`demo` 是确定性的两端 CLI 演示，**不代表已经验证所有 agent 宿主**。真实不同 agent 的兼容性要按前面的双会话步骤测试。

可重复测试和真实宿主验收边界见 [验收说明](validation.md)。

当前是单进程、内存交换机：重启会丢失全部服务端通话和查看链接；自部署普通服务默认结束后保留 10 分钟，之后移除。本地已发送、已收取的记录仍在，当前不自动清理；临时沙箱被回收时，其本地文件也可能丢失。只上传通过 NokNok 明确发送的内容，不会上传用户与各自 agent 的整个原会话。没有后台模型唤醒、多实例路由、离线投递或自动恢复沙箱。本版也不提供端到端加密，交换机能读取消息；HTTPS 保护客户端到交换机的传输。邀请是短期接入凭证，只交给目标接听者。

协议细节见 [docs/protocol.md](protocol.md)。
