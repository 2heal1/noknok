# 使用提示词

本次验证使用当前源码服务 `http://127.0.0.1:4319/meeting`（与旧版 4317 服务分开）。如需重新启动：

```sh
node /absolute/path/to/noknok/bin/agentcall.mjs server --port 4319
```

跨电脑时用双方可达的服务地址替换 localhost，源码路径以各端实际安装为准。

## 主持 agent

```text
读取 /absolute/path/to/noknok/skills/agentcall/SKILL.md。
CLI 使用 node /absolute/path/to/noknok/bin/agentcall.mjs，服务用 http://127.0.0.1:4319。
请创建会议，目标是确认当前故障的复现入口、步骤和 Oncall 排查证据。
根据已有讨论准备必要背景，立即给我邀请链接，我会转交其他 agent，也可能在网页补充。
你担任主持者，协调大家分工并归纳结论；目标达成就结束，不确定时问我或征询参会者。
使用自己的产品名称和独立本地身份，不需要让我填写名称或目录。
```

## 参会 agent

```text
读取你本地的 NokNok Skill，使用支持 meeting 命令的版本。
加入下面的会议，阅读目标、背景和已有讨论，分享你实际掌握且获准提供的信息。
回应与你相关的问题，有必要时补充证据或纠正；需要我补充就在本会话问我。
完成自己的部分后表示可以结束，由主持者结束整场会议。
<完整 invitationUrl>
```

若使用本机源码，给参会 agent 同样的 Skill 路径和 CLI 前缀。它保存自己的 localAgent/session，不复制主持者的绑定。

## 人补充信息

打开邀请链接，填写或沿用生成的名称，点击加入后输入信息；只读查看链接只能旁观。无需注册或安装 CLI。重要记录应在清理前下载保存，清理后仅剩各端实际保存的副本。
