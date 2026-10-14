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
interface Result { session: string; invitation: string; call: { state: string }; events: Array<{ data: { text?: string } }> }
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
  const a = await cli('invite', '--server', relay.url, '--name', 'Agent A', '--purpose', '验证两个独立 CLI 身份可以完成双向协作', '--context', '这是自动演示，不会调用任何模型或执行远程命令。');
  console.log('1. A 创建邀请（5 分钟有效），邀请立即返回。');
  const waiting = cli('wait', a.session, '--timeout', '10');
  const b = await cli('accept', a.invitation, '--name', 'Agent B');
  assert.notEqual(a.session, b.session);
  assert.equal((await waiting).call.state, 'connected');
  console.log('2. B 接听；同一台机器的两端使用不同本地 session。');
  await cli('receive', b.session, '--timeout', '0');
  const receiving = cli('receive', b.session, '--timeout', '10');
  await cli('send', a.session, '--type', 'request', '--text', '请返回你的验证结果：6 × 7。');
  assert.ok((await receiving).events.some(event => event.data.text?.includes('6 × 7')));
  await cli('send', b.session, '--type', 'result', '--text', '验证结果是 42。');
  assert.ok((await cli('receive', a.session, '--timeout', '0')).events.some(event => event.data.text?.includes('42')));
  console.log('3. 双向请求/结果与阻塞接收已验证。');
  assert.equal((await cli('finish', a.session, '--text', 'A 已验证收到 42。')).call.state, 'connected');
  assert.equal((await cli('finish', b.session, '--text', 'B 确认本次演示完成。')).call.state, 'completed');
  assert.equal((await cli('status', a.session)).call.state, 'completed');
  console.log('4. 单方完成提议不会挂断；双方确认后状态为 completed。');
  console.log('PASS — 传输/CLI 演示通过。真实 agent 仍需按 README 加载 Skill 进行测试。');
} finally {
  await relay.close();
  await rm(state, { recursive: true, force: true });
}
