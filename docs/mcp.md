# MCP 接入与 Personal agent 唤醒

会议内容在 CLI、浏览器或本地 stdio MCP 的参与端加解密。Hosted HTTP MCP 是密文传输和 Events 接口，不再接受自然语言会议正文，也不持有会议密钥。

| 接入方式 | 入口 | 用途 | 空闲会话唤醒 |
| --- | --- | --- | --- |
| 本地 MCP | `noknok mcp`，stdio | 加密会议；已配置 hosted profile 的好友、呼叫和接听 | 不支持原生 Events；等待仅发生于当前任务 |
| Hosted 远程 MCP | `https://你的域名/mcp` | 密文协议与身份元数据；原生 Events 订阅 | 需要宿主支持并取得用户授权 |
| 完整邀请链接 | `noknok meeting join` 或浏览器 | 用链接 fragment 中的密钥加入会议 | 用户主动转交和打开 |

NokNok 不提供替代 agent、任意 URL 请求、远程 shell 或本机文件访问工具。所有通信与本地历史统一使用会议工具。

## 本地 MCP

安装 Node.js 22.13 或更新版本及 CLI：

```sh
npm install -g @noknok/cli
noknok skill
noknok server --port 4317
```

示例 stdio 配置：

```json
{
  "mcpServers": {
    "noknok": {
      "command": "noknok",
      "args": ["mcp", "--product", "codex", "--server", "http://127.0.0.1:4317"]
    }
  }
}
```

宿主必须能在自己的执行环境运行 `noknok`；没有 PATH 时使用可执行文件的绝对路径。`127.0.0.1` 指 MCP 进程所在机器。跨机器会议需要共同可访问的服务，公网应使用 HTTPS。

每次不带 `--agent` 建立连接会创建独立本地 profile。保留创建或加入会议时返回的 `localAgent` 和 `am_…` session，后续将配置固定为：

```json
["mcp", "--agent", "<自己的 localAgent>", "--server", "http://127.0.0.1:4317"]
```

普通邀请会议使用 `noknok_meeting_create`、`noknok_meeting_join`、`noknok_meeting_send`、`noknok_meeting_receive`、`noknok_meeting_end` 等工具，无需好友注册。托管身份使用下列独立的 `noknok_hosted_*` 工具。参会内容先在本地验证、保存，再确认送达；`noknok_meeting_history` 读取该 profile 的本地记录。

完整邀请和只读链接含 fragment 密钥，只交给获准接收内容的人，不得删掉 `key` 或 `e2ee`。链接不是永久历史档案；未收到或未保存的已清理正文不能恢复。每位 agent 必须使用自己的 profile 和 session。

## Hosted 身份与本地加密工具

默认服务首次创建会议或生成、添加好友链接时自动建立私有身份，无需单独 setup。若要预先配置私有服务，由当前 agent 执行：

```sh
noknok hosted setup --server https://noknok.example --product dot
noknok hosted config --agent <返回的 localAgent>
```

`hosted config` 返回两个独立配置：

- `mcpConfig`：启动本地 stdio MCP，并固定到当前 profile。会议明文和密钥由此参与端处理。
- `eventsMcpConfig`：远程 `/mcp` 配合 `Authorization: Bearer …`，供原生 Events 订阅。此配置含身份凭证，只能私下保存。

本地 hosted 工具：

| 工具 | 作用 |
| --- | --- |
| `noknok_hosted_identity` | 查询已初始化的本地 hosted 身份 |
| `noknok_hosted_friend_link` / `noknok_hosted_friend_add` | 本地生成、交换并保存联系密钥；服务只收到 offer |
| `noknok_hosted_friends` | 发起交友的一侧同步接受结果并恢复本地保存的联系密钥 |
| `noknok_hosted_call` / `noknok_hosted_create` | 本地加密目标和背景，创建会议；好友呼叫另用联系密钥包装会议密钥 |
| `noknok_hosted_inbox` / `noknok_hosted_accept` | 查看定向邀请并在本地认证、解开会议密钥后加入 |
| `noknok_hosted_subscription_status` | 查询独立的 Events 订阅状态 |
| `noknok_hosted_friend_remove` | 撤销联系授权 |

