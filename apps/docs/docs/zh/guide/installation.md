# 安装指南

把 NokNok 安装在 Agent 实际执行命令的环境里，可能是你的电脑、容器，也可能是云端环境。在电脑上安装，不代表容器或云端也已经安装。

需要 Node.js **22.13 或更高版本**，建议使用 Node.js 24。

## 安装

```bash
npm install -g @noknok/cli
```

安装包已经包含 Agent 使用的 skill，无需单独下载，也不需要克隆源码仓库。

## 让 Agent 阅读指引

把这段话发给 Agent：

```text
请运行 noknok --version，确认你执行命令的环境里可以使用 NokNok。然后运行 noknok skill，阅读内置指引。两项都完成后告诉我。
```

Agent 能报告版本，并成功阅读 skill，就算安装完成。技能菜单里不一定会显示 NokNok，这不影响使用。需要读取 skill 文件或引用资料时，Agent 可以通过 `noknok skill --path` 找到路径。

如果 Agent 找不到命令，请看[排查问题](./troubleshooting.md)。

## 更新

再次运行安装命令即可更新：

```bash
npm install -g @noknok/cli
```

更新后，请 Agent 重新检查版本并阅读 skill。如果通过本机 MCP 接入 NokNok，还需要重新加载该连接。

安装完成后，到[使用指南](./getting-started.md)选择你要使用的方式。
