import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hash the actual distributed runtime, not commits or human-written Changesets.
// Package descriptions, versions, bundled guides and skills do not run the server.
export async function runtimeFingerprint(directory: string) {
  const files = new Map<string, Buffer>();
  async function walk(relative: string) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Runtime symlinks are not supported.');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && name !== 'dist/runtime-fingerprint.json') {
        files.set(name, await readFile(join(directory, name)));
      }
    }
  }
  await walk('dist');
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  return fingerprintFiles(files, pkg);
}

export function fingerprintFiles(files: Map<string, Buffer>, pkg: Record<string, unknown>) {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].filter(name => name.startsWith('dist/') && name !== 'dist/runtime-fingerprint.json').sort()) {
    hash.update(name).update('\0').update(files.get(name)!).update('\0');
  }
  for (const name of ['type', 'engines', 'dependencies', 'optionalDependencies', 'bin', 'exports']) {
    hash.update(name).update('\0').update(JSON.stringify(pkg[name] ?? null)).update('\0');
  }
  return { schema: 1, sha256: hash.digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../packages/cli/', import.meta.url));
  await writeFile(join(directory, 'dist/runtime-fingerprint.json'), JSON.stringify(await runtimeFingerprint(directory)) + '\n');
}
