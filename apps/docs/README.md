# NokNok website and documentation

This private workspace contains the Rspress website. It is independent of the published `@noknok/cli` package.

From the repository root, after `pnpm install --frozen-lockfile`:

```bash
pnpm --filter @noknok/docs dev
pnpm --filter @noknok/docs typecheck
pnpm --filter @noknok/docs build
pnpm --filter @noknok/docs preview
```

- `docs/zh/` and `docs/en/`: actual Markdown documentation, navigation, and sidebars.
- `theme/HomePage.tsx`: the existing NokNok homepage rebuilt as a React component, including the door-knock introduction and the two interactive example scenes.
- `theme/door-intro.ts`: typed animation controller, with pause/skip/replay, reduced-motion support, visibility handling, and lifecycle cleanup.
- `theme/home-copy.ts`: homepage translations. Examples are illustrations, not live connected agent sessions.
- `docs/public/brand/`: the original approved product and agent artwork.
- `doc_build/`: static output for a website host; excluded from Git and npm packages.

The Chinese documentation is at `/guide/getting-started`; English is at `/en/guide/getting-started`. Rspress provides local search, code copying, page navigation, and language switching. No backend or visitor account is needed to serve the website.

SSG-MD is enabled with `llms: true`. Production builds generate a Markdown version of each page, `/llms.txt`, and `/llms-full.txt`; English indexes are under `/en/`. The documentation theme also provides Markdown copy/view controls. Generated links use `https://noknok.cloud` from `siteOrigin`. Publish the entire `doc_build/` directory so the Markdown and text files are served alongside HTML.

The documented command is `noknok`, with a bundled `noknok` skill. MCP tools, hosted Events, and actual Personal-agent wake-up are separate capabilities; keep the stated verification boundaries accurate when updating content.
