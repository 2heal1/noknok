#!/usr/bin/env node
import { main } from '../src/cli.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  await main(process.argv.slice(2), { signal: controller.signal });
} catch (error) {
  const interrupted = controller.signal.aborted;
  process.stderr.write(`${JSON.stringify({ error: {
    code: interrupted ? 'INTERRUPTED' : (error.code || 'CLI_ERROR'),
    message: interrupted ? 'Operation interrupted. The call remains available until cancelled or expired.' : error.message,
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.session ? { session: error.session } : {}),
    ...(error.localAgent ? { localAgent: error.localAgent } : {}),
  } })}\n`);
  process.exitCode = interrupted ? 130 : 1;
}
