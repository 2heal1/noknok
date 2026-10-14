import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readPackageArchive, validatePackageFiles } from '../../../scripts/check-package.js';
import { fingerprintFiles } from '../../../scripts/runtime-fingerprint.js';

const manifest = {
  name: '@noknok/cli', version: '0.0.1', type: 'module', license: 'Apache-2.0',
  bin: { noknok: 'dist/bin/noknok.js' },
  publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
  repository: { type: 'git', url: 'git+https://github.com/2heal1/noknok.git' },
};

function packageFiles(overrides = {}) {
  const files = new Map([
    ['package.json', JSON.stringify({ ...manifest, ...overrides })],
    ['README.md', '# NokNok\n'], ['LICENSE', 'Apache License 2.0\n'], ['NOTICE', 'NokNok\nCopyright 2026 NokNok contributors\n'],
    ['dist/bin/noknok.js', '#!/usr/bin/env node\n'],
    ['dist/src/cli.js', 'export {};\n'], ['dist/src/hosted-service.js', 'export {};\n'], ['dist/src/mcp-stdio.js', 'export {};\n'],
    ['dist/src/deploy/server.js', 'export {};\n'], ['dist/src/deploy/hosted-server.js', 'export {};\n'],
    ['skills/noknok/SKILL.md', '# Skill\n'], ['skills/noknok/references/hosted.md', '# Hosted\n'],
    ['dist/web/meeting.html', '<!doctype html>\n'], ['dist/web/meeting.js', 'export {};\n'], ['dist/web/meeting-invitation.js', 'export {};\n'],
    ['dist/web/e2ee.js', 'export {};\n'], ['dist/src/e2ee.js', 'export {};\n'],
  ]);
  const bytes = new Map([...files].map(([path, text]) => [path, Buffer.from(text)]));
  bytes.set('dist/runtime-fingerprint.json', Buffer.from(JSON.stringify(fingerprintFiles(bytes, { ...manifest, ...overrides }))));
  return bytes;
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
    assert.throws(() => readPackageArchive(archive([{ name: 'package/src/link.js', type }])), { code: 'UNSUPPORTED_TAR_ENTRY' });
  }
  assert.throws(() => readPackageArchive(archive([{ name: 'package/README.md' }, { name: 'package/README.md' }])), { code: 'DUPLICATE_ARCHIVE_PATH' });
});

test('archive inspection rejects corrupt and oversized archives', () => {
  assert.throws(() => readPackageArchive(Buffer.from('not gzip')), { code: 'INVALID_OR_OVERSIZED_ARCHIVE' });
  assert.throws(() => readPackageArchive(gzipSync(Buffer.alloc(33 * 1024 * 1024))), { code: 'INVALID_OR_OVERSIZED_ARCHIVE' });
  assert.throws(() => readPackageArchive(archive([])), { code: 'INCOMPLETE_ARCHIVE' });
});

test('packaging fails closed when private state, credentials, source files or release scripts enter the archive', () => {
  for (const path of ['.npmrc', '.noknok/hosted.json', '.noknok-test/A-code.txt', 'deploy/signing.key', 'deploy/control.sqlite', 'src/.env', 'docs/credentials.json', 'scripts/publish.js', 'node_modules/anything/index.js', 'dist/web/notes.txt', 'dist/web/nested/THIRD_PARTY_NOTICES.txt']) {
    const files = packageFiles();
    files.set(path, Buffer.from('test-only'));
    assert.throws(() => validatePackageFiles(files, manifest), { code: 'UNEXPECTED_PACKAGE_FILE' });
  }
});

