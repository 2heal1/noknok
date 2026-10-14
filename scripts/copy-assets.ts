import { chmod, copyFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = join(root, 'packages/cli');
for (const [source, destination, extensions] of [
  ['packages/cli/web', 'packages/cli/dist/web', ['.html', '.css', '.svg', '.txt']],
  ['docs', 'packages/cli/docs', ['.md']],
] as const) {
  await mkdir(join(root, destination), { recursive: true });
  for (const item of await readdir(join(root, source), { withFileTypes: true })) {
    if (item.isFile() && extensions.some(ext => item.name.endsWith(ext))) {
      await copyFile(join(root, source, item.name), join(root, destination, item.name));
    }
  }
}
await copyFile(join(root, 'README.md'), join(pkg, 'README.md'));
await chmod(join(pkg, 'dist/bin/noknok.js'), 0o755);
