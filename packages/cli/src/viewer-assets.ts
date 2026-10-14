import { avatarAssetNames } from '../web/avatar-catalog.js';

// An explicit allowlist keeps the viewer from serving arbitrary package files.
export const viewerBrandAssets: Array<[string, [string, string]]> = [
  ['/avatar-catalog.js', ['avatar-catalog.js', 'text/javascript; charset=utf-8']],
  ['/mark.svg', ['mark.svg', 'image/svg+xml']],
  ...avatarAssetNames.map(name => [
    `/agent-${name}.svg`, [`agent-${name}.svg`, 'image/svg+xml'],
  ] as [string, [string, string]]),
];
