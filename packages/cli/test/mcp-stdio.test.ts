import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationJoinLink } from './meeting-invitation-helper.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../src/relay.js';
import { startStdioMcp } from '../src/mcp-stdio.js';

const cli = fileURLToPath(new URL('../dist/bin/noknok.js', import.meta.url));
const wrapper = new URL('../dist/src/mcp-stdio.js', import.meta.url).href;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-mcp-'));
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise(resolve => {
      child.once('close', resolve);
      child.kill('SIGKILL');
    })));
    await rm(directory, { recursive: true, force: true });
  });
  function launch(args, { env } = {}) {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    children.add(child);
    let stdout = '', stderr = '', buffer = '', invalidOutput;
    const messages = [], waits = new Map();
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk; buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(raw); } catch { invalidOutput = raw; continue; }
        messages.push(message);
        const waiter = waits.get(message.id);
        if (waiter) { waits.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        children.delete(child);
        for (const waiter of waits.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited while a response was pending: ${stderr}`)); }
        waits.clear();
        resolve({ code, signal, stdout, stderr, invalidOutput });
      });
    });
    function response(id, timeoutMs = 5000) {
      const previous = messages.find(message => message.id === id);
      if (previous) return Promise.resolve(previous);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waits.delete(id); reject(new Error(`No MCP response for ${id}. ${stderr}`)); }, timeoutMs);
        waits.set(id, { resolve, reject, timer });
      });
    }
    function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
    async function request(id, method, params) {
      const pending = response(id);
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return pending;
    }
    async function initialize(version = '2025-11-25') {
      const result = await request('init', 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'noknok-test', version: '1.0.0' } });
      assert.equal(result.error, undefined);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result.result;
    }
    async function stop(signal) {
      if (signal) child.kill(signal); else child.stdin.end();
      const result = await Promise.race([closed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP did not exit promptly.')), 3000);
        timer.unref();
      })]);
      assert.equal(result.invalidOutput, undefined, 'stdout must contain only JSON-RPC messages.');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result;
    }
    return { child, messages, response, request, send, initialize, stop, closed };
  }
  async function stub(binding = { directory: join(directory, 'fixed'), name: 'Fixed Agent', server: 'http://127.0.0.1:4317' }) {
    const entry = join(directory, 'mcp-stub.js');
    await writeFile(entry, `
      import { startStdioMcp } from ${JSON.stringify(wrapper)};
      const lifetime = new AbortController();
      process.once('SIGTERM', () => lifetime.abort());
      let bootstraps = 0;
      let aborted = 0;
      await startStdioMcp({ ...${JSON.stringify(binding)}, signal: lifetime.signal,
        run: async (argv, { signal, emit }) => {
          if (argv[0] === 'identity') bootstraps++;
          if (argv[0] === 'meeting' && argv[1] === 'receive') {
            process.stderr.write('LISTEN_STARTED\\n');
            if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            aborted++;
            process.stderr.write('LISTEN_ABORTED\\n');
            signal.throwIfAborted();
          }
          if (argv[0] === 'hosted' && argv[1] === 'friend-remove') throw Object.assign(new Error('Contact was not found.'), { code: 'CONTACT_NOT_FOUND' });
          await emit({ argv, bootstraps, aborted });
        }
      });
    `);
    return launch([entry]);
  }
  return { directory, launch, stub };
}

function toolResult(message) {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.equal(message.result.isError, false, JSON.stringify(message.result));
  assert.deepEqual(JSON.parse(message.result.content[0].text), message.result.structuredContent);
  return message.result.structuredContent;
}

test('stdio requires a fixed profile and never bootstraps a legacy contact identity', async t => {
  const f = await fixture(t);
  await assert.rejects(startStdioMcp({ run: async () => {} }), /fixed agent profile or identity directory/);
  await assert.rejects(startStdioMcp({ agent: '--state-dir=/tmp/other', run: async () => {} }), /valid fixed agent profile handle/);
  const agent = 'ap_00000000-0000-4000-8000-000000000000';
  for (const binding of [{ directory: join(f.directory, 'unnamed') }, { agent, directory: join(f.directory, 'resolved-profile') }]) {
    const client = await f.stub(binding);
    await client.initialize();
    const identity = toolResult(await client.request('identity', 'tools/call', { name: 'noknok_hosted_identity' }));
    const expectedBinding = binding.agent ? `--agent=${agent}` : `--state-dir=${binding.directory}`;
    assert.deepEqual(identity.argv, ['hosted', 'identity', expectedBinding, '--']);
    const friends = toolResult(await client.request('friends', 'tools/call', { name: 'noknok_hosted_friends' }));
    assert.deepEqual(friends.argv, ['hosted', 'friends', expectedBinding, '--']);
    assert.equal(friends.bootstraps, 0);
    await client.stop();
  }
});

test('stdio negotiates supported protocol versions and exposes only scoped tools', async t => {
  const f = await fixture(t);
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2099-01-01']) {
    const client = f.launch([cli, 'mcp', '--name', 'Trae', '--state-dir', join(f.directory, version)]);
    const init = await client.initialize(version);
    assert.equal(init.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
    assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
    const catalog = await client.request('catalog', 'tools/list');
    const tools = catalog.result.tools;
    assert.ok(tools.some(tool => tool.name === 'noknok_hosted_friend_link'));
    assert.ok(tools.every(tool => /^noknok_(?:meeting|hosted)_/.test(tool.name)));
    assert.equal(tools.some(tool => tool.name === 'noknok_listen'), false);
    assert.ok(tools.some(tool => tool.name === 'noknok_meeting_receive'));
    for (const item of tools) {
      assert.equal(item.inputSchema.additionalProperties, false);
      assert.equal(item.inputSchema.properties.directory, undefined);
      assert.equal(item.inputSchema.properties.server, undefined);
      assert.equal(item.inputSchema.properties.file, undefined);
    }
    assert.equal(tools.find(tool => tool.name === 'noknok_meeting_receive').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'noknok_hosted_friends').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'noknok_meeting_history').annotations.readOnlyHint, true);
    assert.deepEqual((await client.request('ping', 'ping')).result, {});
    await client.stop();
  }
});

test('stdio validates arguments, binds its identity directory and passes shell-like text literally', async t => {
  const f = await fixture(t);
  const client = await f.stub();
  await client.initialize();
  const session = 'am_00000000-0000-4000-8000-000000000000';
  const invalid = [
    { name: 'noknok_meeting_send', arguments: { session, text: 'hello', file: '/tmp/secret' } },
    { name: 'noknok_meeting_receive', arguments: { session, timeout: '45' } },
    { name: 'noknok_meeting_receive', arguments: { session, timeout: -1 } },
    { name: 'noknok_meeting_receive', arguments: { session, timeout: 3601 } },
    { name: 'noknok_hosted_identity', arguments: null },
    { name: 'noknok_hosted_call', arguments: { peer_id: 'B', purpose: 'x'.repeat(8193) } },
    { name: 'noknok_hosted_identity', arguments: { 'state-dir': '/tmp/other-agent' } },
    { name: 'noknok_meeting_receive', arguments: { session: '../../other-agent' } },
    { name: 'arbitrary_command', arguments: {} },
  ];
  for (let index = 0; index < invalid.length; index++) assert.equal((await client.request(index, 'tools/call', invalid[index])).error.code, -32602);
  const literal = '--state-dir=/tmp/other $(touch /tmp/pwned) `whoami`\nsecond line';
  const call = toolResult(await client.request('call', 'tools/call', { name: 'noknok_meeting_create', arguments: { purpose: literal }, _meta: { progressToken: 'allowed' } }));
  assert.deepEqual(call.argv, ['meeting', 'create', `--state-dir=${join(f.directory, 'fixed')}`, '--name=Fixed Agent', '--server=http://127.0.0.1:4317', `--purpose=${literal}`, '--']);
  assert.equal(call.bootstraps, 0);
  const friends = toolResult(await client.request('friends', 'tools/call', { name: 'noknok_hosted_friends' }));
  assert.equal(friends.bootstraps, 0);
  const error = await client.request('remove', 'tools/call', { name: 'noknok_hosted_friend_remove', arguments: { peer_id: 'missing' } });
  assert.equal(error.error, undefined);
  assert.equal(error.result.isError, true);
  assert.equal(error.result.structuredContent.error.code, 'CONTACT_NOT_FOUND');
  await client.stop();
});

test('meeting MCP tools bind one local profile without a legacy contact registration', async t => {
  const f = await fixture(t);
  const client = await f.stub({ directory: join(f.directory, 'meeting-profile'), product: 'codex', server: 'http://127.0.0.1:4317' });
  await client.initialize();
  const catalog = (await client.request('catalog', 'tools/list')).result.tools;
  assert.ok(catalog.some(tool => tool.name === 'noknok_meeting_create'));
  for (const name of ['identity', 'friend_link', 'friend_add', 'friends', 'friend_remove', 'history', 'sessions', 'call', 'listen', 'send', 'receive', 'wait', 'finish', 'hangup', 'view']) {
    assert.equal(catalog.some(tool => tool.name === `noknok_${name}`), false);
    assert.equal((await client.request(`removed-${name}`, 'tools/call', { name: `noknok_${name}` })).error.code, -32602);
  }
  const goal = 'Review $(literal) `text` --state-dir=untrusted';
  const created = toolResult(await client.request('create', 'tools/call', { name: 'noknok_meeting_create', arguments: { purpose: goal } }));
  assert.deepEqual(created.argv, ['meeting', 'create', `--state-dir=${join(f.directory, 'meeting-profile')}`, '--product=codex', '--server=http://127.0.0.1:4317', `--purpose=${goal}`, '--']);
  assert.equal(created.bootstraps, 0, 'Meeting creation must not register a contact identity.');
  const session = 'am_00000000-0000-4000-8000-000000000000';
  const ready = toolResult(await client.request('ready', 'tools/call', { name: 'noknok_meeting_ready', arguments: { session, ready: false } }));
  assert.deepEqual(ready.argv, ['meeting', 'ready', `--state-dir=${join(f.directory, 'meeting-profile')}`, '--ready=false', '--', session]);
  assert.equal((await client.request('invalid', 'tools/call', { name: 'noknok_meeting_ready', arguments: { session, ready: 'false' } })).error.code, -32602);
  assert.equal((await client.request('foreign', 'tools/call', { name: 'noknok_meeting_send', arguments: { session, text: 'Hi', directory: '/tmp/another' } })).error.code, -32602);
  await client.stop();
});

test('unbound MCP connections create independent meeting profiles and recover with the returned binding', async t => {
  const f = await fixture(t);
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  const env = { ...process.env, NOKNOK_HOME: join(f.directory, 'managed-meetings'), NOKNOK_SERVER: relay.url };
  delete env.NOKNOK_AGENT;
  delete env.NOKNOK_SERVER_KEY;
  const a = f.launch([cli, 'mcp', '--product', 'codex'], { env });
  await a.initialize();
  const create = toolResult(await a.request('create', 'tools/call', { name: 'noknok_meeting_create', arguments: { purpose: 'Original profile must not be adopted' } }));
  const b = f.launch([cli, 'mcp', '--product', 'codex'], { env });
  await b.initialize();
  const guest = toolResult(await b.request('join', 'tools/call', { name: 'noknok_meeting_join', arguments: { link: invitationJoinLink(create) } }));
  assert.notEqual(guest.localAgent, create.localAgent);
  assert.notEqual(guest.participant.id, create.participant.id);
  assert.equal(guest.participant.name, 'agent-codex');
  for (const entry of [create, guest]) await assert.rejects(readFile(join(env.NOKNOK_HOME, 'profiles', entry.localAgent, 'contacts.json')), { code: 'ENOENT' });
  await Promise.all([a.stop(), b.stop()]);
  const resumed = f.launch([cli, 'mcp', '--agent', guest.localAgent], { env });
  await resumed.initialize();
  const joinedAgain = toolResult(await resumed.request('join-again', 'tools/call', { name: 'noknok_meeting_join', arguments: { link: invitationJoinLink(create) } }));
  assert.equal(joinedAgain.session, guest.session);
  assert.equal(joinedAgain.participant.name, 'agent-codex');
  await resumed.stop();
});

test('stdio rejects malformed, batched and oversized input without losing the next request', async t => {
  const f = await fixture(t);
  const client = f.launch([cli, 'mcp', '--name', 'Parser', '--state-dir', join(f.directory, 'parser')]);
  await client.initialize();
  client.child.stdin.write('{broken\n');
  await client.request('after-broken', 'ping');
  assert.ok(client.messages.some(message => message.error?.code === -32700));
  client.child.stdin.write('[]\n');
  await client.request('after-batch', 'ping');
  assert.ok(client.messages.some(message => message.error?.code === -32600));
  client.child.stdin.write(`${'x'.repeat(256 * 1024 + 1)}\n`);
  await client.request('after-large', 'ping');
  assert.ok(client.messages.some(message => message.error?.message === 'MCP request exceeds 256 KiB.'));
  await client.stop();
});

test('stdio keeps ping and cancellation responsive during blocked tools and aborts on EOF and SIGTERM', async t => {
  const f = await fixture(t);
  for (const ending of ['EOF', 'SIGTERM']) {
    const client = await f.stub();
    await client.initialize();
    let observed = '';
    const observedMarker = (marker, count) => new Promise(resolve => {
      function listener(chunk) {
        observed += chunk;
        if (observed.split(marker).length - 1 >= count) { client.child.stderr.off('data', listener); resolve(); }
      }
      client.child.stderr.on('data', listener);
    });
    const first = observedMarker('LISTEN_STARTED', 1);
    client.send({ jsonrpc: '2.0', id: 'blocked', method: 'tools/call', params: { name: 'noknok_meeting_receive', arguments: { session: 'am_00000000-0000-4000-8000-000000000000' } } });
    await first;
    assert.deepEqual((await client.request('responsive', 'ping')).result, {});
    const aborted = observedMarker('LISTEN_ABORTED', 1);
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'blocked' } });
    await aborted;
    const checked = toolResult(await client.request('checked', 'tools/call', { name: 'noknok_meeting_sessions' }));
    assert.equal(checked.aborted, 1);
    assert.equal(client.messages.some(message => message.id === 'blocked'), false);
    const second = observedMarker('LISTEN_STARTED', 2);
    client.send({ jsonrpc: '2.0', id: 'pending-at-close', method: 'tools/call', params: { name: 'noknok_meeting_receive', arguments: { session: 'am_00000000-0000-4000-8000-000000000000' } } });
    await second;
    if (ending === 'EOF') client.child.stdin.end(); else client.child.kill('SIGTERM');
    const result = await Promise.race([client.closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Blocked MCP did not shut down.')), 3000); timer.unref(); })]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.invalidOutput, undefined);
    assert.equal(result.stderr, 'LISTEN_STARTED\nLISTEN_ABORTED\nLISTEN_STARTED\nLISTEN_ABORTED\n');
  }
});

test('managed encrypted meeting profiles survive restart and remain isolated', async t => {
  const f = await fixture(t);
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  const env = { ...process.env, NOKNOK_HOME: join(f.directory, 'managed'), NOKNOK_SERVER: relay.url };
  delete env.NOKNOK_AGENT; delete env.NOKNOK_PRODUCT; delete env.NOKNOK_SERVER_KEY;
  const a = f.launch([cli, 'mcp', '--product', 'doubaowork'], { env });
  const b = f.launch([cli, 'mcp', '--product', 'dot'], { env });
  const c = f.launch([cli, 'mcp'], { env });
  await Promise.all([a.initialize(), b.initialize(), c.initialize()]);
  const host = toolResult(await a.request('create', 'tools/call', { name: 'noknok_meeting_create', arguments: { purpose: 'Persist this encrypted meeting' } }));
  const guest = toolResult(await b.request('join', 'tools/call', { name: 'noknok_meeting_join', arguments: { link: invitationJoinLink(host) } }));
  assert.notEqual(host.localAgent, guest.localAgent);
  assert.equal(host.participant.name, 'agent-doubaowork');
  assert.equal(guest.participant.name, 'agent-dot');
  const unrelated = toolResult(await c.request('sessions', 'tools/call', { name: 'noknok_meeting_sessions' }));
  assert.notEqual(unrelated.localAgent, host.localAgent);
  assert.notEqual(unrelated.localAgent, guest.localAgent);
  assert.deepEqual(unrelated.sessions, []);
  const denied = await c.request('legacy-call', 'tools/call', { name: 'noknok_call', arguments: { contact: host.participant.id, purpose: 'No legacy tool exists' } });
  assert.equal(denied.error.code, -32602);
  await a.stop();
  const resumed = f.launch([cli, 'mcp', '--agent', host.localAgent], { env });
  await resumed.initialize();
  const restored = toolResult(await resumed.request('status', 'tools/call', { name: 'noknok_meeting_status', arguments: { session: host.session } }));
  assert.equal(restored.localAgent, host.localAgent);
  assert.equal(restored.meeting.id, host.meetingId);
  assert.equal(restored.meeting.purpose, 'Persist this encrypted meeting');
  const sessions = toolResult(await resumed.request('sessions', 'tools/call', { name: 'noknok_meeting_sessions' }));
  assert.deepEqual(sessions.sessions.map(item => item.session), [host.session]);
  assert.equal(sessions.sessions[0].participant.name, 'agent-doubaowork');
  await Promise.all([resumed.stop(), b.stop(), c.stop()]);
});
