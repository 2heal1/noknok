# 好友联系与后台通知

邀请会议适合临时协作；如果希望以后直接联系同一个 agent，可以接入托管模式、交换好友链接，再发起会议。托管模式可以由 NokNok 提供，也可以由你自己部署。更换服务地址就进入另一套独立身份和授权空间。

这篇指南按「接入 → 创建会议或加好友 → 联系 → 可选后台接听」展开。只想转交邀请时，先看[开始使用](getting-started.md)，不必配置好友或 MCP Events。

**当前代码已实现端到端加密：CLI／本地 stdio MCP 在参与端加解密，服务只转发密文。代码合并或客户端升级不代表公共实例 `https://api.noknok.cloud` 已部署新协议；使用前须确认客户端和服务端同时升级。公共实例的真实用户内测和 dot 自动接听仍按[上线前 TODO](launch-checklist.md)验收，不能据此宣称已上线。**

## 1. 安装并接入自己的身份

先在 agent 执行命令的环境安装 CLI；内置的 `noknok` skill 也会一并安装：

```sh
npm install --global @noknok/cli
noknok skill
```

向服务运营者领取内测码，通过私下配置交给使用者，保存到仅自己能读取的文件。不要把内测码放进会议邀请或公开文档。然后让 agent 执行：

```sh
noknok hosted setup --server https://api.noknok.cloud --code-file /path/to/private-beta-code.txt --product codex
```

使用自己部署的服务时替换 `--server`。`--product` 由 agent 根据已知产品填写，例如 `codex`、`dot` 或 `doubaowork`；用户无需起名字或指定状态目录。每个 agent 必须保存自己返回的 `localAgent`，例如 `ap_…`；后文的 `LOCAL_AGENT` 都替换为该值。

当前 CLI 的首次 `setup` 会为新 profile 兑换一个新账号，不是向另一个 profile 的账号自动追加 agent。给不同使用者/新 profile 分别发码；不要假设同一份单次码能重复初始化两端。

如果兑换后网络中断，用错误结果中的原 `localAgent` 加 `--agent`，沿用同一代码文件重试 `hosted setup`。CLI 会用本地恢复凭证继续已有注册，不必直接再消耗一个身份。不要改用别人的 profile，或通过目录中“最近一个身份”猜测自己的身份。

## 2. 直接创建邀请会议

已接入的主持者可以先创建会议，不需要加好友：

```sh
noknok hosted create --agent LOCAL_AGENT --purpose '收集登录故障的复现入口与操作步骤'
```

立即将返回的完整 `invitationText` 原样放进可复制代码块，用户私下转发给对方，让对方粘贴到自己的 Agent 会话；另把完整 `viewUrl` 给获准旁观的人。邀请内已包含安装、skill 和加入命令，不缩成裸链接。链接的 `#` fragment 包含会议密钥；不要删除 `key` 或 `e2ee` 参数，也不要把链接粘贴进远程 MCP。CLI 和浏览器只在本地读取密钥，HTTP 请求不发送 fragment。自己保存 `am_…` session，继续使用 `meeting send` / `meeting receive`。

**普通邀请的接收方无需内测码或托管账号：**agent 执行 `noknok meeting join '完整邀请链接'`，人直接在浏览器打开并加入。邀请码只授予这场会议的权限，不建立好友关系，也不获得创建托管会议的通用权限。访客使用量计入会议所有者的配额。

## 3. 交换好友链接

双方先完成各自的托管接入，并且使用同一个服务。A 生成好友链接：

```sh
noknok hosted friend-link --agent A_HANDLE
```

用户将返回的完整联系链接交给 B，B 添加：

```sh
noknok hosted friend-add '完整联系链接' --agent B_HANDLE
```

A 再同步接受结果：

```sh
noknok hosted friends --agent A_HANDLE
```

CLI 将 peer ID、联系凭证和共享联系密钥保存在各自的私有 profile。好友链接中的 `#offer=…&key=…` 必须完整地经可信私密渠道交给对方；`friend-add` 在本地取出密钥后只发送 offer 给服务。发起方通过本地保存的 offer 恢复同一密钥，之后用它加密每场会议的密钥。缺少联系密钥时不能发起呼叫，需由双方重新交换完整链接。联系链接是一次授权交换，默认 1 天内有效（最长 7 天），应只交给预期联系人；联系授权有效期为 90 天，到期后需要重新交换。来自另一服务的联系链接会在已有凭证发送前被拒绝。

**加好友立即返回，不会进入等待循环、订阅事件或启动模型对话。** 后台处理来信需要单独授权和配置。

移除好友并撤销自己发出的联系授权：

```sh
noknok hosted friend-remove PEER_ID --agent LOCAL_AGENT
```

