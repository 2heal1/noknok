# 验收说明

## 自动部署准备与凭据审计（2026-10-14）

- 版本发布后的 deploy job、固定版本安装器、受限 SSH 入口和回滚状态机已实现；preview 不部署，npm OIDC 身份不变。
- GitHub 部署环境已配置，只允许 main，使用独立 CI SSH Secret 和固定主机信任记录。管理员私钥没有上传服务器或写入 GitHub。
- 目标服务器已安装 root-owned 控制器及专用账户，配置与 sudoers 权限检查通过；初始化独立新测试卷，保留原卷和运行中的应用。
- 实际 SSH 负测通过：拒绝普通命令、非法版本、调用方回滚、命令注入和反向端口转发。目标 Docker Compose 配置校验通过，原 HTTPS 健康检查仍成功。
- 同步正文确认清理后的健康契约：新版必须返回 `participant + pending_memory`，旧 `memory` 仅允许恢复管理员捕获的 bootstrap 快照。服务器部署程序已更新，当前应用未重启。
- 最终 `pnpm check` 通过（295 项 Node 测试，其中部署测试运行 15 项 Python 用例）；文档构建、npm 归档检查及离线安装通过。
- 当前受版本控制文件、本地可达 Git 历史及 npm `@noknok/cli@0.0.2` 归档未发现真实凭据；识别出的 PEM 文本为明确假值测试 fixture。扫描器已纳入 `pnpm check`，仅输出位置。
- **尚未执行首个新版稳定包的自动部署。** 工作流合入和版本 PR 发布后，仍需记录 GitHub runner 到服务器的真实执行结果；上述权限验证不等于完整自动升级或真实 dot 唤醒验收。镜像回滚测试不替代数据库恢复演练。

## pnpm / TypeScript 工作区验证（2026-10-14）

本次是发布前破坏性重构，尚未部署到公共实例或发布新 npm 版本。

- CLI/服务/浏览器源码已迁至 `packages/cli`，官网与文档位于 `apps/docs`；TypeScript 类型检查与编译通过。
- 267 项自动化测试通过，覆盖 CLI 双向通信、多人会议、人工参与、身份隔离、订阅与签名回调、配额、撤销、重试、恢复和发布归档检查。另有独立 CLI 演示通过。
- 对实际 npm tarball 执行离线安装，确认唯一的 `noknok` 可执行文件、`npm exec`、内置 Skill 和引用路径；包不带网站、运行时依赖、开发源码或私密测试状态。
- 在独立副本模拟 stable `0.1.0` 与 preview 版本生成、构建和离线包检查，根工作区与文档包保持 private，未发布。
- Rspress 18 个页面构建通过。真实浏览器验证中英文、搜索、复制、320px 布局、敲门动画及暂停/跳过/重播/减少动态效果；保留主分支 PR #11 的设计。
- 在本地会议服务验证人工加入、发送补充、CLI 接收带 human 类型的消息及主持者结束；`/view` 与 `/meeting` 无 JS 解析错误。
- CI/Release/Compose YAML 与工作流 shell 语法检查通过。当前本机没有 Docker，新的多阶段镜像尚未在本机构建；合成 MCP 回调不代表真实 dot 自动唤醒，端到端加密也尚未实现。


本仓库的测试使用隔离的本地状态目录、真实 HTTP 和 CLI 子进程验证会议、两方通信、好友身份隔离、后台接收器、MCP 协议与合成事件。模型及宿主行为需另行验证。

