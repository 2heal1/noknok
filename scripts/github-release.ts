import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PACKAGE = '@noknok/cli';
const REPOSITORY = '2heal1/noknok';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const exec = promisify(execFile);

interface Options { version?: string; cwd?: string; token?: string; dryRun?: boolean }
interface Dependencies { git?: (args: string[]) => Promise<string>; fetch?: typeof fetch }
export interface ReleasePlan { version: string; tag: string; commit: string; name: string; body: string; releaseUrl: string }
interface GithubRelease { tag_name?: string; draft?: boolean; prerelease?: boolean }

function newerVersion(candidate: string, current: string) {
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function stableVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) {
    throw new Error('An exact stable package version is required; previews are not archived as GitHub releases.');
  }
}

export function changelogEntry(changelog: string, version: string) {
  stableVersion(version);
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const headings = lines.flatMap((line, index) => line === `## ${version}` ? [index] : []);
  if (headings.length !== 1) throw new Error('The published commit must contain exactly one changelog entry for this version.');
  const start = headings[0] + 1;
  const next = lines.findIndex((line, index) => index >= start && /^## /.test(line));
  const entry = lines.slice(start, next < 0 ? undefined : next).join('\n').trim();
  if (!entry) throw new Error('The published version has an empty changelog entry.');
  return entry;
}

export function releaseNotes(version: string, commit: string, changes: string) {
  stableVersion(version);
  if (!SHA.test(commit)) throw new Error('A full published source commit is required.');
  return [
    `NokNok ${version} is published as [\`${PACKAGE}@${version}\`](https://www.npmjs.com/package/${PACKAGE}/v/${version}).`,
    '',
    `Source: [\`${commit}\`](https://github.com/${REPOSITORY}/commit/${commit}); tag: \`v${version}\`.`,
    '',
    '## CLI and clients',
    '',
    'The package includes the `noknok` CLI, local stdio MCP adapter, bundled agent skill, and browser meeting assets.',
    '',
    '```sh',
    `npm install --global ${PACKAGE}@${version}`,
    'noknok skill',
    '# Or run this exact version without a global installation:',
    `npm exec --yes --package=${PACKAGE}@${version} -- noknok --help`,
    '```',
    '',
    '## Server',
    '',
    `The hosted service and relay ship in the same \`${PACKAGE}@${version}\` package. CLI and server use one release version, \`${version}\`; there is no separately versioned server artifact. See the changes below for compatibility and upgrade requirements.`,
    '',
    '## Changes',
    '',
    changes,
    '',
    '## Deployment status',
    '',
    `This record confirms npm publication and its source tag, not a production deployment. Deployment runs independently after npm verification; it can fail or retain an older running version when the runtime and policy are unchanged. Check the [Release workflow](https://github.com/${REPOSITORY}/actions/workflows/release.yml) deployment job for the actual outcome. Preview publication never deploys the hosted service.`,
    '',
    `<!-- noknok-release-record:v1 package=${PACKAGE} version=${version} gitHead=${commit} -->`,
    '',
  ].join('\n');
}

/** Archive an already published stable package. Never publishes npm or deploys a service. */
export async function archiveGithubRelease(options: Options = {}, dependencies: Dependencies = {}) {
  const cwd = options.cwd || ROOT;
  const fetcher = dependencies.fetch || fetch;
  const git = dependencies.git || (async (args: string[]) => {
    try {
      const { stdout } = await exec('git', args, {
        cwd, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
      });
      return stdout.trim();
    } catch { throw new Error('A Git operation failed; check repository history, origin access, and tag permissions.'); }
  });
  const version = options.version ?? JSON.parse(await readFile(resolve(cwd, 'packages/cli/package.json'), 'utf8')).version;
  stableVersion(version);
  if (!options.token && !options.dryRun) throw new Error('GITHUB_TOKEN is required to create a release; use --dry-run to inspect the plan.');
  const tag = `v${version}`, ref = `refs/tags/${tag}`;
  async function json(url: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('Release metadata request failed; no credentials or response bodies are included in this error.'); }
    return response;
  }
  const metadataResponse = await json(`https://registry.npmjs.org/@noknok%2fcli/${version}`);
  if (!metadataResponse.ok) throw new Error(`Cannot verify the exact npm version (HTTP ${metadataResponse.status}).`);
  let metadata;
  try { metadata = await metadataResponse.json(); } catch { throw new Error('Invalid npm release metadata.'); }
  if (metadata.name !== PACKAGE || metadata.version !== version || !SHA.test(metadata.gitHead || '')) {
    throw new Error('npm must identify the exact package/version and its full gitHead; refusing to guess the source commit.');
  }
  const commit: string = metadata.gitHead;
  try {
    if (await git(['cat-file', '-t', commit]) !== 'commit') throw new Error('Not a commit.');
  } catch { throw new Error('The npm gitHead does not identify a local Git commit. Fetch the published main history first.'); }
  // A later documentation push can share this version. HEAD is never used as the tag target.
  try { await git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']); }
  catch { throw new Error('The npm source commit must be in origin/main history. Fetch main and verify the published gitHead.'); }
  let sourcePackage;
  try { sourcePackage = JSON.parse(await git(['show', `${commit}:packages/cli/package.json`])); }
  catch { throw new Error('Cannot read the package manifest from the npm source commit.'); }
  if (sourcePackage.name !== PACKAGE || sourcePackage.version !== version) throw new Error('The npm source commit has a different package name or version.');
  const changes = changelogEntry(await git(['show', `${commit}:packages/cli/CHANGELOG.md`]), version);
  const plan: ReleasePlan = {
    version, tag, commit, name: `NokNok ${version}`, body: releaseNotes(version, commit, changes),
    releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
  };
  // Both fetch and every push URL must address the same repository as the API.
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--all', '--push', 'origin']]) {
    const urls = (await git(args)).split('\n');
    if (!urls.length || urls.some(url => ![
      `https://github.com/${REPOSITORY}.git`, `https://github.com/${REPOSITORY}`,
      `git@github.com:${REPOSITORY}.git`, `ssh://git@github.com/${REPOSITORY}.git`,
    ].includes(url))) throw new Error('Origin fetch and push URLs must address the canonical NokNok repository.');
  }
  const localRefs = (await git(['for-each-ref', '--format=%(refname)', ref])).split('\n');
  const localTag = localRefs.includes(ref);
  if (localTag && await git(['rev-parse', '--verify', `${ref}^{commit}`]) !== commit) {
    throw new Error('The local version tag points to a different commit; it will not be overwritten.');
  }
  async function remoteTag() {
    const lines = (await git(['ls-remote', '--tags', 'origin', ref, `${ref}^{}`])).split('\n').filter(Boolean);
    if (!lines.length) return false;
    const refs = new Map<string, string>();
    for (const line of lines) {
      const [sha, name, extra] = line.split(/\s+/);
      if (extra || !SHA.test(sha) || ![ref, `${ref}^{}`].includes(name) || refs.has(name)) throw new Error('Unexpected remote version tag response.');
      refs.set(name, sha);
    }
    if (!refs.has(ref) || (refs.get(`${ref}^{}`) || refs.get(ref)) !== commit) {
      throw new Error('The remote version tag points to a different commit; it will not be overwritten.');
    }
    return true;
  }
  const remoteExists = await remoteTag();
  const headers = {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  };
  function checkRelease(release: unknown): asserts release is GithubRelease {
    if (!release || typeof release !== 'object' || (release as GithubRelease).tag_name !== tag
      || (release as GithubRelease).draft !== false || (release as GithubRelease).prerelease !== false) {
      throw new Error('An existing GitHub release is inconsistent with this stable tag; it will not be overwritten.');
    }
  }
  async function existingRelease() {
    const response = await json(`${API}/releases/tags/${tag}`, { headers });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Cannot inspect the GitHub release (HTTP ${response.status}).`);
    let release: unknown;
    try { release = await response.json(); } catch { throw new Error('Invalid GitHub release metadata.'); }
    checkRelease(release);
    return release;
  }
  // An unauthenticated 404 can hide a private repository; it does not prove absence.
  const existing = options.token ? await existingRelease() : undefined;
  if (existing && !remoteExists) throw new Error('The GitHub release has no matching remote tag; refusing to recreate a missing release tag.');
  if (options.dryRun) return { ...plan, status: 'planned', tagExists: remoteExists, releaseExists: options.token ? !!existing : null };
  if (!remoteExists) {
    if (!localTag) await git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag', '--annotate', tag, commit, '--message', `NokNok ${version}\nPublished npm source: ${PACKAGE}@${version}\n${commit}`]);
    try { await git(['push', 'origin', `${ref}:${ref}`]); }
    catch (error) { if (!await remoteTag()) throw error; }
  }
  // Check immediately before POST. target_commitish also pins the source if the tag disappears.
  if (!await remoteTag()) throw new Error('The verified source tag is absent from origin.');
  if (existing) return { ...plan, status: 'existing' };
  const latestResponse = await json(`${API}/releases/latest`, { headers });
  let makeLatest = latestResponse.status === 404;
  if (latestResponse.ok) {
    let latest: unknown;
    try { latest = await latestResponse.json(); } catch { throw new Error('Invalid latest GitHub release metadata.'); }
    if (!latest || typeof latest !== 'object' || !('tag_name' in latest) || typeof latest.tag_name !== 'string') throw new Error('Invalid latest GitHub release metadata.');
    const latestVersion = latest.tag_name.startsWith('v') ? latest.tag_name.slice(1) : '';
    // Preserve custom/non-version latest releases, and never promote an older backfill.
    if (/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(latestVersion)) makeLatest = newerVersion(version, latestVersion);
  } else if (latestResponse.status !== 404) throw new Error(`Cannot inspect the latest GitHub release (HTTP ${latestResponse.status}).`);
  const response = await json(`${API}/releases`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: plan.name, body: plan.body, draft: false, prerelease: false,
      generate_release_notes: false, make_latest: makeLatest ? 'true' : 'false' }) });
  if (response.status === 422 && await existingRelease()) return { ...plan, status: 'existing' };
  if (response.status !== 201) throw new Error(`GitHub release creation failed (HTTP ${response.status}); the source tag is retained for a safe retry.`);
  let created: unknown;
  try { created = await response.json(); } catch { throw new Error('Cannot verify the created GitHub release; inspect it before retrying.'); }
  checkRelease(created);
  return { ...plan, status: 'created' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let version: string | undefined, dryRun = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run' && !dryRun) dryRun = true;
      else if (args[i] === '--version' && version === undefined && args[i + 1]) version = args[++i];
      else throw new Error('Usage: node scripts/github-release.ts [--version VERSION] [--dry-run]');
    }
    const result = await archiveGithubRelease({ version, dryRun, token: process.env.GITHUB_TOKEN });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
