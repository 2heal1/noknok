// Icons are bundled locally: participant names never become image URLs.
export const avatarAssetNames = [
  'dot', 'claude-code', 'claude', 'openai', 'grok', 'gemini',
  'deepseek', 'qwen', 'llama', 'mistral', 'cursor', 'copilot',
] as const;

const brands: Array<{ pattern: RegExp; icon: typeof avatarAssetNames[number] }> = [
  { pattern: /\bclaude[\s_-]*code\b/i, icon: 'claude-code' },
  { pattern: /\b(?:claude|anthropic|sonnet|opus|haiku)\b/i, icon: 'claude' },
  { pattern: /\b(?:openai|chatgpt|codex|gpt(?:[\s_-]*\d[\w.-]*)?|o[1-9](?:[\s_-]*mini)?)\b/i, icon: 'openai' },
  { pattern: /\b(?:grok(?:bot)?|xai)\b/i, icon: 'grok' },
  { pattern: /\bgemini(?:[\s_-]*\d[\w.-]*)?\b/i, icon: 'gemini' },
  { pattern: /\bdeepseek\b/i, icon: 'deepseek' },
  { pattern: /\bqwen(?:[\s_-]*\d[\w.-]*)?\b/i, icon: 'qwen' },
  { pattern: /\b(?:llama(?:[\s_-]*\d[\w.-]*)?|meta[\s_-]*ai)\b/i, icon: 'llama' },
  { pattern: /\b(?:mistral|mixtral|codestral)\b/i, icon: 'mistral' },
  { pattern: /\bcursor\b/i, icon: 'cursor' },
  { pattern: /\b(?:github[\s_-]*)?copilot\b/i, icon: 'copilot' },
  { pattern: /^dot$/i, icon: 'dot' },
];

export function avatarIdentity(name: string, role = 'caller') {
  const normalized = name.normalize('NFKC').trim();
  const icon = brands.find(brand => brand.pattern.test(normalized))?.icon;
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const initials = words.length > 1
    ? [Array.from(words[0]!)[0], Array.from(words[words.length - 1]!)[0]].join('')
    : Array.from(words[0] || (role === 'callee' ? 'B' : 'A')).slice(0, 2).join('');
  let hash = 0;
  for (const char of normalized) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
  return { icon: icon ? `/agent-${icon}.svg` : null, initials: initials.toUpperCase(), tone: String((hash >>> 0) % 6) };
}
