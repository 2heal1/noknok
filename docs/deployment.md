# 自部署

NokNok 的邀请会议只需要 Node.js 22+ 和参与者可访问的服务地址。`/meeting` 展示多人会议并允许人补充信息；旧两方查看页 `/view` 保留；健康检查为 `/health`。同一个进程提供网页和 API，不运行模型。

当前会议仅暂存在内存，无需数据库。服务端独立好友接入、订阅持久化和内测码仍是 [公共内测计划](public-beta-plan.md) 中的待实现能力。

## 本机运行

在仓库根目录执行：

```sh
node bin/noknok.mjs server --port 4317
```

默认地址是 `http://127.0.0.1:4317`。会议由 Agent 调用 CLI/MCP 创建，网页展示沟通并支持人工加入；没有会议链接的 `/meeting` 只显示提示和本地记录。

## 跨机器或企业自部署

使用参与者实际可达的地址，HTTPS 可由已有网关或反向代理提供：

```sh
node bin/noknok.mjs server --host 0.0.0.0 --port 4317 \
  --public-url https://relay.example.com \
  --meeting-ttl-seconds 7200 --retention-seconds 600
```

将示例域名替换为自己的地址。`--public-url` 只设置邀请中的 origin，不申请证书或创建代理。`0.0.0.0` 是监听地址，不是给参会者的地址；不同机器上的 localhost 指向各自机器。企业部署可以使用双方实际能访问的内网地址。

设置 `AGENTCALL_SERVER_KEY` 可限制会议创建；通过受控环境给发起端提供同一密钥，受邀者仍使用独立邀请加入。这个共享创建密钥不等于内测码或多租户认证。不要把密钥放进公开邀请或源码。

## Docker

```sh
docker build -t noknok:local .
docker run --rm -p 4317:4317 -e AGENTCALL_SERVER_KEY noknok:local \
  --public-url https://relay.example.com
```

先在当前 shell 安全配置创建密钥。镜像使用公开 Node 镜像，不需要专有构建平台或包源。HTTPS 入口仍由反向代理提供，代理需支持至少 45 秒的长轮询及并发请求；本版服务不支持子路径挂载。

## 通用环境变量入口

需要由平台分配端口或配置明确的会议数量上限时，可以使用通用 Node 入口：

```sh
AGENTCALL_PUBLIC_URL=https://relay.example.com PORT=8080 node deploy/server.mjs
```

| 名称 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口，默认 8080 |
| `AGENTCALL_PUBLIC_URL` | 参与者可达的服务 origin；该入口必填，不含路径 |
| `AGENTCALL_MEETING_TTL_SECONDS` | 创建后最长开放时间，默认 7200 秒 |
| `AGENTCALL_RETENTION_SECONDS` | 结束/过期后的内存保留期，普通模式默认 600 秒，网关模式默认 60 秒 |
| `AGENTCALL_MAX_MEETINGS` | 保留会议数量上限，通用部署入口默认 50 |
| `AGENTCALL_MAX_CALLS` | 保留旧两方通话数量上限，通用部署入口默认 50 |
| `AGENTCALL_SERVER_KEY` | 可选创建/登记密钥，不写入邀请 |
| `AGENTCALL_GATEWAY_ENABLED` | `1` 启用现有本机接收器网关；默认关闭 |
| `AGENTCALL_MCP_POC_ENABLED` | `1` 启用固定合成身份 PoC；不能与网关同时启用 |

`AGENTCALL_*` 配置名称保留协议兼容。PoC 凭据及本地状态配置见 [MCP Events 实验](mcp-events-poc.md)。

## 现有后台接收器网关

`deploy/compose.gateway.yaml` 提供 Caddy 和现有通信网关，可用于受控验证。先配置 `AGENTCALL_DOMAIN` 和登记密钥，再构建启动；完整步骤见 [后台接收说明](background-receiver.md)。

该模式依赖用户电脑上的接收器，订阅和联系人存放在接收器本地。Compose 不给应用持久数据卷，TLS 卷只保存证书。它不能作为“个人电脑离线也可接听”的部署方案；后者仍待实现。当前没有真实公网 TLS、原生 dot 自动唤醒或容器构建验收结果。

## 数据与验收边界

会议默认自创建起最多开放 2 小时，结束或过期后再保留 10 分钟；读取不会续期。服务重启、升级或崩溃清空全部内存会议与查看链接。各参与端保存自己实际收到的记录；服务能看到转发明文，不是端到端加密。

单进程内存状态不能随机负载均衡到多个副本。小型服务器需配置合理容量上限，不应把默认上限当成压测结果。平台和代理日志应避免记录正文、Authorization 和能力凭据 URL。

部署后检查健康接口、页面加载、多人加入/收发、主持权限、只读鉴权、长轮询以及结束/过期清理。宿主实际唤醒需另行测试，不能用合成回调或 HTTP 200 代替。[会议协议](meeting-contract.md) · [验收说明](validation.md)
