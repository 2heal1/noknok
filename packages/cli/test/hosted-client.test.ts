import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { main } from '../src/cli.js';
import { decodeHostedContact, hostedOrigin } from '../src/hosted-client.js';
import { MeetingStore } from '../src/meeting-client.js';

const accountToken = 'account_abcdefghijklmnopqrstuvwxyz0123456789';
const agentToken = 'agent_abcdefghijklmnopqrstuvwxyz0123456789';
const offer = 'offer_abcdefghijklmnopqrstuvwxyz0123456789';
const capability = 'capability_abcdefghijklmnopqrstuvwxyz0123456789';
const issuedCapability = 'issued_abcdefghijklmnopqrstuvwxyz0123456789';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-hosted-client-'));
  const stateDir = join(directory, 'agent');
  const codePath = join(directory, 'code');
  await writeFile(codePath, 'beta-test-code', { mode: 0o600 });
  const calls = [], mutations = { dropRedeem: 0, dropRegister: 0, claim: false, redirect: false };
  const meetingId = randomUUID(), participantId = randomUUID(), participantToken = 'participant_abcdefghijklmnopqrstuvwxyz012345';
  let url;
  const room = () => ({ meeting: { id: meetingId, purpose: 'Collect reproduction steps', state: 'active', participants: [], createdAt: new Date().toISOString() },
    participant: { id: participantId, name: 'agent-dot', kind: 'agent', role: 'host', token: participantToken },
    viewUrl: `${url}/meeting#id=${meetingId}&view=${'v'.repeat(32)}`, invitationUrl: `${url}/meeting#id=${meetingId}&invite=${'i'.repeat(32)}` });
  const server = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : undefined;
    calls.push({ path: req.url, body, authorization: req.headers.authorization });
    const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (mutations.redirect) { res.writeHead(302, { location: `${url}/unexpected` }); res.end(); return; }
    if (req.url === '/v1/hosted/redeem') {
      if (mutations.dropRedeem-- > 0) { req.socket.destroy(); return; }
      return send({ accountId: 'account-a', accountToken });
    }
    if (req.url === '/v1/hosted/agents') {
      if (mutations.dropRegister-- > 0) { req.socket.destroy(); return; }
      return send({ agentId: 'agent-a', agentToken });
    }
    if (req.url.startsWith('/v1/meetings/')) {
      return send({ meeting: room().meeting, events: [], nextCursor: 0 });
    }
    if (req.url === '/mcp') {
      const { name } = body.params;
      const data = name === 'noknok_friend_link' ? { link: `${url}/contact#offer=${offer}`, offer }
        : name === 'noknok_friend_add' ? { contact: { peerId: 'agent-b', capability }, issuedCapability }
        : name === 'noknok_friend_claim' ? { accepted: mutations.claim, ...(mutations.claim ? { contact: { peerId: 'agent-b', capability }, issuedCapability } : {}) }
        : name === 'noknok_identity' ? { agentId: 'agent-a', accountId: 'account-a' }
        : name === 'noknok_inbox' ? { invitations: [] }
        : name === 'noknok_subscription_status' ? { subscribed: false, receiving: false }
        : name === 'noknok_friend_revoke' ? { revoked: true }
        : { ...room(), invitationId: 'invitation-one', notification: { queued: true } };
      return send({ jsonrpc: '2.0', id: body.id, result: { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] } });
    }
    res.writeHead(404); send({ error: { code: 'NOT_FOUND' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const run = async args => {
    let result;
    await main(['hosted', ...args, '--state-dir', stateDir], { emit: value => { result = value; } });
    return result;
  };
  const setup = () => run(['setup', '--server', url, '--code-file', codePath, '--product', 'dot']);
  const saved = async () => JSON.parse(await readFile(join(stateDir, 'hosted.json'), 'utf8'));
  return { directory, stateDir, codePath, url, calls, mutations, run, setup, saved, room };
}

test('hosted setup saves scoped credentials privately and does not disclose them in ordinary results', async t => {
  const f = await fixture(t);
  const result = await f.setup();
  assert.equal(result.name, 'agent-dot');
  assert.equal(result.agentId, 'agent-a');
  assert.equal(JSON.stringify(result).includes(agentToken), false);
  assert.equal(JSON.stringify(result).includes(accountToken), false);
  const saved = await f.saved();
  assert.equal(saved.accountToken, accountToken);
  assert.equal(saved.agentToken, agentToken);
  assert.match(saved.redeemRequestId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(saved.agentRequestId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(saved.agentRequestId, saved.redeemRequestId);
  assert.equal((await stat(join(f.stateDir, 'hosted.json'))).mode & 0o777, 0o600);
  assert.equal(f.calls[1].authorization, `Bearer ${accountToken}`);
  const before = f.calls.length;
  await f.setup();
  assert.equal(f.calls.length, before);
  const config = await f.run(['config']);
  assert.equal(config.private, true);
  assert.equal(config.mcpConfig.mcpServers.noknok.url, `${f.url}/mcp`);
  assert.equal(config.mcpConfig.mcpServers.noknok.headers.Authorization, `Bearer ${agentToken}`);
});

test('setup resumes lost redemption and agent-registration replies using secrets saved before sending', async t => {
  const f = await fixture(t);
  f.mutations.dropRedeem = 2;
  await assert.rejects(f.setup(), error => error.code === 'CONNECTION_FAILED' && error.requestId === undefined);
  const pending = await f.saved();
  assert.equal(pending.accountToken, undefined);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) assert.equal(call.body.requestId, pending.redeemRequestId);
  f.mutations.dropRegister = 2;
  await assert.rejects(f.setup(), { code: 'CONNECTION_FAILED' });
  const registered = await f.saved();
  assert.equal(registered.accountToken, accountToken);
  assert.equal(registered.agentToken, undefined);
  await f.setup();
  const agentCalls = f.calls.filter(call => call.path === '/v1/hosted/agents');
  assert.equal(agentCalls.length, 3);
  for (const call of agentCalls) assert.equal(call.body.requestId, pending.agentRequestId);
  assert.equal((await f.saved()).agentToken, agentToken);
});

test('friend add returns without waiting or subscribing, stores capabilities locally, and revokes only the issued grant', async t => {
  const f = await fixture(t);
  await f.setup();
  const added = await f.run(['friend-add', `${f.url}/contact#offer=${offer}`]);
  assert.equal(added.added, true);
  assert.equal(JSON.stringify(added).includes(capability), false);
  assert.equal((await f.saved()).contacts['agent-b'].issuedCapability, issuedCapability);
  const methods = f.calls.filter(call => call.path === '/mcp').map(call => call.body.params.name);
  assert.deepEqual(methods, ['noknok_friend_add']);
  const friends = await f.run(['friends']);
  assert.equal(friends.contacts.length, 1);
  assert.equal(JSON.stringify(friends).includes(capability), false);
  await f.run(['friend-remove', 'agent-b']);
  assert.equal(f.calls.at(-1).body.params.arguments.capability, issuedCapability);
  assert.deepEqual((await f.saved()).contacts, {});
});

test('offer owner synchronizes the accepted contact and its own revocation grant to local storage', async t => {
  const f = await fixture(t);
  await f.setup();
  const link = await f.run(['friend-link']);
  assert.equal(decodeHostedContact(link.link).offer, offer);
  assert.equal((await f.run(['friends'])).contacts.length, 0);
  f.mutations.claim = true;
  assert.equal((await f.run(['friends'])).contacts[0].peerId, 'agent-b');
  assert.equal((await f.saved()).contacts['agent-b'].issuedCapability, issuedCapability);
  const before = f.calls.length;
  await f.run(['friends']);
  assert.equal(f.calls.length, before, 'already-claimed offers should not be queried again');
});

test('cross-origin contacts and changed setup servers never receive an existing profile credential', async t => {
  const f = await fixture(t);
  await f.setup();
  const before = f.calls.length;
  await assert.rejects(f.run(['friend-add', `https://other.example/contact#offer=${offer}`]), { code: 'SERVER_MISMATCH' });
  await assert.rejects(f.run(['setup', '--server', 'https://other.example']), { code: 'SERVER_MISMATCH' });
  assert.equal(f.calls.length, before);
  for (const value of ['http://intranet.example', 'https://example.test/path', 'https://user:pass@example.test']) assert.throws(() => hostedOrigin(value));
  for (const value of [`${f.url}/contact?x=y#offer=${offer}`, `${f.url}/contact#offer=${offer}&offer=${offer}`, `${f.url}/contact#offer=bad`]) assert.throws(() => decodeHostedContact(value));
});

test('hosted calls save regular am_ meetings and preserve explicit retry identity', async t => {
  const f = await fixture(t);
  await f.setup();
  await f.run(['friend-add', `${f.url}/contact#offer=${offer}`]);
  const call = ['call', 'agent-b', '--purpose', 'Collect reproduction steps', '--request-id', 'same-call'];
  const first = await f.run(call);
  assert.match(first.session, /^am_/);
  const saved = await new MeetingStore(f.stateDir).load(first.session);
  assert.equal(saved.meetingId, f.room().meeting.id);
  assert.equal(saved.token, f.room().participant.token);
  assert.equal(first.participant.token, undefined);
  const second = await f.run(call);
  assert.equal(second.session, first.session);
  assert.equal(second.restored, true);
  let status;
  await main(['meeting', 'status', first.session, '--state-dir', f.stateDir], { emit: value => { status = value; } });
  assert.equal(status.meeting.id, f.room().meeting.id);
  const calls = f.calls.filter(call => call.body?.params?.name === 'noknok_call');
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${agentToken}`);
    assert.equal(call.body.params.arguments.capability, capability);
    assert.equal(call.body.params.arguments.request_id, 'same-call');
  }
});

test('hosted client refuses redirects instead of forwarding account credentials', async t => {
  const f = await fixture(t);
  await f.setup();
  f.mutations.redirect = true;
  await assert.rejects(f.run(['identity']), { code: 'CONNECTION_FAILED' });
  assert.equal(f.calls.some(call => call.path === '/unexpected'), false);
});

test('hosted commands require an explicit profile rather than adopting another agent', async () => {
  const old = process.env.NOKNOK_AGENT;
  delete process.env.NOKNOK_AGENT;
  try { await assert.rejects(main(['hosted', 'friends'], { emit() {} }), { code: 'AGENT_REQUIRED' }); }
  finally { if (old !== undefined) process.env.NOKNOK_AGENT = old; }
});

test('real hosted service connects two CLI agents, archives their discussion, and enforces contact revocation', async t => {
  const { startHostedService } = await import('../src/hosted-service.js');
  const directory = await mkdtemp(join(tmpdir(), 'noknok-hosted-cli-real-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = await startHostedService({ port, publicUrl: `http://127.0.0.1:${port}`, dataDir: join(directory, 'service') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const codeFile = join(directory, 'beta-code');
  await writeFile(codeFile, server.store.mintCode({ uses: 2 }).code, { mode: 0o600 });
  const agent = stateDir => async (...args) => {
    let value;
    await main([...args, '--state-dir', join(directory, stateDir)], { emit: result => { value = result; } });
    return value;
  };
  const a = agent('a'), b = agent('b');
  const setupA = await a('hosted', 'setup', '--server', server.url, '--code-file', codeFile, '--product', 'codex');
  const setupB = await b('hosted', 'setup', '--server', server.url, '--code-file', codeFile, '--product', 'doubaowork');
  assert.notEqual(setupA.agentId, setupB.agentId);
  const invitation = await a('hosted', 'friend-link');
  const added = await b('hosted', 'friend-add', invitation.link);
  assert.equal(added.peerId, setupA.agentId);
  const contacts = await a('hosted', 'friends');
  assert.equal(contacts.contacts[0].peerId, setupB.agentId);
  const call = await a('hosted', 'call', setupB.agentId, '--purpose', 'Collect reproduction URL and steps', '--request-id', 'real-cli-call');
  assert.match(call.session, /^am_/);
  const inbox = await b('hosted', 'inbox');
  assert.equal(inbox.invitations.length, 1);
  const joined = await b('hosted', 'accept', inbox.invitations[0].id);
  assert.equal(joined.meetingId, call.meetingId);
  await b('meeting', 'send', joined.session, '--text', 'Open /reports and select last week to reproduce.', '--request-id', 'real-cli-message');
  const received = await a('meeting', 'receive', call.session, '--timeout', '0');
  assert.ok(received.events.some(event => event.data?.text === 'Open /reports and select last week to reproduce.'));
  const history = await a('meeting', 'history', call.session);
  assert.ok(history.events.some(event => event.data?.text === 'Open /reports and select last week to reproduce.'));
  await a('meeting', 'end', call.session, '--text', 'Reproduction captured.', '--request-id', 'real-cli-end');
  const closed = await b('meeting', 'status', joined.session);
  assert.equal(closed.meeting.state, 'ended');
  await b('hosted', 'friend-remove', setupA.agentId);
  await assert.rejects(a('hosted', 'call', setupB.agentId, '--purpose', 'Should be rejected', '--request-id', 'real-cli-revoked'), error => /REVOKED/i.test(error.code));
});
