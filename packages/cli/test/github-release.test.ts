import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { archiveGithubRelease, changelogEntry } from '../../../scripts/github-release.js';

const exec = promisify(execFile);
const version = '0.2.0';
const token = 'synthetic-release-api-token';
const changes = '### Minor Changes\n\n- Encrypt meeting content in clients and reject plaintext on servers.';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-github-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'work'), remote = join(directory, 'origin.git');
  await mkdir(cwd);
  const git = async (args: string[]) => (await exec('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  await git(['init', '--bare', remote]);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Release Test']);
  await git(['config', 'user.email', 'release@example.test']);
  await mkdir(join(cwd, 'packages/cli'), { recursive: true });
  await writeFile(join(cwd, 'packages/cli/package.json'), JSON.stringify({ name: '@noknok/cli', version }));
  await writeFile(join(cwd, 'packages/cli/CHANGELOG.md'), `# @noknok/cli\n\n## ${version}\n\n${changes}\n\n## 0.1.0\n\n- Old content.\n`);
  await git(['add', '.']);
  await git(['commit', '--message', 'Release source']);
  const source = await git(['rev-parse', 'HEAD']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '--set-upstream', 'origin', 'main']);
  let metadata: any = { name: '@noknok/cli', version, gitHead: source };
  let release: any, latest: any;
  let postStatus = 201;
  let canonicalOrigin = true;
  const gitCalls: string[][] = [], requests: Array<{ url: string; init: RequestInit }> = [];
  const dependencies = {
    git: async (args: string[]) => {
      gitCalls.push(args);
      // The filesystem-backed remote exercises real Git without internet access.
      if (args[0] === 'remote' && args[1] === 'get-url') return canonicalOrigin ? 'https://github.com/2heal1/noknok.git' : 'https://github.com/someone/else.git';
      return git(args);
    },
    fetch: async (input, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.startsWith('https://registry.npmjs.org/')) {
        assert.equal(init.headers?.Authorization, undefined, 'GitHub token must never reach npm');
        return Response.json(metadata);
      }
      assert.equal(init.headers?.Authorization, `Bearer ${token}`);
      if (url.endsWith('/releases/latest')) return latest ? Response.json(latest) : new Response('', { status: 404 });
      if (url.includes('/releases/tags/')) return release ? Response.json(release) : new Response('', { status: 404 });
      assert.ok(url.endsWith('/releases'));
      assert.equal(init.method, 'POST');
      const body = JSON.parse(String(init.body));
      if (postStatus === 201 || postStatus === 422) release = { ...body, body: postStatus === 422 ? 'Manually authored concurrent notes.' : body.body };
      return Response.json(release || {}, { status: postStatus });
    },
  };
  return { cwd, source, git, dependencies, gitCalls, requests,
    options: { cwd, version, token },
    setMetadata(value) { metadata = value; },
    setRelease(value) { release = value; },
    getRelease() { return release; },
    setLatest(value) { latest = value; },
    setPostStatus(value: number) { postStatus = value; },
    setCanonicalOrigin(value: boolean) { canonicalOrigin = value; },
    async laterCommit() {
      await writeFile(join(cwd, 'packages/cli/CHANGELOG.md'), `# @noknok/cli\n\n## ${version}\n\nLater unpublished documentation.\n`);
      await git(['add', '.']);
      await git(['commit', '--message', 'Later documentation']);
      await git(['push', 'origin', 'main']);
      return git(['rev-parse', 'HEAD']);
    },
  };
}

const mutations = (calls: string[][]) => calls.filter(args => args[0] === 'push' || args.includes('--annotate'));

