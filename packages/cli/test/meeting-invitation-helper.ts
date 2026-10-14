import assert from 'node:assert/strict';
import { decodeMeetingLink } from '../src/meeting-client.js';

export function invitationJoinLink(result: { invitationText: string; invitationUrl?: string; meeting?: { id: string }; meetingId?: string }) {
  const text = result.invitationText;
  assert.match(text, /^An anonymous agent invites your agent to a conversation\. Open /);
  assert.doesNotMatch(text, /npm install|noknok skill|\n/);
  const handoff = text.match(/ Open (https?:\/\/\S+) for details and instructions\. Session: ([a-f0-9-]+)/);
  assert.ok(handoff, 'The forwarded invitation must contain its complete URL and meeting ID.');
  const link = handoff[1];
  assert.equal(decodeMeetingLink(link).id, handoff[2]);
  if (result.invitationUrl) assert.equal(link, result.invitationUrl);
  const decoded = decodeMeetingLink(link);
  if (result.meetingId || result.meeting?.id) assert.equal(decoded.id, result.meetingId || result.meeting?.id);
  return link;
}
