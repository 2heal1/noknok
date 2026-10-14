import { contentAAD, decryptText, encryptText, validKey } from './e2ee.js';
import { fail } from './client.js';

export interface MeetingKey { key: string; encryptionId: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function requireMeetingKey(value: MeetingKey) {
  if (!value || !validKey(value.key) || !UUID.test(value.encryptionId)) {
    throw fail('E2EE_KEY_REQUIRED', 'This meeting requires its original encryption key. Use a complete encrypted invitation or restore your trusted local profile.');
  }
  return value;
}

export function withMeetingKey(link: string, key: string, encryptionId: string) {
  requireMeetingKey({ key, encryptionId });
  const url = new URL(link), params = new URLSearchParams(url.hash.slice(1));
  params.set('key', key); params.set('e2ee', encryptionId);
  url.hash = params.toString();
  return url.href;
}

export function checkMeetingEncryption(meeting, credentials: MeetingKey) {
  requireMeetingKey(credentials);
  if (meeting?.encryption?.v !== 1 || meeting.encryption.id !== credentials.encryptionId) {
    throw fail('E2EE_DOWNGRADE', 'The relay returned a missing or different meeting encryption context. No content was accepted.');
  }
}

export async function decryptMeetingResult(result, credentials: MeetingKey) {
  checkMeetingEncryption(result.meeting, credentials);
  const { key, encryptionId } = credentials;
  const decrypt = (value, type, from, field, data = {}) => decryptText(key, value,
    contentAAD(encryptionId, type, from, field, data['to'], data['replyTo']));
  const meeting = { ...result.meeting };
  for (const field of ['purpose', 'context']) if (meeting[field] !== undefined) meeting[field] = await decrypt(meeting[field], 'started', 'system', field);
  if (meeting.summary !== undefined) meeting.summary = await decrypt(meeting.summary, 'closed', meeting.hostId, 'text');
  if (meeting.reason !== undefined && !(meeting.state === 'expired' && meeting.reason === 'meeting_timeout')) {
    meeting.reason = await decrypt(meeting.reason, 'closed', meeting.hostId, 'reason');
  }
  const event = async item => {
    if (!item.data) return item;
    const data = { ...item.data };
    for (const field of ['purpose', 'context', 'text', 'reason']) {
      if (data[field] === undefined) continue;
      if (item.type === 'closed' && item.from === 'system' && field === 'reason'
        && data.state === 'expired' && data.reason === 'meeting_timeout') continue;
      data[field] = await decrypt(data[field], item.type, item.from, field, data);
    }
    // Content-bearing operations can never be replaced with empty plaintext bodies.
    if (['message', 'request', 'result', 'progress', 'waiting_for_user'].includes(item.type) && typeof data.text !== 'string') {
      throw fail('E2EE_INVALID_CONTENT', 'An encrypted message body is missing.');
    }
    if (item.type === 'started' && (typeof data.purpose !== 'string' || typeof data.context !== 'string')) {
      throw fail('E2EE_INVALID_CONTENT', 'The encrypted meeting goal or context is missing.');
    }
    if (item.type === 'closed' && item.from !== 'system' && typeof data.reason !== 'string') {
      throw fail('E2EE_INVALID_CONTENT', 'The encrypted closing reason is missing.');
    }
    return { ...item, data };
  };
  return { ...result, meeting,
    ...(result.events ? { events: await Promise.all(result.events.map(event)) } : {}),
    ...(result.event ? { event: await event(result.event) } : {}) };
}

export async function prepareMeetingCreation(pending, purpose: string, context = '') {
  if (typeof purpose !== 'string' || !purpose.trim() || Buffer.byteLength(purpose) > 8192
    || typeof context !== 'string' || Buffer.byteLength(context) > 65536) throw fail('INVALID_ARGUMENT', 'Meeting purpose is limited to 8192 bytes and context to 65536 bytes.');
  return pending.prepare({ purpose, context }, async input => ({
    encryption: pending.encryption,
    purpose: await encryptText(pending.encryptionKey, input.purpose, contentAAD(pending.encryption.id, 'started', 'system', 'purpose')),
    context: await encryptText(pending.encryptionKey, input.context, contentAAD(pending.encryption.id, 'started', 'system', 'context')),
  }));
}
