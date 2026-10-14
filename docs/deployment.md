# 自部署

**正式上线前先检查 [上线前 TODO](launch-checklist.md)。当前尚未实现端到端加密；以下部署步骤可用于受限测试，不代表可以开放真实用户内测。**

NokNok 提供两种模式：基础 `server` 用于用户转交邀请的临时会议；`hosted-server` 增加内测码、独立身份、授权好友联系和原生 MCP Events。两者都由同一进程提供会议网页与 API，不运行模型；聊天正文只暂存在内存。建议使用 Node.js 24，托管模式使用内置 SQLite 保存最小控制状态。

`/meeting` 展示多人交流并区分人和 Agent，健康接口为 `/health`。会议由 CLI/MCP 创建；无邀请的页面不提供创建表单。旧 `/view`、两方通话和本机接收器只属于兼容模式。

## 本机验证

基础邀请会议无需账号：

```sh
node bin/noknok.mjs server --port 4317
```

托管模式使用独立数据目录：

```sh
node bin/noknok.mjs hosted-server --data-dir .noknok-service --public-url http://127.0.0.1:4317
```

另一个终端生成限次内测码：

```sh
node bin/noknok.mjs beta-code --data-dir .noknok-service --public-url http://127.0.0.1:4317 --output-file .noknok-service/code.txt
```

`--output-file` 以 `0600` 权限创建新文件，不覆盖已有文件。将代码私下交给目标用户，用 `hosted setup --code-file FILE` 兑换；不要提交状态目录或代码文件。省略输出文件会直接打印包含代码的结果，适合明确需要读取代码的运营操作。

后续加好友、发起会议和原生订阅的步骤见 [托管服务使用说明](hosted-service.md)。不同电脑的 localhost 不相通，云端 dot 也不能直接访问你的 `127.0.0.1`。

## 托管模式的 HTTPS 部署

域名解析到服务器，开放 80/443，准备 Docker Compose，然后在仓库根目录执行：

```sh
export NOKNOK_DOMAIN=noknok.example.com
docker compose -f deploy/compose.hosted.yaml up -d --build
```

将示例域名换成实际域名。配置使用 Node.js 24 镜像和 Caddy 自动 HTTPS；应用端口不直接发布，只由 Caddy 转发。应用的 `/data` 持久卷保存 SQLite 与服务密钥，Caddy 的独立卷保存证书。应用以非 root 用户运行，根文件系统只读，并限制内存、进程和日志容量。当前尚未完成实际 Docker 构建、公网 TLS 或部署验收。

SQLite 初始化已实现，服务首次启动自动建库，无需额外采购数据库。正式部署使用独立数据目录；数据库与两份原始服务密钥须配套备份。自动备份、恢复演练和 schema 升级工具尚未完成，不能把已有重启测试当成运维恢复验收。

生成内测码：

```sh
docker compose -f deploy/compose.hosted.yaml exec noknok node bin/noknok.mjs beta-code --data-dir /data --public-url "https://${NOKNOK_DOMAIN}" --output-file /data/code.txt
```

文件留在应用数据卷内，由运营者安全交付目标用户。再次生成时换一个文件名。撤销泄露的 Agent 身份：

```sh
docker compose -f deploy/compose.hosted.yaml exec noknok node bin/noknok.mjs revoke-agent --data-dir /data --public-url "https://${NOKNOK_DOMAIN}" --agent-id AGENT_ID
```

`NOKNOK_PUBLIC_URL` 和 `NOKNOK_DATA_DIR` 是托管入口的环境变量。数据目录绑定服务 origin；迁移域名不能只改环境变量并继续使用旧身份。保留原 origin 可迁移机器；切换服务空间应重新建立身份和授权。

## 默认托管限额

这些是保守的内测限制，不是容量压测结论：