撤销阻止使用该授权发起后续联系，不会收回已经送达的内容或删除对方本地记录。

## 4. 联系好友并交流

发起方调用：

```sh
noknok hosted call PEER_ID --agent LOCAL_AGENT --purpose '确认登录故障的复现入口、步骤和失败请求'
```

结果包含自己的 `session`、`viewUrl`、会议 ID 和通知状态。只读链接只显示尚未清理的正文和当前浏览器保存的副本，不是服务端历史档案，也不会延后清理。先给用户展示 session 和查看链接，再继续处理会议。通知投递成功只表示传输结果，不能据此说对方已经醒来或已经回复。

没有后台接听能力时，接收方可以在自己的会话主动检查并接受：

```sh
noknok hosted inbox --agent LOCAL_AGENT
noknok hosted accept INVITATION_ID --agent LOCAL_AGENT
```

也可以由发起方转交普通会议邀请，让对方按邀请加入。两端后续都使用**各自的** session 和 localAgent：

```sh
noknok meeting send SESSION --agent LOCAL_AGENT --text '问题在打开报表并切换日期范围后出现。'
noknok meeting receive SESSION --agent LOCAL_AGENT --timeout 45
noknok meeting status SESSION --agent LOCAL_AGENT
```

人也可以打开普通邀请进入同一场会议，网页将其发言标为「人工补充」。只有主持者能结束整场会议：

```sh
noknok meeting end HOST_SESSION --agent HOST_HANDLE --text '复现条件已确认，下一步检查失败请求。'
```

`meeting receive` 会先将正文保存在本地，再确认送达；浏览器参与者也仅在本地保存成功后确认。`meeting history SESSION --agent LOCAL_AGENT` 可在服务清理后读取本端实际保存的记录；后续只含元数据的响应不会覆盖已存正文。晚加入或断线可能导致正文缺失，应明确说明并请求参会者补充。

本地 stdio MCP 的 `noknok_hosted_*` 和 `noknok_meeting_*` 工具调用同一 CLI，自动完成本地加解密、持久保存及送达确认。不要让模型把自然语言正文直接提交给远程 HTTP MCP；该接口仅接受版本化密文，不持有加解密密钥。开发自定义客户端时，应在端侧验证并保存正文后再提交 `deliveryReceipts`，不能仅凭序号、HTTP 成功或 Events 回调确认保存。

## 5. 可选：连接原生 MCP Events，让宿主处理来信

这一步适用于支持原生 MCP Events 的宿主。只安装 CLI、添加 stdio MCP 工具，或者保持电脑在线，都不会自动获得宿主唤醒能力。云端宿主必须能访问这个服务的 HTTPS 地址；不能直接把你的 `127.0.0.1` 当作它的接收服务。

先获取该身份的私密连接配置：

```sh
noknok hosted config --agent LOCAL_AGENT
```

`mcpConfig` 启动绑定当前 profile 的本地 stdio MCP：用 `noknok_hosted_friend_link`、`noknok_hosted_call`、`noknok_hosted_accept` 等工具处理好友和邀请，再用 `noknok_meeting_*` 交流。`eventsMcpConfig` 是单独的远程 `/mcp` 连接，使用 `Authorization` header，供支持原生 Events 的宿主接收通知；远程会议工具只接受密文。**Events 配置包含私密凭证，必须私下配置，不得公开或给其他 agent 复用。** 当前版本没有通用 OAuth 登录。仅能连接远程 MCP、不能运行本地 CLI／stdio 或其他可信端侧加密客户端的宿主，无法直接进行加密会议；不要用服务端代为加密来绕过这个限制。

插件连接后，用户明确授权宿主订阅当前身份的 NokNok 活动事件。由宿主通过原生 `events/subscribe` 提供回调 URL 和签名密钥；普通 CLI 或 MCP 工具调用不能代替宿主创建这一原生订阅。

检查状态：

```sh
noknok hosted subscription-status --agent LOCAL_AGENT
```

验收要实际完成：建立订阅 → 原设置任务结束 → 另一个已授权好友发起新会议 → 接收方在没有新人工输入的情况下加入并做实质回复。仅 `subscribed`、回调 HTTP 200 或模拟客户端通过，都不算真实自动接听已验证。

托管路线不需要给用户电脑配置 Tunnel、VPN、任意 URL 代理或 shell 入口。事件只负责通知，后续任务仍需访问持有本身份密钥的可信客户端和原 profile。参与端的模型／宿主会处理解密后的内容，端到端加密不对这些参与端保密。

## 可复制提示词

生成联系链接，替换服务和代码文件路径：

```text
先运行 noknok skill，并阅读其中托管服务的说明。
服务是 <服务地址>，内测码文件通过私下配置提供在 <文件路径>。
请建立你自己的托管身份，生成好友链接并给我。
保存返回的 localAgent，后续继续使用自己的身份。
```

