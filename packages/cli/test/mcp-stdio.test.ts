import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationJoinLink } from './meeting-invitation-helper.js';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startRelay } from '../src/relay.js';
import { api, decodeInvitation } from '../src/client.js';
import { Store } from '../src/store.js';
import { startStdioMcp } from '../src/mcp-stdio.js';
import { RECEIVER_TOOLS } from '../src/gateway-contract.js';

const cli = fileURLToPath(new URL('../dist/bin/noknok.js', import.meta.url));
const wrapper = new URL('../dist/src/mcp-stdio.js', import.meta.url).href;
const execFileAsync = promisify(execFile);

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
          if (argv[0] === 'listen') {
            process.stderr.write('LISTEN_STARTED\\n');
            if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            aborted++;
            process.stderr.write('LISTEN_ABORTED\\n');
            signal.throwIfAborted();
          }
          if (argv[0] === 'friend-remove') throw Object.assign(new Error('Contact was not found.'), { code: 'CONTACT_NOT_FOUND' });
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

test('stdio requires a fixed identity binding and leaves optional bootstrap settings unset', async t => {
  const f = await fixture(t);
  await assert.rejects(startStdioMcp({ run: async () => {} }), /fixed agent profile or identity directory/);
  await assert.rejects(startStdioMcp({ agent: '--state-dir=/tmp/other', run: async () => {} }), /valid fixed agent profile handle/);
  const agent = 'ap_00000000-0000-4000-8000-000000000000';
  for (const binding of [{ directory: join(f.directory, 'unnamed') }, { agent, directory: join(f.directory, 'resolved-profile') }]) {
    const client = await f.stub(binding);
    await client.initialize();
    const identity = toolResult(await client.request('identity', 'tools/call', { name: 'noknok_identity' }));
    const expectedBinding = binding.agent ? `--agent=${agent}` : `--state-dir=${binding.directory}`;
    assert.deepEqual(identity.argv, ['identity', expectedBinding]);
    const friends = toolResult(await client.request('friends', 'tools/call', { name: 'noknok_friends' }));
    assert.deepEqual(friends.argv, ['friends', expectedBinding, '--']);
    assert.equal(friends.bootstraps, 1);
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
    assert.ok(tools.some(tool => tool.name === 'noknok_friend_link'));
    assert.ok(tools.some(tool => tool.name === 'noknok_listen'));
    for (const item of tools) {
      assert.equal(item.inputSchema.additionalProperties, false);
      assert.equal(item.inputSchema.properties.directory, undefined);
      assert.equal(item.inputSchema.properties.server, undefined);
      assert.equal(item.inputSchema.properties.file, undefined);
    }
    assert.equal(tools.find(tool => tool.name === 'noknok_listen').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'noknok_friends').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'noknok_history').annotations.readOnlyHint, true);
    assert.deepEqual((await client.request('ping', 'ping')).result, {});
    await client.stop();
  }
});

test('stdio validates arguments, binds its identity directory and passes shell-like text literally', async t => {
  const f = await fixture(t);
  const client = await f.stub();
  await client.initialize();
  const invalid = [
    { name: 'noknok_send', arguments: { session: 'ac_00000000-0000-4000-8000-000000000000', text: 'hello', file: '/tmp/secret' } },
    { name: 'noknok_listen', arguments: { timeout: '45' } },
    { name: 'noknok_listen', arguments: { timeout: -1 } },
    { name: 'noknok_listen', arguments: { timeout: 46 } },
    { name: 'noknok_identity', arguments: null },
    { name: 'noknok_call', arguments: { contact: 'B', purpose: 'x'.repeat(8193) } },
    { name: 'noknok_identity', arguments: { 'state-dir': '/tmp/other-agent' } },
    { name: 'noknok_receive', arguments: { session: '../../other-agent' } },
    { name: 'arbitrary_command', arguments: {} },
  ];
  for (let index = 0; index < invalid.length; index++) assert.equal((await client.request(index, 'tools/call', invalid[index])).error.code, -32602);
  const literal = '--state-dir=/tmp/other $(touch /tmp/pwned) `whoami`\nsecond line';
  const call = toolResult(await client.request('call', 'tools/call', { name: 'noknok_call', arguments: { contact: '--other-agent', purpose: literal }, _meta: { progressToken: 'allowed' } }));
  assert.deepEqual(call.argv, ['call', `--state-dir=${join(f.directory, 'fixed')}`, `--purpose=${literal}`, '--', '--other-agent']);
  assert.equal(call.bootstraps, 1);
  const friends = toolResult(await client.request('friends', 'tools/call', { name: 'noknok_friends' }));
  assert.equal(friends.bootstraps, 1);
  const error = await client.request('remove', 'tools/call', { name: 'noknok_friend_remove', arguments: { contact: 'missing' } });
  assert.equal(error.error, undefined);
  assert.equal(error.result.isError, true);
  assert.equal(error.result.structuredContent.error.code, 'CONTACT_NOT_FOUND');
  await client.stop();
});

