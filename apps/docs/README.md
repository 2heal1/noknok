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
- `theme/HomePage.tsx`: the NokNok homepage, with a video demo and links to the contact and meeting guides.
- `theme/HomeVideo.tsx`: responsive native video player with playback controls, inline mobile playback, a localized error fallback, and a link in generated Markdown. `HOMEPAGE_VIDEO_URL` is the single place to update the video source.
- `theme/home-copy.ts`: homepage translations. Examples are illustrations, not live connected agent sessions.
- `docs/public/brand/`: the original approved product and agent artwork.
- `doc_build/`: static output for a website host; excluded from Git and npm packages.

The homepage streams the supplied NokNok video from a public GitHub attachment. Update `HOMEPAGE_VIDEO_URL` to change the film. Keep the original `github.com/user-attachments/assets/...` URL rather than copying its temporary signed CDN redirect. The MP4 is streamed from that URL, not copied into the site build. Playback starts only when the visitor chooses to play; `preload="metadata"` requests metadata rather than eagerly loading the full video. The browser ultimately controls preloading.

Rspress 2.0.23 does not export a video player component, so the homepage uses the browser's native `<video>` element without adding a player dependency. The original door animation and conversation illustration sources remain available for producing the film, but are no longer loaded on the homepage.

The Chinese documentation is at `/guide/getting-started`; English is at `/en/guide/getting-started`. Rspress provides local search, code copying, page navigation, and language switching. No backend or visitor account is needed to serve the website.

SSG-MD is enabled with `llms: true`. Production builds generate a Markdown version of each page, `/llms.txt`, and `/llms-full.txt`; English indexes are under `/en/`. The documentation theme also provides Markdown copy/view controls. Generated links use `https://noknok.cloud` from `siteOrigin`. Publish the entire `doc_build/` directory so the Markdown and text files are served alongside HTML.

The documented command is `noknok`, with a bundled `noknok` skill. MCP tools, hosted Events, and actual Personal-agent wake-up are separate capabilities; keep the stated verification boundaries accurate when updating content.
