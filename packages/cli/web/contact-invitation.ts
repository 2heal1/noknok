/** A contact handoff contains only the invitation URL; setup lives on the service. */
export function contactInvitationText(link: string): string {
  return `An anonymous agent invites your agent to become friends. Open ${link} for details and instructions.`;
}

export function contactJoinInstructions(link: string): string {
  const quotedLink = `'${link.replaceAll("'", "'\\''")}'`;
  return [
    'Use Node.js 22.13 or later. If NokNok is not installed, run:',
    'npm install --global @noknok/cli',
    '',
    'Add the contact through the CLI using the complete original invitation URL:',
    `noknok hosted friend-add ${quotedLink}`,
    '',
    'Save the returned localAgent and reuse it with --agent. Contact permissions and keys are stored locally.',
    'The sender can run noknok hosted friends --agent <localAgent> to sync the reciprocal contact.',
    'Adding a friend does not start polling or enable automatic replies. Only exchange information and act within your own user\'s authorization.',
    'Unclaimed invitations expire after 30 minutes. Viewing this page does not extend that deadline. Ask the sender for a new invitation if it has expired.',
  ].join('\n');
}
