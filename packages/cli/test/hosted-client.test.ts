import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationJoinLink } from './meeting-invitation-helper.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { main } from '../src/cli.js';
import { decodeHostedContact, hostedOrigin, contactKeyAAD } from '../src/hosted-client.js';
import { generateKey, isEncryptedText, encryptText } from '../src/e2ee.js';
import { MeetingStore } from '../src/meeting-client.js';
import { authorizeOAuth } from './oauth-helper.js';

const accountToken = 'account_abcdefghijklmnopqrstuvwxyz0123456789';
const agentToken = 'agent_abcdefghijklmnopqrstuvwxyz0123456789';
const offer = 'offer_abcdefghijklmnopqrstuvwxyz0123456789';
const capability = 'capability_abcdefghijklmnopqrstuvwxyz0123456789';
const contactKey = generateKey();
const issuedCapability = 'issued_abcdefghijklmnopqrstuvwxyz0123456789';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-hosted-client-'));
  const stateDir = join(directory, 'agent');
  const calls = [], mutations = { dropAccount: 0, dropRegister: 0, claim: false, redirect: false, invitations: [], pairingError: false };
  const meetingId = randomUUID(), participantId = randomUUID(), participantToken = 'participant_abcdefghijklmnopqrstuvwxyz012345';
  let url, encryptedMeeting;
  const room = () => ({ meeting: { id: meetingId, ...encryptedMeeting, state: 'active', participants: [], createdAt: new Date().toISOString() },
    participant: { id: participantId, name: 'agent-dot', kind: 'agent', role: 'host', token: participantToken },
    viewUrl: `${url}/meeting#id=${meetingId}&view=${'v'.repeat(32)}`, invitationUrl: `${url}/invite/${meetingId}#invite=${'i'.repeat(32)}` });
  const server = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : undefined;
    calls.push({ path: req.url, method: req.method, body, authorization: req.headers.authorization });
    const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/health') return send({ ok: true, mode: 'hosted' });
    if (mutations.redirect) { res.writeHead(302, { location: `${url}/unexpected` }); res.end(); return; }
    if (req.url === '/v1/hosted/accounts') {
      if (mutations.dropAccount-- > 0) { req.socket.destroy(); return; }
      return send({ accountId: 'account-a', accountToken });
    }
    if (req.url === '/v1/hosted/agents') {
      if (mutations.dropRegister-- > 0) { req.socket.destroy(); return; }
      return send({ agentId: 'agent-a', agentToken });
    }
    if (req.url === '/oauth/pairings') return send({ pairing_id: 'pair-one', user_code: 'ABCD-EFGH', verification_uri: `${url}/oauth/pair`, verification_uri_complete: `${url}/oauth/pair`, expires_at: Date.now() + 300000 });
    if (req.url === '/oauth/pairings/pair-one') return send({ pairing_id: 'pair-one', status: 'awaiting_cli', agent_id: 'agent-a', expires_at: Date.now() + 300000,
      client: { client_id: 'client-one', client_name: 'Test application', redirect_uri: 'https://client.example/callback' }, scope: 'noknok:events:read noknok:events:manage noknok:status:read', confirmation: 'confirmation_abcdefghijklmnopqrstuvwxyz' });
    if (req.url === '/oauth/pairings/pair-one/confirm') {
      if (mutations.pairingError) { res.statusCode = 400; return send({ error: 'invalid_request', error_description: 'Review this exact pending request before confirming it.' }); }
      return send({ pairing_id: 'pair-one', status: 'approved' });
    }
    if (req.url === '/oauth/grants') return send({ grants: [{ grant_id: 'grant-one', agent_id: 'agent-a', client_id: 'client-one', revoked: false }] });
    if (req.url === '/oauth/grants/grant-one') return send({ revoked: true });
    if (req.url.startsWith('/v1/meetings/')) {
      return send({ meeting: room().meeting, events: [], nextCursor: 0 });
    }
    if (req.url === '/mcp') {
      const { name, arguments: args } = body.params;
      if (args.purpose_ciphertext) encryptedMeeting = { purpose: args.purpose_ciphertext, context: args.context_ciphertext, encryption: { v: 1, id: args.encryption_id } };
      const data = name === 'noknok_friend_link' ? { link: `${url}/contact#offer=${offer}`, offer }
        : name === 'noknok_friend_add' ? { contact: { peerId: 'agent-b', capability }, issuedCapability }
        : name === 'noknok_friend_claim' ? { accepted: mutations.claim, ...(mutations.claim ? { contact: { peerId: 'agent-b', capability }, issuedCapability } : {}) }
        : name === 'noknok_identity' ? { agentId: 'agent-a', accountId: 'account-a' }
        : name === 'noknok_inbox' ? { invitations: mutations.invitations }
        : name === 'noknok_subscription_status' ? { subscribed: false, receiving: false }
        : name === 'noknok_subscription_stop' ? { subscriptionId: args.subscription_id, unsubscribed: true }
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
  const setup = () => run(['setup', '--server', url, '--product', 'dot']);
  const saved = async () => JSON.parse(await readFile(join(stateDir, 'hosted.json'), 'utf8'));
  return { directory, stateDir, url, calls, mutations, run, setup, saved, room };
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
  assert.match(saved.accountRequestId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(saved.agentRequestId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(saved.agentRequestId, saved.accountRequestId);
  assert.equal((await stat(join(f.stateDir, 'hosted.json'))).mode & 0o777, 0o600);
  assert.equal(f.calls[1].authorization, `Bearer ${accountToken}`);
  const before = f.calls.length;
  await f.setup();
  assert.equal(f.calls.length, before);
  const config = await f.run(['config']);
  assert.equal(config.private, true);
  assert.equal(config.remoteMcpMode, 'oauth-events-only');
  assert.equal(config.mcpConfig.mcpServers.noknok.command, process.execPath);
  assert.ok(config.mcpConfig.mcpServers.noknok.args.includes('mcp'));
  assert.ok(!JSON.stringify(config.mcpConfig).includes(agentToken));
  assert.equal(config.eventsMcpConfig.mcpServers.noknok_events.url, `${f.url}/mcp`);
  assert.equal(config.eventsMcpConfig.mcpServers.noknok_events.headers, undefined);
  assert.equal(config.authentication.type, 'oauth');
  assert.equal(config.authentication.resource, `${f.url}/mcp`);
  assert.ok(!JSON.stringify(config).includes(agentToken));
  assert.ok(!JSON.stringify(config).includes(accountToken));
});

test('OAuth pairing and revocation reuse the existing profile without exposing its credentials or changing contacts', async t => {
  const f = await fixture(t);
  await f.setup();
  await f.run(['friend-add', `${f.url}/contact#offer=${offer}&key=${contactKey}`]);
  const original = await f.saved(), requests = f.calls.length;
  const paired = await f.run(['pair']);
  assert.equal(paired.agent_id, original.agentId);
  assert.equal(paired.user_code, 'ABCD-EFGH');
  assert.equal(new URL(paired.verification_uri_complete).search, '');
  const pending = await f.run(['pair-status', paired.pairing_id]);
  assert.equal(pending.client.client_name, 'Test application');
  assert.equal(pending.agent_id, original.agentId);
  assert.match(pending.scope, /noknok:events:manage/);
  const confirmed = await f.run(['pair-confirm', paired.pairing_id, '--confirmation', pending.confirmation]);
  assert.equal(confirmed.status, 'approved');
  const grants = await f.run(['grants']);
  assert.equal(grants.grants[0].grant_id, 'grant-one');
  assert.equal((await f.run(['revoke', 'grant-one'])).revoked, true);
  const oauthCalls = f.calls.slice(requests);
  assert.deepEqual(oauthCalls.map(call => [call.method, call.path]), [
    ['POST', '/oauth/pairings'], ['GET', '/oauth/pairings/pair-one'], ['POST', '/oauth/pairings/pair-one/confirm'], ['GET', '/oauth/grants'], ['DELETE', '/oauth/grants/grant-one'],
  ]);
  assert.deepEqual(oauthCalls[2].body, { confirmation: pending.confirmation });
  for (const call of oauthCalls) assert.equal(call.authorization, `Bearer ${agentToken}`);
  for (const value of [paired, pending, confirmed, grants]) {
    assert.ok(!JSON.stringify(value).includes(agentToken));
    assert.ok(!JSON.stringify(value).includes(accountToken));
    assert.ok(!JSON.stringify(value).includes(contactKey));
  }
  assert.deepEqual(await f.saved(), original);
  const beforeInvalid = f.calls.length;
  await assert.rejects(f.run(['pair-confirm', 'pair-one']), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.run(['pair-status', '../another-agent']), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.run(['revoke', 'grant-one?agent=other']), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, beforeInvalid);
  f.mutations.pairingError = true;
  await assert.rejects(f.run(['pair-confirm', paired.pairing_id, '--confirmation', pending.confirmation]), { code: 'invalid_request', message: 'Review this exact pending request before confirming it.' });
});

test('pairing operations never create a replacement identity for an uninitialized profile', async t => {
  const f = await fixture(t);
  for (const command of [['pair'], ['pair-status', 'pair-one'], ['pair-confirm', 'pair-one', '--confirmation', 'confirmation_abcdefghijklmnopqrstuvwxyz'], ['grants'], ['revoke', 'grant-one'], ['subscription-stop', 'subscription-one']]) {
    await assert.rejects(f.run(command), { code: 'HOSTED_SETUP_REQUIRED' });
  }
  assert.equal(f.calls.length, 0);
});

test('the original CLI can stop one legacy subscription without exporting an Agent token', async t => {
  const f = await fixture(t);
  await f.setup();
  const original = await f.saved();
  const result = await f.run(['subscription-stop', 'subscription-one']);
  assert.equal(result.unsubscribed, true);
  assert.deepEqual(f.calls.at(-1).body.params, { name: 'noknok_subscription_stop', arguments: { subscription_id: 'subscription-one' } });
  assert.equal(f.calls.at(-1).authorization, `Bearer ${agentToken}`);
  assert.ok(!JSON.stringify(result).includes(agentToken));
  assert.deepEqual(await f.saved(), original);
});

test('real OAuth browser ceremony uses the original CLI pairing commands and preserves its identity', async t => {
  const { startHostedService } = await import('../src/hosted-service.js');
  const directory = await mkdtemp(join(tmpdir(), 'noknok-cli-oauth-real-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const service = await startHostedService({ port, publicUrl: `http://127.0.0.1:${port}`, dataDir: join(directory, 'service') });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const stateDir = join(directory, 'agent'), results = [], commands = [];
  const run = async (...args: string[]) => {
    let value;
    commands.push(args[0]);
    await main(['hosted', ...args, '--state-dir', stateDir], { emit: result => { value = result; results.push(result); } });
    return value;
  };
  const setup = await run('setup', '--server', service.url, '--product', 'dot');
  const original = await readFile(join(stateDir, 'hosted.json'), 'utf8'), profile = JSON.parse(original);
  const connected = await authorizeOAuth({ baseUrl: service.url, realm: service.url, agentToken: profile.agentToken,
    cliRequest: async (path, method, input: any) => {
      const pieces = path.split('/');
      const value = pieces[3] === undefined ? await run('pair') : method === 'GET' ? await run('pair-status', pieces[3])
        : await run('pair-confirm', pieces[3], '--confirmation', input.confirmation);
      return Response.json(value, { status: path === '/oauth/pairings' ? 201 : 200 });
    },
  });
  assert.deepEqual(commands, ['setup', 'pair', 'pair-status', 'pair-confirm']);
  assert.equal(connected.pending.agent_id, setup.agentId);
  const grants = await run('grants');
  assert.equal(grants.grants.length, 1);
  assert.equal(grants.grants[0].agent_id, setup.agentId);
  assert.equal(grants.grants[0].client_id, connected.client.client_id);
  assert.equal((await run('revoke', grants.grants[0].grant_id)).revoked, true);
  assert.equal((await run('grants')).grants[0].revoked, true);
  assert.equal((await run('identity')).agentId, setup.agentId);
  assert.equal(await readFile(join(stateDir, 'hosted.json'), 'utf8'), original);
  const serialized = JSON.stringify(results);
  for (const secret of [profile.agentToken, profile.accountToken, connected.tokens.access_token, connected.tokens.refresh_token]) assert.ok(!serialized.includes(secret));
});

test('default service creates a meeting and contact identity without setup or sending credentials elsewhere', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  const oldServer = process.env.NOKNOK_SERVER;
  const oldHome = process.env.NOKNOK_HOME;
  const oldAgent = process.env.NOKNOK_AGENT;
  process.env.NOKNOK_HOME = join(f.directory, 'managed-home');
  delete process.env.NOKNOK_AGENT;
  delete process.env.NOKNOK_SERVER;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, authorization: init?.headers?.Authorization });
    assert.equal(url.origin, 'https://api.noknok.cloud');
    const response = await originalFetch(f.url + url.pathname + url.search, init);
    const body = (await response.text()).replaceAll(f.url, url.origin);
    return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (oldServer === undefined) delete process.env.NOKNOK_SERVER;
    else process.env.NOKNOK_SERVER = oldServer;
    if (oldHome === undefined) delete process.env.NOKNOK_HOME;
    else process.env.NOKNOK_HOME = oldHome;
    if (oldAgent === undefined) delete process.env.NOKNOK_AGENT;
    else process.env.NOKNOK_AGENT = oldAgent;
  });
  let meeting;
  await main(['meeting', 'create', '--purpose', 'Collect reproduction steps', '--product', 'dot'], { emit: result => { meeting = result; } });
  assert.match(meeting.session, /^am_/);
  assert.match(meeting.localAgent, /^ap_/);
  assert.match(meeting.invitationText, /https:\/\/api\.noknok\.cloud\/invite\//);
  const saved = JSON.parse(await readFile(join(process.env.NOKNOK_HOME, 'profiles', meeting.localAgent, 'hosted.json'), 'utf8'));
  assert.equal(saved.server, 'https://api.noknok.cloud');
  assert.equal(saved.name, 'agent-dot');
  assert.equal(f.calls.filter(call => call.path === '/v1/hosted/accounts').length, 1);
  assert.equal(f.calls.find(call => call.path === '/v1/hosted/accounts').authorization, undefined);
  assert.equal(f.calls.find(call => call.path === '/v1/hosted/agents').authorization, `Bearer ${accountToken}`);
  const before = requests.length;
  await assert.rejects(main(['meeting', 'create', '--agent', meeting.localAgent, '--server', 'https://other.example', '--purpose', 'Wrong service'], { emit() {} }), { code: 'SERVER_MISMATCH' });
  assert.equal(requests.length, before);
  assert.ok(requests.length > 3);
});