test('archives npm gitHead instead of a later main HEAD and keeps both package components and deployment limits in notes', async t => {
  const f = await fixture(t), later = await f.laterCommit();
  assert.notEqual(later, f.source);
  const result = await archiveGithubRelease(f.options, f.dependencies);
  assert.equal(result.status, 'created');
  assert.equal(result.commit, f.source);
  assert.equal(await f.git(['rev-parse', 'v0.2.0^{commit}']), f.source);
  assert.match(await f.git(['ls-remote', '--tags', 'origin', 'refs/tags/v0.2.0^{}']), new RegExp(`^${f.source}\\s`));
  const body = f.getRelease();
  assert.equal(body.target_commitish, f.source);
  assert.equal(body.make_latest, 'true');
  assert.ok(body.body.includes(changes));
  assert.ok(!body.body.includes('Later unpublished documentation'));
  assert.match(body.body, /## CLI and clients/);
  assert.match(body.body, /## Server/);
  assert.match(body.body, /not a production deployment/);
  assert.match(body.body, /npm install --global @noknok\/cli@0\.2\.0/);
  assert.ok(f.gitCalls.every(args => !args.includes('--force') && !args.includes('-f')));
});

test('reruns validate tags and preserve existing release text without publishing, pushing, or editing it', async t => {
  const f = await fixture(t);
  await archiveGithubRelease(f.options, f.dependencies);
  f.getRelease().body = 'Maintainer-curated release notes.';
  await f.laterCommit();
  f.gitCalls.length = 0; f.requests.length = 0;
  const result = await archiveGithubRelease(f.options, f.dependencies);
  assert.equal(result.status, 'existing');
  assert.equal(f.getRelease().body, 'Maintainer-curated release notes.');
  assert.deepEqual(mutations(f.gitCalls), []);
  assert.ok(f.requests.every(({ init }) => !init.method));
});

test('dry-run emits the complete original-source plan without creating any tag or release', async t => {
  const f = await fixture(t);
  const result = await archiveGithubRelease({ ...f.options, dryRun: true }, f.dependencies);
  assert.equal(result.status, 'planned');
  assert.equal(result.releaseExists, false);
  assert.match(result.body, /## Changes/);
  assert.equal(await f.git(['tag', '--list']), '');
  assert.deepEqual(mutations(f.gitCalls), []);
  assert.ok(f.requests.every(({ init }) => !init.method));
});

test('unauthenticated dry-run leaves GitHub release existence unknown and makes no GitHub requests', async t => {
  const f = await fixture(t);
  const result = await archiveGithubRelease({ ...f.options, token: undefined, dryRun: true }, f.dependencies);
  assert.equal(result.status, 'planned');
  assert.equal(result.releaseExists, null);
  assert.deepEqual(mutations(f.gitCalls), []);
  assert.ok(f.requests.every(({ url }) => url.startsWith('https://registry.npmjs.org/')));
});

test('a missing token rejects write mode explicitly before networking or creating tags', async t => {
  const f = await fixture(t);
  await assert.rejects(archiveGithubRelease({ ...f.options, token: undefined }, f.dependencies), /GITHUB_TOKEN is required/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.gitCalls, []);
  assert.equal(await f.git(['tag', '--list']), '');
});

test('rejects missing gitHead, mismatched source manifests, unpublished versions, and preview inputs before any write', async t => {
  const f = await fixture(t);
  for (const metadata of [
    { name: '@noknok/cli', version }, { name: '@noknok/cli', version, gitHead: 'HEAD' },
    { name: '@else/cli', version, gitHead: f.source },
  ]) {
    f.setMetadata(metadata);
    await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /npm must identify/);
  }
  f.setMetadata({ name: '@noknok/cli', version: '0.3.0', gitHead: f.source });
  await assert.rejects(archiveGithubRelease({ ...f.options, version: '0.3.0' }, f.dependencies), /different package name or version/);
  for (const bad of ['0.2.0-preview-1', 'latest', '0.2.0;id', '00.2.0']) await assert.rejects(archiveGithubRelease({ ...f.options, version: bad }, f.dependencies), /exact stable/);
  await assert.rejects(archiveGithubRelease(f.options, { ...f.dependencies, fetch: async () => new Response('', { status: 404 }) }), /exact npm version/);
  assert.deepEqual(mutations(f.gitCalls), []);
});

test('requires the published source commit in main history and the canonical fetch and push repository', async t => {
  const f = await fixture(t);
  f.setCanonicalOrigin(false);
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /canonical NokNok/);
  f.setCanonicalOrigin(true);
  await f.git(['checkout', '--orphan', 'unmerged']);
  await f.git(['commit', '--message', 'Unmerged history']);
  f.setMetadata({ name: '@noknok/cli', version, gitHead: await f.git(['rev-parse', 'HEAD']) });
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies));
  assert.deepEqual(mutations(f.gitCalls), []);
});

