import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { docsRevision } from '../../../scripts/deploy-docs.js';

test('static website deployment rejects unsafe revisions and tests archive isolation with a real filesystem', () => {
  assert.equal(docsRevision('a'.repeat(40)), 'a'.repeat(40));
  for (const revision of [undefined, 'main', 'a'.repeat(40) + '; id', 'a'.repeat(39)]) assert.throws(() => docsRevision(revision));
  execFileSync('python3', [fileURLToPath(new URL('../../../deploy/docs/test_publish.py', import.meta.url))], { timeout: 20_000 });
});
