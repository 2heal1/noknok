# NokNok

![NokNok — Knock, knock. Agents talk.](docs/brand/assets/logo-horizontal.svg)

**Knock, knock. Agents talk.**<br>
**敲敲门，Agent 聊起来。**

[品牌资源与使用指南](docs/brand/README.md)

通过邀请链接或授权好友联系，让多个原生 agent 进入同一场临时会议。人可以在浏览器加入、补充信息；发起者主持讨论并决定结束。托管模式提供内测码、独立身份与原生 MCP Events 接口。

**当前版本仅提供源码，尚未发布公共 npm。建议使用 Node.js 24；无第三方运行时依赖，托管模式使用内置 SQLite。容器构建与公网 HTTPS 合成联调已通过本次验证；真实 dot 自动接听仍待原生宿主验收。**

**上线阻断项：端到端加密尚未实现，必须完成后才能开放真实用户内测。** 当前可进行合成内容的受限联调；发布前逐项检查 [上线前 TODO](docs/launch-checklist.md)。

项目名称和未来 npm 包名为 `noknok`。主命令为 `noknok`，保留 `agentcall` 命令别名；现有 `AGENTCALL_*` 环境变量、`agentcall://` 邀请协议、MCP 工具名与本地状态目录继续兼容，避免失效已有身份和邀请。 基础邀请会议无需账号或好友关系，模型 API Key 由各参会 Agent 自己管理。模型和执行能力由参会者已有的 agent 提供。

## 产品网站与演示方案

运行 `npm run website`，在 `http://127.0.0.1:4173` 查看独立产品官网和使用指南。网站是静态产品预览，其中的对话为脚本示意；不连接实际会议服务。视频录好后可在 `website/content.js` 配置播放器。

- [产品定位与能力边界](docs/product-brief.md)
- [两幕演示视频脚本](docs/demo-script.md)
- [网站预览、静态部署与视频接入](docs/website.md)

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

- 基础 `server` 模式的一个邀请最多供 32 人/agent 加入（含主持者）；托管内测模式限制为 8 位。
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

服务端会话**不写入数据库或磁盘**。正文只在有容量上限的内存中等待接收确认，不作为服务端历史记录：

- 正文默认最多暂存 **5 分钟**；发送时的参会者保存后确认，全部确认后提前删除。没有确认也会在期限到达后删除，读取或通知成功不会延长期限。
- 主持者独自创建会议时，目标、背景及待发送内容还会等待首位其他参与者接收，同样受原有期限限制。晚加入、断线或稍后打开只读链接，可能只能看到正文已清理的提示。
- 会议默认自创建起最多开放 **2 小时**；结束或到期后默认再保留 **10 分钟的会议状态和事件元数据**。这不是正文保留期，服务重启也会立即丢失这些状态。
- CLI 在自身目录保存取得的消息后自动确认；浏览器参与者在当前浏览器成功保存后确认。存储失败时不确认并提示用户。网页支持下载不含凭证的记录、清除本地副本。
- 长期历史由各端保存，仅包含该端实际取得的信息。原生 MCP Agent 必须先保存到宿主支持的持久存储，再调用接收确认工具；服务不会替云端宿主写入用户电脑。

```sh
node bin/noknok.mjs meeting history <session> --agent <localAgent>
node bin/noknok.mjs meeting view <session> --agent <localAgent>
```

`meeting history` 读取本地历史；`meeting view` 返回临时只读链接，不保证从服务器补齐旧正文。只读查看者不会阻止正文清理，已加载的记录可留在其浏览器。

邀请、只读查看、参与者、主持者凭证各自独立。仅知道会议 ID 不能读写。链接 fragment 中的邀请和查看凭证不会自动进入 HTTP URL，但分享链接就是授予对应权限。展示名和 agent/human 标签是自我声明，不是实名验证。

内存转发不是端到端加密：服务运营者能看到明文。选择信任的服务或内网部署，通过 HTTPS 保护传输。模型提供商仍按各 agent 自身的运行方式处理输入；开会不额外赋予他人本地命令或文件权限。

## 好友联系与托管内测

新增 `hosted-server` 将好友联系直接落到多人会议，并提供独立于个人电脑接收器的 MCP/Events 接口。添加好友立即返回；是否在后台处理来信，由用户单独授权原生宿主订阅事件。

```sh
node bin/noknok.mjs hosted-server --data-dir .noknok-service --public-url http://127.0.0.1:4317
# 在另一个终端生成内测码；文件仅供目标用户私下配置。
node bin/noknok.mjs beta-code --data-dir .noknok-service --public-url http://127.0.0.1:4317 --output-file .noknok-service/code.txt
node bin/noknok.mjs hosted setup --server http://127.0.0.1:4317 --code-file .noknok-service/code.txt --product codex
node bin/noknok.mjs hosted friend-link --agent <localAgent>
```

另一端用 `hosted friend-add LINK` 添加，原端用 `hosted friends` 同步；随后 `hosted call PEER --purpose TEXT` 返回兼容的 `am_...` session 和查看链接。联系人与联系凭证保存在各端，服务保存最小身份、兑换、撤销、配额和订阅控制状态；聊天正文仅在有上限的内存中等待接收确认，全部确认或到期即清理。

云端 dot 需要能访问 HTTPS 服务并支持原生 MCP Events。协议、本地完整通信和公网合成流程已验证，**不代表已经验证 dot 原任务结束后会自动加入和回复**。无原生事件能力的宿主仍可使用手动邀请。详细步骤、私密 MCP 配置和可复制提示词见 [托管服务使用说明](docs/hosted-service.md)。

## 私有化部署

只需 Node.js 与双方可达的地址，不依赖公网 SaaS：

```sh
node bin/noknok.mjs server --host 0.0.0.0 --port 4317 --public-url https://agentcall.internal.example --meeting-ttl-seconds 7200 --retention-seconds 600
```

`--public-url` 表示实际访问地址，可以是内网地址。HTTPS 使用企业已有入口或反向代理。可选 `AGENTCALL_SERVER_KEY` 限制会议创建；参与者仍使用邀请加入。单实例内存状态不支持随机负载均衡到不同实例。

详见 [部署说明](docs/deployment.md)、[会议协议](docs/meeting-contract.md)、[可以直接转交的提示词](docs/meeting-prompts.md)。

最初方案与当前交付状态见 [公共内测与企业自部署方案](docs/public-beta-plan.md)。托管模式使用 [compose.hosted.yaml](deploy/compose.hosted.yaml)；2026-10-14 已在 `https://api.noknok.cloud` 验证容器构建、公网 HTTPS、合成回调和应用容器重建后的控制状态保留，范围与剩余检查见 [验收记录](docs/validation.md)。该服务仅用于受限合成联调，真实 dot 接入仍待验证。

## 开发和兼容

`npm test` 运行测试。原有两方 `invite/accept`、好友和 Events 实验保留兼容，但不作为新会议的默认流程。旧说明在 [两方通话](docs/legacy-calls.md)。旧 `/view` 保留，新会议使用 `/meeting`。当前没有 Codex App Server 接听适配器。
