# Website maintenance

The website lives in `apps/docs`, a private pnpm workspace package named `@noknok/docs`, using Rspress 2, React, and TypeScript. It introduces NokNok and provides user guides. The communication service and actual meeting UI live in `packages/cli`. The website does not create meetings, handle identity credentials/chat data, or ship in the CLI npm package.

## Local development and build

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm website
```

The default preview is `http://127.0.0.1:3000`. To select a port or run package checks:

```sh
pnpm --filter @noknok/docs dev --port 4178
pnpm --filter @noknok/docs typecheck
pnpm --filter @noknok/docs build
pnpm --filter @noknok/docs preview --port 4178
```

Development and preview bind to loopback. Output goes to `apps/docs/doc_build`. [Docs Deploy](docs-deployment.md) publishes site/build-input changes from `main`; **Run workflow → main** redeploys only the website. It does not require npm publication or restart the communication service. Builds need development dependencies; static serving needs no Node service or model API key.

## Files and languages

| Content | Location |
| --- | --- |
| Rspress configuration, languages, theme | `apps/docs/rspress.config.ts` |
| Homepage | `apps/docs/theme/HomePage.tsx` |
| Knock animation, timing, styles | `apps/docs/theme/DoorIntro.tsx`, `door-intro.ts`, `intro.css` |
| Homepage translations | `apps/docs/theme/home-copy.ts` |
| Chinese user guides | `apps/docs/docs/zh/guide/*.md` |
| English user guides | `apps/docs/docs/en/guide/*.md` |
| Navigation and sidebar | Each language's `_nav.json` and `_meta.json` |
| Public images and brand assets | `apps/docs/docs/public/brand/` |

Repository maintainer documents under `docs/` use English. The user-facing website remains bilingual, with Chinese as the default language. Installation and usage routes are `/guide/installation` and `/guide/getting-started`; English adds `/en`. Rspress handles generated HTML, routing, search, sidebar, code copying, and language switching; there is no separate handwritten `guide.html` or translation runtime.

Keep installation separate from usage. The two primary user flows are instant invitations without a contact relationship and reaching an existing contact. People forward complete invitations to one another, then paste them into their own agent chats. Additional guides cover history, Events, self-hosting, troubleshooting, and brand sources. Update both user-guide languages together and verify commands against the CLI. Development uses pnpm; public installation uses `npm install -g @noknok/cli`.

## Product and presentation principles

NokNok connects existing agents for instant text conversations. It supplies invitations, transport, and meeting space; participants bring their own models and execution environments. A useful demonstration shows a concrete question, a follow-up, and agreed next steps with owners. An ordinary Claude Code/Codex session can participate when it can run NokNok and reach the same service; a persistent personal agent is not required.

Keep the centered headline, broad media area, two concise feature sections, and short self-hosting/source footer. Use near-white backgrounds, charcoal `#252823`, and ivory `#F7F3EA` media surfaces, with generous spacing. Preserve readable mobile layouts, visible keyboard focus, and reduced-motion behavior. Use official vectors rather than recreating the logo with CSS or text.

Illustrations must be labeled as such. A successful webhook, an animated conversation, or a role named dot/Grokbot is not evidence of verified native-host compatibility. Instant delivery applies to connected participants receiving messages; model generation, host scheduling, and networking still affect response time. Do not promise zero latency, automatic replies from every offline agent, or voice/video features.

State self-hosting conditions accurately: all participants need network access to the same service; cloud hosts also need supported Events and trusted endpoint execution for wake-up. Different origins have independent identities. Current callbacks require public HTTPS, so a private network alone does not establish native background wake-up. Keep encryption and acceptance claims aligned with [E2EE](e2ee.md) and the [launch checklist](launch-checklist.md).

The planned recording in [demo-script.md](demo-script.md) provides reusable synthetic prompts and a storyboard. Until a recording exists, keep the illustrative state visible. A future player needs a real tested media URL, captions/transcript, user-initiated playback, and a mobile check; do not display a working-looking play control with no video.

## Knock introduction

The existing 10.2-second introduction knocks, opens the door, moves the camera inside, then reveals four illustrative messages. It supports pause/resume, skip, and replay, pauses outside the viewport or in a hidden tab, and shows the full conversation under `prefers-reduced-motion`. Unmounting releases animation frames, observers, and listeners. It accesses no service, model, or real conversation.

The inline SVG uses the approved door mark's geometry and colors. If the brand changes, update `DoorIntro.tsx` and `apps/docs/docs/public/brand/mark.svg` together.

## Brand assets

`docs/brand` is the source of truth. Export there first, then sync copies to `apps/docs/docs/public/brand/` and keep `apps/docs/docs/public/icon.svg` aligned with the official favicon. Preserve proportions, clear space, accessible alternative text, and small-icon readability. Use `logo-compact.svg` for navigation, `mark.svg` for standalone marks, and `wordmark.svg` for the footer.

Third-party product marks identify the illustrated agents:

- dot uses the original SVG from OpenAI's [dot page](https://chatgpt.com/zh-Hans-CN/features/dots/), subject to the [OpenAI brand guidelines](https://openai.com/brand/).
- The Grok Bot PNG was supplied by the user; its download provenance was not independently verified. Preserve its proportions, colors, and transparency; consult the [Grok brand guidelines](https://x.ai/legal/brand-guidelines).
- The Claude Code icon comes from Anthropic's [official extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). Its [name and logo terms](https://code.claude.com/docs/en/legal-and-compliance) apply separately.

Source attribution does not establish permission, partnership, endorsement, or completed host integration. NokNok's own Apache-2.0 terms and attribution requirements are in [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

## Verification

After copy/navigation changes, run documentation typecheck and build. When changing site behavior or layout, inspect language switching, home/getting-started pages, copied commands, search, sidebar, keyboard access, and narrow screens in preview. CLI package checks must exclude `doc_build`, React/Rspress dependencies, and development source from published packages.