test('meeting MCP tools bind one local profile without creating contacts or expanding gateway authority', async t => {
  const f = await fixture(t);
  const client = await f.stub({ directory: join(f.directory, 'meeting-profile'), product: 'codex', server: 'http://127.0.0.1:4317' });
  await client.initialize();
  const catalog = (await client.request('catalog', 'tools/list')).result.tools;
  assert.ok(catalog.some(tool => tool.name === 'noknok_meeting_create'));
  assert.equal(RECEIVER_TOOLS.some(tool => tool.name.startsWith('noknok_meeting_')), false);
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
    client.send({ jsonrpc: '2.0', id: 'blocked', method: 'tools/call', params: { name: 'noknok_listen' } });
    await first;
    assert.deepEqual((await client.request('responsive', 'ping')).result, {});
    const aborted = observedMarker('LISTEN_ABORTED', 1);
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'blocked' } });
    await aborted;
    const checked = toolResult(await client.request('checked', 'tools/call', { name: 'noknok_sessions' }));
    assert.equal(checked.aborted, 1);
    assert.equal(client.messages.some(message => message.id === 'blocked'), false);
    const second = observedMarker('LISTEN_STARTED', 2);
    client.send({ jsonrpc: '2.0', id: 'pending-at-close', method: 'tools/call', params: { name: 'noknok_listen' } });
    await second;
    if (ending === 'EOF') client.child.stdin.end(); else client.child.kill('SIGTERM');
    const result = await Promise.race([client.closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Blocked MCP did not shut down.')), 3000); timer.unref(); })]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.invalidOutput, undefined);
    assert.equal(result.stderr, 'LISTEN_STARTED\nLISTEN_ABORTED\nLISTEN_STARTED\nLISTEN_ABORTED\n');
  }
});

test('real CLI-backed MCP exchanges messages and exposes the actual read-only session transcript', async t => {
  const f = await fixture(t);
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  const aStore = new Store(join(f.directory, 'A'));
  const bStore = new Store(join(f.directory, 'B'));
  const invitation = await api(relay.url, '/v1/calls', { method: 'POST', body: { name: 'Trae', purpose: 'Verify real local MCP messages' } });
  const decoded = decodeInvitation(invitation.invitation);
  const joined = await api(relay.url, `/v1/calls/${decoded.callId}/join`, { method: 'POST', body: { name: 'Dot', token: decoded.token } });
  const aSession = await aStore.create(relay.url, invitation.call, invitation.participant);
  const bSession = await bStore.create(relay.url, joined.call, joined.participant);
  const a = f.launch([cli, 'mcp', '--name', 'Trae', '--state-dir', aStore.directory, '--server', relay.url]);
  const b = f.launch([cli, 'mcp', '--name', 'Dot', '--state-dir', bStore.directory, '--server', relay.url]);
  await Promise.all([a.initialize(), b.initialize()]);
  const call = (client, id, name, args) => client.request(id, 'tools/call', { name: `noknok_${name}`, arguments: args }).then(toolResult);
  await call(b, 'drain', 'receive', { session: bSession.id, timeout: 0 });
  let resolvePoll;
  const polling = new Promise(resolve => { resolvePoll = resolve; });
  function listener(req) { if (req.url.includes(`/v1/calls/${decoded.callId}/events`) && req.url.includes('waitMs=25000')) { relay.server.off('request', listener); resolvePoll(); } }
  relay.server.on('request', listener);
  const waiting = call(b, 'receive', 'receive', { session: bSession.id, timeout: 45 });
  await polling;
  assert.deepEqual((await b.request('ping-while-receiving', 'ping')).result, {});
  const text = 'A real MCP message: 你好 dot';
  const sent = await call(a, 'send', 'send', { session: aSession.id, text });
  assert.equal(sent.event.data.text, text);
  const received = await waiting;
  assert.equal(received.events.at(-1).data.text, text);
  await call(b, 'reply', 'send', { session: bSession.id, text: '你好 Trae，消息已收到。' });
  const reply = await call(a, 'receive-reply', 'receive', { session: aSession.id, timeout: 0 });
  assert.ok(reply.events.some(event => event.data.text === '你好 Trae，消息已收到。'));
  const viewed = await call(a, 'view', 'view', { session: aSession.id });
  assert.equal(viewed.viewSession, decoded.callId);
  assert.ok(viewed.url.includes(decoded.callId));
  const history = await call(b, 'history', 'history', { session: bSession.id });
  assert.ok(history.history.some(entry => entry.event?.data?.text === text));
  const wrongDirectory = await a.request('wrong-identity', 'tools/call', { name: 'noknok_history', arguments: { session: bSession.id } });
  assert.equal(wrongDirectory.result.isError, true);
  assert.equal(wrongDirectory.result.structuredContent.error.code, 'SESSION_NOT_FOUND');
  await Promise.all([a.stop(), b.stop()]);
});

