import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const registry = 'https://registry.npmjs.org';
const directory = fileURLToPath(new URL('../packages/cli/', import.meta.url));
const pkg: { name: string; version: string } = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
const tag = process.argv[2] || 'latest';
if (!['latest', 'preview'].includes(tag) || pkg.name !== '@noknok/cli'
  || !(tag === 'latest' ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+-preview-/).test(pkg.version)) {
  throw new Error('Invalid publication identity or tag.');
}
// pnpm manages the workspace; npm is the explicit trusted-publishing uploader.
// Query the exact version so a rerun does not attempt to overwrite immutable npm content.
let published = false;
try {
  const { stdout } = await promisify(execFile)('npm', ['view', `${pkg.name}@${pkg.version}`, 'version', '--json', `--registry=${registry}`, '--fetch-retries=0'], { timeout: 30_000 });
  if (JSON.parse(stdout) !== pkg.version) throw new Error('Unexpected registry response.');
  published = true;
} catch (error) {
  let code: unknown;
  try { code = JSON.parse(error.stdout).error?.code; } catch {}
  if (code !== 'E404') throw new Error('Unable to verify registry state; publication stopped.');
}
if (published) {
  console.log(`${pkg.name}@${pkg.version} already exists; skipping publish.`);
} else {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['publish', '--access', 'public', '--tag', tag, `--registry=${registry}`], { cwd: directory, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm publish exited ${code}. Inspect the registry before retrying.`)));
  });
}