test('first contact generation and addition enroll independent identities without setup', async t => {
  const a = await fixture(t), b = await fixture(t);
  await a.run(['friend-link', '--server', a.url, '--product', 'codex']);
  const result = await b.run(['friend-add', `${b.url}/contact#offer=${offer}&key=${contactKey}`, '--product', 'doubaowork']);
  assert.equal(result.added, true);
  assert.equal((await a.saved()).name, 'agent-codex');
  assert.equal((await b.saved()).name, 'agent-doubaowork');
  assert.equal(a.calls.filter(call => call.path === '/mcp').length, 1);
  assert.equal(b.calls.filter(call => call.path === '/mcp').length, 1);
});

test('setup resumes lost account and agent-registration replies using secrets saved before sending', async t => {
  const f = await fixture(t);
  f.mutations.dropAccount = 2;
  await assert.rejects(f.setup(), error => error.code === 'CONNECTION_FAILED' && error.requestId === undefined);
  const pending = await f.saved();
  assert.equal(pending.accountToken, undefined);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) assert.equal(call.body.requestId, pending.accountRequestId);
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
  const added = await f.run(['friend-add', `${f.url}/contact#offer=${offer}&key=${contactKey}`]);
  assert.equal(added.added, true);
  assert.equal(JSON.stringify(added).includes(capability), false);
  assert.equal((await f.saved()).contacts['agent-b'].issuedCapability, issuedCapability);
  assert.equal((await f.saved()).contacts['agent-b'].encryptionKey, contactKey);
  assert.ok(!JSON.stringify(f.calls).includes(contactKey));
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
  await assert.rejects(f.run(['friend-add', `https://other.example/contact#offer=${offer}&key=${contactKey}`]), { code: 'SERVER_MISMATCH' });
  await assert.rejects(f.run(['setup', '--server', 'https://other.example']), { code: 'SERVER_MISMATCH' });
  assert.equal(f.calls.length, before);
  for (const value of ['http://intranet.example', 'https://example.test/path', 'https://user:pass@example.test']) assert.throws(() => hostedOrigin(value));
  for (const value of [`${f.url}/contact?x=y#offer=${offer}`, `${f.url}/contact#offer=${offer}&offer=${offer}`, `${f.url}/contact#offer=bad`]) assert.throws(() => decodeHostedContact(value));
});

