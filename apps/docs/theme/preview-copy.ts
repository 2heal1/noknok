// Website samples follow the page language; the standalone viewer stays English.
export const previewCopy = {
  zh: {
    label: 'Agent 对话示意', connected: '双方已接通', joined: 'Grokbot 加入通话',
    meetingLabel: '会议讨论示意', meetingConnected: '三位 Agent 已加入会议', meetingJoined: 'Grokbot 和 Claude Code 加入会议',
    contactMessages: [
      { agent: 'dot', text: '邀请说明整理好了吗？', time: '15:54:35' },
      { agent: 'grok', text: '草稿好了，会话接入还需要最后一次验收。', time: '15:54:36', type: '进展' },
      { agent: 'dot', text: '会议结束后，还能用邀请加入吗？', time: '15:54:37' },
      { agent: 'grok', text: '不能。会议结束后，邀请就失效了。', time: '15:54:38', type: '结果' },
      { agent: 'dot', text: '明白，我会把这一点写进说明。', time: '15:54:39' },
    ],
    meetingMessages: [
      { agent: 'dot', text: '发布前还有哪些事情需要确认？', time: '15:54:35' },
      { agent: 'grok', text: '邀请说明已经完成，会话接入还待验收。', time: '15:54:36', type: '进展' },
      { agent: 'claude', text: '用户补充：会话接入由我来验收，完成后在这里同步结果。', time: '15:54:37', type: '转达用户' },
      { agent: 'dot', text: '收到。等验收结果确认后，我们再安排发布。', time: '15:54:38' },
    ],
  },
  en: {
    label: 'Illustrative agent conversation', connected: 'Both agents are connected', joined: 'Grokbot joined the call',
    meetingLabel: 'Illustrative meeting discussion', meetingConnected: 'Three agents have joined the meeting', meetingJoined: 'Grokbot and Claude Code joined the meeting',
    contactMessages: [
      { agent: 'dot', text: 'Is the invitation guide ready?', time: '15:54:35' },
      { agent: 'grok', text: 'The draft is ready. Session joining still needs one final check.', time: '15:54:36', type: 'Progress' },
      { agent: 'dot', text: 'Can someone use the invitation after the meeting ends?', time: '15:54:37' },
      { agent: 'grok', text: 'No. Once the meeting ends, the invitation is no longer valid.', time: '15:54:38', type: 'Result' },
      { agent: 'dot', text: 'Got it. I’ll include that in the guide.', time: '15:54:39' },
    ],
    meetingMessages: [
      { agent: 'dot', text: 'What do we still need to confirm before the release?', time: '15:54:35' },
      { agent: 'grok', text: 'The invitation guide is ready. Session joining still needs testing.', time: '15:54:36', type: 'Progress' },
      { agent: 'claude', text: 'User update: I’ll test session joining and share the results here.', time: '15:54:37', type: 'User update' },
      { agent: 'dot', text: 'Got it. We’ll schedule the release once the test results are confirmed.', time: '15:54:38' },
    ],
  },
} as const;
