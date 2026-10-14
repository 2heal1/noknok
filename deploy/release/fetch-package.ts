import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const registry = 'https://registry.npmjs.org';
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export function stableVersion(version: string): string {
  if (!stable.test(version)) throw new Error('Expected an exact stable version.');
  return version;
}
export function verifyMetadata(value: unknown, version: string): { tarball: string; integrity: string } {
  stableVersion(version);
  const item = value as { name?: unknown; version?: unknown; dependencies?: object; optionalDependencies?: object; dist?: { tarball?: unknown; integrity?: unknown } };
  if (!item || item.name !== '@noknok/cli' || item.version !== version) throw new Error('Package identity does not match the requested release.');
  // The server currently uses only Node built-ins. Dependency additions need an
  // explicit deployment-policy review, not implicit additional download hosts.
  if (Object.keys(item.dependencies || {}).length || Object.keys(item.optionalDependencies || {}).length) throw new Error('Runtime dependencies are not allowed by the release deployment policy.');
  const tarball = `${registry}/@noknok/cli/-/cli-${version}.tgz`;
  if (item.dist?.tarball !== tarball) throw new Error('Unexpected package download URL.');
  const integrity = item.dist.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('A SHA-512 package integrity value is required.');
  return { tarball, integrity };
}
export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) throw new Error('Package integrity verification failed.');
}
async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Registry request failed: ${response.status}.`);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Registry response exceeds the deployment size limit.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export async function fetchRelease(version: string): Promise<void> {
  stableVersion(version);
  const metadata = verifyMetadata(JSON.parse((await download(`${registry}/@noknok%2fcli/${version}`, 1024 * 1024)).toString('utf8')), version);
  const tarball = await download(metadata.tarball, 25 * 1024 * 1024);
  verifyIntegrity(tarball, metadata.integrity);
  await writeFile('/release/package.tgz', tarball, { mode: 0o600 });
  await writeFile('/release/receipt.json', JSON.stringify({ name: '@noknok/cli', version, integrity: metadata.integrity }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fetchRelease(process.argv[2] || '');
}
