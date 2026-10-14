import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const EXPECTED_NAME = '@noknok/cli';
const REGISTRY = 'https://registry.npmjs.org';
const REQUIRED = [
  'package.json', 'README.md', 'Dockerfile', 'bin/noknok.mjs', 'bin/agentcall.mjs',
  'src/cli.mjs', 'src/mcp-stdio.mjs', 'deploy/server.mjs', 'deploy/hosted-server.mjs',
  'deploy/compose.hosted.yaml', 'deploy/Caddyfile.hosted', 'poc/mcp-events/server.mjs',
  'skills/noknok/SKILL.md', 'skills/noknok/references/hosted.md',
  'skills/noknok/references/legacy-calls.md', 'web/meeting.html', 'web/meeting.js',
];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function numberField(buffer) {
  const value = buffer.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(value)) fail('INVALID_TAR_NUMBER');
  return Number.parseInt(value, 8);
}

function stringField(buffer) {
  return buffer.toString('utf8').replace(/\0.*$/s, '');
}

function safeArchivePath(name) {
  return name.startsWith('package/') && !/[\\\x00-\x1f\x7f]/.test(name)
    && name.split('/').every(part => part && !part.startsWith('.'));
}

// Inspect the bytes before npm installs them. Links and extended headers are not
// needed by this package and deliberately fail closed instead of being extracted.
export function readPackageArchive(archive) {
  if (archive.length > MAX_ARCHIVE_BYTES) fail('ARCHIVE_TOO_LARGE');
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch { fail('INVALID_OR_OVERSIZED_ARCHIVE'); }
  const files = new Map();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) fail('TRAILING_TAR_DATA');
      ended = true;
      break;
    }
    const expectedChecksum = numberField(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expectedChecksum) fail('INVALID_TAR_CHECKSUM');
    const prefix = stringField(header.subarray(345, 500));
    const rawName = stringField(header.subarray(0, 100));
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const type = header[156];
    const size = numberField(header.subarray(124, 136));
    if (![0, 48, 53].includes(type)) fail('UNSUPPORTED_TAR_ENTRY');
    const path = type === 53 ? name.replace(/\/$/, '') : name;
    if (path !== 'package' && !safeArchivePath(path)) fail('UNSAFE_ARCHIVE_PATH');
    if (type !== 53 && !safeArchivePath(path)) fail('UNSAFE_ARCHIVE_PATH');
    if (type === 53 && size !== 0) fail('INVALID_TAR_DIRECTORY');
    const end = offset + 512 + size;
    if (end > tar.length) fail('TRUNCATED_TAR_ENTRY');
    if (type !== 53) {
      const relative = path.slice('package/'.length);
      if (files.has(relative)) fail('DUPLICATE_ARCHIVE_PATH');
      files.set(relative, Buffer.from(tar.subarray(offset + 512, end)));
      if (files.size > 512) fail('TOO_MANY_ARCHIVE_FILES');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || files.size === 0) fail('INCOMPLETE_ARCHIVE');
  return files;
}

