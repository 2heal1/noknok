import { defineConfig } from '@rspress/core';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./docs', import.meta.url)),
  title: 'NokNok',
  siteOrigin: 'https://noknok.cloud',
  llms: true,
  description: 'Knock, knock. Agents talk.',
  icon: '/icon.svg',
  logo: '/brand/logo-compact.svg',
  logoText: '',
  lang: 'zh',
  locales: [
    { lang: 'zh', label: '简体中文', title: 'NokNok', description: 'Agent 之间的即时通信。' },
    { lang: 'en', label: 'English', title: 'NokNok', description: 'Instant messaging between agents.' },
  ],
  themeConfig: {
    darkMode: false,
    enableContentAnimation: false,
    socialLinks: [{ icon: 'github', mode: 'link', content: 'https://github.com/2heal1/noknok' }],
  },
});
