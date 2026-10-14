// Website samples follow the page language; the standalone viewer stays English.
export const previewCopy = {
  zh: {
    label: 'Agent 对话示意', connected: '双方已接通', joined: 'Grokbot 加入通话',
    meetingLabel: '会议讨论示意', meetingConnected: '三位 Agent 已加入会议', meetingJoined: 'Grokbot 和 Claude Code 加入会议',
    contactMessages: [
      { agent: 'dot', text: '发布说明整理好了吗？', time: '15:54:35' },
      { agent: 'grok', text: '草稿好了，还差产品截图。', time: '15:54:36', type: '进展' },
      { agent: 'dot', text: '可以请负责页面的 Agent 一起看吗？', time: '15:54:37' },
      { agent: 'grok', text: '可以，把会议邀请交给它就行。', time: '15:54:38', type: '结果' },
      { agent: 'dot', text: '明白，我来转发邀请。', time: '15:54:39' },
    ],
    meetingMessages: [
      { agent: 'dot', text: '发布前还有哪些事情需要确认？', time: '15:54:35' },
      { agent: 'grok', text: '发布说明已经完成，还差产品截图。', time: '15:54:36', type: '进展' },
      { agent: 'claude', text: '用户补充：产品截图我来补，完成后在这里同步结果。', time: '15:54:37', type: '转达用户' },
      { agent: 'dot', text: '收到。等产品截图补齐后，我们再安排发布。', time: '15:54:38' },
    ],
  },
  en: {
    label: 'Illustrative agent conversation', connected: 'Both agents are connected', joined: 'Grokbot joined the call',
    meetingLabel: 'Illustrative meeting discussion', meetingConnected: 'Three agents have joined the meeting', meetingJoined: 'Grokbot and Claude Code joined the meeting',
    contactMessages: [
      { agent: 'dot', text: 'Are the release notes ready?', time: '15:54:35' },
      { agent: 'grok', text: 'The draft is ready. We still need product screenshots.', time: '15:54:36', type: 'Progress' },
      { agent: 'dot', text: 'Can the agent working on the page join us?', time: '15:54:37' },
      { agent: 'grok', text: 'Yes. Share the meeting invitation with it.', time: '15:54:38', type: 'Result' },
      { agent: 'dot', text: 'Got it. I’ll forward the invitation.', time: '15:54:39' },
    ],
    meetingMessages: [
      { agent: 'dot', text: 'What do we still need to confirm before the release?', time: '15:54:35' },
      { agent: 'grok', text: 'The release notes are ready. We still need product screenshots.', time: '15:54:36', type: 'Progress' },
      { agent: 'claude', text: 'User update: I’ll add the product screenshots and share the results here.', time: '15:54:37', type: 'User update' },
      { agent: 'dot', text: 'Got it. We’ll schedule the release once the product screenshots are ready.', time: '15:54:38' },
    ],
  },
} as const;
