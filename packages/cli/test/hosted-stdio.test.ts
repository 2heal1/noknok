import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { startHostedService } from '../src/hosted-service.js';
import { startStdioMcp } from '../src/mcp-stdio.js';
import { MeetingStore } from '../src/meeting-client.js';
import { isEncryptedText } from '../src/e2ee.js';

async function stdio(t, directory, run = main) {
  const input = new PassThrough(), output = new PassThrough();
  const pending = new Map();
  let buffer = '';
  output.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      pending.get(value.id)?.(value); pending.delete(value.id);
    }
  });
  const completion = startStdioMcp({ directory, input, output, run });
  t.after(async () => { input.end(); await completion; });
  async function request(method, params) {
    const id = randomUUID();
    const result = new Promise(resolve => pending.set(id, resolve));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return result;
  }
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    request,
    async tool(name, args = {}) {
      const response = await request('tools/call', { name: `noknok_${name}`, arguments: args });
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.equal(response.result.isError, false, JSON.stringify(response.result));
      return response.result.structuredContent;
    },
  };
}

test('hosted local stdio binds the profile and preserves shell-like content literally', async t => {
  const directory = join(tmpdir(), `noknok-stdio-binding-${randomUUID()}`);
  const mcp = await stdio(t, directory, async (argv, { emit }) => emit({ argv }));
  const tools = (await mcp.request('tools/list', {})).result.tools;
  assert.ok(tools.some(item => item.name === 'noknok_hosted_call'));
  const literal = '--state-dir=/tmp/other $(touch /tmp/pwned) `whoami`\nline';
  const result = await mcp.tool('hosted_call', { peer_id: '--other-agent', purpose: literal, request_id: 'stable' });
  assert.deepEqual(result.argv, ['hosted', 'call', `--state-dir=${directory}`, `--purpose=${literal}`, '--request-id=stable', '--', '--other-agent']);
  const accept = await mcp.tool('hosted_accept', { invitation_id: 'target-invitation' });
  assert.deepEqual(accept.argv, ['hosted', 'accept', `--state-dir=${directory}`, '--', 'target-invitation']);
  const rejected = await mcp.request('tools/call', { name: 'noknok_hosted_identity', arguments: { directory: '/tmp/other' } });
  assert.equal(rejected.error.code, -32602);
});

test('two local stdio agents exchange encrypted hosted invitations and archive plaintext only locally', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-hosted-stdio-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const service = await startHostedService({ dataDir: join(directory, 'service'), publicUrl: `http://127.0.0.1:${port}`, port });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const codeFile = join(directory, 'beta');
  await writeFile(codeFile, service.store.mintCode({ uses: 2 }).code, { mode: 0o600 });
  for (const name of ['a', 'b']) await main(['hosted', 'setup', '--server', service.url, '--code-file', codeFile, '--state-dir', join(directory, name)], { emit() {} });
  const a = await stdio(t, join(directory, 'a')), b = await stdio(t, join(directory, 'b'));
  const invitation = await a.tool('hosted_friend_link');
  await b.tool('hosted_friend_add', { link: invitation.link });
  const friends = await a.tool('hosted_friends');
  const call = await a.tool('hosted_call', { peer_id: friends.contacts[0].peerId, purpose: 'stdio private goal', context: 'stdio private context', request_id: 'stdio-call' });
  const stored = await new MeetingStore(join(directory, 'a')).load(call.session);
  const relay = service.meetings.inspect(call.meetingId);
  assert.ok(isEncryptedText(relay.purpose));
  assert.ok(!JSON.stringify(relay).includes('stdio private goal'));
  assert.ok(!JSON.stringify(relay).includes(stored.encryptionKey));
  const inbox = await b.tool('hosted_inbox');
  const joined = await b.tool('hosted_accept', { invitation_id: inbox.invitations[0].id });
  assert.equal(joined.meeting.purpose, 'stdio private goal');
  await b.tool('meeting_send', { session: joined.session, text: 'stdio private reply', request_id: 'stdio-send' });
  const received = await a.tool('meeting_receive', { session: call.session, timeout: 0 });
  assert.ok(received.events.some(event => event.data?.text === 'stdio private reply'));
  const history = await a.tool('meeting_history', { session: call.session });
  assert.ok(history.events.some(event => event.data?.text === 'stdio private reply'));
  await a.tool('meeting_end', { session: call.session, text: 'stdio private summary', request_id: 'stdio-end' });
  const ended = await b.tool('meeting_status', { session: joined.session });
  assert.equal(ended.meeting.summary, 'stdio private summary');
});
