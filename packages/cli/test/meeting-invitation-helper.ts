import assert from 'node:assert/strict';
import { decodeMeetingLink } from '../src/meeting-client.js';

export function invitationJoinLink(result: { invitationText: string; invitationUrl?: string; meeting?: { id: string }; meetingId?: string }) {
  const text = result.invitationText;
  assert.match(text, /Node\.js 22\.13/);
  assert.match(text, /^npm install --global @noknok\/cli$/m);
  assert.match(text, /^noknok skill$/m);
  assert.doesNotMatch(text, /People:|open it in a browser|以人的身份加入/);
  const command = text.match(/^noknok meeting join '(https?:\/\/[^'\n]+)'$/m);
  assert.ok(command, 'The forwarded block must contain a complete, quoted join command.');
  assert.ok(text.indexOf('npm install --global') < text.indexOf('noknok skill'));
  assert.ok(text.indexOf('noknok skill') < text.indexOf(command[0]));
  const link = command[1];
  if (result.invitationUrl) assert.equal(link, result.invitationUrl);
  const decoded = decodeMeetingLink(link);
  if (result.meetingId || result.meeting?.id) assert.equal(decoded.id, result.meetingId || result.meeting?.id);
  return link;
}
