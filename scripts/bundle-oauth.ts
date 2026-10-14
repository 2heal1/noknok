import { build } from 'esbuild';
import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the inspected npm tarball self-contained for offline installs and the
// release image. The maintained OAuth implementation is pinned in pnpm-lock.
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/cli/src/oauth-engine.ts'],
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: { js: "import { createRequire as oauthCreateRequire } from 'node:module'; const require = oauthCreateRequire(import.meta.url);" },
  write: false, metafile: true, legalComments: 'inline',
});
const licenses = new Map<string, string>();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== dirname(directory)) {
    try { await access(join(directory, 'package.json')); break; } catch { directory = dirname(directory); }
  }
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (licenses.has(pkg.name)) continue;
  let license: string | undefined;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try { license = await readFile(join(directory, name), 'utf8'); break; } catch {}
  }
  if (!license) throw new Error(`Missing license for bundled dependency ${pkg.name}`);
  licenses.set(pkg.name, `${pkg.name} ${pkg.version}\n${license}`);
}
const notice = [...licenses.values()].join('\n\n').replaceAll('*/', '* /');
await writeFile(join(root, 'packages/cli/dist/src/oauth-engine.js'), `/*! Bundled dependency licenses\n${notice}\n*/\n${result.outputFiles[0].text}`);
