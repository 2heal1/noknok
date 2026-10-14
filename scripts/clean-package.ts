import { rm } from 'node:fs/promises';

// Only generated, package-owned build artifacts. Never touch profiles or service data.
for (const relative of ['dist', 'docs', 'README.md', 'LICENSE', 'NOTICE']) {
  await rm(new URL(`../packages/cli/${relative}`, import.meta.url), { recursive: true, force: true });
}
