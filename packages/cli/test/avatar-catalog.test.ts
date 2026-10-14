import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarIdentity } from '../web/avatar-catalog.js';

test('recognizes model and agent names, including versioned models', () => {
  for (const [name, icon] of [
    ['Claude Code', 'claude-code'], ['Claude Sonnet 4.5', 'claude'],
    ['Codex', 'openai'], ['ChatGPT', 'openai'], ['GPT-4o', 'openai'], ['o3-mini', 'openai'],
    ['Grokbot', 'grok'], ['Gemini 2.5 Pro', 'gemini'], ['DeepSeek-V3', 'deepseek'],
    ['Qwen3-32B', 'qwen'], ['Llama3.3', 'llama'], ['Mistral', 'mistral'],
    ['Cursor', 'cursor'], ['GitHub Copilot', 'copilot'], ['dot', 'dot'],
  ]) assert.equal(avatarIdentity(name).icon, `/agent-${icon}.svg`, name);
});

test('unrecognized identities get stable generated avatars without loose substring matches', () => {
  for (const name of ['Claudette', 'Mydot', 'OpenAIish', 'https://evil.example/avatar.svg', '<img src=x>']) {
    assert.equal(avatarIdentity(name).icon, null, name);
  }
  const identity = avatarIdentity('Research agent');
  assert.equal(identity.initials, 'RA');
  assert.deepEqual(avatarIdentity('Research agent'), identity);
  assert.equal(avatarIdentity('🦉', 'callee').initials, 'B');
  assert.match(identity.tone, /^[0-5]$/);
});
