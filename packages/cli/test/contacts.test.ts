import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { contactCommand, decodeContactLink } from '../src/contacts.js';
import { startRelay } from '../src/relay.js';
import { Store } from '../src/store.js';
import { api } from '../src/client.js';

// Wait for the receiving request to become an open server-side long poll.
// Request-body completion schedules the production handler's continuation;
// setImmediate runs after that continuation has registered the poll. A poll
// that immediately returns queued activity is not ready to receive a call yet.
async function waitForContactPoll<T>(relay: Awaited<ReturnType<typeof startRelay>>, start: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  let onRequest: (req: IncomingMessage, res: ServerResponse) => void;
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Contact listener did not establish an open long poll.')), 10_000);
    onRequest = (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/contacts') return;
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.once('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
        if (body.op !== 'poll' || !(body.waitMs > 0)) return;
        setImmediate(() => {
          if (!res.writableEnded && !res.destroyed) resolve();
        });
      });
    };
    relay.server.on('request', onRequest);
  });
  try {
    const listening = Promise.resolve().then(start);
    await Promise.race([ready, listening.then(() => { throw new Error('Contact listener ended before its long poll became ready.'); })]);
    return { listening };
  } finally {
    clearTimeout(timer!);
    relay.server.off('request', onRequest!);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-contacts-'));
  let relay = await startRelay({ port: 0, contacts: true });
  const dirs = Object.fromEntries(['A', 'B', 'C'].map(key => [key, join(directory, key)]));
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const cmd = (who, command, args = [], options = {}) => contactCommand(command, args, { 'state-dir': dirs[who], ...options });
  const profile = who => readFile(join(dirs[who], 'contacts.json'), 'utf8').then(JSON.parse);
  const identify = who => cmd(who, 'identity', [], { name: who, server: relay.url });
  const listen = who => waitForContactPoll(relay, () => cmd(who, 'listen', [], { timeout: '10' }));
  const connect = async () => {
    await identify('A'); await identify('B');
    const link = await cmd('A', 'friend-link');
    await cmd('B', 'friend-add', [link.contactLink]);
    await cmd('A', 'friends');
    return link;
  };
  return { cmd, profile, identify, connect, listen, dirs, get relay() { return relay; }, async restart() {
    const port = new URL(relay.url).port;
    await relay.close();
    relay = await startRelay({ port: Number(port), contacts: true });
  } };
}