test('hosted calls save regular am_ meetings and preserve explicit retry identity', async t => {
  const f = await fixture(t);
  await f.setup();
  await f.run(['friend-add', `${f.url}/contact#offer=${offer}&key=${contactKey}`]);
  const call = ['call', 'agent-b', '--purpose', 'Collect reproduction steps', '--request-id', 'same-call'];
  const first = await f.run(call);
  assert.match(first.session, /^am_/);
  const saved = await new MeetingStore(f.stateDir).load(first.session);
  assert.equal(saved.meetingId, f.room().meeting.id);
  assert.equal(saved.token, f.room().participant.token);
  assert.equal(invitationJoinLink(first), saved.invitationUrl);
  assert.ok(first.invitationText.includes(saved.viewUrl));
  assert.ok(!first.invitationText.includes('Collect reproduction steps'), 'The share text carries setup and links, not retained meeting content.');
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
    assert.ok(isEncryptedText(call.body.params.arguments.purpose_ciphertext));
    assert.ok(isEncryptedText(call.body.params.arguments.encrypted_key));
    assert.ok(!JSON.stringify(call).includes('Collect reproduction steps'));
    assert.ok(!JSON.stringify(call).includes(saved.encryptionKey));
    assert.ok(!JSON.stringify(call).includes(contactKey));
  }
  assert.deepEqual(calls[0].body.params.arguments, calls[1].body.params.arguments);
  await assert.rejects(f.run(['call', 'agent-b', '--purpose', 'Changed', '--request-id', 'same-call']), { code: 'IDEMPOTENCY_CONFLICT' });
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
  try {
    for (const command of ['friends', 'config', 'wakeup']) await assert.rejects(main(['hosted', command], { emit() {} }), { code: 'AGENT_REQUIRED' });
  }
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
  const agent = stateDir => async (...args) => {
    let value;
    await main([...args, '--state-dir', join(directory, stateDir)], { emit: result => { value = result; } });
    return value;
  };
  const a = agent('a'), b = agent('b');
  const setupA = await a('hosted', 'setup', '--server', server.url, '--product', 'codex');
  const setupB = await b('hosted', 'setup', '--server', server.url, '--product', 'doubaowork');
  assert.notEqual(setupA.agentId, setupB.agentId);
  const meeting = await a('hosted', 'create', '--purpose', 'Join without an account or contacts');
  const guest = await agent('guest')('meeting', 'join', invitationJoinLink(meeting));
  assert.equal(guest.meetingId, meeting.meetingId);
  assert.equal(guest.participant.kind, 'agent');
  await a('meeting', 'end', meeting.session, '--text', 'Guest joined from the forwarded invitation.');
  const invitation = await a('hosted', 'friend-link');
  assert.ok(invitation.invitationText.includes(invitation.link));
  assert.doesNotMatch(invitation.invitationText, /noknok skill|npm install/);
  assert.match(invitation.invitationText, /^An anonymous agent invites your agent to become friends\.\nOpen https?:\/\/\S+ for details and instructions\.$/);
  const page = await fetch(invitation.link);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /noknok hosted friend-add/);
  assert.match(html, /npm install --global @noknok\/cli/);
  assert.ok(!html.includes(new URLSearchParams(new URL(invitation.link).hash.slice(1)).get('key')));
  const added = await b('hosted', 'friend-add', invitation.link);
  assert.equal(added.peerId, setupA.agentId);
  const contacts = await a('hosted', 'friends');
  assert.equal(contacts.contacts[0].peerId, setupB.agentId);
  const call = await a('hosted', 'call', setupB.agentId, '--purpose', 'Collect reproduction URL and steps', '--request-id', 'real-cli-call');
  assert.match(call.session, /^am_/);
  const fallback = await agent('fallback')('meeting', 'join', invitationJoinLink(call));
  assert.equal(fallback.meetingId, call.meetingId);
  const inbox = await b('hosted', 'inbox');
  assert.equal(inbox.invitations.length, 1);
  const joined = await b('hosted', 'accept', inbox.invitations[0].id);
  assert.equal(joined.meetingId, call.meetingId);
  const localA = await new MeetingStore(join(directory, 'a')).load(call.session);
  const localB = await new MeetingStore(join(directory, 'b')).load(joined.session);
  assert.equal(localA.encryptionKey, localB.encryptionKey);
  const relaySnapshot = JSON.stringify(server.meetings.inspect(call.meetingId));
  assert.ok(!relaySnapshot.includes(localA.encryptionKey));
  assert.ok(!relaySnapshot.includes('Collect reproduction URL and steps'));
  assert.equal(new URLSearchParams(new URL(call.invitationUrl).hash.slice(1)).get('key'), localA.encryptionKey);
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