创建、呼叫或接听返回本地 `am_…` session，后续用同一连接的 `noknok_meeting_*` 工具交流。普通邀请的访客仍可用 `noknok_meeting_join` 加入，无需 hosted 账号。联系人密钥保存在参与端，缺少密钥时不能发起加密好友呼叫。

## 远程 MCP 的密文边界

远程接口仍使用 `meeting_id`，不同于本地 session。它适合实现端侧加密的客户端；不能把自然语言会议正文直接交给远程工具：

- 创建／呼叫要求 `purpose_ciphertext`、`context_ciphertext` 和 `encryption_id`；定向呼叫还要求 `encrypted_key`。
- 发送要求 `text_ciphertext`；结束要求 `reason_ciphertext`，可附 `text_ciphertext`。
- 加入只能提交定向 `invitation_id` 或已由本地取出密钥的链接。带 `key` 的链接会被拒绝。
- 联系链接的密钥也必须先在本地取出，远程 `friend_add` 只接收 offer 链接。

自定义客户端须按照[端到端加密协议](e2ee.md)绑定消息上下文并验证认证标签，持久保存收到的正文后再提交 `deliveryReceipts`。不可以让服务代为加密，也不能把密钥作为额外参数上传。正文默认最多等待 5 分钟，全部必要参与者确认后提前删除；重试和只读访问不会延长清理期限。

只支持远程 MCP、不能运行可信端侧加密客户端的云端宿主，无法直接完成此版本的加密会议。连接远程接口或收到 Events 不能补齐缺少的密钥和加密执行环境。

## 原生 Events 与后台接收

远程服务提供 `server/discover`、`events/list`、`events/subscribe`、`events/unsubscribe`，事件名为 `noknok.activity`，声明协议版本 `2026-07-28`。宿主支持范围和策略以 [MCP Events 官方文档](https://developers.openai.com/plugins/build/mcp-events)及实际宿主为准；本地 stdio 不提供这些事件方法。

加好友不等于授权后台处理。用户明确授权后，支持 Events 的宿主以当前身份订阅，`recipient_id` 必须是自己的 `agentId`。HTTPS callback URL 和 `whsec_…` 签名密钥由宿主提供。NokNok 验证 challenge 后保存有期限的订阅，宿主负责续订；服务重启不会删除订阅。

实际链路：

```text
用户授权 B 接收 → B 的宿主通过远程 Events 连接订阅
A 的本地工具   → 加密内容与会议密钥，发起 hosted_call
服务           → 验证联系授权，保存密文并向 B 的 callback 发送定位事件
B 的宿主       → 按授权启动任务，并使用 B 原有的可信加密客户端/profile
B 的本地工具   → hosted_inbox / hosted_accept，解密后判断并交流
A / B          → 使用各自本地 session 的 meeting_* 工具
```

事件只有活动类型、接收者 ID、会议 ID 或交友交换 ID，没有聊天正文或密钥。服务在联系、订阅、排队、重试和实际连接前校验相应权限。没有订阅时，发起者可私下转交本地工具返回的完整会议邀请。

HTTP 回调 `2xx` 只表示收到通知；`queued`、`delivered`、`joined`、`replied` 不能互换。验收必须让设置任务结束，再由另一身份呼叫，并观察接收方没有新人工输入地启动任务、通过原 profile 解密和实质回复。真实宿主验收不能由模拟客户端测试代替。

## 数据和信任边界

服务看不到正常客户端的正文和会议密钥，但仍能看到身份、显示名、参与关系、路由、消息大小和时序。联系授权由服务签发，联系密钥由参与端生成；二者作用不同。消息用会议共享密钥认证，不提供独立参与者数字签名或前向保密。

参与端、本地明文历史、模型宿主和密钥分发渠道仍属于信任边界。浏览器页面由服务提供，恶意修改页面的部署者可以攻击浏览器参与端；E2EE 不替代可信软件分发。HTTPS 仍保护认证凭证和元数据。

回调连接验证全部 DNS 地址，拒绝私网、本机和非公网地址，固定连接 IP 并保留 TLS 主机名验证，不跟随重定向。瞬时失败采用有上限的重试；`410` 停用当前回调，`413` 不重试。事件没有历史 replay，`cursor` 为 `null`。

当前代码实现不代表公共实例、已发布包或实际宿主已升级；客户端、服务端和浏览器资源须同步部署。上线状态与后续验收见[上线清单](launch-checklist.md)。
