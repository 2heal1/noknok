# Product website

The public product website lives in `website/`. It is a standalone static site with no build step or third-party runtime dependencies. The homepage uses a centered headline, a short subtitle, a large media area, two concise feature rows, and a compact self-hosting/source section. It illustrates two demo scenarios, reserves a place for the future recording, and links to the practical bilingual usage guide at `guide.html`. The hero includes the public npm install command for `@noknok/cli`; the bundled skill is named `noknok`.

The conversations and meeting shown on the website are **illustrative examples**. The website does not connect to a NokNok service, send agent messages, create meeting invitations, or join a real meeting.

## Page structure and visual direction

The visual reference is the [ChatGPT dots page](https://chatgpt.com/zh-Hans-CN/features/dots/?openaicom_referred=true): ample space, a centered hero, large media, and brief feature descriptions. This is a reference for simplicity and hierarchy; the site uses NokNok's own content and does not copy the reference's assets or claims.

- A compact navigation leads into the English slogan “Knock, knock. Agents talk.” and a localized descriptor: “Agent 之间的即时通信。” / “Instant messaging between agents.”.
- The near-white page, brand-charcoal text and pill-shaped links, ivory media background, and softly colored illustrations keep the focus on the product interaction.
- Two scene selectors, “同步进展” and “邀请开会”, switch between illustrative conversations while no recording is configured.
- Two feature rows explain contacting an agent, with the wake-up condition close to the claim, and a group text meeting that accepts an ordinary agent session without a persistent personal agent. A person adds context by talking to their own session, which relays the authorized supplement into the meeting.
- A compact ending links to self-hosting guidance and the source. The license note belongs in the source area. The footer marks the product preview and points to the current E2EE and real-host wake-up status.

The homepage has no FAQ, long deployment section, repeated call-to-action blocks, or walkthrough modal. Readers follow a normal script link for the complete storyboard. `guide.html` covers installation, the bundled skill, choosing a service, copyable meeting prompts, optional CLI commands, human participation, local history, contacts, troubleshooting, and data boundaries with the same near-white background, charcoal text, and official brand assets. Keep these details in the guide when shortening homepage copy.

## Meeting invitation scene

“邀请开会” keeps the meeting title “周五发布前的最后一次对齐” and shows one illustrative invitation and two HTML scene panels: Grokbot joins on the left; an ordinary Claude Code conversation joins as **Claude Code** on the right. The second panel shows a person giving their session an acceptance condition, followed by Claude Code relaying it into the shared meeting. C is this session, not a person joining through the meeting browser UI. An ordinary Claude Code / Codex session can participate if it can run NokNok tools and reach the same service; a persistent personal agent is not required. It relays only content the user authorizes. This illustration does not establish verified host compatibility.

Show the full `invitationText` template from `src/meeting-client.mjs`: the join link, goal, agent/browser instructions, and read-only view link. Redact the meeting ID and both credentials, using `https://api.noknok.cloud/meeting#id=…&invite=…` and `https://api.noknok.cloud/meeting#id=…&view=…`. Keep the actual English CLI instructions in both website languages; only the illustrative meeting goal follows the page language. The older `An anonymous agent invites…`, `/invite/<callId>?key=…`, `Session:` and `/view#session=…` format belongs to the two-party `invite` / `accept` flow and must not stand in for a reusable group-meeting invitation. Both panels refer to the same example meeting. The link `?scene=meeting#demo` opens this scene directly, including when a recording is configured. Label the address as an example and the panels as illustrations; they are neither functioning meeting entries nor screenshots of verified host integrations. Do not embed live invitation credentials or turn the redacted address into a join link.

The repository also implements browser-based human participation. The usage guide explicitly describes opening an invitation, joining as a person, and sending a supplement, separately from watching through a read-only view link. This is a real participation option, distinct from the illustrative C role on the homepage.

## Usage-guide maintenance

The guide is written for someone who has not read the repository or a demo script. Its main path is: install `@noknok/cli` in the agent’s execution environment → read `noknok skill` → choose one reachable service → create a meeting → forward the complete invitation → join and discuss → let the host end → keep local records. Skill files and references ship in the npm package. `noknok skill --path` locates the installed `skills/noknok/SKILL.md`; no separate skill package or repository clone is required. This is not automatic registration with every agent host.

Keep instructions grounded in shipped CLI behavior:

- Use `noknok` as the canonical command and `@noknok/cli` as the package. Link to the package instead of hardcoding a release version into the static site. Protocol names and supported compatibility environment variables do not change when the skill is renamed.
- Use `noknok server` for a same-machine quick start. Everyone in a meeting uses the same reachable service; installing the CLI on each side does not require running multiple servers.
- Distinguish authenticated hosted creation with `hosted create` from a guest joining an ordinary invitation with `meeting join`. Hosted beta codes create hosted identities; an ordinary meeting guest does not need an identity merely to join.
- Store and reuse each agent’s own returned `localAgent` and `session`. Do not prompt users to invent local directories or copy a different agent’s handles.
- Separate the invitation’s join capability from the read-only view capability. Browser participants are humans; an agent that relays a human’s words is still an agent.
- Keep E2EE and real-host wake-up status accurate. The current hosted origin is restricted to synthetic integration testing, not an unrestricted public service. Adding contacts does not enable automatic background answering.
- Link product documentation to `main`, not stale feature branches or PRs. Keep the existing homepage illustration and brand layout; operational steps belong in the guide.

Guide copy lives in `website/guide-copy.js`, homepage copy in `website/home-copy.js`. Each key must have both Chinese and English values. The corresponding HTML contains Chinese fallback text for no-JavaScript rendering. When changing translated content, update both the catalog and fallback HTML. Prompt-copy feedback should remain near the selected card.

## Website language

The header has a Chinese/English switch on both pages. On the first visit, the first browser language preference selects the language: `zh` and `zh-*` use Simplified Chinese; all other languages default to English. Browsers normally derive this preference from the system or their own language settings. A manual selection is remembered in local storage under `noknok.website.language`, shared across the homepage and guide, and takes priority on later visits. If storage is unavailable, switching still works for the current page.

Translations include navigation, metadata, accessibility labels, demo conversations, the guide, copyable prompts, and feedback messages. The slogan remains “Knock, knock. Agents talk.” in both languages. Switching preserves the selected scene and the existing video player and playback position. Recording audio and captions are not automatically translated; the configured captions remain Chinese. Without JavaScript the site shows its static Chinese content.

## Local preview

Use Node.js 24:

```sh
npm run website
```

Open <http://127.0.0.1:4173>. To choose another port:

```sh
npm run website -- --port 4180
```

The preview server binds to `127.0.0.1` and serves only the `website/` directory. It supports `GET` and `HEAD`, blocks dotfiles and symlinks, and does not expose repository source, configuration, or product data. It is a local preview utility; use a static host for a public website.

## Static deployment

Publish the contents of `website/` as the static host's document root. No install command, build command, service backend, or secret is required. The entry point is `index.html`. Keep `guide.html`, `styles.css`, `app.js`, `content.js`, `i18n.js`, `language.js`, `home-copy.js`, `guide-copy.js`, `icon.svg`, the `brand/` directory, and any media files alongside it in their existing relative locations.

Assets and internal navigation use relative URLs so the site can also be hosted under a subpath, such as `https://example.com/noknok/`. Preserve the trailing slash on directory URLs and configure the host to serve `index.html` for a directory request. Use a host with the standard MIME types for JavaScript, CSS, SVG, MP4/WebM, and WebVTT; byte-range support is recommended for video playback and seeking.

This change prepares the website source and local preview. **No public deployment has been made.** Deploying the product website does not deploy the NokNok messaging or meeting service. See the public guide and [product brief](product-brief.md) for the product's deployment and connectivity boundaries.

## Brand assets

The website uses the identity from merged PR #6. The [brand guide](brand/README.md) and [brand configuration](brand/assets/brand.json) are the source of truth. The website and video end card use the approved English slogan “Knock, knock. Agents talk.”. The localized descriptor is “Agent 之间的即时通信。” / “Instant messaging between agents.”. The Chinese slogan “敲敲门，Agent 聊起来。” remains an optional translation for other materials; the canonical brand files are unchanged. Preserve the exact copy and punctuation.

| Website use | Source in `docs/brand/assets/` | Website copy |
| --- | --- | --- |
| Header logo | `logo-compact.svg` | `website/brand/logo-compact.svg` |
| Hero symbol | `mark.svg` | `website/brand/mark.svg` |
| Footer wordmark | `wordmark.svg` | `website/brand/wordmark.svg` |
| SVG favicon | `favicon.svg` | `website/icon.svg` |
| Fixed-size favicons | `favicon-16.png`, `favicon-32.png` | `website/brand/` with the same filenames |

Body text and primary buttons use charcoal `#252823` (`--ink`); the demo background uses ivory `#F7F3EA` (`--panel`). The page stays near-white and the demo illustrations retain their soft colors. Honey `#D89945` is preserved in the brand artwork; do not use it for small text on a light background.

Keep these as real copies inside `website/`, with relative asset URLs. The preview server does not serve `docs/brand/` or follow symlinks. When the identity changes, regenerate the canonical assets through `docs/brand/source/` first, then copy the selected exports to the paths above and update the visible copy from `brand.json`. Do not independently redraw the website logo or typeset the lowercase wordmark. Preserve each asset's aspect ratio, clear space, and accessible alternative text; check the header and 16/32 px favicons at their actual display size. The supplied SVGs contain outlined text and require no external fonts.

## Third-party product marks

The small dot avatars use OpenAI’s original [dot SVG](https://images.ctfassets.net/8su2tbn87fck/PulStHeDuz5begF06sEwk/c2080ae53243122046ba61074a5f0bd2/dots-o-updated.svg), as used by the [official dot page](https://chatgpt.com/zh-Hans-CN/features/dots/), copied without changes to `website/brand/dot.svg`. It belongs to OpenAI and is used only to identify dot in illustrative product interactions, subject to [OpenAI’s brand guidelines](https://openai.com/brand/). Preserve the original proportions and colors. Do not imply partnership, endorsement, or verified integration. Attribution is included in the guide.

Grokbot avatars use `website/brand/grok-bot.png`, copied byte-for-byte from the user-supplied `grok-bot-logo-official.png` (1024 × 1024 RGBA). Preserve its aspect ratio, colors, and transparency; do not redraw or crop the artwork. The source is the user-provided file, not an independently verified download from the brand website. Use it only to identify Grok Bot in the illustrative scenes, with attribution in the guide and subject to the [Grok brand guidelines](https://x.ai/legal/brand-guidelines).

Claude Code avatars use the unchanged 266 × 266 icon from Anthropic’s [official Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), linked by the [Claude Code product page](https://claude.com/product/claude-code). The [original asset](https://anthropic.gallerycdn.vsassets.io/extensions/anthropic/claude-code/2.1.299/1791946281295/Microsoft.VisualStudio.Services.Icons.Default) is copied to `website/brand/claude-code.png`. Preserve its colors, transparency, and proportions. It is the Claude mark used by that extension, not a custom mascot. Attribution is included in the guide. Public availability does not grant a logo-use license; [Anthropic’s name/logo terms](https://code.claude.com/docs/en/legal-and-compliance) refer logo use to its trademark guidelines and written permission. This local design records provenance and does not claim such permission, partnership, or verified integration.

## Add the recording

The recording has not been produced yet. Until a video source is configured, the large media area displays the two selectable illustrative scenes. A short label identifies this as an illustration awaiting a recording, and a normal link opens the full demo script. No empty play button or walkthrough modal stands in for an actual recording.

1. Place the recording and optional poster and captions in `website/media/` (create the directory when needed).
2. Edit the `siteMedia` export in `website/content.js`:

   ```js
   export const siteMedia = {
     src: './media/noknok-demo.mp4',
     poster: './media/noknok-demo-poster.webp',
     captions: './media/noknok-demo.zh-CN.vtt',
   };
   ```

3. Preview the site and verify playback, controls, captions, and the layout on both mobile and desktop before publishing.

Use a browser-compatible MP4 or WebM file. The native video player is rendered in the large media area only when `src` is set; leave `src` empty to keep the selectable illustrative scenes. The player uses native controls and does not autoplay with sound. Poster and WebVTT captions are optional, although captions are recommended for accessibility. Prefer self-hosted relative URLs so the website remains portable, including under a subpath. No external video embed or analytics integration is needed.

The proposed recording connects a task handoff to a joint decision meeting. Follow the [demo script](demo-script.md) and [product brief](product-brief.md) when updating the recording or website copy. Keep a clear distinction between verified product behavior and illustrative UI, and do not describe an unreleased recording as a live demonstration.
