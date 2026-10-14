# 官网与文档独立部署

`Docs Deploy`（`.github/workflows/docs.yml`）只发布 `apps/docs/doc_build/` 静态网站，不发布 npm、不运行服务部署、不接触身份与聊天数据。修改 `apps/docs/**`、相关工作区依赖/构建配置或部署脚本并合入 main 后自动执行。

需要单独重部署时，在 GitHub Actions 选择 **Docs Deploy → Run workflow → main**。它与 **Release → Run workflow** 的 preview 发包含义不同。仅 main 可取得文档部署凭据；PR CI 和其他分支不能部署。

## 凭据与权限

配置独立 environment `noknok-docs-production`，仅允许 main，无额外人工审批：

| 类型 | 名称 | 含义 |
| --- | --- | --- |
| Variable | `NOKNOK_DEPLOY_HOST` | 已核验的 SSH 主机 |
| Variable | `NOKNOK_DEPLOY_PORT` | SSH 端口 |
| Variable | `NOKNOK_DOCS_URL` | 文档站 HTTPS origin |
| Secret | `NOKNOK_DOCS_SSH_KEY` | 文档专用 Ed25519 私钥 |
| Secret | `NOKNOK_DEPLOY_KNOWN_HOSTS` | 事先独立核验的主机公钥记录 |

专用账号 `noknok-docs` 没有 sudo、Docker 或任意 shell 权限，公钥使用 `restrict` 与 root-owned forced command。它只接收 `docs <完整提交 SHA>` 和 stdin 中的静态归档。不会把管理员或服务部署私钥交给该工作流。

服务器限制压缩与展开大小、条目数量，拒绝路径穿越、隐藏路径、符号/硬链接、设备文件及重复条目；要求完整站点首页和入门页。通过后写入新目录，原子切换 `current` 链接，保留旧目录。CI 再核对公网 HTTPS 的 `/_noknok_deployment.json` 是否等于本次提交。正文和授权凭据不得放入文档内容。

## 一次性服务器配置

在 root-owned、其他用户不可写的源码目录运行：

```sh
python3 deploy/docs/install.py --public-key /root/noknok-docs-ci.pub
```

此脚本复用 `deploy/release/install.py` 中的 SSH 策略检查，因此安装时同时保留这两个目录。服务器只接收公钥；私钥留在管理端或 runner。安装程序只配置账号和固定入口，不自动改变 Caddy。

- 发布程序：`/usr/local/lib/noknok-docs/publish.py`，root 所有。
- SSH 入口：`/usr/local/libexec/noknok-docs-ssh`，root 所有。
- 静态发布目录：`/var/lib/noknok-docs/releases/`，由文档专用用户写入。
- 当前站点：`/var/lib/noknok-docs/current`，相对链接到已校验发布目录。
- 发布状态：`/var/lib/noknok-docs/state.json`，包含提交与前一目录，不含秘密。

管理员应用 `deploy/docs/compose.caddy.yaml` 作为现有 Caddy 的 override，配置 `NOKNOK_CADDYFILE`、`NOKNOK_DOCS_ROOT=/var/lib/noknok-docs`、`NOKNOK_DOCS_DOMAIN`；使用 `deploy/docs/Caddyfile` 的 API 与网站双域名模板。仅重建 Caddy 以添加只读目录挂载；保留证书卷，不重建应用容器。先验证 Caddy 配置，再进行切换。之后每次文档更新只切换静态链接，不需要重启 Caddy 或应用。

域名必须解析到服务器并允许 80/443；证书仍由 Caddy 管理。文档域名与 API 域名应分开。手工排查使用 HTTPS、当前状态与文件摘要，不关闭 TLS 或 SSH 主机校验。

自动清理旧文档发布目录尚未配置；排障或清理应避开 `current` 与状态中记录的前一目录。不要清理应用数据卷。