test('the bundled logo notice is allowed and still checked for sensitive content', () => {
  const files = packageFiles();
  const path = 'dist/web/THIRD_PARTY_NOTICES.txt';
  files.set(path, Buffer.from('MIT License\nCopyright (c) 2023 LobeHub\n'));
  files.set('dist/runtime-fingerprint.json', Buffer.from(JSON.stringify(fingerprintFiles(files, manifest))));
  assert.equal(validatePackageFiles(files, manifest).fileCount, files.size);
  files.set(path, Buffer.from(`npm_${'a'.repeat(36)}`));
  assert.throws(() => validatePackageFiles(files, manifest), { code: 'CREDENTIAL_CONTENT' });
});

test('allowed text paths still reject accidentally embedded keys, live-format credentials and development paths', () => {
  const cases = [
    ['PRIVATE_KEY_CONTENT', '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n'],
    ['CREDENTIAL_CONTENT', `npm_${'a'.repeat(36)}`],
    ['CREDENTIAL_CONTENT', `nk_agent_${'a'.repeat(43)}`],
    ['CREDENTIAL_CONTENT', `nk_retired_${'a'.repeat(32)}`],
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
    [{ license: 'UNLICENSED' }, 'INVALID_PACKAGE_LICENSE'],
    [{ private: true }, 'INVALID_PUBLISH_CONFIG'],
    [{ publishConfig: { registry: 'https://registry.npmjs.org', access: 'restricted' } }, 'INVALID_PUBLISH_CONFIG'],
    [{ publishConfig: { registry: 'https://example.invalid', access: 'public' } }, 'INVALID_PUBLISH_CONFIG'],
    [{ bin: { noknok: 'bin/missing.js' } }, 'INVALID_PACKAGE_BIN'],
    [{ dependencies: { unexpected: '1.0.0' } }, 'UNEXPECTED_RUNTIME_DEPENDENCIES'],
    [{ scripts: { postinstall: 'node setup.js' } }, 'UNEXPECTED_INSTALL_HOOK'],
  ];
  for (const [override, code] of cases) assert.throws(() => validatePackageFiles(packageFiles(override), manifest), { code });
});

test('missing license, executable, encryption module or bundled skill fails before installation', () => {
  for (const path of ['LICENSE', 'NOTICE', 'dist/bin/noknok.js', 'skills/noknok/SKILL.md', 'dist/src/deploy/hosted-server.js', 'dist/web/e2ee.js', 'dist/src/e2ee.js']) {
    const files = packageFiles();
    files.delete(path);
    assert.throws(() => validatePackageFiles(files, manifest), { code: 'MISSING_REQUIRED_PACKAGE_FILE' });
  }
  const files = packageFiles();
  files.set('dist/bin/noknok.js', Buffer.from('console.log("missing shebang");'));
  assert.throws(() => validatePackageFiles(files, manifest), { code: 'INVALID_BIN_ENTRY' });
});

test('release-generated changelog are allowed without publishing release machinery', () => {
  const files = packageFiles();
  for (const path of ['CHANGELOG.md', 'docs/releasing.md']) files.set(path, Buffer.from('test-only'));
  assert.equal(validatePackageFiles(files, manifest).fileCount, files.size);
  files.set('scripts/check-package.js', Buffer.from('test-only'));
  assert.throws(() => validatePackageFiles(files, manifest), { code: 'UNEXPECTED_PACKAGE_FILE' });
});

test('retired plaintext protocols and viewers cannot return in the published package', () => {
  for (const path of ['dist/poc/mcp-events/server.js', 'dist/src/legacy.js', 'dist/src/store.js', 'dist/src/contacts.js', 'dist/src/contact-switch.js', 'dist/src/receiver.js', 'dist/src/receiver-control.js', 'dist/src/gateway.js', 'dist/src/gateway-client.js', 'dist/src/gateway-contract.js', 'dist/src/viewer.js', 'dist/web/app.js', 'dist/web/index.html', 'dist/web/styles.css']) {
    const files = packageFiles();
    files.set(path, Buffer.from('retired'));
    assert.throws(() => validatePackageFiles(files, manifest), { code: 'UNEXPECTED_PACKAGE_FILE' });
  }
});
