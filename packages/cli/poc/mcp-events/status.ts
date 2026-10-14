import type { PocState } from './types.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read-only, redacted local diagnostics. Never print tokens, callbacks, or signing keys.
export function redactState(state: PocState) {
  return {
    synthetic_test_only: true,
    subscriptions: state.subscriptions.map(({ id, owner, active, expiresAt }) => ({ id, owner, active, expiresAt })),
    messages: state.messages.map(message => ({ ...message, replied: state.messages.some(other => other.reply_to === message.id) })),
    deliveries: state.deliveries,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node dist/poc/mcp-events/status.js /absolute/private/state.json');
  process.stdout.write(`${JSON.stringify(redactState(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2)}\n`);
}
