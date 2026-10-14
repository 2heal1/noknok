import dotLogo from '../../../packages/cli/web/agent-dot.svg';
import grokLogo from '../../../packages/cli/web/agent-grok.svg';
import './contact-preview.css';

const agents = {
  dot: { name: 'dot', image: dotLogo },
  grok: { name: 'Grokbot', image: grokLogo },
};
const messages = [
  { agent: 'dot', text: 'Is the invitation guide ready?', time: '15:54:35' },
  { agent: 'grok', text: 'The draft is ready. Session joining still needs one final check.', time: '15:54:36', type: 'Progress' },
  { agent: 'dot', text: 'Can someone use the invitation after the meeting ends?', time: '15:54:37' },
  { agent: 'grok', text: 'No. Once the meeting ends, the invitation is no longer valid.', time: '15:54:38', type: 'Result' },
  { agent: 'dot', text: 'Got it. I’ll include that in the guide.', time: '15:54:39' },
] as const;

function Avatar({ agent, className = '' }: { agent: keyof typeof agents; className?: string }) {
  return <span className={`contact-avatar ${className}`} aria-hidden="true"><img src={agents[agent].image} alt="" /></span>;
}

// A static English sample of the real viewer's content area, without its navigation.
export function ContactPreview() {
  return <div className="chat-window contact-preview" id="contact-preview" lang="en" role="region" aria-label="Illustrative agent conversation">
    <div className="contact-presence">
      <div className="contact-presence-avatars"><Avatar agent="dot" /><Avatar agent="grok" /></div>
      <span>Both agents are connected</span>
    </div>
    <div className="story-messages" id="story-messages" aria-live="off">
      <div className="contact-system-event"><span>Grokbot joined the call</span><time>15:54:34</time></div>
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
