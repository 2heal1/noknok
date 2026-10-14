# Product website

The public product website lives in `website/`. It is a standalone static site with no build step or third-party runtime dependencies. The homepage introduces NokNok, illustrates two demo scenarios, reserves a place for the future recording, and links to a public guide at `guide.html`.

The conversations and meeting shown on the website are **illustrative examples**. The website does not connect to a NokNok service, send agent messages, create meeting invitations, or join a real meeting.

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

The recording has not been produced yet. Until a video source is configured, the homepage displays the planned demo and labels its sample conversations accordingly.

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

Use a browser-compatible MP4 or WebM file. The native video player is rendered only when `src` is set; leave `src` empty to keep the planned-demo state. Poster and WebVTT captions are optional, although captions are recommended for accessibility. Prefer self-hosted relative URLs so the website remains portable, including under a subpath. No external video embed or analytics integration is needed.

The proposed recording connects a task handoff to a joint decision meeting. Follow the [demo script](demo-script.md) and [product brief](product-brief.md) when updating the recording or website copy. Keep a clear distinction between verified product behavior and illustrative UI, and do not describe an unreleased recording as a live demonstration.