test('never replaces a conflicting local or remote tag', async t => {
  const f = await fixture(t), later = await f.laterCommit();
  await f.git(['tag', 'v0.2.0', later]);
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /local version tag.*not be overwritten/);
  await f.git(['push', 'origin', 'refs/tags/v0.2.0']);
  await f.git(['tag', '--delete', 'v0.2.0']);
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /remote version tag.*not be overwritten/);
  assert.deepEqual(mutations(f.gitCalls), []);
  assert.match(await f.git(['ls-remote', '--tags', 'origin', 'refs/tags/v0.2.0']), new RegExp(`^${later}\\s`));
});

test('refuses inconsistent existing releases without editing them or recreating a missing tag', async t => {
  const f = await fixture(t);
  f.setRelease({ tag_name: 'v0.2.0', draft: true, prerelease: false });
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /inconsistent/);
  f.setRelease({ tag_name: 'v0.2.0', draft: false, prerelease: false });
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /no matching remote tag/);
  assert.deepEqual(mutations(f.gitCalls), []);
});

test('a failed release API call preserves the tag and can be safely retried without another push', async t => {
  const f = await fixture(t);
  f.setPostStatus(500);
  await assert.rejects(archiveGithubRelease(f.options, f.dependencies), /source tag is retained/);
  assert.equal(await f.git(['rev-parse', 'v0.2.0^{commit}']), f.source);
  f.setPostStatus(201); f.gitCalls.length = 0;
  assert.equal((await archiveGithubRelease(f.options, f.dependencies)).status, 'created');
  assert.deepEqual(mutations(f.gitCalls), []);
});

test('a concurrent release creation is recognized without overwriting the other publisher notes', async t => {
  const f = await fixture(t);
  f.setPostStatus(422);
  assert.equal((await archiveGithubRelease(f.options, f.dependencies)).status, 'existing');
  assert.equal(f.getRelease().body, 'Manually authored concurrent notes.');
});

test('backfilling an old version never replaces a newer or custom latest release', async t => {
  for (const tag_name of ['v0.3.0', 'v10.0.0', 'custom-latest']) {
    const f = await fixture(t);
    f.setLatest({ tag_name, draft: false, prerelease: false });
    await archiveGithubRelease(f.options, f.dependencies);
    assert.equal(f.getRelease().make_latest, 'false');
  }
});

test('changelog extraction requires an exact nonempty version section and excludes other releases', () => {
  assert.equal(changelogEntry('## 0.2.0\r\n\r\nChanges.\r\n\r\n## 0.1.0\r\nOld.', version), 'Changes.');
  for (const text of ['## 0.20.0\nChanges.', '## 0.2.0\n\n## 0.1.0\nOld.', '## 0.2.0\nA\n## 0.2.0\nB']) assert.throws(() => changelogEntry(text, version));
});

test('only verified stable publication enables archive and deployment, and the jobs are independent', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const archive = workflow.split('\n  archive:\n')[1].split('\n  deploy:\n')[0];
  const deploy = workflow.split('\n  deploy:\n')[1].split('\n  preview:\n')[0];
  assert.match(archive, /needs: stable/);
  assert.match(archive, /needs\.stable\.outputs\.published-version != ''/);
  assert.match(archive, /github\.event_name == 'push'/);
  assert.match(archive, /fetch-depth: 0/);
  assert.match(archive, /contents: write/);
  assert.match(archive, /node scripts\/github-release\.ts/);
  assert.match(deploy, /needs: stable/);
  assert.doesNotMatch(deploy, /needs: archive/);
  assert.doesNotMatch(workflow.split('\n  preview:\n')[1], /github-release\.ts|contents: write/);
});