test('contact identity persists privately and cannot accidentally change name or server', async t => {
  const f = await fixture(t);
  const first = await f.identify('A');
  assert.match(first.agent.id, /^ag_[a-f0-9]{64}$/);
  const profile = await f.profile('A');
  assert.equal((await stat(join(f.dirs.A, 'contacts.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(first).includes(profile.token), false);
  assert.deepEqual((await f.cmd('A', 'identity')).agent, first.agent);
  await assert.rejects(f.cmd('A', 'identity', [], { name: 'other' }), { code: 'IDENTITY_CONFLICT' });
  await assert.rejects(f.cmd('A', 'identity', [], { server: 'http://127.0.0.1:1' }), { code: 'IDENTITY_CONFLICT' });
  await assert.rejects(f.cmd('B', 'friends'), { code: 'IDENTITY_NOT_FOUND' });
});

test('first friend-link uses an honest generic name without a product and reuses its identity', async t => {
  const f = await fixture(t);
  const first = await f.cmd('A', 'friend-link', [], { server: f.relay.url });
  const profile = await f.profile('A');
  assert.equal(first.agent.name, 'agent');
  assert.equal(profile.name, first.agent.name);
  assert.equal(JSON.stringify(first).includes(profile.token), false);
  const second = await f.cmd('A', 'friend-link');
  assert.deepEqual(second.agent, first.agent);
  assert.equal((await f.profile('A')).token, profile.token);
  assert.deepEqual((await f.cmd('A', 'identity')).agent, first.agent);
});

test('fresh friend-add derives its switch from the link and creates a distinct local identity', async t => {
  const f = await fixture(t);
  const link = await f.cmd('A', 'friend-link', [], { server: f.relay.url });
  const added = await f.cmd('B', 'friend-add', [link.contactLink]);
  const profile = await f.profile('B');
  assert.match(added.next, /no listener was started/);
  assert.match(added.next, /only when the user asks to receive calls/);
  assert.equal(profile.server, f.relay.url);
  assert.notEqual(added.agent.id, link.agent.id);
  assert.equal(added.agent.name, 'agent');
  assert.deepEqual(added.contact, link.agent);
  assert.deepEqual((await f.cmd('A', 'friends')).contacts, [added.agent]);
  assert.deepEqual((await f.cmd('B', 'friend-add', [link.contactLink])).agent, added.agent);
  assert.equal((await f.profile('B')).token, profile.token);

  const another = await f.cmd('A', 'friend-link');
  const named = await f.cmd('C', 'friend-add', [another.contactLink], { name: 'Chosen by agent' });
  assert.equal(named.agent.name, 'Chosen by agent');
});

test('known product hints give readable names while same-product identities remain distinct', async t => {
  const f = await fixture(t);
  const dot = await f.cmd('A', 'friend-link', [], { product: 'Codex Dot', server: f.relay.url });
  const doubao = await f.cmd('B', 'friend-add', [dot.contactLink], { product: 'Doubao Work' });
  const another = await f.cmd('C', 'identity', [], { product: '豆包工作', server: f.relay.url });
  assert.equal(dot.agent.name, 'agent-dot');
  assert.equal(doubao.agent.name, 'agent-doubaowork');
  assert.equal(another.agent.name, doubao.agent.name);
  assert.notEqual(another.agent.id, doubao.agent.id);
  assert.deepEqual((await f.cmd('A', 'friends')).contacts, [doubao.agent]);
});

test('explicit names and already named products stay stable when later product hints differ', async t => {
  const f = await fixture(t);
  const named = await f.cmd('A', 'identity', [], { name: 'My assistant', product: 'dot', server: f.relay.url });
  assert.equal(named.agent.name, 'My assistant');
  assert.deepEqual((await f.cmd('A', 'identity', [], { product: 'doubaowork' })).agent, named.agent);
  await assert.rejects(f.cmd('A', 'identity', [], { name: 'Different name', product: 'dot' }), { code: 'IDENTITY_CONFLICT' });

  const dot = await f.cmd('B', 'identity', [], { product: 'dot', server: f.relay.url });
  assert.deepEqual((await f.cmd('B', 'identity', [], { product: 'doubaowork' })).agent, dot.agent);
  const generic = await f.cmd('C', 'identity', [], { name: 'agent', server: f.relay.url });
  assert.deepEqual((await f.cmd('C', 'identity', [], { product: 'dot' })).agent, generic.agent);
});

test('product environment supplies a hint and an explicit product takes precedence', async t => {
  const f = await fixture(t);
  const previous = process.env.NOKNOK_PRODUCT;
  try {
    process.env.NOKNOK_PRODUCT = 'doubao_work';
    assert.equal((await f.cmd('A', 'identity', [], { server: f.relay.url })).agent.name, 'agent-doubaowork');
    assert.equal((await f.cmd('B', 'identity', [], { product: 'dot', server: f.relay.url })).agent.name, 'agent-dot');
    process.env.NOKNOK_PRODUCT = 'not/a/product';
    assert.equal((await f.cmd('C', 'identity', [], { product: 'My Custom Agent', server: f.relay.url })).agent.name, 'agent-my-custom-agent');
  } finally {
    if (previous === undefined) delete process.env.NOKNOK_PRODUCT;
    else process.env.NOKNOK_PRODUCT = previous;
  }
});

test('product hints refine generic names and keep credentials, contacts, and call names', async t => {
  const f = await fixture(t);
  const link = await f.cmd('A', 'friend-link', [], { server: f.relay.url });
  await f.cmd('B', 'friend-add', [link.contactLink]);
  await f.cmd('A', 'friends');
  const legacy = await f.profile('A');
  const migrated = await f.cmd('A', 'identity', [], { product: 'dot' });
  const after = await f.profile('A');
  assert.deepEqual(migrated.agent, { id: legacy.id, name: 'agent-dot' });
  assert.equal(after.token, legacy.token);
  assert.deepEqual(after.contacts, legacy.contacts);
  assert.deepEqual(after.requests, legacy.requests);
  assert.equal(after.createdAt, legacy.createdAt);
  assert.deepEqual((await f.cmd('A', 'identity')).agent, migrated.agent);

  const beforeB = await f.profile('B');
  const migratedB = await f.cmd('B', 'identity', [], { product: 'doubaowork' });
  assert.deepEqual(migratedB.agent, { id: beforeB.id, name: 'agent-doubaowork' });
  assert.equal((await f.profile('B')).token, beforeB.token);
  const { listening } = await f.listen('B');
  const outgoing = await f.cmd('A', 'call', [beforeB.id], { purpose: 'Verify updated display names' });
  const incoming = await listening;
  const participants = incoming.calls[0].call.participants;
  assert.equal(participants.caller.name, 'agent-dot');
  assert.equal(participants.callee.name, 'agent-doubaowork');
  assert.equal(incoming.calls[0].callId, outgoing.callId);
});

test('explicit custom names are not changed by product hints', async t => {
  const f = await fixture(t);
  await f.cmd('A', 'identity', [], { name: 'Agent-12345678', server: f.relay.url });
  assert.equal((await f.cmd('A', 'identity', [], { product: 'dot' })).agent.name, 'Agent-12345678');
});

test('invalid bootstrap input neither saves an identity nor consumes a friend link', async t => {
  const f = await fixture(t);
  const link = await f.cmd('A', 'friend-link', [], { server: f.relay.url });
  const rejected = [
    ['friend-add', ['noknok://contact/invalid'], {}, 'INVALID_CONTACT_LINK'],
    ['friend-add', [link.contactLink], { name: '\n' }, 'INVALID_ARGUMENT'],
    ['friend-add', [link.contactLink], { 'request-id': '' }, 'INVALID_ARGUMENT'],
    ['friend-link', ['unexpected'], { server: f.relay.url }, 'INVALID_ARGUMENT'],
    ['friend-link', [], { server: `${f.relay.url}/path` }, 'INVALID_SERVER'],
    ['identity', [], { name: '', server: f.relay.url }, 'INVALID_ARGUMENT'],
    ['identity', [], { product: '', server: f.relay.url }, 'INVALID_ARGUMENT'],
    ['identity', [], { product: 'dot\n', server: f.relay.url }, 'INVALID_ARGUMENT'],
    ['identity', [], { product: '../dot', server: f.relay.url }, 'INVALID_ARGUMENT'],
    ['identity', [], { product: 'a'.repeat(65), server: f.relay.url }, 'INVALID_ARGUMENT'],
    ['identity', [], { server: 'file:///tmp' }, 'INVALID_SERVER'],
  ];
  for (const [command, args, options, code] of rejected) {
    await assert.rejects(f.cmd('B', command, args, options), { code });
    await assert.rejects(f.profile('B'), { code: 'ENOENT' });
  }
  assert.equal((await f.cmd('B', 'friend-add', [link.contactLink])).outcome, 'added');
});

test('friend-add never replaces an existing identity when a link points to another switch', async t => {
  const f = await fixture(t);
  await f.identify('A');
  await f.identify('B');
  const link = await f.cmd('A', 'friend-link');
  const foreign = `noknok://contact/${Buffer.from(JSON.stringify({ ...decodeContactLink(link.contactLink), server: 'http://127.0.0.1:1' })).toString('base64url')}`;
  const before = await readFile(join(f.dirs.B, 'contacts.json'), 'utf8');
  await assert.rejects(f.cmd('B', 'friend-add', [foreign]), { code: 'DIFFERENT_SWITCH' });
  assert.equal(await readFile(join(f.dirs.B, 'contacts.json'), 'utf8'), before);
  assert.equal((await f.cmd('B', 'friend-add', [link.contactLink])).outcome, 'added');
});

test('friend invitation grants both local contact lists and retrying add is idempotent', async t => {
  const f = await fixture(t);
  const link = await f.connect();
  const again = await f.cmd('B', 'friend-add', [link.contactLink]);
  assert.equal(again.contact.name, 'A');
  assert.deepEqual((await f.cmd('A', 'friends')).contacts.map(entry => entry.name), ['B']);
  assert.deepEqual((await f.cmd('B', 'friends')).contacts.map(entry => entry.name), ['A']);
  await f.identify('C');
  assert.deepEqual((await f.cmd('C', 'friends')).contacts, []);
  await assert.rejects(f.cmd('C', 'call', [again.contact.id], { purpose: 'Unauthorized' }), { code: 'CONTACT_NOT_FOUND' });
  const invalid = Buffer.from(JSON.stringify({ ...decodeContactLink(link.contactLink), server: 'http://127.0.0.1:1' })).toString('base64url');
  await assert.rejects(f.cmd('B', 'friend-add', [`noknok://contact/${invalid}`]), { code: 'DIFFERENT_SWITCH' });
});

test('contact call returns shared viewing session while listener receives its own participant session', async t => {
  const f = await fixture(t);
  await f.connect();
  const { listening } = await f.listen('B');
  const outgoing = await f.cmd('A', 'call', ['B'], { purpose: 'Discuss the local prototype', context: 'Synthetic test', 'request-id': 'contact-conversation' });
  const incoming = await listening;
  assert.equal(outgoing.outcome, 'delivered');
  assert.equal(incoming.outcome, 'activity');
  assert.equal(incoming.calls.length, 1);
  const callee = incoming.calls[0];
  assert.equal(callee.callId, outgoing.callId);
  assert.notEqual(callee.session, outgoing.session);
  assert.equal(outgoing.viewSession, outgoing.callId);
  assert.equal(callee.viewUrl, outgoing.viewUrl);
  assert.equal(callee.call.purpose, 'Discuss the local prototype');
  const callerSession = await new Store(f.dirs.A).load(outgoing.session);
  const calleeSession = await new Store(f.dirs.B).load(callee.session);
  const sent = await api(f.relay.url, `/v1/calls/${outgoing.callId}/messages`, { method: 'POST', token: callerSession.token, body: { text: 'Hello', type: 'message', requestId: 'message-one' } });
  assert.equal(sent.event.data.text, 'Hello');
  const reply = await api(f.relay.url, `/v1/calls/${outgoing.callId}/messages`, { method: 'POST', token: calleeSession.token, body: { text: 'Hello back', type: 'message', requestId: 'message-two' } });
  assert.equal(reply.event.data.text, 'Hello back');
  assert.deepEqual(await f.cmd('A', 'call', ['B'], { purpose: 'Discuss the local prototype', context: 'Synthetic test', 'request-id': 'contact-conversation' }), outgoing);
  await assert.rejects(f.cmd('A', 'call', ['B'], { purpose: 'Changed', 'request-id': 'contact-conversation' }), { code: 'IDEMPOTENCY_CONFLICT' });
  // The public view URL is stable even though the participants have private handles.
  assert.equal(new URL(outgoing.viewUrl).hash, `#session=${outgoing.callId}`);
});

test('offline contact failure cancels the orphan relay call', async t => {
  const f = await fixture(t);
  await f.connect();
  await assert.rejects(f.cmd('A', 'call', ['B'], { purpose: 'Offline test', 'request-id': 'offline-one' }), { code: 'CONTACT_UNAVAILABLE' });
  const sessions = await new Store(f.dirs.A).list();
  assert.equal(sessions.length, 1);
  const session = await new Store(f.dirs.A).load(sessions[0].session);
  const result = await api(f.relay.url, `/v1/calls/${session.callId}`, { token: session.token });
  assert.equal(result.call.state, 'cancelled');
  assert.equal((await new Store(f.dirs.A).history(session.id)).at(-1).callState, 'cancelled');
  await assert.rejects(f.cmd('A', 'call', ['B'], { purpose: 'Offline test', 'request-id': 'offline-one' }), { code: 'CONTACT_UNAVAILABLE' });
  assert.equal((await new Store(f.dirs.A).list()).length, 1);
});

test('friends sync accepts and preserves queued incoming calls before acknowledging', async t => {
  const f = await fixture(t);
  await f.connect();
  const profileB = await f.profile('B');
  const { listening: rawPoll } = await waitForContactPoll(f.relay, () => api(f.relay.url, '/v1/contacts', { method: 'POST', token: profileB.token, body: { op: 'poll', after: profileB.cursor, waitMs: 10_000 } }));
  const outgoing = await f.cmd('A', 'call', ['B'], { purpose: 'Keep this activity', 'request-id': 'sync-call' });
  assert.equal((await rawPoll).events[0].type, 'incoming_call');
  assert.equal((await f.cmd('B', 'friends')).pendingCalls, 1);
  const before = await f.profile('B');
  assert.equal(before.pendingCalls[0].callId, outgoing.callId);
  const incoming = await f.cmd('B', 'listen', [], { timeout: '0' });
  assert.equal(incoming.calls[0].callId, outgoing.callId);
  const rawAfter = await api(f.relay.url, '/v1/contacts', { method: 'POST', token: profileB.token, body: { op: 'poll', after: 0, waitMs: 0 } });
  assert.deepEqual(rawAfter.events, []);
});

test('local contacts and identity survive switch restart and restore routing', async t => {
  const f = await fixture(t);
  await f.connect();
  const before = await f.profile('A');
  assert.ok(before.cursor > 0);
  await f.restart();
  assert.equal((await f.cmd('A', 'friends')).contacts[0].name, 'B');
  await f.cmd('B', 'friends');
  const after = await f.profile('A');
  assert.equal(before.id, after.id);
  assert.equal(after.cursor, 0);
  assert.notEqual(before.instanceId, after.instanceId);
  const { listening } = await f.listen('B');
  const outgoing = await f.cmd('A', 'call', ['B'], { purpose: 'After restart' });
  assert.equal((await listening).calls[0].callId, outgoing.callId);
});

test('removing a friend denies future calls and malformed contact links are rejected', async t => {
  const f = await fixture(t);
  await f.connect();
  await f.cmd('B', 'friend-remove', ['A']);
  assert.deepEqual((await f.cmd('B', 'friends')).contacts, []);
  await assert.rejects(f.cmd('A', 'call', ['B'], { purpose: 'Removed contact' }), { code: 'CONTACT_UNAVAILABLE' });
  for (const value of [null, '', 'noknok://contact/!', 'noknok://invite/abc', 'https://example.test/contact', `noknok://contact/${Buffer.from('{}').toString('base64url')}`]) {
    assert.throws(() => decodeContactLink(value), { code: 'INVALID_CONTACT_LINK' });
  }
});

test('outgoing async call retains the profile lock until its delivery completes', async t => {
  const f = await fixture(t);
  await f.connect();
  const originalFetch = globalThis.fetch;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    if (String(url) === `${f.relay.url}/v1/calls` && options.method === 'POST') {
      entered();
      await gate;
    }
    return originalFetch(url, options);
  };
  const calling = f.cmd('A', 'call', ['B'], { purpose: 'Lock test', 'request-id': 'lock-test' });
  const outcome = calling.catch(error => error);
  try {
    await started;
    await assert.rejects(f.cmd('A', 'friends'), { code: 'SESSION_BUSY' });
  } finally { release(); globalThis.fetch = originalFetch; }
  assert.equal((await outcome).code, 'CONTACT_UNAVAILABLE');
  assert.equal((await f.cmd('A', 'friends')).contacts[0].name, 'B');
});

test('lost create responses return the outer request ID and retry recovers one call', async t => {
  const f = await fixture(t);
  await f.connect();
  const originalFetch = globalThis.fetch;
  let dropped = 0;
  globalThis.fetch = async (url, options) => {
    const result = await originalFetch(url, options);
    if (String(url) === `${f.relay.url}/v1/calls` && options.method === 'POST') {
      dropped++;
      await result.body.cancel();
      throw new Error('Synthetic response loss after the relay created the call.');
    }
    return result;
  };
  try {
    await assert.rejects(f.cmd('A', 'call', ['B'], { purpose: 'Recover creation', 'request-id': 'outer-retry-id' }), { code: 'CONNECTION_FAILED', requestId: 'outer-retry-id' });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(dropped, 2);
  const profile = await f.profile('A');
  assert.equal(Object.keys(profile.requests).length, 1);
  assert.equal((await new Store(f.dirs.A).list()).length, 0);
  const { listening } = await f.listen('B');
  const result = await f.cmd('A', 'call', ['B'], { purpose: 'Recover creation', 'request-id': 'outer-retry-id' });
  assert.equal(result.requestId, 'outer-retry-id');
  assert.equal((await listening).calls[0].callId, result.callId);
  assert.equal((await new Store(f.dirs.A).list()).length, 1);
});

test('product hints preserve the outgoing create payload after its response was lost', async t => {
  const f = await fixture(t);
  const link = await f.cmd('A', 'friend-link', [], { server: f.relay.url });
  const added = await f.cmd('B', 'friend-add', [link.contactLink]);
  await f.cmd('A', 'friends');
  const legacy = await f.profile('A');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const result = await originalFetch(url, options);
    if (String(url) === `${f.relay.url}/v1/calls` && options.method === 'POST') {
      await result.body.cancel();
      throw new Error('Synthetic lost create response before renaming.');
    }
    return result;
  };
  const options = { purpose: 'Recover creation after renaming', 'request-id': 'rename-create' };
  try { await assert.rejects(f.cmd('A', 'call', [added.agent.id], options), { code: 'CONNECTION_FAILED' }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal((await f.cmd('A', 'identity', [], { product: 'dot' })).agent.name, 'agent-dot');
  assert.equal((await f.profile('A')).requests['rename-create'].name, legacy.name);
  const { listening } = await f.listen('B');
  const outgoing = await f.cmd('A', 'call', [added.agent.id], options);
  const incoming = await listening;
  assert.equal(incoming.calls[0].callId, outgoing.callId);
  assert.equal(incoming.calls[0].call.participants.caller.name, legacy.name);
  assert.equal((await new Store(f.dirs.A).list()).length, 1);
});

test('product hints preserve an interrupted incoming join payload and recover its session', async t => {
  const f = await fixture(t);
  const link = await f.cmd('A', 'friend-link', [], { server: f.relay.url });
  const added = await f.cmd('B', 'friend-add', [link.contactLink]);
  await f.cmd('A', 'friends');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const result = await originalFetch(url, options);
    if (String(url).endsWith('/join') && options.method === 'POST') {
      await result.body.cancel();
      throw new Error('Synthetic lost join response before renaming.');
    }
    return result;
  };
  let outgoing;
  try {
    const { listening } = await f.listen('B');
    const outcome = listening.catch(error => error);
    outgoing = await f.cmd('A', 'call', [added.agent.id], { purpose: 'Recover join after renaming' });
    assert.equal((await outcome).code, 'CONNECTION_FAILED');
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await new Store(f.dirs.B).list()).length, 0);
  assert.equal((await f.cmd('B', 'identity', [], { product: 'doubaowork' })).agent.name, 'agent-doubaowork');
  const incoming = await f.cmd('B', 'listen', [], { timeout: '0' });
  assert.equal(incoming.calls[0].callId, outgoing.callId);
  assert.equal(incoming.calls[0].call.participants.callee.name, 'agent');
  assert.equal((await new Store(f.dirs.B).list()).length, 1);
});