test('two stdio clients add a friend and open a visible contact call with independent disk identities', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const relay = await startRelay({ port: 0, contacts: true });
  t.after(() => relay.close());
  const aDirectory = join(f.directory, 'trae');
  const bDirectory = join(f.directory, 'dot');
  const a = f.launch([cli, 'mcp', '--name', 'Trae', '--state-dir', aDirectory, '--server', relay.url]);
  const b = f.launch([cli, 'mcp', '--name', 'Dot', '--state-dir', bDirectory, '--server', relay.url]);
  await Promise.all([a.initialize(), b.initialize()]);
  const call = (client, id, name, args) => client.request(id, 'tools/call', { name: `noknok_${name}`, ...(args ? { arguments: args } : {}) }).then(toolResult);
  const invitation = await call(a, 'friend-link', 'friend_link');
  assert.match(invitation.contactLink, /^noknok:\/\/contact\//);
  const accepted = await call(b, 'friend-add', 'friend_add', { link: invitation.contactLink });
  assert.equal(accepted.contact.id, invitation.agent.id);
  const synced = await call(a, 'friends', 'friends');
  assert.equal(synced.contacts.length, 1);
  assert.equal(synced.contacts[0].id, accepted.agent.id);
  const aProfile = JSON.parse(await readFile(join(aDirectory, 'contacts.json'), 'utf8'));
  const bProfile = JSON.parse(await readFile(join(bDirectory, 'contacts.json'), 'utf8'));
  assert.notEqual(aProfile.token, bProfile.token);
  assert.equal(aProfile.contacts[0].id, bProfile.id);
  assert.equal(bProfile.contacts[0].id, aProfile.id);

  let resolvePoll;
  const polling = new Promise(resolve => { resolvePoll = resolve; });
  function listener(req) {
    if (req.url !== '/v1/contacts') return;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.op === 'poll' && body.waitMs > 0) { relay.server.off('request', listener); resolvePoll(); }
    });
  }
  relay.server.on('request', listener);
  const listening = call(b, 'listen', 'listen', { timeout: 45 });
  await polling;
  const outgoing = await call(a, 'call', 'call', { contact: accepted.agent.id, purpose: 'A synthetic test of the user friend workflow' });
  assert.equal(outgoing.outcome, 'delivered');
  assert.equal(typeof outgoing.viewSession, 'string');
  assert.ok(outgoing.viewUrl.includes(outgoing.viewSession));
  const incoming = await listening;
  assert.equal(incoming.calls.length, 1);
  assert.equal(incoming.calls[0].callId, outgoing.callId);
  assert.notEqual(incoming.calls[0].session, outgoing.session);
  await call(a, 'wait', 'wait', { session: outgoing.session, timeout: 0 });
  await call(a, 'send', 'send', { session: outgoing.session, text: 'Trae MCP test: hello Dot.' });
  const received = await call(b, 'receive', 'receive', { session: incoming.calls[0].session, timeout: 0 });
  assert.ok(received.events.some(event => event.data.text === 'Trae MCP test: hello Dot.'));
  await call(b, 'reply', 'send', { session: incoming.calls[0].session, text: 'Dot MCP test: hello Trae.' });
  const response = await call(a, 'receive', 'receive', { session: outgoing.session, timeout: 0 });
  assert.ok(response.events.some(event => event.data.text === 'Dot MCP test: hello Trae.'));
  await call(a, 'finish', 'finish', { session: outgoing.session, text: 'Friend workflow verified by synthetic clients.' });
  const finished = await call(b, 'finish', 'finish', { session: incoming.calls[0].session, text: 'Verified.' });
  assert.equal(finished.call.state, 'completed');
  await Promise.all([a.stop(), b.stop()]);
});