function allowedFile(path) {
  if (['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'Dockerfile', 'scripts/demo.mjs', 'scripts/probe-mcp-events.mjs'].includes(path)) return true;
  if (path.split('/').some(part => part.startsWith('.'))) return false;
  if (/^(bin|src)\/[a-zA-Z0-9_/-]+\.mjs$/.test(path)) return true;
  if (/^web\/[a-zA-Z0-9_/-]+\.(?:js|css|html|svg)$/.test(path)) return true;
  if (/^(docs|skills)\/[a-zA-Z0-9_/-]+\.md$/.test(path)) return true;
  if (/^deploy\/(?:[a-zA-Z0-9_.-]+\.(?:mjs|ya?ml)|Caddyfile(?:\.[a-zA-Z0-9_-]+)?)$/.test(path)) return true;
  return /^poc\/mcp-events\/[a-zA-Z0-9_-]+\.mjs$/.test(path);
}

// These checks detect accidental inclusion, not every possible secret. Errors
// disclose only a rule code, never the matched content or credential-bearing path.
const CONTENT_RULES = [
  ['PRIVATE_KEY_CONTENT', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['CREDENTIAL_CONTENT', /\b(?:npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|nk_(?:account|agent|beta)_[A-Za-z0-9_-]{24,}|whsec_[A-Za-z0-9+/=_-]{24,}|nk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,})\b/],
  ['CREDENTIAL_CONTENT', /(?:_authToken|_auth|password)\s*=\s*[A-Za-z0-9+/_=-]{24,}/i],
  ['CREDENTIAL_CONTENT', /["'](?:accountToken|agentToken|privateKey|signingKey|webhookSecret)["']\s*:\s*["'][A-Za-z0-9+/_=-]{24,}["']/],
  ['DEVELOPER_PATH_CONTENT', /(?:\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\)/],
];

export function validatePackageFiles(files, expectedManifest) {
  for (const [path, bytes] of files) {
    if (!safeArchivePath(`package/${path}`) || !allowedFile(path)) fail('UNEXPECTED_PACKAGE_FILE');
    if (bytes.includes(0)) fail('UNEXPECTED_BINARY_CONTENT');
    const content = bytes.toString('utf8');
    for (const [code, pattern] of CONTENT_RULES) if (pattern.test(content)) fail(code);
  }
  for (const path of REQUIRED) if (!files.has(path)) fail('MISSING_REQUIRED_PACKAGE_FILE');
  let packed;
  try { packed = JSON.parse(files.get('package.json').toString('utf8')); }
  catch { fail('INVALID_PACKAGE_MANIFEST'); }
  if (packed.name !== EXPECTED_NAME || packed.name !== expectedManifest.name || packed.version !== expectedManifest.version) fail('PACKAGE_IDENTITY_MISMATCH');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packed.version)) fail('INVALID_PACKAGE_VERSION');
  if (packed.private || packed.publishConfig?.access !== 'public' || packed.publishConfig?.registry?.replace(/\/$/, '') !== REGISTRY) fail('INVALID_PUBLISH_CONFIG');
  if (packed.repository?.url !== 'git+https://github.com/2heal1/noknok.git') fail('INVALID_REPOSITORY');
  if (packed.bin?.noknok !== 'bin/noknok.mjs' || packed.bin?.agentcall !== 'bin/agentcall.mjs' || Object.keys(packed.bin).length !== 2) fail('INVALID_PACKAGE_BIN');
  for (const bin of Object.values(packed.bin)) if (!files.get(bin)?.toString('utf8').startsWith('#!/usr/bin/env node\n')) fail('INVALID_BIN_ENTRY');
  if (Object.keys(packed.dependencies || {}).length || Object.keys(packed.optionalDependencies || {}).length || packed.bundleDependencies?.length || packed.bundledDependencies?.length) fail('UNEXPECTED_RUNTIME_DEPENDENCIES');
  for (const hook of ['preinstall', 'install', 'postinstall']) if (packed.scripts?.[hook]) fail('UNEXPECTED_INSTALL_HOOK');
  return { name: packed.name, version: packed.version, fileCount: files.size };
}

async function command(program, args, options) {
  try {
    return await exec(program, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options });
  } catch {
    // npm errors can include local paths/configuration; never forward raw output.
    fail('PACKAGE_CHECK_SUBPROCESS_FAILED');
  }
}

export async function checkPackage({ root = ROOT, archivePath } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'noknok-package-check-'));
  try {
    const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (expected.name !== EXPECTED_NAME) fail('PACKAGE_IDENTITY_MISMATCH');
    const work = join(temp, 'work');
    const prefix = join(temp, 'installed');
    await Promise.all([mkdir(work), mkdir(prefix)]);
    const userConfig = join(temp, 'user.npmrc');
    const globalConfig = join(temp, 'global.npmrc');
    await Promise.all([writeFile(userConfig, '', { mode: 0o600 }), writeFile(globalConfig, '', { mode: 0o600 })]);
    const env = {
      PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
      TMPDIR: temp, TEMP: temp, TMP: temp,
      AGENTCALL_HOME: join(temp, 'agent-state'), XDG_CONFIG_HOME: join(temp, 'config'),
      NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(temp, 'cache'), NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_REGISTRY: REGISTRY, NPM_CONFIG_LOGLEVEL: 'error',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const npmPath = process.env.npm_execpath;
    const npm = npmPath && basename(npmPath) === 'npm-cli.js'
      ? args => command(process.execPath, [npmPath, ...args], { cwd: work, env })
      : args => command('npm', args, { cwd: work, env });
    const npmVersion = (await npm(['--version'])).stdout.trim();
    if (expected.packageManager !== `npm@${npmVersion}`) fail('PACKAGE_MANAGER_VERSION_MISMATCH');
    let tarball = archivePath && resolve(archivePath);
    if (!tarball) {
      const result = await npm(['pack', root, '--json', '--ignore-scripts', '--offline', '--pack-destination', temp]);
      let report;
      try { report = JSON.parse(result.stdout); } catch { fail('INVALID_PACK_REPORT'); }
      if (report.length !== 1 || basename(report[0].filename) !== report[0].filename) fail('INVALID_PACK_REPORT');
      tarball = join(temp, report[0].filename);
    }
    const archive = await readFile(tarball);
    const files = readPackageArchive(archive);
    const inspection = validatePackageFiles(files, expected);
    // Exact inspected bytes, copied into our private workspace before installing.
    const checkedTarball = join(temp, 'checked.tgz');
    await writeFile(checkedTarball, archive, { mode: 0o600 });
    await npm(['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--no-save', checkedTarball]);
    const installed = join(prefix, 'node_modules', '@noknok', 'cli');
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    if (installedManifest.name !== expected.name || installedManifest.version !== expected.version) fail('INSTALLED_IDENTITY_MISMATCH');
    const installedSkill = join(installed, 'skills', 'noknok', 'SKILL.md');
    const expectedSkill = files.get('skills/noknok/SKILL.md').toString('utf8');
    for (const bin of ['noknok', 'agentcall']) {
      const executable = join(prefix, 'node_modules', '.bin', bin);
      if (await realpath(executable) !== await realpath(join(installed, installedManifest.bin[bin]))) fail('INSTALLED_BIN_MISMATCH');
      const version = await command(executable, ['--version'], { cwd: work, env });
      if (version.stderr || JSON.stringify(JSON.parse(version.stdout)) !== JSON.stringify({ name: expected.name, version: expected.version })) fail('CLI_VERSION_MISMATCH');
      const skill = await command(executable, ['skill'], { cwd: work, env });
      const path = await command(executable, ['skill', '--path'], { cwd: work, env });
      if (skill.stderr || skill.stdout !== expectedSkill || path.stderr || path.stdout.trim() !== await realpath(installedSkill)) fail('INSTALLED_SKILL_MISMATCH');
    }
    // The package name differs from both binary names, so npm exec must select
    // the binary explicitly. Use only the inspected tarball, never the registry.
    const invoked = await npm(['exec', '--offline', '--yes', `--package=${checkedTarball}`, '--', 'noknok', '--version']);
    if (invoked.stderr || JSON.stringify(JSON.parse(invoked.stdout)) !== JSON.stringify({ name: expected.name, version: expected.version })) fail('NPM_EXEC_VERSION_MISMATCH');
    try { await stat(env.AGENTCALL_HOME); fail('UNEXPECTED_AGENT_STATE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return {
      ok: true, ...inspection, npmVersion,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      checks: ['archive-contents', 'publish-metadata', 'secret-patterns', 'offline-tarball-install', 'offline-npm-exec', 'both-cli-bins', 'bundled-skill', 'no-agent-state'],
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--archive')) fail('USAGE_CHECK_PACKAGE_OPTIONAL_ARCHIVE');
    console.log(JSON.stringify(await checkPackage({ archivePath: args[1] })));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'PACKAGE_CHECK_FAILED' }));
    process.exitCode = 1;
  }
}
