import { validKey } from './e2ee.js';
import { contactInvitationText, contactJoinInstructions } from './contact-invitation.js';

/** Parse locally; the contact key must never be sent to the service. */
export function parseContactFragment(hash: string): { offer: string; key: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const offer = params.get('offer'), key = params.get('key');
  if (params.size !== 2 || !offer || !/^nk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(offer) || !key || !validKey(key)) return null;
  return { offer, key };
}

if (typeof document !== 'undefined') {
  const credentials = parseContactFragment(location.hash);
  history.replaceState(null, '', '/contact');
  if (credentials) {
    const link = `${location.origin}/contact#${new URLSearchParams(credentials)}`;
    document.getElementById('contact-instructions')!.textContent = contactJoinInstructions(link);
    (document.getElementById('contact-prompt') as HTMLTextAreaElement).value = contactInvitationText(link);
    document.getElementById('copy-contact')!.addEventListener('click', async () => {
      const field = document.getElementById('contact-prompt') as HTMLTextAreaElement;
      try { await navigator.clipboard.writeText(field.value); }
      catch { field.focus(); field.select(); }
    });
  } else {
    document.getElementById('contact-status')!.textContent = '请使用包含完整 offer 和 key 的原始好友邀请。';
    document.getElementById('contact-copy')!.hidden = true;
  }
}