## 可重复验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
pnpm check:package
node packages/cli/dist/bin/noknok.js --version
node packages/cli/dist/bin/noknok.js skill --path
```

`demo` 是确定性的两端 CLI 通信，不代表两个真实 personal agent 已自动讨论。测试和打包应在独立目录执行，不读取用户的身份、联系人、订阅或聊天文件。

## 需要另外确认

- [端到端加密上线阻断项](launch-checklist.md)：尚未实现，必须补齐端侧密钥、多人/浏览器/dot 兼容和中转端不可解密的验证；已有自动化测试不构成其验收。
- 控制数据库及原服务密钥的一致性备份和恢复演练；已有重启测试不等于备份恢复测试。
- 异常退出后的数据库完整性与故障恢复；保留控制卷的应用容器重建已验证，但不等于异常退出或备份恢复验收。
- 证书自动续期、持续运行和用户规模容量验证。
- 不同产品、不同机器及受限沙箱的访问和工具执行能力。
- dot 原生插件发现、真实订阅、设置任务结束后的自动唤醒和实质回复。
- 原生宿主是否接受当前 Bearer / 私密 MCP URL 认证；本版本没有 OAuth 授权流程。

只有真实宿主在没有新增人工输入时处理事件并调用工具回复，才证明自动唤醒。收到 webhook 2xx、合成客户端往返或后台进程存在均不足以证明。

本机后台接收器模式要求电脑和接收器在线。hosted-server 独立提供会议与 Events 接口，操作见 [托管服务指南](hosted-service.md)，设计见 [公共内测计划](public-beta-plan.md)。会议正文只在服务端内存暂存，重启丢失；记录只包含各端实际接收到的内容。

## 外部仓库迁移检查

迁移以干净源码快照进行，使用目标仓库自身历史；不携带源仓库历史、本地运行数据、凭据或部署产物。已移除专有平台构建与端口设置，默认服务改为本机地址，包元数据和安装来源采用公开 npm 注册表。迁移时尚未发布公共 npm；后续已发布 `@noknok/cli`，发布流程见 [releasing.md](releasing.md)。

迁移后的测试、打包和扫描结果以实际验证记录为准；本文不引用旧发布环境的测试或上线记录。

## 历史验证记录

以下日期、版本与测试数量描述当时源码，不代表本次 pnpm/TypeScript 工作区已部署或发布。当前验证使用上面的命令；新版本不保留旧命名或旧状态格式兼容。

## 外部版本本机验证（2026-10-13）

- Node.js 24.18.1 下原布局的 `npm test`：201 / 201 通过，无跳过。
- `npm pack` 产生 49 个文件；仅在本机安装，未发布公共 npm。
- 隔离目录离线安装 tarball 后，当时发布包的命令版本输出、Skill 路径验证通过。
- 源码正文与打包文件检查没有遗留专有平台域名/标识、开发者机器路径或常见真实凭据格式；包中没有本地身份、订阅、会话或部署回执。
- Markdown 相对链接和代码围栏完整，未复制源仓库提交历史。

以上验证不证明真实 dot 自动唤醒或公网服务已上线。

## 0.6.0 托管模式本地验收（2026-10-13）

- Node.js 24.18.1 下原布局的 `npm test`：254 / 254 通过，无跳过；包含真实 HTTP + CLI 双端流程及合成回调验证。
- 注册恢复、单次内测码、A/B/C 隔离、复制联系凭证失败、跨服务拒绝、撤销期间慢请求与长轮询均有测试。
- 订阅在 SQLite 中加密保存，覆盖重启、更新回调、签名密钥轮换、410 停用、并发变更和撤销后重试；消息/事件正文不进入数据库。
- 邀请兜底、多人及人工发言、主持权限、消息幂等、绝对过期、清理缓存、通知失败状态、按字节响应预算及每日配额均有测试。
- 内测码 CLI 私有文件输出、hosted-server 启停、Skill 校验、打包与隔离安装验证通过。
- 当前机器没有 Docker；尚未验证容器构建、Caddy 实际证书、公网运行或真实 dot 接听，也没有做用户规模容量压测。

本地模拟测试证明服务实现的行为，不证明原生宿主是否会调度模型。下一步公网验收应先创建真实订阅，结束设置任务，再由另一位已授权 Agent 联系，观察同一会议内的真实加入与实质回复。

## 0.6.0 hosted 受限合成部署验收（2026-10-14）

本次使用提交 `7c36941`，在全新 Linux VPS 上部署 `https://api.noknok.cloud`，仅用于合成内容的受限联调。以下结果更新当前部署状态，不改写上方 2026-10-13 的历史本机验收结论，也不代表服务已向真实用户开放。

| 项目 | 实测结果 |
| --- | --- |
| 运行环境 | Ubuntu 24.04、amd64；Docker 29.9.0、Docker Compose 5.6.0 |
| 服务运行时 | Node.js 24.21.0、Caddy 2.11.7 |
| 构建和代理配置 | hosted 镜像构建成功，Caddy 配置校验通过 |
| 公网 HTTPS | `https://api.noknok.cloud/health` 返回 HTTP 200，TLS 证书链与域名校验通过 |
| 应用容器 | 状态 healthy，以 `node`（UID 1000）运行，根文件系统只读，capabilities 全部移除，4317 未发布至宿主机 |
| 控制数据权限 | `/data` 为 `0700`；`control.sqlite`、`signing.key`、`subscriptions.key` 为 `0600` |
| Linux 自动化测试 | 使用同镜像的隔离 Linux 容器运行测试：254 / 254 通过 |
| 公网基础合成流程 | 19 项检查全部通过；这些流程使用合成身份与内容，不代表真实宿主自动接听 |
| HTTPS 合成回调与应用重建 | 重建前 4 项、重建后 7 项，共 11 项检查全部通过；使用合成接收器验证 MCP Events 协议与实际 HTTPS 投递 |

