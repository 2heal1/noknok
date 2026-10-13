import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../src/relay.mjs';

const cliPath = fileURLToPath(new URL('../bin/agentcall.mjs', import.meta.url));

async function fixture(t, { contacts = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentcall-managed-cli-'));
  const home = join(directory, 'home');
  const children = new Set();
  let relay;
  t.after(async () => {
    for (const running of children) running.child.kill('SIGKILL');
    await Promise.all([...children].map(running => running.result.catch(() => {})));
    await relay?.close();
    await rm(directory, { recursive: true, force: true });
  });
  relay = await startRelay({ port: 0, contacts });

  function launch(args, overrides = {}) {
    const env = { ...process.env, AGENTCALL_HOME: home, AGENTCALL_SERVER: 'http://127.0.0.1:1' };
    delete env.AGENTCALL_AGENT;
    delete env.AGENTCALL_PRODUCT;
    delete env.AGENTCALL_SERVER_KEY;
    Object.assign(env, overrides);
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const running = { child };
    running.result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('error', error => { clearTimeout(timer); children.delete(running); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        children.delete(running);
        resolve({ code, signal, stdout, stderr });
      });
    });
    children.add(running);
    return running;
  }

  async function ok(args, env) { return success(await launch(args, env).result); }
  async function error(args, expected, env) {
    const result = await launch(args, env).result;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, '');
    const { error } = JSON.parse(result.stderr);
    assert.equal(error.code, expected, error.message);
    return error;
  }
  return {
    home, launch, ok, error, get relay() { return relay; },
    profile: handle => readFile(join(home, 'profiles', handle, 'contacts.json'), 'utf8').then(JSON.parse),
    async restartWithContacts() {
      const port = Number(new URL(relay.url).port);
      await relay.close();
      relay = await startRelay({ port, contacts: true });
    },
  };
}

function success(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

// Observe the incoming HTTP body to establish that the actual CLI listener is
// waiting before making a call. No sleeps or guesses about subprocess startup.
function nextContactPoll(relay) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      relay.server.off('request', listener);
      reject(new Error('Managed CLI did not establish a contact long poll.'));
    }, 5000);
    function listener(req, res) {
      if (req.url !== '/v1/contacts') return;
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.once('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.op !== 'poll' || body.waitMs <= 0) return;
        clearTimeout(timer);
        relay.server.off('request', listener);
        setImmediate(() => resolve({ responseEnded: res.writableEnded }));
      });
    }
    relay.server.on('request', listener);
  });
}

test('first-use CLI friendship and chat keep two automatic identities isolated in one home and cwd', async t => {
  const f = await fixture(t);
  const a = await f.ok(['friend-link', '--product', 'Doubao Work', '--server', f.relay.url], { AGENTCALL_PRODUCT: 'wrong-host' });
  const b = await f.ok(['friend-add', a.contactLink], { AGENTCALL_PRODUCT: 'dot' });
  assert.match(a.localAgent, /^ap_/);
  assert.match(b.localAgent, /^ap_/);
  assert.notEqual(a.localAgent, b.localAgent);
  assert.notEqual(a.agent.id, b.agent.id);
  assert.equal(a.agent.name, 'agent-doubaowork');
  assert.equal(b.agent.name, 'agent-dot');
  assert.equal(b.contact.id, a.agent.id);
  assert.equal((await f.profile(b.localAgent)).server, f.relay.url, 'friend-add must use the invitation origin instead of AGENTCALL_SERVER');
  const aCmd = args => f.ok([...args, '--agent', a.localAgent]);
  const bCmd = args => f.ok([...args, '--agent', b.localAgent]);
  assert.deepEqual((await aCmd(['friends'])).contacts, [b.agent]);
  assert.deepEqual((await bCmd(['friends'])).contacts, [a.agent]);

  // Saving a friend does not leave a listener running or make an idle peer callable.
  await f.error(['call', b.agent.id, '--agent', a.localAgent, '--purpose', 'Must wait for explicit listening'], 'CONTACT_UNAVAILABLE');
  const cancelledCalls = (await aCmd(['sessions'])).sessions;
  assert.equal(cancelledCalls.length, 1);
  assert.equal((await aCmd(['status', cancelledCalls[0].session])).call.state, 'cancelled');

  const poll = nextContactPoll(f.relay);
  const listener = f.launch(['listen', '--agent', b.localAgent, '--timeout', '5']);
  assert.equal((await poll).responseEnded, false);
  const outgoing = await aCmd(['call', b.agent.id, '--purpose', 'Verify 17 times 19']);
  assert.equal(outgoing.localAgent, a.localAgent);
  assert.equal(outgoing.outcome, 'delivered');
  assert.equal(outgoing.viewSession, outgoing.callId);
  assert.equal(outgoing.viewUrl, `${f.relay.url}/view#session=${outgoing.callId}`);
  const incoming = success(await listener.result);
  assert.equal(incoming.localAgent, b.localAgent);
  assert.equal(incoming.outcome, 'activity');
  assert.equal(incoming.calls.length, 1);
  const callee = incoming.calls[0];
  assert.equal(callee.callId, outgoing.callId);
  assert.notEqual(callee.session, outgoing.session);

  assert.equal((await aCmd(['wait', outgoing.session, '--timeout', '0'])).outcome, 'connected');
  await aCmd(['receive', outgoing.session, '--timeout', '0']);
  await bCmd(['receive', callee.session, '--timeout', '0']);
  const sent = await aCmd(['send', outgoing.session, '--text', 'Please check 17 times 19.']);
  assert.equal(sent.localAgent, a.localAgent);
  const received = await bCmd(['receive', callee.session, '--timeout', '0']);
  assert.equal(received.localAgent, b.localAgent);
  assert.deepEqual(received.events.map(event => event.data.text), ['Please check 17 times 19.']);
  await bCmd(['send', callee.session, '--text', '17 times 19 equals 323.']);
  assert.deepEqual((await aCmd(['receive', outgoing.session, '--timeout', '0'])).events.map(event => event.data.text), ['17 times 19 equals 323.']);

  assert.deepEqual(new Set((await aCmd(['sessions'])).sessions.map(session => session.session)), new Set([cancelledCalls[0].session, outgoing.session]));
  assert.deepEqual((await bCmd(['sessions'])).sessions.map(session => session.session), [callee.session]);
  await f.error(['history', outgoing.session, '--agent', b.localAgent], 'SESSION_NOT_FOUND');
  await f.error(['send', callee.session, '--agent', a.localAgent, '--text', 'Must not impersonate B'], 'SESSION_NOT_FOUND');
  assert.ok((await aCmd(['history', outgoing.session])).history.some(entry => entry.event?.data.text === '17 times 19 equals 323.'));
  assert.equal((await aCmd(['view', outgoing.session])).url, outgoing.viewUrl);
  assert.equal((await aCmd(['finish', outgoing.session, '--text', 'Confirmed 323.'])).call.state, 'connected');
  assert.equal((await bCmd(['finish', callee.session, '--text', 'Confirmed independently.'])).call.state, 'completed');
  assert.equal((await aCmd(['status', outgoing.session])).call.state, 'completed');
});

