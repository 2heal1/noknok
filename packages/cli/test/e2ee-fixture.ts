import { randomUUID } from 'node:crypto';
import { generateKey, encryptText, decryptText, contentAAD, isEncryptedText } from '../web/e2ee.js';

/** Legacy protocol tests still speak clear text locally; only authenticated
 * ciphertext crosses the in-process or HTTP relay boundary. */
export function encryptedMeetingFixture() {
  const key = generateKey(), defaultId = randomUUID();
  const creations = new Map(), rooms = new Map(), participants = new Map(), wires = new Map();
  async function encrypted(text, id, type, from, field, to?, replyTo?) {
    if (typeof text !== 'string' || isEncryptedText(text) || Buffer.byteLength(text) > 65536) return text;
    const aad = contentAAD(id, type, from, field, to, replyTo);
    const cacheKey = JSON.stringify([aad, text]);
    if (!wires.has(cacheKey)) wires.set(cacheKey, await encryptText(key, text, aad));
    return wires.get(cacheKey);
  }
  async function encode(path, body, token?) {
    if (!body) return body;
    const result = { ...body };
    if (path === '/v1/meetings') {
      const creation = body.requestId || JSON.stringify([body.name, body.purpose, body.context]);
      if (!creations.has(creation)) creations.set(creation, randomUUID());
      const id = creations.get(creation);
      result.encryption ??= { v: 1, id };
      result.purpose = await encrypted(body.purpose, id, 'started', 'system', 'purpose');
      result.context = await encrypted(body.context ?? '', id, 'started', 'system', 'context');
    } else if (/\/(messages|end)$/.test(path)) {
      const id = rooms.get(path.split('/')[3]) || defaultId;
      const type = path.endsWith('/end') ? 'closed' : body.type || 'message';
      if (path.endsWith('/end')) result.reason ??= 'host_ended';
      for (const field of ['text', 'reason']) if (result[field] !== undefined) result[field] = await encrypted(result[field], id, type, participants.get(token) || 'unknown', field, body.to, body.replyTo);
    }
    return result;
  }
  async function decode(payload) {
    if (!payload?.meeting?.encryption) return payload;
    const result = structuredClone(payload), id = result.meeting.encryption.id;
    rooms.set(result.meeting.id, id);
    if (result.participant) participants.set(result.participant.token, result.participant.id);
    async function field(value, type, from, name, to?, replyTo?) {
      return isEncryptedText(value) ? decryptText(key, value, contentAAD(id, type, from, name, to, replyTo)) : value;
    }
    for (const name of ['purpose', 'context']) if (result.meeting[name] !== undefined) result.meeting[name] = await field(result.meeting[name], 'started', 'system', name);
    for (const [name, wireName] of [['summary', 'text'], ['reason', 'reason']]) if (result.meeting[name] !== undefined) result.meeting[name] = await field(result.meeting[name], 'closed', result.meeting.hostId, wireName);
    for (const event of [...(result.events || []), ...(result.event ? [result.event] : [])]) for (const name of ['purpose', 'context', 'text', 'reason']) if (event.data?.[name] !== undefined) event.data[name] = await field(event.data[name], event.type, event.from, name, event.data.to, event.data.replyTo);
    return result;
  }
  return { encode, decode };
}
