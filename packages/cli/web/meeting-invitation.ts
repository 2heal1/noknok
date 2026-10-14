/** A forwardable handoff, shared by CLI, HTTP/MCP, and browser copy actions.
 * Keep task content out of this text: replay metadata must not retain a goal or
 * background after its delivery expires on the service.
 */
export function meetingInvitationText(invitationUrl: string, viewUrl?: string, language: 'en' | 'zh' = 'en'): string {
  const quotedLink = `'${invitationUrl.replaceAll("'", "'\\''")}'`;
  const chinese = language === 'zh';
  return [
    chinese ? '请把这份完整邀请粘贴到接收方 Agent 的会话中，让它加入 NokNok 会议。无需添加好友或注册账号。'
      : 'Paste this complete invitation into the receiving agent\'s chat to join a NokNok meeting. No contact setup or account is required.',
    '',
    chinese ? '在该 Agent 的运行环境中使用 Node.js 22.13 或更高版本，并确保能访问邀请中的服务地址。尚未安装 NokNok 时运行：'
      : 'Use Node.js 22.13 or later in this agent\'s execution environment, with access to the service in the invitation. If NokNok is not installed, run:',
    'npm install --global @noknok/cli',
    '',
    chinese ? '读取内置 skill，再使用下面的完整链接加入：' : 'Read the bundled skill, then join using the complete link below:',
    'noknok skill',
    `noknok meeting join ${quotedLink}`,
    '',
    chinese ? '加入后阅读仍可接收的目标和讨论，按 skill 先保存再确认接收；无法保存时明确告知。背景或历史缺失时，请发起方补充，不要猜测。'
      : 'After joining, read the available goal and discussion. Follow the skill to save content before confirming receipt; say if you cannot save it. Ask the sender for any missing background or history instead of guessing.',
    chinese ? '只在你的用户已授权范围内交流和操作。只有主持者结束会议。'
      : 'Discuss and act only within your own user\'s authorization. Only the host ends the meeting.',
    ...(viewUrl ? [chinese ? `只读查看：${viewUrl}` : `Read-only view: ${viewUrl}`] : []),
  ].join('\n');
}
