import type { LocalSession } from './runtime-types.js';
import { mkdir, readFile, writeFile, rename, appendFile, open, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { decodeInvitation, fail } from './client.js';

export class Store {
  directory: string;
  constructor(directory = process.env.NOKNOK_HOME || join(homedir(), '.noknok')) {
    this.directory = directory;
  }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  path(id, suffix = '.json') {
    if (!/^ac_[a-f0-9-]{36}$/.test(id)) throw fail('INVALID_SESSION', 'Use the local session handle returned by invite/accept (ac_...), not the shared callId.');
    return join(this.directory, `${id}${suffix}`);
  }
  async create(server, call, participant, id = `ac_${randomUUID()}`) {
    await this.init();
    const session = {
      v: 1, id, server, callId: call.id, role: participant.role,
      token: participant.token, cursor: 0, createdAt: new Date().toISOString(), purpose: call.purpose,
    };
    await this.save(session);
    await this.record(session.id, { direction: 'session', call });
    return session;
  }
  async load(id): Promise<LocalSession> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw fail('SESSION_NOT_FOUND', 'Local session not found. Use the session returned by invite/accept and the same --state-dir.');
      throw error;
    }
  }
  async save(session) {
    const destination = this.path(session.id);
    const tmp = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(tmp, destination);
    } finally { await unlink(tmp).catch(() => {}); }
  }
  async record(id, entry) {
    await appendFile(this.path(id, '.ndjson'), `${JSON.stringify({ recordedAt: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  }
  async history(id) {
    await this.load(id);
    try {
      return (await readFile(this.path(id, '.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async list() {
    await this.init();
    const entries: Array<{ session: string; callId: string; server: string; role: string; purpose: string; createdAt: string }> = [];
    for (const filename of await readdir(this.directory)) {
      if (!/^ac_[a-f0-9-]{36}\.json$/.test(filename)) continue;
      const session = await this.load(filename.slice(0, -5));
      entries.push({ session: session.id, callId: session.callId, server: session.server, role: session.role, purpose: session.purpose, createdAt: session.createdAt });
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async lock(id) {
    return this.lockPath(this.path(id, '.lock'));
  }
  async acceptance(invitation, name, explicitId, { reuseName = false } = {}) {
    await this.init();
    const decoded = decodeInvitation(invitation);
    // Link and encoded invitation forms redeem the same single-use capability.
    // The expiry is intentionally not part of its durable local identity.
    const identity = JSON.stringify([decoded.server, decoded.callId, decoded.token]);
    const hash = createHash('sha256').update(identity).digest('hex');
    const path = join(this.directory, `.accept-${hash}.json`);
    const release = await this.lockPath(`${path}.lock`);
    try {
      let entry;
      try { entry = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entry && ((!reuseName && entry.name !== name) || (explicitId !== undefined && entry.requestId !== explicitId))) {
        throw fail('ACCEPT_IN_PROGRESS', 'An interrupted acceptance exists with a different name/request ID. Retry the original command using the same local state directory.');
      }
      entry ||= { name, requestId: explicitId || randomUUID(), session: `ac_${randomUUID()}` };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      return { ...entry, release: async () => { await release(); } };
    } catch (error) { await release(); throw error; }
  }
  async lockPath(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await open(path, 'wx', 0o600);
        await file.writeFile(JSON.stringify({ pid: process.pid }));
        await file.close();
        return async () => { await unlink(path).catch(() => {}); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let pid;
        try { pid = JSON.parse(await readFile(path, 'utf8')).pid; } catch {}
        if (!Number.isInteger(pid) || pid < 1) throw fail('SESSION_BUSY', 'Another receiver is initializing for this session. Try again shortly.');
        try { process.kill(pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') { await unlink(path).catch(() => {}); continue; }
        }
        throw fail('SESSION_BUSY', 'This session already has a receiver. Continue that process instead of starting another receive/wait.');
      }
    }
    throw fail('SESSION_BUSY', 'Could not acquire the session receiver lock.');
  }
}