test('managed profile MCP binding survives restart without names, directories or relay overrides', async t => {
  const f = await fixture(t);
  const relay = await startRelay({ port: 0, contacts: true });
  t.after(() => relay.close());
  const env = { ...process.env, NOKNOK_HOME: join(f.directory, 'managed') };
  delete env.NOKNOK_AGENT;
  delete env.NOKNOK_PRODUCT;
  const makeIdentity = async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, 'identity', '--server', relay.url], { env });
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.match(result.localAgent, /^ap_[a-f0-9-]{36}$/);
    return result;
  };
  const [aIdentity, bIdentity, cIdentity] = await Promise.all([makeIdentity(), makeIdentity(), makeIdentity()]);
  assert.equal(new Set([aIdentity, bIdentity, cIdentity].map(item => item.localAgent)).size, 3);
  const launch = async (identity, product) => {
    const client = f.launch([cli, 'mcp', '--agent', identity.localAgent, ...(product ? ['--product', product] : [])], { env });
    await client.initialize();
    return client;
  };
  const call = async (client, localAgent, id, name, args) => {
    const result = toolResult(await client.request(id, 'tools/call', { name: `noknok_${name}`, ...(args ? { arguments: args } : {}) }));
    assert.equal(result.localAgent, localAgent);
    return result;
  };
  let a = await launch(aIdentity, 'Doubao Work');
  const b = await launch(bIdentity, 'dot');
  const c = await launch(cIdentity);
  const aBefore = await call(a, aIdentity.localAgent, 'identity', 'identity');
  const bBefore = await call(b, bIdentity.localAgent, 'identity', 'identity');
  assert.notEqual(aBefore.agent.id, bBefore.agent.id);
  assert.equal(aBefore.agent.name, 'agent-doubaowork');
  assert.equal(bBefore.agent.name, 'agent-dot');
  assert.equal(aBefore.agent.id, aIdentity.agent.id);
  assert.equal(bBefore.agent.id, bIdentity.agent.id);
  const invitation = await call(a, aIdentity.localAgent, 'friend-link', 'friend_link');
  await call(b, bIdentity.localAgent, 'friend-add', 'friend_add', { link: invitation.contactLink });
  const friends = await call(a, aIdentity.localAgent, 'friends', 'friends');
  assert.deepEqual(friends.contacts.map(contact => contact.id), [bBefore.agent.id]);
  const unrelated = await call(c, cIdentity.localAgent, 'friends', 'friends');
  assert.deepEqual(unrelated.contacts, []);
  const denied = await c.request('unrelated-call', 'tools/call', { name: 'noknok_call', arguments: { contact: aBefore.agent.id, purpose: 'No friendship permission' } });
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.localAgent, cIdentity.localAgent);
  assert.equal(denied.result.structuredContent.error.code, 'CONTACT_NOT_FOUND');
  await a.stop();
  a = await launch(aIdentity);
  const aAfter = await call(a, aIdentity.localAgent, 'identity', 'identity');
  assert.deepEqual(aAfter.agent, aBefore.agent);
  const restored = await call(a, aIdentity.localAgent, 'friends', 'friends');
  assert.deepEqual(restored.contacts.map(contact => contact.id), [bBefore.agent.id]);
  await Promise.all([a.stop(), b.stop(), c.stop()]);
});
