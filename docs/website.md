# 官网与文档站

官网位于 `apps/docs`，使用 Rspress 2、React 和 TypeScript，属于根目录 pnpm workspace 中的私有包 `@noknok/docs`。它与 `packages/cli` 的实际会议服务分开：官网介绍产品和用法，不创建会议、不接触身份凭据或聊天数据，也不随 CLI npm 包发布。

## 本地开发与构建

在仓库根目录运行：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm website
```

默认在 `http://127.0.0.1:3000` 预览。也可以只运行文档包并指定端口：

```sh
pnpm --filter @noknok/docs dev --port 4178
pnpm --filter @noknok/docs typecheck
pnpm --filter @noknok/docs build
pnpm --filter @noknok/docs preview --port 4178
```

`dev` 和 `preview` 都绑定回环地址。构建产物位于 `apps/docs/doc_build`。部署时将整个产物目录发布到静态托管服务；不要把仓库根目录当成站点根目录。构建需要安装开发依赖，部署后的页面不需要 Node 服务或模型 API Key。

## 修改位置

| 内容 | 文件或目录 |
| --- | --- |
| Rspress 配置、语言与主题设置 | `apps/docs/rspress.config.ts` |
| 官网首页组件 | `apps/docs/theme/HomePage.tsx` |
| 敲门动画组件、时序与样式 | `apps/docs/theme/DoorIntro.tsx`、`door-intro.ts`、`intro.css` |
| 首页中英文文案 | `apps/docs/theme/home-copy.ts` |
| 中文指南 | `apps/docs/docs/zh/guide/*.md` |
| 英文指南 | `apps/docs/docs/en/guide/*.md` |
| 顶部导航与侧栏 | 对应语言目录的 `_nav.json`、`_meta.json` |
| 对外静态图片和品牌资源 | `apps/docs/docs/public/brand/` |

中文为默认语言，入门路径是 `/guide/getting-started`；英文为 `/en/guide/getting-started`。静态构建会生成对应 HTML，导航和链接交给 Rspress 处理。搜索、侧栏、代码复制和语言切换使用 Rspress 能力，不再维护独立 `guide.html` 或手写文档翻译运行时。

当前指南覆盖安装、会议、人工补充、好友、MCP Events、私有部署、排障和品牌来源。更新用户操作时，中文与英文都要同步；命令要与实际 CLI 一致。开发命令使用 pnpm；普通用户安装公开包仍使用 `npm install -g @noknok/cli`。

首页保留 NokNok 已有的品牌、简洁布局与场景展示。示意场景只说明产品目标；不能把可点击动画或合成回调写成真实 dot 自动唤醒已验收。尚未实现端到端加密、真实宿主唤醒待验证等边界需与[上线清单](launch-checklist.md)一致。

## 敲门开场动画

保留 PR #11 的 10.2 秒开场：敲门、开门、镜头进入，然后四条示意消息依次出现。组件提供暂停/继续、跳过、重播；离开视口或浏览器标签时暂停，`prefers-reduced-motion` 下直接展示完整对话。组件卸载时释放动画帧、观察器和事件监听。动画不访问服务、模型或真实会话。

动画内联 SVG 使用已批准门标的原路径与颜色。更新品牌时同时更新 `DoorIntro.tsx` 和 `docs/public/brand/mark.svg`；不要单独重画标志。

## 品牌资源

NokNok 原始品牌资料在 `docs/brand`；站点使用复制到 `docs/public/brand` 的导出资源，不从其他源码目录读取文件。修改品牌时先更新原始资源，再同步网站；保持比例、留白与可访问替代文本，检查小尺寸图标。不要重新绘制已有标志。

产品场景中的第三方标志仅用于标识对应 agent：

- dot 使用 OpenAI [dot 页面](https://chatgpt.com/zh-Hans-CN/features/dots/)的原始 SVG，遵循 [OpenAI 品牌指南](https://openai.com/brand/)。
- Grok Bot PNG 来自用户提供的素材，未经独立下载来源核验；保留比例、颜色和透明度，使用受 [Grok 品牌指南](https://x.ai/legal/brand-guidelines)约束。
- Claude Code 图标来自 Anthropic 的[官方扩展](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)，不是自制标志。[其名称与标志条款](https://code.claude.com/docs/en/legal-and-compliance)另有使用条件。

这些来源记录不代表授权、合作、背书或完成宿主集成。

## 验证

文案或导航更新后至少执行文档包 typecheck 和 build，并在预览中检查：中英文切换、首页和入门页、复制命令、搜索、侧栏以及窄屏。CLI 的包检查还需确认 `doc_build`、React/Rspress 依赖和开发源码不会意外进入发布包。
