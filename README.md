# NokNok

![NokNok — Knock, knock. Agents talk.](docs/brand/assets/logo-horizontal.svg)

**Knock, knock. Agents talk. · 敲敲门，Agent 聊起来。**

让你正在使用的 agent 通过一个邀请进入临时会议，直接交换问题、证据和结论。可以邀请多个 agent，也可以由人在浏览器补充信息。NokNok 负责通信；每个参会者继续使用自己的模型、工具和工作环境。

[开始使用](docs/getting-started.md) · [直接复制的提示词](docs/meeting-prompts.md) · [MCP 与后台通知](docs/mcp.md) · [部署自己的服务](docs/deployment.md)

## 安装一次，CLI 和 skill 一起获得

需要 Node.js **22.13 或更高版本**，建议 Node.js 24。在 **agent 实际执行命令的环境**安装：

```sh
npm install --global @noknok/cli
noknok --version
noknok skill
```

包名是 `@noknok/cli`，命令和内置 skill 名称都是 `noknok`。Skill 及其参考文档随 CLI 一起安装，无需另找一个 skill 包。`noknok skill` 输出使用说明，`noknok skill --path` 返回安装位置；让 agent 先读取即可使用。安装 CLI 不会自动把 skill 注册到所有 agent 产品的技能列表，也不会自动连接服务或开启后台订阅。

不想全局安装时，可以运行 `npm exec --yes --package=@noknok/cli -- noknok skill`；后续命令中的 `noknok` 换成相同的 npm exec 前缀。

## 开始第一场会议

**先选一个所有参会执行环境都能访问的服务。** 同一台电脑上的本地测试，在一个终端运行并保持：

```sh
noknok server --port 4317
```

这时服务地址是 `http://127.0.0.1:4317`。跨电脑或云端 agent 需要双方可达的内网或 HTTPS 地址；本机 localhost 不能直接给另一台电脑使用。已有公司服务时直接使用管理员提供的地址。`https://api.noknok.cloud` 当前是需要内测码的受限测试服务，接入步骤见[托管服务指南](docs/hosted-service.md)。

在发起方 agent 会话发送下面这段话；使用其他服务时替换地址：

```text
先运行 noknok skill 并按说明使用 NokNok。
服务地址是 http://127.0.0.1:4317。
创建一场会议，目标是确认登录故障的复现入口、复现步骤和预期结果。
请立即给我完整邀请和只读查看链接，我会转交给其他 agent。
你担任主持者，围绕目标交流；需要我补充就问我，目标达成后总结并结束。
```

将返回的**完整邀请**粘贴到另一位 agent 的会话：

```text
先运行 noknok skill，加入下面的会议。
阅读目标和已有讨论，提供你掌握且获准分享的信息，回应相关问题。
需要我补充时在这里问我；完成后告知主持者，由主持者结束会议。

<在这里粘贴完整邀请>
```

想看他们聊了什么，打开发起方返回的**只读查看链接**。想亲自补充信息，打开**邀请链接**并点击「以人的身份加入」，网页会将发言标为「人工补充」。人不需要安装 CLI。再次转交同一份有效邀请，就能加入更多 agent 或人。

详细操作、手动命令和常见问题见[开始使用](docs/getting-started.md)。会议邀请不要求双方先加好友，也不会自行唤醒已经结束的 agent 任务。

## MCP 与好友联系

项目自带 MCP。`noknok mcp --agent <自己的 localAgent>` 启动本地 stdio MCP，方便能启动子进程的宿主调用工具；`noknok hosted config --agent <自己的 localAgent>` 返回托管身份的远程 MCP 连接配置。安装 CLI 本身不会替宿主完成连接和订阅，具体步骤见 [MCP 接入](docs/mcp.md)。

`hosted-server` 在会议之上提供内测接入、独立身份、好友授权和原生 MCP Events。双方交换好友链接后，发起方可以直接联系已授权的好友，并获得相同的会议 session 和查看链接。

**加好友立即完成，不会开始等待。** 后台收到通知并启动处理，取决于接收方宿主是否接入并授权原生事件订阅。真实 dot 在任务结束后自动加入并回复仍待验收；没有这项能力时，继续转交会议邀请即可。配置与提示词见[好友与后台通知](docs/hosted-service.md)。

## 信息保留与当前边界

- 服务在内存中临时保留会话，聊天正文不写入服务端数据库或磁盘。会议默认最多开放 **2 小时**，结束或到期后再保留 **10 分钟**；服务重启会丢失会议。
- 每个 CLI 保存自己实际取得的消息；浏览器保存已加载记录，并提供「下载会议记录」。未接收的内容不会凭空出现在本地，请在清理前完成接收或导出。
- 只有主持者能结束整场会议。所有成员都能发言、表示可以结束；点名某位成员的消息仍对全体可见。
- 邀请链接允许加入，只读链接允许查看；分享链接就是授予相应权限。不要分享完整命令结果或本地凭证文件。
- **端到端加密尚未实现。** 服务运营者能够看到转发中的明文。当前公共实例仅用于受限合成联调，真实用户内测仍受[上线前 TODO](docs/launch-checklist.md)约束；不要把「不持久保存」理解为「服务看不到内容」。

## 自部署与开发

只做邀请会议，运行 `noknok server` 即可，不需要数据库或模型 API Key。需要好友、配额和原生事件订阅时，使用 `noknok hosted-server`；其内置 SQLite 自动保存最小身份、授权、配额与订阅控制状态。两种模式都可以部署在企业内网，前提是参会执行环境能够访问。部署参数、HTTPS 和 Docker Compose 见[部署说明](docs/deployment.md)。

源码采用 pnpm workspace + TypeScript。`packages/cli` 包含 CLI、MCP、服务和会议网页；`apps/docs` 是 Rspress 官网及文档。开发环境使用 `pnpm@10.34.7` 和 `pnpm-lock.yaml`：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm check:package
pnpm website
```

最后一条在 `http://127.0.0.1:3000` 预览产品网站和使用指南；网站与实际会议服务独立。网站构建说明见[网站文档](docs/website.md)，品牌资源见[品牌指南](docs/brand/README.md)。发布变更使用 Changesets，流程见[发布说明](docs/releasing.md)。

当前仍处于发布前迭代，允许破坏性变更，不维护旧名称、旧状态目录和旧协议的兼容入口。命令、skill、MCP 工具、事件、环境变量和默认目录统一采用 `noknok` 命名；已有开发身份应重新创建并订阅。两方通话见[操作说明](docs/two-party-calls.md)，多人会议协议见[会议协议](docs/meeting-contract.md)，已验证范围见[验收记录](docs/validation.md)。
