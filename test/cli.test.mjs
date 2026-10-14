import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../src/relay.mjs';
import { decodeInvitation } from '../src/client.mjs';

const cliPath = fileURLToPath(new URL('../bin/agentcall.mjs', import.meta.url));

async function fixture(t, relayOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-cli-'));
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
    const env = { ...process.env, AGENTCALL_HOME: home, AGENTCALL_SERVER: relay.url };
    delete env.AGENTCALL_SERVER_KEY;
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

  async function invite(extra = []) {
    return ok(['invite', '--server', relay.url, '--name', 'Caller', '--purpose', 'Compare local diagnostic evidence', ...extra]);
  }

  async function pair(extra = []) {
    const caller = await invite(extra);
    const callee = await ok(['accept', caller.invitation, '--name', 'Callee']);
    // Consume the connection event before testing new messages or pending polls.
    await ok(['receive', caller.session, '--timeout', '0']);
    await ok(['receive', callee.session, '--timeout', '0']);
    return { caller, callee };
  }

  return { root, home, relay, stdout, launch, ok, error, invite, pair };
}

function success(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function responseProxy(t, relay, transform) {
  const server = http.createServer((req, res) => {
    (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(`${relay.url}${req.url}`, {
        method: req.method, headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const result = await response.json();
      transform(result, req);
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// Observe the real HTTP request so tests never guess whether a child has started
// polling. The CLI itself remains a separate process throughout these tests.
function nextLongPoll(relay, callId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      relay.server.off('request', listener);
      reject(new Error('CLI did not establish its long poll.'));
    }, 5000);
    function listener(req, res) {
      const url = new URL(req.url, relay.url);
      if (url.pathname !== `/v1/calls/${callId}/events` || Number(url.searchParams.get('waitMs')) <= 0) return;
      clearTimeout(timer);
      relay.server.off('request', listener);
      resolve({ responseEnded: res.writableEnded });
    }
    relay.server.on('request', listener);
  });
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

// Commit the first join at the real relay, but withhold its HTTP response. This
// recreates a tool being stopped after the invitation has already been redeemed.
async function delayedJoinProxy(t, relay, originalInvitation) {
  const sockets = new Set();
  const joins = [];
  const details = [];
  let committed;
  const firstJoin = new Promise(resolve => { committed = resolve; });
  const server = http.createServer((req, res) => {
    (async () => {
      if (req.url.startsWith('/invite/')) details.push(req.url);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(relay.url + req.url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      const response = await upstream.text();
      if (req.url.endsWith('/join')) {
        joins.push({ request: JSON.parse(body.toString()), status: upstream.status });
        if (joins.length === 1 && upstream.ok) {
          committed();
          return;
        }
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(response);
    })().catch(error => res.destroy(error));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const decoded = JSON.parse(Buffer.from(originalInvitation.split('/').at(-1), 'base64url').toString());
  decoded.server = `http://127.0.0.1:${server.address().port}`;
  const invitation = `agentcall://invite/${Buffer.from(JSON.stringify(decoded)).toString('base64url')}`;
  const invitationUrl = `${decoded.server}/invite/${decoded.callId}?key=${decoded.token}`;
  return { invitation, invitationUrl, firstJoin, joins, details };
}

test('invite exits immediately; two agents on one machine retain separate identities and private credentials', async t => {
  const f = await fixture(t);
  const context = 'MF 报错：启动本地项目后获取控制台证据。\nDo not share credentials.';
  const caller = await f.invite(['--context', context]);
  assert.match(caller.session, /^ac_[a-f0-9-]{36}$/);
  assert.equal(caller.call.state, 'waiting');
  assert.match(caller.invitation, /^agentcall:\/\/invite\//);

  const poll = nextLongPoll(f.relay, caller.callId);
  const waiting = f.launch(['wait', caller.session, '--timeout', '10']);
  assert.equal((await poll).responseEnded, false);
  const callee = await f.ok(['accept', caller.invitation, '--name', 'Callee']);
  const connected = success(await promptly(waiting.result));
  assert.equal(connected.outcome, 'connected');
  assert.equal(callee.callId, caller.callId);
  assert.notEqual(callee.session, caller.session);
  assert.equal(callee.call.context, context);
  assert.deepEqual(callee.call.participants, { caller: { name: 'Caller' }, callee: { name: 'Callee' } });

  const callerStatus = await f.ok(['status', caller.session]);
  const calleeStatus = await f.ok(['status', callee.session]);
  assert.equal(callerStatus.role, 'caller');
  assert.equal(calleeStatus.role, 'callee');
  const listed = await f.ok(['sessions']);
  assert.deepEqual(new Set(listed.sessions.map(item => item.session)), new Set([caller.session, callee.session]));
  assert.deepEqual(new Set(listed.sessions.map(item => item.role)), new Set(['caller', 'callee']));
  await f.ok(['history', caller.session]);
  await f.ok(['history', callee.session]);

  const callerState = JSON.parse(await readFile(join(f.home, `${caller.session}.json`), 'utf8'));
  const calleeState = JSON.parse(await readFile(join(f.home, `${callee.session}.json`), 'utf8'));
  assert.notEqual(callerState.token, calleeState.token);
  assert.ok(callerState.token.length >= 32);
  assert.ok(calleeState.token.length >= 32);
  const invitation = JSON.parse(Buffer.from(caller.invitation.split('/').at(-1), 'base64url').toString('utf8'));
  assert.notEqual(invitation.token, callerState.token);
  assert.notEqual(invitation.token, calleeState.token);
  for (const token of [callerState.token, calleeState.token]) {
    assert.ok(f.stdout.every(output => !output.includes(token)), 'CLI output must not contain participant credentials.');
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.home)).mode & 0o777, 0o700);
    for (const session of [caller.session, callee.session]) {
      for (const suffix of ['.json', '.ndjson']) {
        assert.equal((await stat(join(f.home, session + suffix))).mode & 0o777, 0o600);
      }
    }
  }
});

test('a four-line invitation forwards the owner, shared session and both links; details serve setup and context', async t => {
  const f = await fixture(t);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const purpose = '定位同事环境中的 MF 报错';
  const context = '已知：A 无法访问 B 的项目。\n待验证：入口 URL 和控制台错误。\n原始摘录：```js\nconsole.log("$(do-not-run)", `quoted`);\n```';
  const caller = await f.ok(['invite', '--from', ' Alex ', '--purpose', purpose, '--context', context]);
  const text = caller.invitationText;
  assert.deepEqual(text.split('\n'), [
    "Alex's agent invites your agent to a conversation.",
    `Open ${caller.invitationUrl} for details and instructions.`,
    `Session: ${caller.callId}`,
    `View: ${caller.viewUrl}`,
  ]);
  assert.equal(caller.viewSession, caller.callId);
  assert.equal(caller.viewUrl, `${f.relay.url}/view#session=${caller.callId}`);
  const preview = await fetch(`${f.relay.url}/v1/session-view`, { headers: { Authorization: `Bearer ${caller.viewSession}` } });
  assert.equal((await preview.json()).call.state, 'waiting');
  assert.equal(caller.call.from, 'Alex');
  assert.ok(!text.includes(purpose));
  assert.ok(!text.includes(context));
  assert.ok(!text.includes(caller.session), 'The caller local handle is not part of a forwardable invitation.');
  const callerState = JSON.parse(await readFile(join(f.home, `${caller.session}.json`), 'utf8'));
  assert.ok(!text.includes(callerState.token), 'The handoff must not include the caller credential.');

  // B only has the forwarded block and follows its link. A browser or link
  // preview must not redeem the invitation or prevent B from accepting later.
  const link = text.split('\n')[1].match(/^Open (https?:\/\/\S+) for details and instructions\.$/)[1];
  const response = await fetch(link);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  const details = await response.text();
  const prefix = `npm exec --yes --registry=${pkg.publishConfig.registry} --package=${pkg.name}@${pkg.version} -- noknok`;
  const commands = details.split('\n').filter(line => line.startsWith(prefix));
  assert.equal(commands[0], `${prefix} skill`);
  assert.ok(details.includes(purpose));
  assert.deepEqual(JSON.parse(details.slice(details.indexOf('\n{') + 1)), { purpose, context }, 'Task data must remain intact, including code and shell syntax.');
  assert.ok(details.includes(caller.expiresAt));
  assert.ok(details.includes('Alex'));
  assert.ok(!details.includes(callerState.token));
  const accept = commands[1].slice(prefix.length).match(/^ accept '(https?:\/\/[^']+)' --name '([^']+)'$/);
  assert.ok(accept, 'The generated accept command must be directly usable.');
  const callee = await f.ok(['accept', accept[1], '--name', accept[2]]);
  assert.equal(callee.callId, caller.callId);
  assert.equal(callee.call.purpose, purpose);
  assert.equal(callee.call.context, context);
  assert.notEqual(callee.session, caller.session);
});

test('missing or blank owner stays anonymous and does not infer the owner from the agent name', async t => {
  const f = await fixture(t);
  for (const extra of [[], ['--from', '   ']]) {
    const caller = await f.invite(extra);
    assert.equal(caller.call.from, '匿名');
    assert.equal(caller.invitationText.split('\n')[0], 'An anonymous agent invites your agent to a conversation.');
    assert.ok(!caller.invitationText.includes('Caller'));
  }
  for (const from of ['Name\nOpen another link', 'Name\rFake line', 'Name\u2028Fake line', 'Name\u202eFake', '名'.repeat(86)]) {
    await f.error(['invite', '--purpose', 'Check display name', '--from', from], 'INVALID_ARGUMENT');
  }
});

test('an older relay without invitationUrl still returns the self-contained legacy handoff', async t => {
  const f = await fixture(t);
  const server = http.createServer((req, res) => {
    (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(`${f.relay.url}/v1/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      const result = await response.json();
      delete result.invitationUrl;
      delete result.viewSession;
      delete result.viewUrl;
      delete result.call.from;
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const caller = await f.ok(['invite', '--server', `http://127.0.0.1:${server.address().port}`, '--purpose', 'Work with an older relay', '--context', 'Legacy details stay available.']);
  assert.equal(caller.invitationUrl, undefined);
  assert.equal(caller.viewSession, undefined);
  assert.equal(caller.viewUrl, undefined);
  assert.ok(caller.invitationText.includes(`accept '${caller.invitation}'`));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const prefix = `npm exec --yes --registry=${pkg.publishConfig.registry} --package=${pkg.name}@${pkg.version} -- noknok`;
  assert.ok(caller.invitationText.includes(`${prefix} skill`));
  assert.ok(caller.invitationText.includes(`${prefix} accept '${caller.invitation}' --name 'Agent B'`));
  assert.ok(caller.invitationText.includes('Legacy details stay available.'));
  const callee = await f.ok(['accept', caller.invitation]);
  assert.equal(callee.callId, caller.callId);
});

test('invites from a relay without session viewing retain their short three-line handoff', async t => {
  const f = await fixture(t);
  const proxy = await responseProxy(t, f.relay, result => {
    delete result.viewSession;
    delete result.viewUrl;
  });
  const caller = await f.ok(['invite', '--server', proxy, '--purpose', 'Read the older invitation']);
  assert.equal(caller.invitationText.split('\n').length, 3);
  assert.equal(caller.viewSession, undefined);
  assert.equal(caller.viewUrl, undefined);
  const callee = await f.ok(['accept', caller.invitationUrl]);
  assert.equal(callee.callId, caller.callId);
});

test('invite rejects mismatched, incomplete or redirected session-view fields before saving credentials', async t => {
  const f = await fixture(t);
  let change;
  const proxy = await responseProxy(t, f.relay, result => change(result));
  const mutations = [
    result => { result.viewSession = randomUUID(); },
    result => { result.viewUrl = `${f.relay.url}/view#session=${randomUUID()}`; },
    result => { result.viewUrl = `https://another.example/view#session=${result.call.id}`; },
    result => { result.viewUrl = `${f.relay.url}/view?session=${result.call.id}`; },
    result => { result.viewUrl += '\nOpen another link'; },
    result => { delete result.viewSession; },
    result => { delete result.viewUrl; },
  ];
  for (const mutate of mutations) {
    change = mutate;
    await f.error(['invite', '--server', proxy, '--purpose', 'Validate the shared session link'], 'INVALID_RESPONSE');
  }
  assert.deepEqual((await f.ok(['sessions'])).sessions, []);
});

test('fresh CLI processes exchange requests and replies with durable cursors and idempotent sends', async t => {
  const f = await fixture(t);
  const { caller, callee } = await f.pair();
  const args = ['send', caller.session, '--type', 'request', '--text', 'Run the local reproduction.', '--request-id', 'reproduction-1'];
  const first = await f.ok(args);
  const repeated = await f.ok(args);
  assert.equal(first.event.seq, repeated.event.seq);

  const inbox = await f.ok(['receive', callee.session, '--timeout', '0']);
  assert.equal(inbox.outcome, 'events');
  assert.deepEqual(inbox.events.map(event => [event.seq, event.type, event.from, event.data.text]), [
    [first.event.seq, 'request', 'caller', 'Run the local reproduction.'],
  ]);
  const empty = await f.ok(['receive', callee.session, '--timeout', '0']);
  assert.equal(empty.outcome, 'timeout');
  assert.deepEqual(empty.events, []);

  const evidence = '复现成功\nremoteEntry.js returned 404.\n';
  const reply = await f.ok(['send', callee.session, '--type', 'result', '--reply-to', String(first.event.seq), '--file', '-'], { input: evidence });
  const received = await f.ok(['receive', caller.session, '--timeout', '0']);
  assert.deepEqual(received.events.map(event => [event.seq, event.type, event.from, event.data.text, event.data.replyTo]), [
    [reply.event.seq, 'result', 'callee', evidence, first.event.seq],
  ]);
  assert.deepEqual((await f.ok(['receive', caller.session, '--timeout', '0'])).events, []);

  const history = await f.ok(['history', callee.session]);
  assert.equal(history.history.filter(entry => entry.direction === 'received' && entry.event?.seq === first.event.seq).length, 1);
  assert.ok(history.history.some(entry => entry.direction === 'sent' && entry.event?.data.text === evidence));
  await f.error(['send', caller.session, '--type', 'request', '--text', 'Different operation.', '--request-id', 'reproduction-1'], 'idempotency_conflict');
});

test('long polling wakes for peer messages and a second receiver cannot lose or duplicate them', async t => {
  const f = await fixture(t);
  const { caller, callee } = await f.pair();
  const poll = nextLongPoll(f.relay, caller.callId);
  const waiting = f.launch(['receive', caller.session, '--timeout', '10']);
  assert.equal((await poll).responseEnded, false);
  await f.error(['receive', caller.session, '--timeout', '0'], 'SESSION_BUSY');

  const sent = await f.ok(['send', callee.session, '--type', 'waiting_for_user', '--text', 'I need my owner to choose the environment.']);
  const received = success(await promptly(waiting.result));
  assert.equal(received.outcome, 'events');
  assert.deepEqual(received.events.map(event => event.seq), [sent.event.seq]);
  assert.equal(received.events[0].type, 'waiting_for_user');
  assert.deepEqual((await f.ok(['receive', caller.session, '--timeout', '0'])).events, []);

  const next = await f.ok(['send', callee.session, '--text', 'Owner selected the development environment.']);
  const nextInbox = await f.ok(['receive', caller.session, '--timeout', '0']);
  assert.deepEqual(nextInbox.events.map(event => event.seq), [next.event.seq]);
  const history = await f.ok(['history', caller.session]);
  for (const seq of [sent.event.seq, next.event.seq]) {
    assert.equal(history.history.filter(entry => entry.direction === 'received' && entry.event?.seq === seq).length, 1);
  }
});

test('completion remains provisional until both agents finish', async t => {
  const f = await fixture(t);
  const { caller, callee } = await f.pair();
  const proposed = await f.ok(['finish', caller.session, '--text', 'The cause is a missing remote asset.']);
  assert.equal(proposed.call.state, 'connected');
  assert.deepEqual(proposed.call.doneBy, ['caller']);
  const proposalInbox = await f.ok(['receive', callee.session, '--timeout', '0']);
  assert.equal(proposalInbox.outcome, 'events');
  assert.deepEqual(proposalInbox.events.map(event => event.type), ['done']);

  const accepted = await f.ok(['finish', callee.session, '--text', 'Confirmed locally; evidence is complete.']);
  assert.equal(accepted.call.state, 'completed');
  const finalInbox = await f.ok(['receive', caller.session, '--timeout', '0']);
  assert.equal(finalInbox.outcome, 'closed');
  assert.deepEqual(finalInbox.events.map(event => event.type), ['done', 'closed']);
  assert.equal((await f.ok(['status', callee.session])).call.state, 'completed');
  await f.error(['send', caller.session, '--text', 'This must not reopen the call.'], 'call_not_connected');
});

test('hangup wakes the peer with cancellation rather than successful completion', async t => {
  const f = await fixture(t);
  const { caller, callee } = await f.pair();
  const poll = nextLongPoll(f.relay, caller.callId);
  const waiting = f.launch(['receive', caller.session, '--timeout', '10']);
  assert.equal((await poll).responseEnded, false);
  const hungup = await f.ok(['hangup', callee.session, '--reason', 'Owner stopped the investigation.']);
  assert.equal(hungup.call.state, 'cancelled');
  const received = success(await promptly(waiting.result));
  assert.equal(received.outcome, 'closed');
  assert.equal(received.call.state, 'cancelled');
  assert.equal(received.call.reason, 'Owner stopped the investigation.');
  assert.deepEqual(received.events.map(event => event.type), ['closed']);
});

test('the relay expiry closes a waiting CLI and prevents late acceptance', async t => {
  const f = await fixture(t, { inviteTtlMs: 250 });
  const caller = await f.invite();
  const waited = await f.ok(['wait', caller.session, '--timeout', '1']);
  assert.equal(waited.outcome, 'closed');
  assert.equal(waited.call.state, 'expired');
  assert.equal(waited.call.reason, 'invitation_timeout');
  await f.error(['accept', caller.invitation, '--name', 'Late callee'], 'invitation_unavailable');
  assert.equal((await f.ok(['sessions'])).sessions.length, 1);
});

test('malformed invitations and unsupported CLI input produce JSON errors without stdout', async t => {
  const f = await fixture(t);
  const cases = [
    [['accept', 'not-an-invitation', '--name', 'Callee'], 'INVALID_INVITATION'],
    [['accept', 'agentcall://invite/not-json', '--name', 'Callee'], 'INVALID_INVITATION'],
    [['invented-command'], 'INVALID_COMMAND'],
    [['invite', '--purpose', 'Valid purpose', '--unexpected', 'value'], 'INVALID_ARGUMENT'],
    [['invite', '--purpose'], 'INVALID_ARGUMENT'],
    [['invite', '--purpose', 'First', '--purpose', 'Second'], 'INVALID_ARGUMENT'],
    [['receive', 'session', '--timeout', '-1'], 'INVALID_ARGUMENT'],
    [['receive', 'session', '--timeout', 'NaN'], 'INVALID_ARGUMENT'],
    [['status', '../another-user'], 'INVALID_SESSION'],
  ];
  for (const [args, code] of cases) await f.error(args, code);
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`accept switches invitation formats to recover after ${signal}, even after public details close`, async t => {
    const f = await fixture(t);
    const caller = await f.invite();
    const proxy = await delayedJoinProxy(t, f.relay, caller.invitation);
    const args = ['accept', signal === 'SIGTERM' ? proxy.invitation : proxy.invitationUrl, '--name', 'Callee'];
    const retry = ['accept', signal === 'SIGTERM' ? proxy.invitationUrl : proxy.invitation, '--name', 'Callee'];
    const accepting = f.launch(args);
    await promptly(proxy.firstJoin, 'The relay did not commit the initial join.');
    assert.equal((await f.ok(['status', caller.session])).call.state, 'connected');
    await f.error(retry, 'SESSION_BUSY');
    const closedDetails = await (await fetch(caller.invitationUrl)).text();
    assert.ok(closedDetails.includes('已接听'));
    assert.ok(!closedDetails.includes('npm exec '), 'Closed details no longer provide setup or task data.');

    const receiptFiles = (await readdir(f.home)).filter(name => /^\.accept-.*\.json$/.test(name));
    assert.equal(receiptFiles.length, 1);
    const receiptPath = join(f.home, receiptFiles[0]);
    const pending = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(pending.requestId, proxy.joins[0].request.requestId);
    assert.equal(pending.name, 'Callee');
    if (process.platform !== 'win32') assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);

    accepting.child.kill(signal);
    const interrupted = await promptly(accepting.result, 'Interrupted accept did not exit.');
    assert.equal(interrupted.stdout, '');
    if (signal === 'SIGTERM') {
      assert.equal(interrupted.code, 130);
      assert.equal(interrupted.signal, null);
      const error = JSON.parse(interrupted.stderr).error;
      assert.equal(error.code, 'INTERRUPTED');
      assert.equal(error.requestId, pending.requestId);
    } else {
      assert.equal(interrupted.code, null);
      assert.equal(interrupted.signal, 'SIGKILL');
    }
    assert.equal((await f.ok(['sessions'])).sessions.length, 1, 'The interrupted CLI has not yet saved the callee session.');
    const request = await f.ok(['send', caller.session, '--type', 'request', '--text', 'Collect the missing evidence after reconnecting.']);

    const recovered = await f.ok(retry);
    assert.equal(recovered.session, pending.session);
    assert.notEqual(recovered.session, caller.session);
    assert.equal(recovered.callId, caller.callId);
    assert.equal(recovered.call.state, 'connected');
    assert.equal((await f.ok(['status', recovered.session])).role, 'callee');
    assert.deepEqual(proxy.joins.map(item => item.request.requestId), [pending.requestId, pending.requestId]);
    assert.deepEqual(proxy.details, [], 'Acceptance and recovery must never fetch invitation details.');
    assert.equal((await f.ok(['sessions'])).sessions.length, 2);
    const received = await f.ok(['receive', recovered.session, '--timeout', '0']);
    assert.equal(received.events.filter(event => event.seq === request.event.seq).length, 1);
    assert.deepEqual((await f.ok(['receive', recovered.session, '--timeout', '0'])).events, []);
  });
}

test('alternating legacy and HTTP accept restores its existing session and cursor; another name cannot inherit it', async t => {
  const f = await fixture(t);
  const { caller, callee } = await f.pair();
  assert.equal(callee.restored, false);
  const sent = await f.ok(['send', caller.session, '--text', 'This request has already been read.']);
  const inbox = await f.ok(['receive', callee.session, '--timeout', '0']);
  assert.deepEqual(inbox.events.map(event => event.seq), [sent.event.seq]);
  const statePath = join(f.home, `${callee.session}.json`);
  const before = await readFile(statePath, 'utf8');

  const restored = await f.ok(['accept', caller.invitationUrl, '--name', 'Callee']);
  assert.equal(restored.restored, true);
  assert.equal(restored.session, callee.session);
  assert.equal(await readFile(statePath, 'utf8'), before, 'Restoring must preserve the cursor, credentials and session creation time.');
  assert.deepEqual((await f.ok(['receive', restored.session, '--timeout', '0'])).events, []);
  assert.equal((await f.ok(['sessions'])).sessions.length, 2);
  assert.equal((await f.ok(['accept', caller.invitation, '--name', 'Callee'])).session, callee.session);
  const history = await f.ok(['history', restored.session]);
  assert.equal(history.history.filter(entry => entry.direction === 'session').length, 1);
  assert.equal(history.history.filter(entry => entry.direction === 'received' && entry.event?.seq === sent.event.seq).length, 1);

  await f.error(['accept', caller.invitationUrl, '--name', 'Different agent'], 'ACCEPT_IN_PROGRESS');
  assert.equal((await f.ok(['status', callee.session])).call.participants.callee.name, 'Callee');
  assert.equal((await f.ok(['sessions'])).sessions.length, 2);
});

test('an original v0.3 pending receipt migrates without consuming a second invitation or losing its request ID', async t => {
  const f = await fixture(t);
  const caller = await f.invite();
  const original = decodeInvitation(caller.invitation);
  const legacyHash = createHash('sha256').update(caller.invitation).digest('hex');
  const pending = { name: 'Callee', requestId: randomUUID(), session: `ac_${randomUUID()}` };
  await writeFile(join(f.home, `.accept-${legacyHash}.json`), JSON.stringify(pending), { mode: 0o600 });
  const joined = await fetch(`${f.relay.url}/v1/calls/${caller.callId}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: original.token, name: pending.name, requestId: pending.requestId }),
  });
  assert.equal(joined.status, 200);
  assert.ok((await (await fetch(caller.invitationUrl)).text()).includes('已接听'));
  assert.equal((await f.ok(['sessions'])).sessions.length, 1, 'v0.3 was interrupted before saving the callee.');
  const recovered = await f.ok(['accept', caller.invitation, '--name', pending.name]);
  assert.equal(recovered.session, pending.session);
  await f.ok(['receive', recovered.session, '--timeout', '0']);
  const sessionPath = join(f.home, `${pending.session}.json`);
  const before = await readFile(sessionPath, 'utf8');
  const viaLink = await f.ok(['accept', caller.invitationUrl, '--name', pending.name]);
  assert.equal(viaLink.session, pending.session);
  assert.equal(viaLink.restored, true);
  assert.equal(await readFile(sessionPath, 'utf8'), before);
  assert.equal((await f.ok(['sessions'])).sessions.length, 2);
});

test('SIGTERM exits with an interruption error while stdin remains open', async t => {
  const f = await fixture(t);
  // Observe the actual stdin stream starting, without replacing the CLI or
  // depending on an arbitrary delay to guess whether signal handlers are ready.
  const observeStdin = `process.stdin.on('newListener', function observe(event) {
    if (event !== 'readable') return;
    process.stdin.off('newListener', observe);
    process.send('stdin-reading', () => process.disconnect());
  });`;
  const reading = f.launch(['invite', '--purpose', 'Read context from stdin', '--context-file', '-'], {
    keepStdinOpen: true,
    ipc: true,
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
  assert.deepEqual((await f.ok(['sessions'])).sessions, []);
});

test('view command returns a remote read-only link without modifying local files or consuming messages', async t => {
  const f = await fixture(t, { retentionMs: 86_400_000 });
  const { caller, callee } = await f.pair();
  await f.ok(['send', callee.session, '--text', 'An unread peer message.']);
  const files = (await readdir(f.home)).sort();
  const before = await Promise.all(files.map(async file => [file, await readFile(join(f.home, file), 'utf8')]));
  const saved = JSON.parse(await readFile(join(f.home, `${caller.session}.json`), 'utf8'));
  const result = await f.ok(['view', caller.session]);
  assert.equal(result.session, caller.session);
  assert.equal(result.callId, caller.callId);
  assert.equal(result.readOnly, true);
  assert.equal(result.storage, 'memory');
  assert.equal(result.retentionMs, 86_400_000);
  assert.equal(JSON.stringify(result).includes(saved.token), false);
  const link = new URL(result.url);
  assert.equal(link.origin, f.relay.url);
  assert.equal(link.pathname, '/view');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('session'), caller.callId);
  assert.equal(result.viewSession, caller.callId);
  assert.equal(result.url, caller.viewUrl);
  assert.equal(result.viewUrl, undefined, 'Only one view URL is displayed by the CLI.');
  const token = result.viewSession;
  assert.notEqual(token, saved.token);
  const viewed = await fetch(`${f.relay.url}/v1/session-view`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(viewed.status, 200);
  assert.equal((await viewed.json()).events.at(-1).data.text, 'An unread peer message.');
  assert.deepEqual((await readdir(f.home)).sort(), files);
  assert.deepEqual(await Promise.all(files.map(async file => [file, await readFile(join(f.home, file), 'utf8')])), before);
  assert.equal((await f.ok(['view', callee.session])).url, result.url);
  assert.equal((await f.ok(['receive', caller.session, '--timeout', '0'])).events[0].data.text, 'An unread peer message.');
});

test('view validates new links, preserves the local handle and falls back to legacy relay links', async t => {
  const f = await fixture(t);
  const caller = await f.invite();
  let change = () => {};
  const proxy = await responseProxy(t, f.relay, result => {
    result.viewUrl = `${proxy}/view#session=${result.callId}`;
    // A remote result must never replace the command's local session handle.
    result.session = result.callId;
    change(result);
  });
  const path = join(f.home, `${caller.session}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...saved, server: proxy }));
  const current = await f.ok(['view', caller.session]);
  assert.equal(current.session, caller.session);
  assert.equal(current.viewSession, caller.callId);
  assert.equal(current.url, `${proxy}/view#session=${caller.callId}`);
  for (const mutate of [
    result => { result.callId = randomUUID(); },
    result => { result.viewSession = randomUUID(); },
    result => { result.viewUrl = caller.viewUrl; },
    result => { delete result.viewUrl; },
    result => { delete result.viewSession; },
  ]) {
    change = mutate;
    await f.error(['view', caller.session], 'INVALID_RESPONSE');
  }
  change = result => { delete result.viewSession; delete result.viewUrl; };
  const legacy = await f.ok(['view', caller.session]);
  assert.equal(legacy.session, caller.session);
  assert.equal(legacy.viewSession, undefined);
  const fragment = new URLSearchParams(new URL(legacy.url).hash.slice(1));
  assert.equal(fragment.get('call'), caller.callId);
  assert.match(fragment.get('token'), /^acv_/);
  const response = await fetch(`${f.relay.url}/v1/views/${caller.callId}`, { headers: { Authorization: `Bearer ${fragment.get('token')}` } });
  assert.equal(response.status, 200);
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