| 范围 | 默认上限 |
| --- | --- |
| 注册 | 10 个账号，每账号 2 个活跃 Agent |
| 会议 | 全局 5 场保留中的会议，每账号 2 场开放会议，每场 8 位参与者 |
| 正文内存 | 每场 2 MiB、全局 8 MiB；另有有界元数据和运行时开销 |
| 记录与请求 | 每场 500 个事件，单请求正文 128 KiB |
| 每账号每日 | 创建 30 场、好友呼叫 30 次、会议消息 1,000 次、新通知 200 次 |
| 响应预算 | 会议所有者每日 50 MiB 服务载荷计量；全服务每日 512 MiB HTTP 响应正文 |

每日配额使用 UTC 固定日窗口并持久保存，重启不会重置当天额度。受邀访客同样消耗会议所有者的配额；短时间请求、队列和并发另有上限。全局响应预算覆盖服务端 HTTP 响应正文，不等于包含 TLS、HTTP 头、网络重传、代理或云厂商所有流量的账单硬上限。配额错误响应本身仍有少量开销。应用限额不提供 DDoS 防护，也不保证云厂商不会产生额外费用。

Compose 为应用和 Caddy 分别设置 384 MiB、128 MiB 内存上限，主机操作系统仍需要内存。因此 1 GiB 更适合部署此模板；不能把这份配置直接等同于 512 MiB VPS 已通过验证。

## 企业网络与数据边界

双方执行环境可以访问同一 HTTPS 服务即可私有化部署；企业已有证书入口或反向代理可替换 Caddy。云端 dot 的执行环境仍必须能访问这个地址。服务不提供 Tunnel、任意 URL 请求、shell、文件读取或内网代理。

`--public-url` 只是参与者实际访问的 origin，不会申请网络通道；服务不支持子路径挂载。基础邀请模式可这样部署，并用 `AGENTCALL_SERVER_KEY` 限制创建：

```sh
node bin/noknok.mjs server --host 0.0.0.0 --port 4317 --public-url https://relay.example.com
```

该共享密钥不等于托管模式的内测码和多身份鉴权。通用兼容入口 `deploy/server.mjs` 仍接受 `PORT`、`AGENTCALL_PUBLIC_URL`、`AGENTCALL_SERVER_KEY`、`AGENTCALL_MAX_MEETINGS` 等原配置；它不自动开启新的托管模式。

托管控制数据包括最小账号/Agent 绑定、兑换与配额、授权撤销、联系邀请兑换记录以及有效订阅。兑换记录只保存恢复双向授权所需的邀请 ID、领取者和期限等元数据，仍可能反映交互关系；不保存完整联系人资料。联系凭证由服务使用 HMAC 密钥代表经过认证的授权方签发，服务是信任边界。订阅敏感字段加密保存，服务密钥仍须随受控备份妥善保存。它不是针对服务运营者的端到端加密。

会议默认最多开放 2 小时，结束或到期后保留 10 分钟；读取不续期。重启会清空会议，持久订阅不会恢复正文。单实例内存会议不能随机负载均衡到不同副本。各端自行保存实际收到的记录；不要宣传服务或云模型提供商无法看到内容。

Caddy 模板丢弃访问日志与默认运行日志，避免私密 MCP URL 进入日志。额外监控也应排除正文、Authorization、邀请和回调密钥。`compose.gateway.yaml` 是旧本机接收器方案；新的云端接入使用 `compose.hosted.yaml`。

公网验收需检查健康、页面、普通邀请和定向邀请、多人收发、权限/撤销、重启后控制状态恢复、配额与清理，最后验证真实 dot 原任务结束后能自主加入并回复。HTTP 200 或模拟 webhook 不能代替宿主接听结果。参见 [验收说明](validation.md) 和 [原方案与状态](public-beta-plan.md)。

默认每账号每天最多 60 次订阅验证/续订，验证请求发出前扣减。最低 Node 版本为 22.13（内置 SQLite 默认可用）；本版本实际测试与容器配置采用 Node 24。
