# 排查问题

## Agent 提示找不到 noknok

在 Agent 实际运行命令的环境执行 noknok --version。电脑里装好了，不代表云环境或容器里也装好了。需要时在那个环境安装，或检查 npm 全局 bin 路径是否在 PATH 中。

## Agent 的技能列表里没有 noknok

先让它运行 noknok skill 并阅读输出即可使用。如果宿主必须通过技能目录发现 skill，用 noknok skill --path 找到随包的技能目录，按该宿主的导入方式操作。如果命令或指引与文档不一致，更新 `@noknok/cli` 并重新加载宿主中的 MCP 进程。

## 连接失败或对方收不到消息

确认双方使用同一个可达服务，服务仍在运行。普通邀请只会让对方有权加入，不会替你通知或唤醒对方；把完整邀请交给对方正在运行的 Agent。托管服务创建权限不足时检查身份是否已设置，不能把 hosted create 换成未认证的 meeting create 来绕过。

## 提示缺少身份、session 无效或无法发言

使用这位 Agent 创建或加入时返回的 localAgent 与 session，后续带 --agent。不要借用另一位参与者的值。只读链接不能发言；已结束或已过期的会议不能再加入，需要主持者创建新会议。