HTTPS 合成回调测试通过 `events/subscribe` 为合成身份 B 建立订阅，验证 challenge 与 HMAC 签名，确认 A 联系 B 后事件送达。随后在保留控制卷的情况下仅强制重建应用容器：A/B 身份保持不变，B 的订阅以同一订阅 ID 恢复；重建前临时会议返回 HTTP 404。重建后，A 再次联系 B，回调送达，B 加入并发送合成回复，A 读取回复并结束会议，全部通过。合成接收器记录到 1 次验证和 3 次活动投递（2 次 `incoming_meeting`、1 次 `meeting_ended`），拒绝和重复计数均为 0。测试订阅与本轮新建的好友授权均已撤销。

联调结束后已恢复原 Caddy 配置，移除临时 HTTPS 接收器、测试路由及远端临时配置与密钥，并通过受限数据库操作停用三个合成测试账号及其 Agent；控制记录保留，未删除。数据库 `quick_check` 返回 `ok`，账号与 Agent 各 3 条、活跃数均为 0，订阅数为 0，剩余有效内测码可兑换次数为 0；数据库中未检出两组测试正文标记。

清理后另执行 8 项公网检查并全部通过：健康接口返回 HTTP 200，临时回调路径返回 HTTP 404，三个已停用 Agent 凭据访问均返回 HTTP 401，三个已停用账号凭据发起注册请求均返回 HTTP 401。当前账号上限按所有持久账号记录计数，停用不释放注册名额；保留的测试记录占默认 10 个名额中的 3 个，剩余 7 个。此结果不代表已向真实用户发放资格。

本次没有验证证书自动续期、长期稳定性、用户规模容量或数据库与原服务密钥的备份恢复，也没有验证真实 dot 的插件认证、原生订阅、任务结束后的自动加入与实质回复。端到端加密尚未实现；254 项测试和公网合成流程均不能替代这些验收，真实用户内测仍受 [上线前 TODO](launch-checklist.md) 阻断。

## 2026-10-14：确认收件后清理正文

在独立开发 worktree、Node.js 24.18.1 下执行 `npm test`，273 / 273 项通过。新增验证覆盖：

- 逐事件、逐参与者的收件凭据，整批校验、跨身份拒绝和重复确认；默认五分钟到期清理。
- 消息、目标、上下文、总结和自定义结束原因清理；核心及 hosted 重试缓存不能恢复已删除正文。
- 首位参与者的收件窗口、多人确认、离开/撤销、晚加入以及内存预算。
- 客户端先持久保存再确认，保存失败不确认，确认失败保留凭据重试；已删除事件不会覆盖本地正文。
- 浏览器只读查看者不确认，存储截断时只确认实际保存的正文，导出不包含收件凭据；确认网络失败不重复提交业务消息。
- 原生 MCP 慢速上传期间的身份撤销复核，覆盖 Bearer header 和私有 MCP URL。

此轮未部署新协议；上节公网环境仍是已记录的旧版本。端到端加密及真实原生宿主联调仍按上线清单验收。

### Pending-delivery integration with the TypeScript workspace (2026-10-14)

The remaining pending-delivery changes from the hosted-service branch are integrated with the current `packages/cli` TypeScript layout and canonical NokNok naming. The new meeting-delivery tests run as `.test.ts` alongside the existing suite; the removed legacy browser-cache migration remains removed.

- `pnpm check` passes: CLI/server/browser compilation, workspace type checks, and 286 tests with no failures or skips.
- Tests cover participant-scoped receipts, all-recipient acknowledgment, expiry without incoming requests, unavailable recipients, retry-cache cleanup, durable CLI save before acknowledgment, missing-history reporting, and browser save/confirmation retries.
- `pnpm --filter @noknok/docs build` and `pnpm check:package` pass, including actual offline tarball installation, npm exec, the canonical CLI binary, and bundled skill checks.
- No service deployment or npm publication is performed by this integration. Docker is unavailable locally; deployment-image validation is provided by the existing PR CI workflow.
