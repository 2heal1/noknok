# 稳定版发布后的自动部署

本流程面向托管服务维护者。它只自动更新程序，不开放注册、不生成内测码、不完成端到端加密或原生宿主验收。网站是独立静态产物，不随本流程部署。

## 触发与失败处理

`release.yml` 的 stable job 发布精确版本并验证 npm `latest` 后，才输出 `published-version`。依赖它的 deploy job 使用 `noknok-production` 环境，执行 `scripts/deploy-hosted.ts`。有待发布 Changesets 的普通合入只更新版本 PR，不部署；`workflow_dispatch` 仍只发布 preview，也不部署。npm 发布失败或校验失败时不会获得部署版本。

发布和部署共用不取消进行中任务的并发组，服务器还会加独占锁。部署失败会使 Release 显示失败，但**不能撤回已经成功的 npm 发布**。修复部署问题后可重跑失败的 deploy job；它使用原稳定版本，不重新发布。若重跑完整工作流，已存在的不可变 npm 版本会跳过上传，再做版本验证。

## GitHub 环境

创建 `noknok-production` environment，只允许 `main` 分支部署。自动模式不配置人工等待审批。npm 的可信发布者仍是无 environment 的 `release.yml`：不要给 stable job 添加 environment，以免改变原 OIDC 身份。

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `NOKNOK_DEPLOY_HOST` | SSH 主机名或 IPv4 地址 |
| Variable | `NOKNOK_DEPLOY_PORT` | SSH 端口，默认 22 |
| Variable | `NOKNOK_PUBLIC_URL` | 用于 HTTPS 健康检查的 origin |
| Secret | `NOKNOK_DEPLOY_SSH_KEY` | 专用 `noknok-deploy` 用户的私钥，不使用管理员私钥 |
| Secret | `NOKNOK_DEPLOY_KNOWN_HOSTS` | 通过可信渠道事先核验的主机公钥记录 |

服务器必须允许 GitHub runner 访问 SSH 与公网健康地址。不使用 `StrictHostKeyChecking=no`，不在 CI 临时运行 `ssh-keyscan` 后直接信任结果。主机换钥匙时，由管理员重新核验后更新 Secret。

私钥通过受限文件或 stdin 写入 GitHub Secret，不粘贴进 issue、PR、日志或配置示例。执行期间仅写到 runner 的 `0700` 临时目录、`0600` 文件，结束后删除；SSH 子进程不继承包含私钥的环境。GitHub Environment 的 Secret 仍是发布系统的信任边界，能修改并合入部署代码的人也必须可信。

## 服务器一次性安装

先按[自部署说明](deployment.md)建立 Docker/Caddy 实例。服务器需要 Linux、Docker Compose、Python 3、curl、sudo、OpenSSH；现有实例的 Compose 和环境文件用于首次失败回滚。以下部署文件由管理员安装为 root 所有，CI 无权替换：

- `/usr/local/libexec/noknok-deploy-ssh`：只接受 `deploy X.Y.Z`，拒绝其他命令、参数和预发布版本。
- `/usr/local/sbin/noknok-release-deploy`：固定部署策略、并发锁、健康检查、回滚。
- `/usr/local/lib/noknok-deploy/`：固定 Dockerfile、下载校验代码、Compose 和 Caddy 模板。
- `/etc/noknok/deploy.json`：实际域名、项目名、external 卷名、首次接管的 Compose/env 路径，权限 `0600`。
- `/var/lib/noknok-deploy/`：当前/上一版快照、镜像 ID、部署状态与锁，禁止普通用户读取。

以 `deploy/release/deploy.example.json` 创建真实配置，放在受限位置，勿提交。需要全新测试状态时，使用新的 control 卷名；原卷保持不变。Caddy 证书卷复用。安装器用**公钥文件**建立专用账户和 forced command，私钥留在管理端与 GitHub Secret 中；该账户不加入 docker 组、不允许交互 shell/转发，仅能通过 sudo 调用固定部署命令。

将已审阅的部署文件放到 root 所有、其他用户不可写的目录中。输入配置和公钥也必须满足这个权限要求；从另一台机器传输 tar 时使用 `tar --no-same-owner`，避免继承另一台机器的 UID。管理员执行：

```sh
bash /root/noknok-source/deploy/release/install.sh \
  --public-key /root/noknok-ci.pub \
  --config /root/noknok-production.json
```

安装器验证 SSH 有效配置和 sudoers，只初始化新的 control 卷，不切换应用或修改 sshd 配置。安装完成后，用专用 key 验证普通命令与端口转发被拒绝。已有安装默认拒绝覆盖；更新固定程序或公钥需要显式 `--update`，且已有部署配置必须完全一致。修改域名或卷需要另外制定迁移步骤。应用版本发布不会自动替换部署程序。

## 版本与回滚

服务器只从 `https://registry.npmjs.org` 获取 `@noknok/cli` 的精确稳定版本，拒绝跳转和其他下载地址，核验名称、版本及 SHA-512 完整性。当前策略只允许没有运行时依赖的包；增加依赖时须同步审查部署策略。安装禁用生命周期脚本，构建时检查编译入口与 CLI 版本；构建失败不会切换线上实例。

切换只更新 NokNok 容器，不重建 Caddy、不执行 `compose down`、不删除持久卷。部署成功需要镜像 ID 一致、容器健康及公网 HTTPS `/health` 检查通过。失败会尝试恢复上一套镜像、Compose 和卷配置。自动回滚失败或进程中断时保留 pending 状态，后续自动部署会停下，避免覆盖不确定状态。

管理员先检查状态，再按需执行：

```sh
sudo cat /var/lib/noknok-deploy/state.json
sudo /usr/local/sbin/noknok-release-deploy rollback previous
```

状态不含聊天正文或密钥，但会暴露部署路径，应仅限管理员。CI 身份不能调用 rollback。自动部署拒绝低于已部署最高稳定版本的请求；重复部署当前版本只重新验健康。

**镜像回滚不是数据库回滚。** 对同一卷的 schema 或密钥做不兼容变更前，必须配套备份、恢复演练或改用新卷；部署程序不擅自恢复数据库覆盖新数据。会议正文只在内存中，任何应用重启都可能中断活动会议。

## 凭据检查

`pnpm check` 包含 `pnpm check:secrets`，扫描受版本控制文件中的常见凭据格式和敏感路径，仅输出位置、不输出匹配值。管理员还可以运行 `pnpm exec tsx scripts/check-secrets.ts --history` 扫描本地可达历史。扫描不能保证发现任意编码或图片中的秘密；发现真实泄露时先撤销/轮换，再处理历史，仅删除当前文件不够。

环境变量是注入机制，不是加密存储。实际密钥只放 Secret、密钥管理器或受限文件；即使运维仓库私有，也只提交变量名、路径、用途和恢复步骤。每个实例的主机、卷和配置位置由其运维文档维护。
