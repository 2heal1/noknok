import { homeMessages } from './home-copy.js';
import { guideMessages } from './guide-copy.js';
import { languageStorageKey, readLanguage, saveLanguage } from './language.js';

const sharedMessages = {
  zh: {
    'shared.skip': '跳到正文',
    'shared.home': 'NokNok 首页',
    'shared.nav': '主导航',
    'shared.demo': '演示',
    'shared.guide': '使用指南',
    'shared.copyPrompt': '复制提示词',
    'shared.copySuccess': '提示词已复制，可以粘贴到你的 Agent 会话。',
    'shared.copyFallback': '浏览器未允许自动复制。已选中文本，请使用系统复制操作。',
  },
  en: {
    'shared.skip': 'Skip to content',
    'shared.home': 'NokNok home',
    'shared.nav': 'Main navigation',
    'shared.demo': 'Demo',
    'shared.guide': 'Guide',
    'shared.copyPrompt': 'Copy prompt',
    'shared.copySuccess': 'Prompt copied. Paste it into your agent chat.',
    'shared.copyFallback': 'Automatic copying is unavailable. The text is selected; use your system’s copy command.',
  },
};
const messages = {
  zh: { ...sharedMessages.zh, ...homeMessages.zh, ...guideMessages.zh },
  en: { ...sharedMessages.en, ...homeMessages.en, ...guideMessages.en },
};
let storage;
try { storage = window.localStorage; } catch { /* Storage may be disabled. */ }
let language = readLanguage(storage, navigator);
let manualChoice = false;

export function t(key) {
  return messages[language][key] ?? messages.zh[key] ?? key;
}

function applyLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = t(node.dataset.i18n);
  });
  // Only local, reviewed catalog strings are used as HTML; never user input.
  document.querySelectorAll('[data-i18n-html]').forEach(node => {
    node.innerHTML = t(node.dataset.i18nHtml);
  });
  for (const attribute of ['aria-label', 'content']) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(node => {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    });
  }
  document.querySelectorAll('[data-language-switch]').forEach(button => {
    const chinese = language === 'zh';
    button.textContent = chinese ? 'EN' : '中文';
    button.lang = chinese ? 'en' : 'zh-CN';
    button.title = chinese ? 'Switch to English' : '切换为中文';
    button.setAttribute('aria-label', button.title);
    button.hidden = false;
  });
  window.dispatchEvent(new CustomEvent('noknok:languagechange', { detail: { language } }));
}

applyLanguage();
document.querySelectorAll('[data-language-switch]').forEach(button => {
  button.addEventListener('click', () => {
    language = language === 'zh' ? 'en' : 'zh';
    manualChoice = true;
    saveLanguage(storage, language);
    applyLanguage();
  });
});
window.addEventListener('languagechange', () => {
  if (!manualChoice) {
    language = readLanguage(storage, navigator);
    applyLanguage();
  }
});
window.addEventListener('storage', event => {
  if (event.key === languageStorageKey || event.key === null) {
    manualChoice = false;
    language = readLanguage(storage, navigator);
    applyLanguage();
  }
});
