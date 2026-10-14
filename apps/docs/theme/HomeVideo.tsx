import { useState } from 'react';

// Temporary video supplied for the website preview. Replace this URL with the
// finished NokNok film from noknok-media when it is ready.
const HOMEPAGE_VIDEO_URL = 'https://module-federation-assest.netlify.app/document/announcement/blog/announcement/announcement-video.mp4';

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
