#!/usr/bin/env node
import { createServer } from 'node:http';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../website/', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.woff2': 'font/woff2',
};

function reply(res, status, message, head = false, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    ...headers,
  });
  res.end(head ? undefined : message);
}

// Serve this directory only. Neither dotfiles nor symlink targets are public.
async function findFile(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return null;

  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    if ((await lstat(candidate)).isSymbolicLink()) return null;
  }
  if ((await lstat(candidate)).isDirectory()) {
    candidate = path.join(candidate, 'index.html');
  }
  if ((await lstat(candidate)).isSymbolicLink()) return null;
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    return null;
  }
  return { handle, stat, filename: resolved };
}

export async function createWebsiteServer({ rootDir = defaultRoot } = {}) {
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('The website directory must be a regular directory.');
  }
  const root = await realpath(rootDir);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      reply(res, 405, 'Method not allowed\n', false, { Allow: 'GET, HEAD' });
      return;
    }

    let file;
    try {
      // Parse the raw request path without URL normalization swallowing "..".
      const pathname = (req.url ?? '/').split('?')[0];
      if (!pathname.startsWith('/')) {
        reply(res, 400, 'Bad request\n', head);
        return;
      }
      file = await findFile(root, pathname);
    } catch (error) {
      const status = error instanceof URIError ? 400
        : ['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code) ? 404 : 500;
      reply(res, status, status === 400 ? 'Bad request\n' : status === 404 ? 'Not found\n' : 'Server error\n', head);
      return;
    }
    if (!file) {
      reply(res, 404, 'Not found\n', head);
      return;
    }

    const { handle, stat, filename } = file;
    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filename).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
    });
    if (head) {
      await handle.close();
      res.end();
      return;
    }
    const stream = handle.createReadStream();
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

function parsePort(args) {
  if (args.length === 0) return 4173;
  const value = args.length === 2 && args[0] === '--port' ? args[1]
    : args.length === 1 && args[0].startsWith('--port=') ? args[0].slice(7) : '';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('Usage: npm run website -- [--port 4173]');
  }
  return Number(value);
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const server = await createWebsiteServer();
  server.on('error', (error) => {
    console.error(`Website preview failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Noknok website preview: http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close());
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Website preview failed: ${error.message}`);
    process.exitCode = 1;
  });
}
