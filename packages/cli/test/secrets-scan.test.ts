import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSecretText } from '../../../scripts/check-secrets.js';

// Construct synthetic examples so this regression test never carries a
// literal credential that could be mistaken for a usable production secret.
test('secret scanner reports only credential locations, never their values', () => {
  const samples = [
    ['PRIVATE_KEY', ['-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'].join('')],
    ['NPM_TOKEN', ['npm', '_', 'x'.repeat(36)].join('')],
    ['GITHUB_TOKEN', ['github', '_pat_', 'y'.repeat(60)].join('')],
    ['CLOUD_ACCESS_KEY', ['AK', 'IA', 'A'.repeat(16)].join('')],
    ['NOKNOK_CREDENTIAL', ['nk', '_agent_', 'z'.repeat(43)].join('')],
    ['NOKNOK_CREDENTIAL', ['wh', 'sec_', 'a'.repeat(44)].join('')],
    ['MODEL_API_TOKEN', ['sk', '-proj-', 'a'.repeat(48)].join('')],
  ];
  for (const [rule, value] of samples) {
    const result = scanSecretText(`safe first line\n${value}\n`, 'src/example.ts');
    assert.ok(result.some(item => item.rule === rule && item.line === 2));
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('secret scanner permits lockfile digests, public registry and environment references', () => {
  const harmless = [
    'registry=https://registry.npmjs.org',
    ['//registry.npmjs.org/:_authToken=', '${NPM_TOKEN}'].join(''),
    `integrity: sha512-${'a'.repeat(86)}==`,
    'const token = process.env.NOKNOK_TOKEN;',
    'const signingKey = randomBytes(32);',
  ].join('\n');
  assert.deepEqual(scanSecretText(harmless, '.npmrc'), []);
  assert.equal(scanSecretText('', 'deploy/identity.pem')[0].rule, 'SENSITIVE_FILE');
  for (const basename of ['id_rsa', 'noknok_ci_deploy_ed25519', 'operator_ecdsa', 'legacy_dsa']) {
    assert.equal(scanSecretText('', `deploy/${basename}`)[0].rule, 'SENSITIVE_FILE');
    assert.deepEqual(scanSecretText('', `deploy/${basename}.pub`), []);
  }
  const literal = ['//registry.npmjs.org/:_authToken=', 'a'.repeat(40)].join('');
  assert.ok(scanSecretText(literal, '.npmrc').some(item => item.rule === 'NPM_AUTH_CONFIG'));
});