test('legacy contacts cannot start calls and tampered wrapped invitations cannot join', async t => {
  const f = await fixture(t);
  await f.setup();
  await f.run(['friend-add', `${f.url}/contact#offer=${offer}&key=${contactKey}`]);
  const state = await f.saved();
  delete state.contacts['agent-b'].encryptionKey;
  await writeFile(join(f.stateDir, 'hosted.json'), JSON.stringify(state));
  const before = f.calls.length;
  await assert.rejects(f.run(['call', 'agent-b', '--purpose', 'Blocked']), { code: 'CONTACT_ENCRYPTION_REQUIRED' });
  assert.equal(f.calls.length, before);
  state.contacts['agent-b'].encryptionKey = contactKey;
  await writeFile(join(f.stateDir, 'hosted.json'), JSON.stringify(state));
  const encryptionId = randomUUID(), key = generateKey();
  const encryptedKey = await encryptText(contactKey, JSON.stringify({ key, encryptionId }), contactKeyAAD('agent-b', 'agent-a', encryptionId));
  f.mutations.invitations = [{ id: 'incoming', from: 'agent-b', encryptionId: randomUUID(), encryptedKey }];
  await assert.rejects(f.run(['accept', 'incoming']), { code: 'INVALID_ENCRYPTED_INVITATION' });
  assert.ok(!f.calls.some(call => call.body?.params?.name === 'noknok_meeting_join'));
  assert.ok(!JSON.stringify(f.calls).includes(key));
  assert.throws(() => decodeHostedContact(`${f.url}/contact#offer=${offer}`), { code: 'INVALID_CONTACT' });
});

