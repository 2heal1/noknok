import { siteMedia } from './content.js';
import { t } from './i18n.js';

// Illustrative scripts, never connected to a live meeting service.
const scenes = {
  contact: {
    title: 'story.contact.title',
    messages: [
      ['d', 'dot', 'story.contact.ask'],
      ['g', 'Grokbot', 'story.contact.reply'],
      ['d', 'dot', 'story.contact.followup'],
      ['g', 'Grokbot', 'story.contact.answer'],
    ],
  },
  meeting: { title: 'home.inviteTitle', messages: [] },
};

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const preview = document.querySelector('#story-preview');
const recording = document.querySelector('#recorded-video');
const recordingButton = document.querySelector('#show-recording');
const mediaLabel = document.querySelector('#media-label');
let video;
let mediaFailed = false;
let currentScene = 'contact';
const requestedScene = new URLSearchParams(location.search).get('scene');

function renderScene(scene) {
  if (!scenes[scene]) return;
  currentScene = scene;
  video?.pause();
  preview.hidden = false;
  preview.classList.toggle('is-meeting', scene === 'meeting');
  document.querySelector('#contact-preview').hidden = scene === 'meeting';
  document.querySelector('#meeting-preview').hidden = scene !== 'meeting';
  recording.hidden = true;
  recordingButton.setAttribute('aria-pressed', 'false');
  document.querySelectorAll('[data-scene]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.scene === scene));
  });
  updateSceneCopy();
}

function updateSceneCopy() {
  document.querySelector('#story-title').textContent = t(scenes[currentScene].title);
  document.querySelector('#story-messages').replaceChildren(...scenes[currentScene].messages.map(([avatar, name, content]) => {
    const row = make('div', undefined, `story-message ${avatar === 'd' ? 'from-dot' : avatar === 'g' ? 'from-grok' : 'from-session'}`);
    const mark = make('span', avatar, 'message-avatar');
    mark.setAttribute('aria-hidden', 'true');
    if (avatar === 'd' || avatar === 'g') {
      const icon = make('img');
      icon.src = avatar === 'd' ? './brand/dot.svg' : './brand/grok-bot.png';
      icon.alt = '';
      icon.width = avatar === 'd' ? 81 : 1024;
      icon.height = icon.width;
      mark.classList.add('product-avatar');
      mark.replaceChildren(icon);
    }
    const body = make('div', undefined, 'message-body');
    body.append(make('strong', name), make('p', t(content)));
    row.append(mark, body);
    return row;
  }));
  mediaLabel.textContent = !preview.hidden
    ? t(mediaFailed ? 'media.failed' : siteMedia.src ? 'media.illustration' : 'media.pending')
    : t('media.recording');
  if (video) {
    video.setAttribute('aria-label', t('media.label'));
    const track = video.querySelector('track');
    if (track) track.label = t('media.captionsChinese');
  }
}

function showRecording() {
  if (!video || mediaFailed) return;
  preview.hidden = true;
  recording.hidden = false;
  recordingButton.setAttribute('aria-pressed', 'true');
  document.querySelectorAll('[data-scene]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  mediaLabel.textContent = t('media.recording');
}

function configureVideo() {
  if (!siteMedia.src) return;
  video = make('video', undefined, 'recording');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('aria-label', t('media.label'));
  if (siteMedia.poster) video.poster = siteMedia.poster;
  if (siteMedia.captions) {
    const track = make('track');
    track.kind = 'captions';
    track.srclang = 'zh-CN';
    track.label = t('media.captionsChinese');
    track.src = siteMedia.captions;
    track.default = true;
    video.append(track);
  }
  recording.replaceChildren(video);
  recordingButton.hidden = false;
  recordingButton.addEventListener('click', showRecording);
  video.addEventListener('error', () => {
    const restoreFocus = document.activeElement === recordingButton || document.activeElement === video;
    mediaFailed = true;
    recordingButton.hidden = true;
    renderScene(currentScene);
    if (restoreFocus) document.querySelector(`[data-scene="${currentScene}"]`).focus();
  });
  if (!['contact', 'meeting'].includes(requestedScene)) showRecording();
  video.src = siteMedia.src;
}

if (preview) {
  mediaLabel.setAttribute('role', 'status');
  renderScene(requestedScene === 'meeting' ? 'meeting' : 'contact');
  document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => renderScene(button.dataset.scene)));
  configureVideo();
}

let copyStatusKey;
window.addEventListener('noknok:languagechange', () => {
  if (preview) updateSceneCopy();
  if (copyStatusKey) document.querySelector('#copy-status').textContent = t(copyStatusKey);
});

// Guide prompt cards: native clipboard, with a selectable manual fallback.
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const text = document.getElementById(button.dataset.copy);
  const status = document.querySelector('#copy-status');
  button.closest('.copy-card')?.append(status);
  try {
    await navigator.clipboard.writeText(text.textContent.trim());
    copyStatusKey = 'shared.copySuccess';
    status.textContent = t(copyStatusKey);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatusKey = 'shared.copyFallback';
    status.textContent = t(copyStatusKey);
  }
}));
