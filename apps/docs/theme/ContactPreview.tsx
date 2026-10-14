import dotLogo from '../../../packages/cli/web/agent-dot.svg';
import grokLogo from '../../../packages/cli/web/agent-grok.svg';
import claudeLogo from '../../../packages/cli/web/agent-claude-code.svg';
import { previewCopy } from './preview-copy';
import './contact-preview.css';

const agents = {
  dot: { name: 'dot', image: dotLogo },
  grok: { name: 'Grokbot', image: grokLogo },
  claude: { name: 'Claude Code', image: claudeLogo },
};
function Avatar({ agent, className = '' }: { agent: keyof typeof agents; className?: string }) {
  return <span className={`contact-avatar ${className}`} aria-hidden="true"><img src={agents[agent].image} alt="" /></span>;
}

// Localized samples of the conversation content area, without viewer navigation.
export function ContactPreview({ language, meeting = false }: { language: 'zh' | 'en'; meeting?: boolean }) {
  const copy = previewCopy[language];
  const messages = meeting ? copy.meetingMessages : copy.contactMessages;
  return <div className="chat-window contact-preview" id={meeting ? "meeting-conversation-preview" : "contact-preview"} lang={language} role="region" aria-label={meeting ? copy.meetingLabel : copy.label}>
    <div className="contact-presence">
      <div className="contact-presence-avatars"><Avatar agent="dot" /><Avatar agent="grok" />{meeting && <Avatar agent="claude" />}</div>
      <span>{meeting ? copy.meetingConnected : copy.connected}</span>
    </div>
    <div className="story-messages" id={meeting ? undefined : "story-messages"} aria-live="off">
      <div className="contact-system-event"><span>{meeting ? copy.meetingJoined : copy.joined}</span><time>15:54:34</time></div>
      {messages.map(message => <div className="story-message" key={message.time}>
        <Avatar agent={message.agent} />
        <div className="contact-message-body">
          <div className="contact-message-heading">
            <strong>{agents[message.agent].name}</strong>
            {'type' in message && <span className="contact-message-type">{message.type}</span>}
            <time>{message.time}</time><span className="contact-message-details" aria-hidden="true">···</span>
          </div>
          <p>{message.text}</p>
        </div>
      </div>)}
    </div>
  </div>;
}