test('connection and wakeup instructions reuse the bound identity without subscribing or modifying state', async t => {
  const f = await fixture(t);
  await f.setup();
  const before = await f.saved(), requests = f.calls.length;
  const config = await f.run(['config']);
  assert.ok(config.instructions.includes('mcpConfig'));
  assert.ok(config.instructions.includes('eventsMcpConfig'));
  assert.ok(config.instructions.includes('same identity'));
  assert.equal(config.requiresClientAction, true);
  const wakeup = await f.run(['wakeup']);
  assert.equal(wakeup.agentId, before.agentId);
  assert.equal(wakeup.server, before.server);
  assert.equal(wakeup.mode, 'host-instructions');
  assert.equal(wakeup.applied, false);
  assert.equal(wakeup.requiresClientAction, true);
  assert.deepEqual(wakeup.subscription, { name: 'noknok.activity', arguments: { recipient_id: before.agentId } });
  assert.match(wakeup.instructions, /user asks to enable/);
  assert.match(wakeup.instructions, /contacts already saved/);
  assert.match(wakeup.instructions, /save each message durably, then acknowledge/);
  assert.match(wakeup.instructions, /without new human input/);
  assert.ok(!JSON.stringify(wakeup).includes(before.agentToken));
  assert.equal(f.calls.length, requests, 'Instruction commands must not create remote subscriptions or contacts.');
  assert.deepEqual(await f.saved(), before);
  await assert.rejects(f.run(['wakeup', 'another-identity']), { code: 'INVALID_ARGUMENT' });
});
