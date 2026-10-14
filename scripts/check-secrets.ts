import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SecretFinding {
  rule: string;
  path: string;
  line: number;
  blob?: string;
  commits?: string[];
}
interface SecretRule { id: string; pattern: RegExp }
const RULES: SecretRule[] = [
  { id: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { id: 'NPM_TOKEN', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { id: 'GITHUB_TOKEN', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { id: 'CLOUD_ACCESS_KEY', pattern: /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b/g },
  { id: 'MODEL_API_TOKEN', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/g },
  { id: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: 'NOKNOK_CREDENTIAL', pattern: /\b(?:nk_(?:account|agent|beta)_[A-Za-z0-9_-]{24,}|nk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}|whsec_[A-Za-z0-9+/=_-]{24,})\b/g },
  { id: 'AUTH_LITERAL', pattern: /(?:_authToken|_auth|privateKey|signingKey|api[_-]?key|access[_-]?token|secret[_-]?key|password)["']?\s*[:=]\s*["'][A-Za-z0-9+/_=.-]{24,}["']/gi },
  { id: 'NPM_AUTH_CONFIG', pattern: /(?:^|\n)[^\n=]*(?:_authToken|_auth|_password)\s*=\s*(?!\$\{)[A-Za-z0-9+/_=-]{20,}(?:\s|$)/g },
  { id: 'INTERNAL_REFERENCE', pattern: /(?:code\.byted\.org|sso\.bytedance\.com|bytedance\.larkoffice\.com|[A-Za-z0-9._-]+\.(?:boe|byted)\.(?:org|com|net)|\/Users\/bytedance\/|\/home\/bytedance\/|[A-Za-z0-9._%+-]+@bytedance\.com)/gi },
];
const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh|\.aws|\.env(?:\.[^/]*)?|[^/]+_(?:rsa|ed25519|ecdsa|dsa)|control\.sqlite(?:-wal|-shm)?|signing\.key|subscriptions\.key)(?:\/|$)|\.(?:pem|p12|pfx|key)$/i;
const BUFFER_LIMIT = 128 * 1024 * 1024;
// This one packaging-regression fixture contains a PEM heading followed by
// deliberately fake content. Match the entire audited source line, not its
// filename alone: adding a real credential anywhere in a test must still fail.
const PACKAGE_FIXTURE_HASH = 'c46d3ac1c2dfa649d08a496bdbb9e79db6fc62e469bb9628cc57f8c0cb240466';
function knownFixture(rule: string, path: string, line: string): boolean {
  return rule === 'PRIVATE_KEY' && ['packages/cli/test/package-check.test.ts', 'test/package-check.test.mjs'].includes(path)
    && createHash('sha256').update(line.trim()).digest('hex') === PACKAGE_FIXTURE_HASH;
}

// Deliberately return locations only. Never include matching values, source
// lines, subprocess stderr, or credential-bearing exception messages.
export function scanSecretText(content: string | Buffer, path: string): SecretFinding[] {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  const findings: SecretFinding[] = [];
  if (SENSITIVE_PATH.test(path)) findings.push({ rule: 'SENSITIVE_FILE', path, line: 1 });
  for (const { id, pattern } of RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      if (!knownFixture(id, path, text.split('\n')[line - 1])) findings.push({ rule: id, path, line });
    }
  }
  return findings;
}

function git(cwd: string, args: string[], input?: string): Buffer {
  return execFileSync('git', args, { cwd, input, maxBuffer: BUFFER_LIMIT, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function checkSecrets({ cwd = process.cwd(), history = false }: { cwd?: string; history?: boolean } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).toString().trim();
  const tracked = git(root, ['ls-files', '-z']).toString().split('\0').filter(Boolean);
  const findings: SecretFinding[] = [];
  for (const path of tracked) {
    const filename = join(root, path);
    let info;
    try { info = lstatSync(filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    // Do not follow a tracked symlink into credentials outside the repository.
    if (info.isSymbolicLink()) { findings.push(...scanSecretText(readlinkSync(filename), path)); continue; }
    if (!info.isFile() || info.size > BUFFER_LIMIT) throw new Error('UNSCANNABLE_TRACKED_FILE');
    findings.push(...scanSecretText(readFileSync(filename), path));
  }
  let historyObjects = 0;
  if (history) {
    const objects = git(root, ['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean).map(line => {
      const split = line.indexOf(' ');
      return split < 0 ? { id: line, path: '' } : { id: line.slice(0, split), path: line.slice(split + 1) };
    });
    const batch = git(root, ['cat-file', '--batch'], objects.map(item => item.id).join('\n') + '\n');
    let offset = 0;
    for (const object of objects) {
      const newline = batch.indexOf(10, offset);
      if (newline < 0) throw new Error('INVALID_GIT_BATCH');
      const [id, type, sizeText] = batch.subarray(offset, newline).toString().split(' ');
      const size = Number(sizeText);
      if (id !== object.id || !Number.isSafeInteger(size) || size < 0 || newline + size + 2 > batch.length) throw new Error('INVALID_GIT_BATCH');
      const bytes = batch.subarray(newline + 1, newline + 1 + size);
      offset = newline + size + 2;
      if (!['blob', 'commit', 'tag'].includes(type)) continue;
      historyObjects++;
      const hits = scanSecretText(bytes, object.path || `<${type}>`);
      if (!hits.length) continue;
      const commits = type === 'commit' ? [id] : git(root, ['log', '--all', `--find-object=${id}`, '--format=%H']).toString().trim().split('\n').filter(Boolean);
      findings.push(...hits.map(hit => ({ ...hit, blob: id, commits })));
    }
    if (offset !== batch.length) throw new Error('INVALID_GIT_BATCH');
  }
  return { ok: findings.length === 0, trackedFiles: tracked.length, historyObjects, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--history')) throw new Error('INVALID_ARGUMENTS');
    const result = checkSecrets({ history: args.includes('--history') });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'SECRET_SCAN_FAILED' }));
    process.exitCode = 1;
  }
}
