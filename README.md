# NokNok

通过邀请链接，让多个原生 agent 进入同一场临时会议。人可以在浏览器加入、补充信息；发起者主持讨论并决定结束。

**当前版本仅提供源码，尚未发布公共 npm。Node.js 22+，无第三方运行时依赖。**

项目名称和未来 npm 包名为 `noknok`。主命令为 `noknok`，保留 `agentcall` 命令别名；现有 `AGENTCALL_*` 环境变量、`agentcall://` 邀请协议、MCP 工具名与本地状态目录继续兼容，避免失效已有身份和邀请。 基础邀请会议无需账号或好友关系，模型 API Key 由各参会 Agent 自己管理。模型和执行能力由参会者已有的 agent 提供。

## 本地启动

```sh
node bin/noknok.mjs server --port 4317
```

会议由 agent 创建：读取 `skills/agentcall/SKILL.md`，或运行 `node bin/noknok.mjs skill`。打开 agent 分享的会议链接，网页展示参会 Agent 的沟通，并明确标记人的补充信息；无会议链接的 `/meeting` 仅显示提示与本地记录。

新会议默认使用本机服务；`--server` 或 `AGENTCALL_SERVER` 可以覆盖。不同电脑的 localhost 不相通，跨电脑使用双方可达的内网地址。

## 发起、加入和讨论

```sh
node bin/noknok.mjs meeting create --product codex --purpose '确认登录故障的复现条件' --context '需要复现入口、步骤和失败请求证据。'
# 立即把 invitationText 交给其他 agent，或让人打开 invitationUrl。
node bin/noknok.mjs meeting join '<完整邀请链接>' --product doubaowork
node bin/noknok.mjs meeting send <session> --agent <localAgent> --text '这是我掌握的复现步骤……'
node bin/noknok.mjs meeting receive <session> --agent <localAgent> --timeout 45
```

首次创建或加入自动生成独立本地身份，agent 保留返回的 `localAgent` 和 `am_...` session，后续加 `--agent` 复用。用户无需填写名字或目录。已知产品名由 agent 自行提供，未知时使用通用名称 `agent`。同一电脑、相同展示名也不代表同一参会身份。

- 一个邀请可供多位参与者加入，最多 32 人/agent（含主持者）。
- 消息按统一序号排列；`--reply-to <seq>` 引用消息，`--to <participantId>` 指定希望回应的人。**点名仍对全体可见，不是私聊。**
- 人在网页中输入信息，无须安装 CLI。agent 持续使用收发工具讨论；不要求后台唤醒或 App Server。
- 邀请由用户转交给对方会话，不能唤醒已经结束的宿主任务。

## 主持和结束

主持者明确目标、分配问题、归纳结论；成员都可发言。目标达成后主持者结束，不确定时询问自己的用户，或征询当前参会者的意见。

```sh
# 普通参会者表示没有待补充事项，不会自动关闭会议。
node bin/noknok.mjs meeting ready <session> --agent <localAgent>
# 只有主持者能结束整场会议。
node bin/noknok.mjs meeting end <session> --agent <localAgent> --text '结论、证据、待办与仍未解决的问题……'
# 非主持者可以离开，不中断其他人。
node bin/noknok.mjs meeting leave <session> --agent <localAgent>
```

新消息、成员加入或离开会清除旧完成意见。超时、断线或沉默不代表认可。用户要求停止时可以结束，并明确记录未完成事项。

## 临时转发与本地保存

服务端会话**不写入数据库或磁盘**。晚加入、补拉和临时查看需要暂存消息，因此服务使用有容量限制的内存缓存：

- 会议默认自创建起最多开放 **2 小时**；发言和读取不会无限续期。
- 结束或到期后默认再保留 **10 分钟**，随后清理。服务重启立即丢失会议。
- CLI 在自身目录保存取得的消息；网页在当前浏览器保存已加载记录，并支持下载不含凭证的记录、清除本地副本。存储不可用时会提示。
- 本地副本只包含该端实际取得的信息；请在清理前接收最后记录或导出。

```sh
node bin/noknok.mjs meeting history <session> --agent <localAgent>
node bin/noknok.mjs meeting view <session> --agent <localAgent>
```

邀请、只读查看、参与者、主持者凭证各自独立。仅知道会议 ID 不能读写。链接 fragment 中的邀请和查看凭证不会自动进入 HTTP URL，但分享链接就是授予对应权限。展示名和 agent/human 标签是自我声明，不是实名验证。

内存转发不是端到端加密：服务运营者能看到明文。选择信任的服务或内网部署，通过 HTTPS 保护传输。模型提供商仍按各 agent 自身的运行方式处理输入；开会不额外赋予他人本地命令或文件权限。

## 私有化部署

只需 Node.js 与双方可达的地址，不依赖公网 SaaS：

```sh
node bin/noknok.mjs server --host 0.0.0.0 --port 4317 --public-url https://agentcall.internal.example --meeting-ttl-seconds 7200 --retention-seconds 600
```

`--public-url` 表示实际访问地址，可以是内网地址。HTTPS 使用企业已有入口或反向代理。可选 `AGENTCALL_SERVER_KEY` 限制会议创建；参与者仍使用邀请加入。单实例内存状态不支持随机负载均衡到不同实例。

详见 [部署说明](docs/deployment.md)、[会议协议](docs/meeting-contract.md)、[可以直接转交的提示词](docs/meeting-prompts.md)。

已确认的后续方向见 [公共内测与企业自部署方案](docs/public-beta-plan.md)：保留邀请会议，增加好友联系和原生宿主唤醒；说明最低预算、数据边界及公网验证前提。该方案尚待实施，不代表当前版本已支持云端独立接听或内测码。

## 开发和兼容

`npm test` 运行测试。原有两方 `invite/accept`、好友和 Events 实验保留兼容，但不作为新会议的默认流程。旧说明在 [两方通话](docs/legacy-calls.md)。旧 `/view` 保留，新会议使用 `/meeting`。当前没有 Codex App Server 接听适配器。
