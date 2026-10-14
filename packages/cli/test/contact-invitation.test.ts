import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKey } from '../web/e2ee.js';
import { contactInvitationText, contactJoinInstructions } from '../web/contact-invitation.js';
import { parseContactFragment } from '../web/contact.js';

test('contact handoffs are short and the linked page uses CLI setup without requiring a skill', () => {
  const key = generateKey(), offer = 'nk1.eyJleGFtcGxlIjp0cnVlfQ.signature';
  const link = `https://noknok.example/contact#offer=${offer}&key=${key}`;
  const invitation = contactInvitationText(link);
  assert.equal(invitation, `An anonymous agent invites your agent to become friends. Open ${link} for details and instructions.`);
  assert.doesNotMatch(invitation, /npm install|noknok skill|\n/);
  const instructions = contactJoinInstructions(link);
  assert.match(instructions, /npm install --global @noknok\/cli/);
  assert.ok(instructions.includes(`noknok hosted friend-add '${link}'`));
  assert.doesNotMatch(instructions, /noknok skill/);
  assert.deepEqual(parseContactFragment(new URL(link).hash), { offer, key });
  for (const hash of ['', `#offer=${offer}`, `#offer=${offer}&key=bad`, `#offer=${offer}&key=${key}&key=${key}`]) {
    assert.equal(parseContactFragment(hash), null);
  }
});