test('unbound contact commands refuse to guess the sole or latest profile and malformed links allocate nothing', async t => {
  const f = await fixture(t);
  await f.error(['friend-add', 'not-an-invitation'], 'INVALID_CONTACT_LINK');
  await f.error(['friend-add', 'agentcall://contact/invalid'], 'INVALID_CONTACT_LINK');
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
  const commands = [['friends'], ['listen', '--timeout', '0'], ['call', 'someone', '--purpose', 'Test']];
  for (let profiles = 0; profiles < 3; profiles++) {
    if (profiles) await f.ok(['friend-link', '--server', f.relay.url]);
    for (const args of commands) await f.error(args, 'AGENT_REQUIRED');
    if (profiles) assert.equal((await readdir(join(f.home, 'profiles'))).length, profiles);
  }
});

test('a failed first friend-link exposes its saved handle and retry preserves that identity', async t => {
  const f = await fixture(t, { contacts: false });
  const failed = await f.error(['friend-link', '--server', f.relay.url], 'not_found');
  assert.match(failed.localAgent, /^ap_/);
  const before = await f.profile(failed.localAgent);
  await f.restartWithContacts();
  const retried = await f.ok(['friend-link', '--agent', failed.localAgent]);
  assert.equal(retried.localAgent, failed.localAgent);
  assert.equal(retried.agent.id, before.id);
  assert.equal(retried.agent.name, before.name);
  const after = await f.profile(failed.localAgent);
  assert.equal(after.token, before.token);
  assert.equal(after.server, f.relay.url);
  assert.equal((await readdir(join(f.home, 'profiles'))).length, 1);
});

test('environment identity binding is stable and conflicting storage selectors are rejected', async t => {
  const f = await fixture(t);
  const first = await f.ok(['friend-link', '--server', f.relay.url]);
  const second = await f.ok(['friend-link', '--server', f.relay.url]);
  assert.equal(first.agent.name, 'agent');
  assert.equal(second.agent.name, 'agent');
  assert.notEqual(first.agent.id, second.agent.id, 'display names must not determine identity');
  const boundEnv = { AGENTCALL_AGENT: first.localAgent };
  const identity = await f.ok(['identity'], boundEnv);
  assert.equal(identity.localAgent, first.localAgent);
  assert.equal(identity.agent.id, first.agent.id);
  assert.deepEqual((await f.ok(['friends'], boundEnv)).contacts, []);
  assert.equal((await f.ok(['listen', '--timeout', '0'], boundEnv)).localAgent, first.localAgent);
  assert.deepEqual((await f.ok(['sessions'], boundEnv)).sessions, []);
  assert.equal(identity.mcpConfig.mcpServers.agentcall.args.at(-1), first.localAgent);
  assert.equal(identity.mcpConfig.mcpServers.agentcall.env.AGENTCALL_HOME, f.home);
  assert.equal((await f.ok(['identity', '--agent', second.localAgent], boundEnv)).localAgent, second.localAgent);
  await f.error(['friends', '--agent', first.localAgent, '--state-dir', join(f.home, 'manual')], 'INVALID_ARGUMENT');
  await f.error(['friends', '--state-dir', join(f.home, 'manual')], 'INVALID_ARGUMENT', boundEnv);
  await assert.rejects(stat(join(f.home, 'manual')), { code: 'ENOENT' });
  assert.equal((await readdir(join(f.home, 'profiles'))).length, 2);
});
