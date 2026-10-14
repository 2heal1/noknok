import { useState } from 'react';

// Keep the stable GitHub attachment URL; its CDN redirect is temporary.
const HOMEPAGE_VIDEO_URL = 'https://github.com/user-attachments/assets/7bbf32b9-d3d9-4f5c-a99f-8e56bc12c3d0';

type Props = { label: string; errorText: string; openText: string };

export function HomeVideo({ label, errorText, openText }: Props) {
  const [failed, setFailed] = useState(false);

  // Keep the video discoverable in Rspress's generated Markdown pages.
  if (import.meta.env.SSG_MD) return <p><a href={HOMEPAGE_VIDEO_URL}>{label}</a></p>;

  return <div className="demo-stage">
    {failed ? <div className="video-fallback" role="status">
      <p>{errorText}</p>
      <a className="button secondary" href={HOMEPAGE_VIDEO_URL} target="_blank" rel="noopener noreferrer">{openText} ↗</a>
    </div> : <video
      className="demo-video"
      src={HOMEPAGE_VIDEO_URL}
      poster="/brand/video-poster.svg"
      width={1920}
      height={1080}
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      onError={() => setFailed(true)}
    >
      <a href={HOMEPAGE_VIDEO_URL}>{openText}</a>
    </video>}
  </div>;
}
