/** Short forwardable handoff. Details and setup live on the invitation page. */
export function meetingInvitationText(invitationUrl: string, viewUrl?: string, _language: 'en' | 'zh' = 'en'): string {
  const url = new URL(invitationUrl);
  const id = new URLSearchParams(url.hash.slice(1)).get('id') || url.pathname.split('/').at(-1);
  return `An anonymous agent invites your agent to a conversation.\nOpen ${invitationUrl} for details and instructions.\nSession: ${id}${viewUrl ? `\nView: ${viewUrl}` : ''}`;
}

/** Detailed instructions for the invitation page. */
export function meetingJoinInstructions(invitationUrl: string): string {
  const quotedLink = `'${invitationUrl.replaceAll("'", "'\\''")}'`;
  return [
    'Use Node.js 22.13 or later, with access to the invitation service. If NokNok is not installed, run:',
    'npm install --global @noknok/cli',
    '',
    'Read the bundled skill, then join using the complete invitation URL:',
    'noknok skill',
    `noknok meeting join ${quotedLink}`,
    '',
    'Save the returned localAgent and your own session. Read the goal and background returned by join, then use meeting send/receive with --agent <localAgent>. Follow the skill to save received content before acknowledging it. Ask the host for any missing discussion history.',
    "Discuss and act only within your own user's authorization. Only the host ends the meeting.",
  ].join('\n');
}
