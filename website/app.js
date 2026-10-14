import { siteMedia } from './content.js';

// Illustrative scripts, never connected to a live meeting service.
const scenes = {
  contact: {
    title: '和 B 的 Grokbot 聊聊',
    messages: [
      ['d', 'dot', '邀请说明整理好了吗？'],
      ['g', 'Grokbot', '草稿好了，会话接入还待验收。'],
      ['d', 'dot', '会议结束后，还能用邀请加入吗？'],
      ['g', 'Grokbot', '不能。结束后的 10 分钟只保留记录。'],
    ],
  },
  meeting: { title: '一个链接，一起聊。', messages: [] },
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
  document.querySelector('#story-title').textContent = scenes[scene].title;
  document.querySelector('#story-messages').replaceChildren(...scenes[scene].messages.map(([avatar, name, content]) => {
    const row = make('div', undefined, `story-message ${avatar === 'd' ? 'from-dot' : avatar === 'g' ? 'from-grok' : 'from-session'}`);
    const mark = make('span', avatar, 'message-avatar');
    mark.setAttribute('aria-hidden', 'true');
    const body = make('div', undefined, 'message-body');
    body.append(make('strong', name), make('p', content));
    row.append(mark, body);
    return row;
  }));
  mediaLabel.textContent = mediaFailed ? '视频暂时无法加载 · 以下为场景示意' : siteMedia.src ? '场景示意 · 非实录' : '场景示意 · 视频待录制';
}

function showRecording() {
  if (!video || mediaFailed) return;
  preview.hidden = true;
  recording.hidden = false;
  recordingButton.setAttribute('aria-pressed', 'true');
  document.querySelectorAll('[data-scene]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  mediaLabel.textContent = '产品演示实录';
}

function configureVideo() {
  if (!siteMedia.src) return;
  video = make('video', undefined, 'recording');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('aria-label', 'NokNok 产品演示实录');
  if (siteMedia.poster) video.poster = siteMedia.poster;
  if (siteMedia.captions) {
    const track = make('track');
    track.kind = 'captions';
    track.srclang = 'zh-CN';
    track.label = '中文';
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

// Guide prompt cards: native clipboard, with a selectable manual fallback.
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const text = document.getElementById(button.dataset.copy);
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(text.textContent.trim());
    status.textContent = '提示词已复制，可以粘贴到你的 Agent 会话。';
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = '浏览器未允许自动复制。已选中文本，请使用系统复制操作。';
  }
}));
