import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { createMcpDiagnosticWriter, type McpDiagnosticRecord } from '../src/mcp-diagnostics.js';

const record = (requestId: string): McpDiagnosticRecord => ({ component: 'noknok.mcp',
  timestamp: '2026-10-14T14:26:42.000Z', requestId, event: 'request', stage: 'received',
  httpMethod: 'POST', origin: 'absent' });

test('the default diagnostic sink survives a closed stderr pipe', { timeout: 10_000 }, async t => {
  // Run the real default sink in a separate process: an unhandled stream error
  // terminates that process instead of being hidden by a test-owned error listener.
  const moduleUrl = new URL('../src/mcp-diagnostics.ts', import.meta.url).href;
  const source = `
    import { writeMcpDiagnostic } from ${JSON.stringify(moduleUrl)};
    const originalEmit = process.stderr.emit.bind(process.stderr);
    process.stderr.emit = (event, ...args) => {
      const emitted = originalEmit(event, ...args);
      if (event === 'error') setImmediate(() => {
        writeMcpDiagnostic(${JSON.stringify(record('after-pipe-failure'))});
        process.stdout.write(JSON.stringify({ survived: true, errorCode: args[0].code }));
        process.disconnect();
      });
      return emitted;
    };
    process.send('ready');
    process.once('message', () => {
      writeMcpDiagnostic(${JSON.stringify(record('first'))});
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const finished = once(child, 'close');
  const ready = await Promise.race([once(child, 'message'), finished.then(() => { throw new Error(`Child exited before readiness: ${stderr}`); })]);
  assert.equal(ready[0], 'ready');
  const pipeClosed = once(child.stderr, 'close');
  child.stderr.destroy();
  await pipeClosed;
  child.send('write');
  const [exitCode, signal] = await finished;
  assert.equal(signal, null);
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { survived: true, errorCode: 'EPIPE' });
});

test('diagnostic backpressure drops subsequent records until drain without growing the queue', async t => {
  const writes: string[] = [], pending: Array<() => void> = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    writes.push(chunk.toString()); pending.push(done);
  } });
  t.after(() => output.destroy());
  const write = createMcpDiagnosticWriter(output);
  write(record('accepted-before-pressure'));
  const initialBytes = output.writableLength;
  assert.ok(initialBytes > output.writableHighWaterMark);
  for (let index = 0; index < 10_000; index++) write(record(`dropped-${index}`));
  assert.equal(output.writableLength, initialBytes);
  assert.equal(writes.length, 1);
  assert.equal(output.listenerCount('drain'), 1);
  const drained = once(output, 'drain');
  pending.shift()!();
  await drained;
  assert.equal(output.writableLength, 0);
  write(record('accepted-after-drain'));
  assert.deepEqual(writes.map(line => JSON.parse(line).requestId), ['accepted-before-pressure', 'accepted-after-drain']);
  assert.equal(output.listenerCount('error'), 1);
  const finalDrain = once(output, 'drain');
  pending.shift()!();
  await finalDrain;
});
