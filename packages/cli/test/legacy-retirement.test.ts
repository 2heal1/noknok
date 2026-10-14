import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { startRelay } from '../src/relay.js';
import { MEETING_TOOLS, HOSTED_LOCAL_TOOLS } from '../src/mcp-stdio.js';

const TOOLS = [...MEETING_TOOLS, ...HOSTED_LOCAL_TOOLS];

test('removed commands fail before networking, reading content files or creating profiles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-removed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commands = [
    ['invite', '--purpose', 'secret', '--context-file', '/missing-sensitive-context'],
    ['accept', 'https://untrusted.invalid/invite/old?key=secret'],
    ['call', 'friend', '--purpose', 'secret'], ['listen'], ['wait', 'ac_old'], ['receive', 'ac_old'],
    ['send', 'ac_old', '--file', '/missing-sensitive-content'], ['finish', 'ac_old', '--text', 'secret'],
    ['hangup', 'ac_old', '--reason', 'secret'], ['status', 'ac_old'], ['view', 'ac_old'], ['receiver', 'start'], ['receiver-run'],
    ['gateway'], ['viewer'], ['history', 'ac_old'], ['sessions'], ['friend-link'], ['friend-add', 'old'], ['friends'],
    ['beta-code'],
  ];
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unknown commands must not access the network.'); };
  try {
    for (const command of commands) {
      await assert.rejects(main([...command, '--state-dir', directory], { emit() { throw new Error('No successful output is expected.'); } }), error => {
        assert.equal(error.code, 'INVALID_COMMAND', command[0]);
        return true;
      });
    }
    await assert.rejects(main(['hosted', 'setup', '--code-file', '/missing-private-code', '--state-dir', directory], { emit() {} }), { code: 'INVALID_ARGUMENT' });
  } finally { globalThis.fetch = original; }
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('removed relay protocol routes return 404 without parsing plaintext bodies', async t => {
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  for (const path of ['/v1/calls', '/v1/calls/old', '/v1/calls/old/join', '/v1/calls/old/messages', '/v1/calls/old/events',
    '/v1/calls/old/finish', '/v1/calls/old/hangup', '/v1/calls/old/view', '/invite/old?key=legacy-secret', '/v1/session-view', '/v1/views/old',
    '/v1/contacts', '/v1/gateway', '/mcp/old']) {
    const response = await fetch(relay.url + path, { method: 'POST', body: 'malformed-private-input' });
    assert.equal(response.status, 404, path);
    const result = await response.json();
    assert.equal(result.error.code, 'not_found');
    assert.equal(JSON.stringify(result).includes('malformed-private-input'), false);
  }
  assert.equal((await fetch(relay.url + '/health')).status, 200);
});

test('local MCP advertises only encrypted meeting and hosted tools', () => {
  assert.ok(TOOLS.some(tool => tool.name === 'noknok_meeting_create'));
  assert.ok(TOOLS.some(tool => tool.name === 'noknok_hosted_call'));
  for (const name of ['call', 'send', 'receive', 'wait', 'finish', 'hangup', 'view', 'history', 'sessions', 'receiver', 'friends', 'friend_link', 'friend_add']) {
    assert.equal(TOOLS.some(tool => tool.name === `noknok_${name}`), false, name);
  }
});
