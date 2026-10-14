import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../src/relay.js';

const cliPath = fileURLToPath(new URL('../dist/bin/noknok.js', import.meta.url));

async function fixture(t, relayOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noknok-cli-'));
  const home = join(root, 'state');
  const children = new Set();
  const stdout = [];
  let relay;
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise(resolve => {
      child.once('close', resolve);
      child.kill('SIGKILL');
    })));
    await relay?.close();
    await rm(root, { recursive: true, force: true });
  });
  relay = await startRelay({ port: 0, ...relayOptions });

  function launch(args, { input, keepStdinOpen = false, nodeArgs = [], ipc = false } = {}) {
    const env = { ...process.env, NOKNOK_HOME: home, NOKNOK_SERVER: relay.url };
    delete env.NOKNOK_SERVER_KEY;
    const child = spawn(process.execPath, [...nodeArgs, cliPath, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
    });
    children.add(child);
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    if (!keepStdinOpen) child.stdin.end(input);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.once('error', error => {
        clearTimeout(timer);
        children.delete(child);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        stdout.push(out);
        resolve({ code, signal, stdout: out, stderr: err });
      });
    });
    return { child, result };
  }

  async function ok(args, options) {
    return success(await launch(args, options).result);
  }

  async function error(args, code) {
    const result = await launch(args).result;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, '', 'Errors must not be mixed into stdout.');
    const data = JSON.parse(result.stderr);
    assert.equal(data.error.code, code);
    assert.equal(typeof data.error.message, 'string');
    return data.error;
  }

  return { root, home, relay, stdout, launch, ok, error };
}

function success(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function promptly(result, message = 'Incoming event did not wake the waiting CLI.') {
  let timer;
  try {
    return await Promise.race([
      result,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('malformed encrypted invitations and unsupported input produce only structured errors', async t => {
  const f = await fixture(t);
  for (const [args, code] of [
    [['meeting', 'join', 'not-an-invitation'], 'INVALID_INVITATION'],
    [['invented-command'], 'INVALID_COMMAND'],
    [['meeting', 'create', '--purpose', 'Valid purpose', '--unexpected', 'value'], 'INVALID_ARGUMENT'],
    [['meeting', 'create', '--purpose'], 'INVALID_ARGUMENT'],
    [['meeting', 'create', '--purpose', 'First', '--purpose', 'Second'], 'INVALID_ARGUMENT'],
    [['invite', '--purpose', 'Plaintext must not leave this computer'], 'INVALID_COMMAND'],
  ]) await f.error(args, code);
});

test('SIGTERM interrupts encrypted meeting creation while stdin remains open', async t => {
  const f = await fixture(t);
  const observeStdin = `process.stdin.on('newListener', function observe(event) {
    if (event !== 'readable') return;
    process.stdin.off('newListener', observe);
    process.send('stdin-reading', () => process.disconnect());
  });`;
  const reading = f.launch(['meeting', 'create', '--purpose', 'Read context from stdin', '--context-file', '-'], {
    keepStdinOpen: true, ipc: true,
    nodeArgs: ['--import', `data:text/javascript,${encodeURIComponent(observeStdin)}`],
  });
  const [ready] = await once(reading.child, 'message', { signal: AbortSignal.timeout(3000) });
  assert.equal(ready, 'stdin-reading');
  reading.child.kill('SIGTERM');
  const interrupted = await promptly(reading.result, 'CLI ignored SIGTERM while waiting for stdin.');
  assert.equal(interrupted.signal, null);
  assert.equal(interrupted.code, 130);
  assert.equal(interrupted.stdout, '');
  assert.equal(JSON.parse(interrupted.stderr).error.code, 'INTERRUPTED');
  assert.deepEqual((await f.ok(['meeting', 'sessions'])).sessions, []);
});

test('server retention accepts only positive integer seconds within the supported range', async t => {
  const f = await fixture(t);
  for (const value of ['0', '-1', '0.5', 'wat', '604801']) {
    await f.error(['server', '--port', '0', '--retention-seconds', value], 'INVALID_ARGUMENT');
  }
  const launched = f.launch(['server', '--port', '0', '--retention-seconds', '86400']);
  let buffer = '';
  const listening = new Promise((resolve, reject) => {
    launched.child.stdout.on('data', chunk => {
      buffer += chunk;
      try { const value = JSON.parse(buffer); if (value.event === 'listening') resolve(value); } catch {}
    });
    launched.child.once('error', reject);
  });
  const ready = await promptly(listening, 'Configured relay did not start.');
  assert.equal(ready.retentionSeconds, 86400);
  assert.equal(ready.storage, 'memory');
  launched.child.kill('SIGTERM');
  const stopped = await promptly(launched.result);
  assert.equal(stopped.signal, null);
});

test('skill commands expose the installed Skill without opening a session or creating local state', async t => {
  const f = await fixture(t);
  const skillPath = fileURLToPath(new URL('../skills/noknok/SKILL.md', import.meta.url));
  const expected = await readFile(skillPath, 'utf8');
  for (const args of [['skill'], ['--skill']]) {
    const result = await f.launch(args).result;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
  }
  const path = await f.launch(['skill', '--path']).result;
  assert.equal(path.code, 0, path.stderr);
  assert.equal(path.stdout, `${skillPath}\n`);
  assert.equal(path.stderr, '');
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
  const help = await f.launch(['--help']).result;
  assert.match(help.stdout, /noknok skill \[--path\]/);
  assert.match(help.stdout, /noknok --skill/);
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await f.ok(['--version']), { name: metadata.name, version: metadata.version });
  await f.error(['--skill', 'sessions'], 'INVALID_ARGUMENT');
  await f.error(['skill', '--path=true'], 'INVALID_ARGUMENT');
});
