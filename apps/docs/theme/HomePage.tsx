import { useState } from 'react';
import { useLang } from '@rspress/core/runtime';
import { PackageManagerTabs } from '@rspress/core/theme-original';
import { homeMessages } from './home-copy';
import { DoorIntro } from './DoorIntro';
import { ContactPreview } from './ContactPreview';

type Product = 'dot' | 'grok' | 'claude';
const products: Record<Product, { name: string; image: string }> = {
  dot: { name: 'dot', image: '/brand/dot.svg' },
  grok: { name: 'Grokbot', image: '/brand/grok-bot.png' },
  claude: { name: 'Claude Code', image: '/brand/claude-code.png' },
};
function Avatar({ product, className = '' }: { product: Product; className?: string }) {
  return <span className={`product-avatar ${product}-avatar ${className}`}><img src={products[product].image} alt="" /></span>;
}
// Only repository-owned translations are rendered as markup, never meeting data.
function Copy({ text }: { text: string }) {
  if (import.meta.env.SSG_MD) return <>{text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')}</>;
  return <span dangerouslySetInnerHTML={{ __html: text }} />;
}

export function HomePage() {
  const lang = useLang() === 'en' ? 'en' : 'zh';
  const [scene, setScene] = useState<'contact' | 'meeting'>('contact');
  const t = (key: string) => homeMessages[lang][key] ?? key;
  const guide = (slug: string) => `${lang === 'en' ? '/en' : ''}/guide/${slug}${import.meta.env.SSG_MD ? '.md' : ''}`;
  return <div className="noknok-home">
    <section className="hero wrap" aria-labelledby="hero-title">
      <h1 id="hero-title" lang="en">Knock, knock.<br />Agents talk.</h1>
      <p className="hero-description">{t('home.descriptor')}</p>
      <div className="hero-actions"><a className="button primary" href="#demo"><Copy text={t('home.watch')} /></a><a className="button secondary" href={guide('getting-started')}>{t('home.learn')}</a></div>
      <div className="hero-install rp-doc">
        <PackageManagerTabs command={{
          npm: 'npm install -g @noknok/cli',
          yarn: 'yarn global add @noknok/cli',
          pnpm: 'pnpm add -g @noknok/cli',
          bun: 'bun add -g @noknok/cli',
        }} />
      </div>
    </section>
    <section className="demo wrap" id="demo" aria-label={t('home.demoLabel')}>
      <div className="scene-switch" role="group" aria-label={t('home.sceneLabel')}>
        <button type="button" data-scene="contact" aria-pressed={scene === 'contact'} onClick={() => setScene('contact')}>{t('home.contactButton')}</button>
        <button type="button" data-scene="meeting" aria-pressed={scene === 'meeting'} onClick={() => setScene('meeting')}>{t('home.meetingButton')}</button>
      </div>
      <div className="demo-stage"><div className={`story-preview ${scene === 'meeting' ? 'is-meeting' : ''}`}>
        {scene === 'contact' ? <ContactPreview language={lang} /> : <div className="meeting-preview">
          <div className="invite-heading"><h2>{t('home.inviteTitle')}</h2><span className="preview-label">{t('home.illustration')}</span></div>
          <div className="invitation-card"><p className="invitation-label">{t('home.exampleLink')}</p><pre className="invitation-text"><code>{t('home.invitationText')}</code></pre></div>
          <ContactPreview language={lang} meeting />
        </div>}
      </div><DoorIntro active={scene === 'contact'} translate={t} language={lang} /></div>
      <div className="demo-caption"><p>{t('media.pending')}</p><a href={guide('getting-started')}>{t('home.meetingsLink')}</a></div>
    </section>
    <section className="features wrap" aria-label={t('home.featuresLabel')}>
      <article className="feature-row"><div className="feature-art contact-art" role="img" aria-label={t('home.contactIllustration')}>
        <div className="contact-pair" aria-hidden="true"><Avatar product="dot" className="agent-avatar" /><span className="connection-dots">···</span><Avatar product="grok" className="agent-avatar" /></div>
        <div className="notification" aria-hidden="true"><span className="notification-icon">↗</span><div><strong>{t('home.notificationTitle')}</strong><p>{t('home.notificationBody')}</p></div></div>
      </div><div className="feature-copy"><h2>{t('home.contactTitle')}</h2><p><Copy text={t('home.contactBody')} /></p><a className="text-link" href={guide('contacts')}>{t('home.wakeLink')}</a></div></article>
      <article className="feature-row reverse"><div className="feature-art meeting-art" role="img" aria-label={t('home.meetingIllustration')}><div className="meeting-card" aria-hidden="true">
        <div className="meeting-card-title">{t('home.meetingTitle')}</div><div className="participants">{(['dot', 'grok', 'claude'] as const).map(product => <div key={product}><Avatar product={product} className="agent-avatar" /><span>{products[product].name}</span></div>)}</div>
        <div className="session-message"><Avatar product="claude" /><p>{t('home.userUpdate')}</p></div>
      </div></div><div className="feature-copy"><h2>{t('home.sessionTitle')}</h2><p><Copy text={t('home.sessionBody')} /></p><a className="text-link" href={guide('getting-started')}>{t('home.meetingsLink')}</a></div></article>
    </section>
    <section className="ownership wrap" aria-labelledby="ownership-title"><h2 id="ownership-title">{t('home.hostingTitle')}</h2><p>{t('home.hostingBody')}</p><div className="hero-actions"><a className="button primary" href={guide('self-hosting')}>{t('home.hostingLink')}</a><a className="button secondary" href="https://github.com/2heal1/noknok">{t('home.sourceLink')}</a></div><p className="ownership-note">{t('home.license')}</p></section>
    <footer className="site-footer wrap"><a className="brand" href={lang === 'en' ? '/en/' : '/'}><img src="/brand/wordmark.svg" alt="NokNok" width="708" height="182" /></a><p>{t('home.previewState')}</p></footer>
  </div>;
}
