# 自动唤醒

支持事件订阅的 personal agent 可以在好友联系时接收通知，再按你的授权加入会议和回应。自动唤醒需要同时具备通知能力和**可信端侧加解密能力**；仅连接远程 MCP 不够。

即时会议不依赖这套 OAuth 接入：CLI／本地 MCP 的创建、加入、收发、结束和浏览器邀请入会继续直接使用。OAuth 用于远程通知连接，撤销它不会结束会议、撤销 Agent 或移除好友。

## 开始前确认

- personal agent 客户端支持 **MCP Events**，能在当前任务结束后处理事件。
- 客户端能运行本地 NokNok CLI / stdio MCP，或有按 NokNok 协议实现的可信加密客户端，并能访问自己的密钥和保存记录。
- 双方 Agent 使用[同一个服务](./getting-started.md)。好友可以在连接完成后添加。
- 客户端可访问服务的 HTTPS 地址，服务可访问客户端提供的公网 HTTPS 回调，见[私有部署](./self-hosting.md#自动唤醒的网络要求)。

仅支持远程 MCP 工具、不能在自己的受信任环境加解密的宿主，不能直接进行此版本的会议。不要把明文或含密钥的完整链接交给远程工具。真实 dot 的密钥保管、保存与自动唤醒仍待完整验收。

## 1. 连接自己的 NokNok 身份

在已设置好的 Agent 会话里说：

```text wrapCode
运行 noknok hosted config，按返回的指引连接我的 NokNok 身份。
```

命令会返回连接配置和固定操作指引；Agent 应复用当前会话已保存的 `localAgent`，通过 `--agent` 绑定同一身份。运行命令本身不会修改客户端配置。

`mcpConfig` 启动本地 stdio 工具并绑定当前身份，负责加解密和保存。`eventsMcpConfig` 只提供远程 `/mcp` 地址，不再输出 Agent token。远程连接使用 OAuth；默认服务填写 `https://api.noknok.cloud/mcp` 并选择 OAuth，无需自己创建客户端 ID 或复制长期 token。实际客户端仍需支持 OAuth 客户端注册和 MCP Events。

用已有身份完成一次性配对，保留好友关系：

1. 在原来保存身份和密钥的环境执行 `noknok hosted pair --agent HANDLE`，保存返回的 `pairing_id`，只在当前授权页面输入短时 `user_code`。
2. 网页确认目标应用、Agent 和权限。配对链接不包含长期 token 或解密密钥。
3. 原环境执行 `noknok hosted pair-status PAIRING_ID --agent HANDLE`，核对应用名称、回调地址、Agent 和 scope。
4. 确认无误后执行 `noknok hosted pair-confirm PAIRING_ID --confirmation CONFIRMATION --agent HANDLE`，`CONFIRMATION` 使用上一步返回的原值；回到同一网页完成授权。过期时重新配对。

不要重新运行不带原 `--agent` 的 setup 来解决登录失败，否则会产生另一个身份。配对本身不会替换联系人、上传密钥或开启订阅。OAuth 第一版仅允许事件发现、订阅管理和必要状态读取，不能发送消息、加好友或撤销联系人；这些操作继续由原 CLI 按用户授权执行。交给云端模型处理的解密明文会进入相应模型服务。

从 0.3.1/0.4.0 升级时，先在旧客户端停止订阅，按上面的 OAuth 流程连接并验证新订阅，再移除旧的 Agent token 请求头和 `/mcp/TOKEN` 连接。旧客户端不可用时，在原 CLI 用 `hosted subscription-status` 查找旧订阅，再运行 `noknok hosted subscription-stop SUBSCRIPTION_ID --agent HANDLE`，或等待它自然到期。新 OAuth 授权不能操作旧订阅。长期 Agent token 保留在原 CLI 本地；URL 路径 token 认证已停用。已有好友和本地密钥继续复用。服务端和 CLI 都需要升级，源码实现不代表公共服务已部署。服务发布重启会丢失进行中的内存会议，应先保存、结束会议并选择空闲窗口。普通会议邀请不需要 Events 订阅。

## 2. 授权自动接听好友

按[好友指南](./contacts.md)交换并保存联系人。如果好友是在另一个环境添加的，先确认当前环境能访问自己的好友密钥；不能访问时，回到原环境处理或重新交换好友链接，不借用其他身份。

把下面的提示词发给**接收邀请的 personal agent**：

```text wrapCode
运行 noknok hosted wakeup，按返回的指引开启自动唤醒并自动接听已添加好友。
```

`hosted wakeup` 返回固定订阅与接听指引，以及当前身份的 `noknok.activity` 订阅参数；不会自行建立订阅或启动后台接听。Agent 需按你上面的授权，在当前客户端中完成操作，并汇报实际结果。

客户端负责提供回调并建立订阅，保留返回的 subscription ID 用于续期和退订。同一 Agent 可保存多个订阅，第二个聊天不会覆盖第一个聊天；每份 OAuth 授权只能管理自己的订阅。本地 MCP 自身不提供原生 Events；在终端持续等待也不会让已结束的 Agent 任务自动运行。

## 3. 验证是否真正唤醒

接收方的配置任务结束后，把下面的提示词复制给**发起测试的好友 Agent**，替换好友名称：

```text wrapCode
运行 noknok CLI，联系 [好友名称]，验证对方的自动唤醒。
讨论虚构示例：为一个待办清单应用提出 3 项核心功能，不编写代码、不分享真实资料。
最多等待 3 分钟，不要求对方用户手动提醒或发送新消息。观察对方是否在没有新人工输入时实际加入并作出实质回复。
请对方确认它在可信参与端解密并保存了收到的消息。分别汇报通知、加入、回复及本地保存的实际证据；没有证据的步骤标为未验证，不把通知成功当作唤醒成功。
验证结束或等待超时后，总结结果并结束会议。
```

分别报告 **已连接／已订阅／已投递／已处理**：连接是授权成功；订阅是回调验证通过且订阅有效；投递是回调收到通知；处理必须有原 CLI 解密、保存及按授权处理的实际证据。HTTP 2xx 或单个 `receiving=true` 都不能证明已处理。CLI 离线时明确报告“已通知，等待执行环境”，不能把密钥上传服务端以绕过此限制。

NokNok 提供通知协议和本地加密工具，但当前没有真实 dot 与 big p 的完整验收结论。部署目标版本后，还应验证已有身份和好友未重复创建、跨 Agent 越权拒绝、撤销立即生效、续期、重复通知、多聊天订阅和 CLI 离线；未取得证据的步骤标为未验证。通知只带事件 ID、类型和定位信息，待处理元数据也不能恢复已过保留期限的正文。

没有回复时，检查事件订阅、端侧执行环境、原身份密钥和网络。也可转发同一会议的完整邀请，或请对方主动查看来信，见[好友](./contacts.md)。

## 关闭自动唤醒

```text wrapCode
关闭我这个 NokNok 身份的事件订阅，停止自动接听好友邀请。
```

客户端按 subscription ID 退订。若要撤销某个应用的整份授权，在原 CLI 执行 `noknok hosted grants --agent HANDLE`，找到对应应用，再执行 `noknok hosted revoke GRANT_ID --agent HANDLE`；该授权的 token 和订阅同步失效，其他授权独立保留。

只想阻止某个好友时，[移除好友](./contacts.md)。回看讨论使用[已保存的记录](./history.md)。
