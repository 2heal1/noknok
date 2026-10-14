import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readPackageArchive, validatePackageFiles } from '../scripts/check-package.mjs';

const manifest = {
  name: '@noknok/cli', version: '0.0.1', type: 'module',
  bin: { noknok: 'bin/noknok.mjs', agentcall: 'bin/agentcall.mjs' },
  publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
  repository: { type: 'git', url: 'git+https://github.com/2heal1/noknok.git' },
};

function packageFiles(overrides = {}) {
  const files = new Map([
    ['package.json', JSON.stringify({ ...manifest, ...overrides })],
    ['README.md', '# NokNok\n'], ['Dockerfile', 'FROM node:24-alpine\n'],
    ['bin/noknok.mjs', '#!/usr/bin/env node\n'], ['bin/agentcall.mjs', '#!/usr/bin/env node\n'],
    ['src/cli.mjs', 'export {};\n'], ['src/mcp-stdio.mjs', 'export {};\n'],
    ['deploy/server.mjs', 'export {};\n'], ['deploy/hosted-server.mjs', 'export {};\n'],
    ['deploy/compose.hosted.yaml', 'services: {}\n'], ['deploy/Caddyfile.hosted', ':80 {}\n'],
    ['poc/mcp-events/server.mjs', 'export {};\n'],
    ['skills/agentcall/SKILL.md', '# Skill\n'], ['skills/agentcall/references/hosted.md', '# Hosted\n'],
    ['skills/agentcall/references/legacy-calls.md', '# Legacy\n'],
    ['web/meeting.html', '<!doctype html>\n'], ['web/meeting.js', 'export {};\n'],
  ]);
  return new Map([...files].map(([path, text]) => [path, Buffer.from(text)]));
}

