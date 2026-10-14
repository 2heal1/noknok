import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { deploymentConfig, deployHosted } from '../../../scripts/deploy-hosted.js';

const fixture = () => ({
  NOKNOK_DEPLOY_VERSION: '0.1.0', NOKNOK_DEPLOY_HOST: 'deploy.example.test',
  NOKNOK_PUBLIC_URL: 'https://api.example.test',
  NOKNOK_DEPLOY_SSH_KEY: 'test fixture PRIVATE KEY----- not a real key',
  NOKNOK_DEPLOY_KNOWN_HOSTS: 'test fixture host key',
  SHOULD_NOT_REACH_SSH: 'private fixture', PATH: process.env.PATH,
});

test('deployment configuration rejects command injection, previews, credentials in URLs, and absent secrets', () => {
  for (const invalid of [
    { NOKNOK_DEPLOY_VERSION: '0.1.0; id' }, { NOKNOK_DEPLOY_VERSION: '0.1.0-preview.1' },
    { NOKNOK_DEPLOY_VERSION: '01.1.0' }, { NOKNOK_DEPLOY_HOST: '-oProxyCommand=id' },
    { NOKNOK_DEPLOY_PORT: '65536' }, { NOKNOK_PUBLIC_URL: 'https://secret@example.test' },
    { NOKNOK_PUBLIC_URL: 'http://example.test' }, { NOKNOK_PUBLIC_URL: 'https://example.test/path' },
    { NOKNOK_DEPLOY_SSH_KEY: '' }, { NOKNOK_DEPLOY_KNOWN_HOSTS: '' },
  ]) assert.throws(() => deploymentConfig({ ...fixture(), ...invalid }));
});

test('CI deployment pins SSH trust, limits the command, isolates credentials, and removes temporary files', async () => {
  const env = fixture();
  let identityPath: string;
  const result = await deployHosted(env, {
    run: async (command, args, options) => {
      assert.equal(command, 'ssh');
      assert.equal(args.at(-1), 'deploy 0.1.0');
      assert.equal(args.at(-2), 'noknok-deploy@deploy.example.test');
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.ok(args.includes('IdentitiesOnly=yes'));
      assert.ok(args.includes('GlobalKnownHostsFile=/dev/null'));
      assert.equal(options.env.NOKNOK_DEPLOY_SSH_KEY, undefined);
      assert.equal(options.env.SHOULD_NOT_REACH_SSH, undefined);
      identityPath = args[args.indexOf('-i') + 1];
      assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
      assert.equal((await readFile(identityPath, 'utf8')).trim(), env.NOKNOK_DEPLOY_SSH_KEY);
    },
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.example.test/health');
      assert.equal(options?.redirect, 'error');
      return Response.json({ ok: true, mode: 'hosted', transcriptStorage: 'participant', deliveryStorage: 'pending_memory' });
    },
  });
  assert.equal(result.version, '0.1.0');
  await assert.rejects(stat(identityPath!), { code: 'ENOENT' });
});

test('CI rejects a legacy or incorrectly configured transcript endpoint after a new deployment', async () => {
  for (const health of [
    { ok: true, mode: 'hosted', transcriptStorage: 'memory' },
    { ok: true, mode: 'hosted', transcriptStorage: 'participant', deliveryStorage: 'disk' },
  ]) await assert.rejects(deployHosted(fixture(), {
    run: async () => {}, fetch: async () => Response.json(health),
  }), /participant-owned transcripts/);
});

test('failed SSH never runs public health verification and still removes credentials', async () => {
  let identityPath: string;
  await assert.rejects(deployHosted(fixture(), {
    run: async (_command, args) => { identityPath = args[args.indexOf('-i') + 1]; throw new Error('failed deployment'); },
    fetch: async () => { assert.fail('must not verify a failed deployment'); },
  }), /failed deployment/);
  await assert.rejects(stat(identityPath!), { code: 'ENOENT' });
});
