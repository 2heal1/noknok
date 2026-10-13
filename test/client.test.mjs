import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeInvitation } from '../src/client.mjs';

const data = {
  v: 1,
  server: 'https://relay.example',
  callId: '12345678-abcd-4000-8000-123456789abc',
  token: 'abcDEF012_-abcDEF012_-abcDEF012',
  expiresAt: '2026-10-10T08:00:00.000Z',
};
const raw = value => `agentcall://invite/${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const link = `${data.server}/invite/${data.callId}?key=${data.token}`;

test('HTTP(S) and legacy invitations decode to the same server, call and redemption token', () => {
  const { expiresAt, ...identity } = data;
  assert.deepEqual(decodeInvitation(link), identity);
  assert.deepEqual(decodeInvitation(raw(data)), data);
  assert.deepEqual(decodeInvitation(link.replace('https://relay.example', 'http://localhost:4317')), { ...identity, server: 'http://localhost:4317' });
  assert.deepEqual(decodeInvitation(link.replace('relay.example', 'RELAY.EXAMPLE:443')), identity);
});

test('invitation parsing rejects unrelated, ambiguous, credentialed or injected URLs before network access', () => {
  for (const input of [
    undefined, null, 123, '', 'not-an-invitation',
    link.replace('https:', 'ftp:'),
    link.replace('/invite/', '/view/'),
    link.replace('/invite/', '/prefix/invite/'),
    link.replace(data.callId, `${data.callId}/join`),
    link.replace(data.callId, 'hello%2Fworld'),
    link.replace('relay.example', 'user:password@relay.example'),
    `${link}#`, `${link}#fragment`, `${link}&key=${data.token}`, `${link}&extra=1`,
    link.replace('?key=', '?token='), link.replace(data.token, 'short'),
    link.replace(data.token, `${data.token}%27%3Bcommand`),
    link.replace(data.token, `${data.token}%0Acommand`),
    link.replace(data.token, `${data.token}%00`),
    `${link}\n`, ` ${link}`, link.replace('/invite/', '\\invite\\'),
    raw({ ...data, token: "0123456789abcdef';command" }),
    raw({ ...data, token: '0123456789abcdef\ncommand' }),
    raw({ ...data, server: 'https://user:password@relay.example' }),
    raw({ ...data, expiresAt: 'invalid' }),
  ]) {
    assert.throws(() => decodeInvitation(input), { code: 'INVALID_INVITATION' }, `Unexpectedly accepted ${String(input)}`);
  }
});