function archive(entries) {
  const chunks = [];
  for (const { name, text = '', type = '0' } of entries) {
    const bytes = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

test('archive inspection accepts a complete public scoped package without requiring private files', () => {
  const original = packageFiles();
  const files = readPackageArchive(archive([...original].map(([path, bytes]) => ({ name: `package/${path}`, text: bytes }))));
  assert.deepEqual(files, original);
  assert.deepEqual(validatePackageFiles(files, manifest), { name: manifest.name, version: manifest.version, fileCount: original.size });
});

test('archive inspection rejects traversal, absolute paths, links and duplicate entries before installation', () => {
  for (const name of ['package/../escape', '/tmp/escape', 'package/src/../../escape', 'package/src\\escape', 'package/a\nname']) {
    assert.throws(() => readPackageArchive(archive([{ name, text: 'unsafe' }])), { code: 'UNSAFE_ARCHIVE_PATH' });
  }
  for (const type of ['1', '2', 'x', 'g']) {
    assert.throws(() => readPackageArchive(archive([{ name: 'package/src/link.mjs', type }])), { code: 'UNSUPPORTED_TAR_ENTRY' });
  }
  assert.throws(() => readPackageArchive(archive([{ name: 'package/README.md' }, { name: 'package/README.md' }])), { code: 'DUPLICATE_ARCHIVE_PATH' });
});

test('archive inspection rejects corrupt and oversized archives', () => {
  assert.throws(() => readPackageArchive(Buffer.from('not gzip')), { code: 'INVALID_OR_OVERSIZED_ARCHIVE' });
  assert.throws(() => readPackageArchive(gzipSync(Buffer.alloc(33 * 1024 * 1024))), { code: 'INVALID_OR_OVERSIZED_ARCHIVE' });
  assert.throws(() => readPackageArchive(archive([])), { code: 'INCOMPLETE_ARCHIVE' });
});

test('packaging fails closed when private state, credentials, build output or new scripts enter the archive', () => {
  for (const path of ['.npmrc', '.noknok/hosted.json', '.noknok-test/A-code.txt', 'deploy/signing.key', 'deploy/control.sqlite', 'src/.env', 'docs/credentials.json', 'scripts/publish.mjs', 'node_modules/anything/index.js']) {
    const files = packageFiles();
    files.set(path, Buffer.from('test-only'));
    assert.throws(() => validatePackageFiles(files, manifest), { code: 'UNEXPECTED_PACKAGE_FILE' });
  }
});

test('allowed text paths still reject accidentally embedded keys, live-format credentials and development paths', () => {
  const cases = [
    ['PRIVATE_KEY_CONTENT', '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n'],
    ['CREDENTIAL_CONTENT', `npm_${'a'.repeat(36)}`],
    ['CREDENTIAL_CONTENT', `nk_agent_${'a'.repeat(43)}`],
    ['CREDENTIAL_CONTENT', `nk_beta_${'a'.repeat(32)}`],
    ['CREDENTIAL_CONTENT', `whsec_${'a'.repeat(43)}=`],
    ['CREDENTIAL_CONTENT', `nk1.${'a'.repeat(24)}.${'a'.repeat(43)}`],
    ['CREDENTIAL_CONTENT', `{"accountToken":"${'a'.repeat(32)}"}`],
    ['CREDENTIAL_CONTENT', `//registry.npmjs.org/:_authToken=${'a'.repeat(32)}`],
    ['DEVELOPER_PATH_CONTENT', '/Users/example/project/file'],
    ['DEVELOPER_PATH_CONTENT', '/home/example/project/file'],
    ['DEVELOPER_PATH_CONTENT', 'C:\\Users\\example\\file'],
  ];
  for (const [code, text] of cases) {
    const files = packageFiles();
    files.set('docs/notes.md', Buffer.from(text));
    assert.throws(() => validatePackageFiles(files, manifest), error => error.code === code && error.message === code);
  }
});

test('scope, version, public registry and bins must match the reviewed release identity', () => {
  const cases = [
    [{ name: 'noknok' }, 'PACKAGE_IDENTITY_MISMATCH'],
    [{ name: '@noknok/noknok' }, 'PACKAGE_IDENTITY_MISMATCH'],
    [{ version: '9.9.9' }, 'PACKAGE_IDENTITY_MISMATCH'],
    [{ private: true }, 'INVALID_PUBLISH_CONFIG'],
    [{ publishConfig: { registry: 'https://registry.npmjs.org', access: 'restricted' } }, 'INVALID_PUBLISH_CONFIG'],
    [{ publishConfig: { registry: 'https://example.invalid', access: 'public' } }, 'INVALID_PUBLISH_CONFIG'],
    [{ bin: { noknok: 'bin/missing.mjs', agentcall: 'bin/agentcall.mjs' } }, 'INVALID_PACKAGE_BIN'],
    [{ dependencies: { unexpected: '1.0.0' } }, 'UNEXPECTED_RUNTIME_DEPENDENCIES'],
    [{ scripts: { postinstall: 'node setup.mjs' } }, 'UNEXPECTED_INSTALL_HOOK'],
  ];
  for (const [override, code] of cases) assert.throws(() => validatePackageFiles(packageFiles(override), manifest), { code });
});

test('missing executable or bundled skill fails before installation', () => {
  for (const path of ['bin/agentcall.mjs', 'skills/agentcall/SKILL.md', 'deploy/hosted-server.mjs', 'poc/mcp-events/server.mjs']) {
    const files = packageFiles();
    files.delete(path);
    assert.throws(() => validatePackageFiles(files, manifest), { code: 'MISSING_REQUIRED_PACKAGE_FILE' });
  }
  const files = packageFiles();
  files.set('bin/noknok.mjs', Buffer.from('console.log("missing shebang");'));
  assert.throws(() => validatePackageFiles(files, manifest), { code: 'INVALID_BIN_ENTRY' });
});

test('release-generated changelog and existing support scripts are allowed without publishing release machinery', () => {
  const files = packageFiles();
  for (const path of ['CHANGELOG.md', 'docs/releasing.md', 'scripts/demo.mjs', 'scripts/probe-mcp-events.mjs']) files.set(path, Buffer.from('test-only'));
  assert.equal(validatePackageFiles(files, manifest).fileCount, files.size);
  files.set('scripts/check-package.mjs', Buffer.from('test-only'));
  assert.throws(() => validatePackageFiles(files, manifest), { code: 'UNEXPECTED_PACKAGE_FILE' });
});