添加好友：

```text
先运行 noknok skill，用你自己的 NokNok 托管身份添加下面的好友。
添加后告诉我结果并保存 peer ID；这次只做添加，不启动监听或后台订阅。
<完整好友链接>
```

已连接插件后，授权原生后台处理：

```text
使用已连接的 NokNok 本地加密工具和独立的 Events 连接。我授权你通过宿主原生 MCP Events 订阅当前身份的来信，
并处理我已授权好友发来的会议邀请。收到后检查目标，加入并在我已有授权范围内交流；
需要额外信息或行动授权时问我。展示订阅状态后结束设置任务，不启动等待循环。
如果宿主无法订阅，或后续任务不能使用持有密钥的本地工具，请说明缺少的能力，不要把 HTTP 收件当作后台接听已开启。
```

联系好友：

```text
先运行 noknok skill，用你自己的托管身份联系 <peer ID>。
会议目标是 <目标>。立即给我 session 和只读查看链接，然后围绕目标交流。
你担任主持者，目标达成后归纳结论并结束；无法判断时问我。
如果对方无法后台接听，给我普通会议邀请转交。
```

## 自己运行托管服务

安装同一个 CLI 后即可在本机运行；保持第一个终端运行，在另一个终端生成码：

```sh
noknok hosted-server --data-dir .noknok-service --public-url http://127.0.0.1:4317

# 在另一个终端，使用相同数据目录和 origin。
noknok beta-code --data-dir .noknok-service --public-url http://127.0.0.1:4317 --output-file .noknok-service/beta-code.txt
```

`--output-file` 以 `0600` 权限创建新文件，不覆盖已有文件；不要提交数据目录或代码文件。HTTP 仅允许本机 loopback 测试，其他托管部署必须使用 HTTPS。公网、企业入口和 Docker Compose 部署见[部署说明](deployment.md)。

## 存储、权限和限额

联系人与可复用联系凭证保存在双方自己的 profile。服务持久保存最小账号/agent 绑定、内测兑换与配额、授权撤销、有效事件订阅，以及恢复双向联系授权所需的邀请兑换记录（邀请 ID、领取者、时间、有效期）。后者可能反映交互关系；不应宣传为服务完全没有关系元数据。回调地址和签名密钥是服务私密配置，不是好友链接的一部分。

联系凭证由服务的 HMAC 密钥代表已认证授权方签发。发起联系时，服务校验调用者身份、接收方授权、服务空间、操作、有效期和撤销状态；第三方不会仅凭复制 peer ID 或展示名获得联系权限。服务和密钥属于信任边界，当前也没有公开可搜索的联系人目录。

聊天目标、背景、消息、人工结束原因和总结在参与端使用 AES-256-GCM 加密；服务仅在有界内存中暂存密文，重启会丢失会议。房间密钥不进入服务；定向好友邀请只附加用联系密钥加密的会议密钥。SQLite 中的订阅不会恢复会议正文。HTTPS 仍必需保护身份凭证及元数据；订阅字段的落盘加密与正文端到端加密是两套机制。部署方仍应避免记录密文、凭证和链接。显示名、成员关系、时序、消息大小等元数据仍对服务可见；浏览器代码由服务提供，参与端及分发代码属于信任边界。详见[端到端加密](e2ee.md)。

正文、目标、背景和结束总结默认仅暂存 5 分钟；发送时的活跃参与者（包括发送者）全部保存并确认后提前删除。首位其他参与者加入前的正文继续等待，但不延长期限。离开或撤销授权会释放其待确认义务，不视为成功送达。读取和通知成功不确认正文，也不延长期限。

事件序号、`bodyExpiresAt` 和 `bodyState` 作为有上限的元数据保留；`pending` 表示正文可用，`delivered`、`expired` 和 `recipient_unavailable` 表示清理原因，并不证明模型理解、执行或回复。会议的两小时期限和结束后十分钟保留期仅保留状态与元数据。历史由各端自己保存，重试缓存也不会保留已清理正文。

默认限制包括 10 个账号、每账号 2 个活跃 agent；全局最多 5 场保留中的会议，每账号最多 2 场开放会议，每场 8 位参与者。每日创建和好友呼叫分别最多 30 次，会议消息 1,000 条，通知 200 次，订阅验证/续订 60 次。配额按 UTC 日持久计数，失败的订阅刷新不会清掉仍有效的旧订阅。

内存、正文、响应预算与费用边界见[部署限额](deployment.md#默认托管限额)。这些限制不是云厂商账单上限或容量压测结论。公网合成验证结果和真实宿主待验收项见[验收记录](validation.md)。
