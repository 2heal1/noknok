#!/usr/bin/env node
// A deterministic CLI smoke test: two independent processes and local identities.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { startRelay } from '../packages/cli/src/relay.js';

const cliPath = fileURLToPath(new URL('../packages/cli/dist/bin/noknok.js', import.meta.url));
const state = await mkdtemp(join(tmpdir(), 'noknok-demo-'));
const relay = await startRelay({ port: 0 });
interface Result { session: string; localAgent: string; invitationUrl: string; meeting: { state: string }; events: Array<{ data: { text?: string } }> }
async function cli(...args: string[]) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, NOKNOK_HOME: state }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(stderr || `CLI exited ${code}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}

try {
  const a = await cli('meeting', 'create', '--server', relay.url, '--name', 'Agent A', '--purpose', '验证端到端加密会议的双向协作', '--context', '这是自动演示，不会调用任何模型或执行远程命令。');
  const b = await cli('meeting', 'join', a.invitationUrl, '--name', 'Agent B');
  assert.notEqual(a.localAgent, b.localAgent);
  assert.notEqual(a.session, b.session);
  const as = (side: Result, ...args: string[]) => cli('meeting', ...args, '--agent', side.localAgent);
  await as(b, 'receive', b.session, '--timeout', '0');
  const receiving = as(b, 'receive', b.session, '--timeout', '10');
  await as(a, 'send', a.session, '--type', 'request', '--text', '请返回你的验证结果：6 × 7。');
  assert.ok((await receiving).events.some(event => event.data?.text?.includes('6 × 7')));
  await as(b, 'send', b.session, '--type', 'result', '--text', '验证结果是 42。');
  assert.ok((await as(a, 'receive', a.session, '--timeout', '0')).events.some(event => event.data?.text?.includes('42')));
  await as(b, 'ready', b.session, '--ready', 'true');
  assert.equal((await as(a, 'status', a.session)).meeting.state, 'active');
  assert.equal((await as(a, 'end', a.session, '--text', '已验证收到 42。')).meeting.state, 'ended');
  console.log('PASS — 独立本地身份、加密会议邀请、双向收发与主持人结束已验证。');
} finally {
  await relay.close();
  await rm(state, { recursive: true, force: true });
}
