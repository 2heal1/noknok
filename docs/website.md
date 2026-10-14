# Product website

The public product website lives in `website/`. It is a standalone static site with no build step or third-party runtime dependencies. The homepage uses a centered headline, a short subtitle, a large media area, two concise feature rows, and a compact self-hosting/source section. It illustrates two demo scenarios, reserves a place for the future recording, and links to the full public guide at `guide.html`.

The conversations and meeting shown on the website are **illustrative examples**. The website does not connect to a NokNok service, send agent messages, create meeting invitations, or join a real meeting.

## Page structure and visual direction

The visual reference is the [ChatGPT dots page](https://chatgpt.com/zh-Hans-CN/features/dots/?openaicom_referred=true): ample space, a centered hero, large media, and brief feature descriptions. This is a reference for simplicity and hierarchy; the site uses NokNok's own content and does not copy the reference's assets or claims.

- A compact navigation leads into “让你的 Agent，找到他的 Agent。” and the subtitle “即时沟通，把事情聊清楚。”.
- The off-white page, grayscale text, softly colored illustrations, black pill-shaped links, and large rounded media area keep the focus on the product interaction.
- Two scene selectors, “同步进展” and “邀请开会”, switch between illustrative conversations while no recording is configured.
- Two feature rows explain contacting an agent, with the wake-up condition close to the claim, and a group text meeting that also welcomes people without an agent.
- A compact ending links to self-hosting guidance and the source. The license note belongs in the source area. The footer marks the product preview and points to the current E2EE and real-host wake-up status.

The homepage has no FAQ, long deployment section, repeated call-to-action blocks, or walkthrough modal. Readers follow a normal script link for the complete storyboard. `guide.html` retains the detailed setup instructions, network and identity boundaries, FAQ, and release conditions in the same grayscale visual style. Keep these details in the guide when shortening homepage copy.

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

Publish the contents of `website/` as the static host's document root. No install command, build command, service backend, or secret is required. The entry point is `index.html`. Keep `guide.html`, `styles.css`, `app.js`, `content.js`, `icon.svg`, and any media files alongside it in their existing relative locations.

Assets and internal navigation use relative URLs so the site can also be hosted under a subpath, such as `https://example.com/noknok/`. Preserve the trailing slash on directory URLs and configure the host to serve `index.html` for a directory request. Use a host with the standard MIME types for JavaScript, CSS, SVG, MP4/WebM, and WebVTT; byte-range support is recommended for video playback and seeking.

This change prepares the website source and local preview. **No public deployment has been made.** Deploying the product website does not deploy the NokNok messaging or meeting service. See the public guide and [product brief](product-brief.md) for the product's deployment and connectivity boundaries.

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
