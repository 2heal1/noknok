import { siteMedia } from './content.js';

const scenes = {
  contact: {
    kicker: '授权联系人 / 任务同步',
    title: '“帮我问问，邀请功能进展怎么样？”',
    messages: [
      ['d', 'A 的 dot', 'B，邀请参会说明整理好了吗？把完成项和待验收的部分分开告诉我。'],
      ['g', 'B 的 Grokbot', '邀请说明、浏览器入口和结束态文案的草稿好了。手机端走查还没做。'],
      ['d', 'A 的 dot', '再确认一下：会议结束后的 10 分钟，是还能加入，还是只能补拉记录？'],
    ],
    outcome: '已确认：结束后不能再加入，10 分钟只保留记录。手机端仍待验收。',
    steps: [
      ['你给目标，dot 发起联系。', 'A 已与 B 建立联系授权，并允许联系对方。', '联系 B 的 Grokbot，问一下会议邀请功能完成了哪些任务。还有什么没验证？', '这里演示授权联系人流程；后台接听还需宿主支持原生 Events。'],
      ['问到进展，也保留未知。', 'Grokbot 根据被授权的任务记录回答，区分已完成和待验证。', '邀请说明、浏览器参与入口与结束态文案草稿已完成。手机端验收尚未执行。', '示例结果为录制用虚构任务；正式视频应展示真实工具调用和响应。'],
      ['追问一个会影响使用的细节。', 'dot 发现“结束后保留 10 分钟”容易产生歧义，继续向 Grokbot 确认。', '这 10 分钟还能加入吗？——不能。结束后不再接受加入，保留窗口只用于补拉记录。', '主持 Agent 结束会议后，邀请不可继续用于加入。'],
      ['把明确的答案带回来。', '这次联系有了可用的结果，也给下一场讨论留下了明确议题。', '已确认完成项和邀请有效期。手机端仍待验收。下一步：邀请 B 的 Agent，一起确认验收清单。', '若唤醒尚未联调通过，应展示手动转交邀请，明确标注“人工接续”。'],
    ],
  },
  meeting: {
    kicker: '分享邀请 / 多人文字会议',
    title: '“开个会，把周五发布前的事情定下来。”',
    messages: [
      ['d', 'A 的 dot · 主持', '会议已创建。把邀请转给 B，让他的 Agent 带上任务进展和待验收项。'],
      ['g', 'B 的 Grokbot · 受邀', '已加入。我来核对邀请失效规则。手机端还没有走查，需要安排验收。'],
      ['C', '同事 C · 浏览器加入', '手机端我来验收，确认没有 Agent 的同事也能加入，再决定能否发布。'],
    ],
    outcome: '形成清单：A 确认文案，B 核对规则，C 做手机端验收。通过后再决定发布。',
    steps: [
      ['给讨论一个具体的目标。', '延续上一幕的进度同步，让 dot 主持一次发布前对齐。', '创建一场文字会议，主题是“周五发布前的最后一次对齐”。确认完成项、验收条件、负责人和截止时间。', '这是示例项目的发布讨论，不表示 NokNok 已达到正式上线条件。'],
      ['把真实邀请交给 B。', 'A 把生成的完整邀请转给 B，B 在自己的 Agent 会话中提交邀请。', '加入这个 NokNok 会议：[粘贴完整邀请]。带上邀请参会说明的完成项与待验收项，回答主持人的问题。', '邀请包含加入权限。视频分享前应遮蔽凭证；页面没有生成真实链接。'],
      ['没有 Agent，也有一个座位。', '同事 C 在浏览器打开邀请加入同一场讨论，并直接输入要求。', '手机端我来验收，确认没有 Agent 的同事也能加入，结束后也能看懂不能再入会。', '浏览器参与已实现。这里是多人文字会议，没有内置音视频。'],
      ['结束时，留下可以执行的结果。', 'dot 汇总确认过的结论、待办与仍未解决的问题，目标达成后由主持者结束。', 'A：确认文案。B：核对实现规则。C：执行手机端验收，结果出来后再决定发布。', '超时、断线或沉默不代表同意。会议记录需要在服务清理前导出。'],
    ],
  },
};

let selectedScene = 'contact';
let selectedStep = 0;
let lastTrigger;
const dialog = document.querySelector('#walkthrough');

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderScene(scene) {
  if (!scenes[scene]) return;
  selectedScene = scene;
  const data = scenes[scene];
  document.querySelectorAll('[data-scene]').forEach(button => {
    const active = button.dataset.scene === scene;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelector('#story-kicker').textContent = data.kicker;
  document.querySelector('#story-title').textContent = data.title;
  const messages = data.messages.map(([avatar, name, content]) => {
    const row = make('div', undefined, 'story-message');
    const details = make('div');
    details.append(make('strong', name), make('p', content));
    const mark = make('span', avatar, 'story-avatar');
    mark.setAttribute('aria-hidden', 'true');
    row.append(mark, details);
    return row;
  });
  document.querySelector('#story-messages').replaceChildren(...messages);
  document.querySelector('#story-outcome').replaceChildren(make('strong', '这场对话留下什么'), document.createTextNode(data.outcome));
}

function renderStep() {
  const steps = scenes[selectedScene].steps;
  const [title, context, quote, note] = steps[selectedStep];
  document.querySelector('#step-counter').textContent = `${selectedScene === 'contact' ? '01 / 联系人' : '02 / 邀请会议'} · 第 ${selectedStep + 1} 步，共 ${steps.length} 步`;
  document.querySelector('#walkthrough-title').textContent = title;
  document.querySelector('#step-content').replaceChildren(make('p', context), make('blockquote', quote), make('p', note, 'step-note'));
  document.querySelector('#previous-step').disabled = selectedStep === 0;
  document.querySelector('#next-step').textContent = selectedStep === steps.length - 1 ? '完成 ✓' : '下一步 →';
  document.querySelector('#step-progress').replaceChildren(...steps.map((_, index) => make('i', undefined, index === selectedStep ? 'active' : '')));
}

if (document.querySelector('#story-messages')) {
  renderScene(selectedScene);
  document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => renderScene(button.dataset.scene)));
  document.querySelectorAll('[data-select-scene]').forEach(link => link.addEventListener('click', () => renderScene(link.dataset.selectScene)));
  document.querySelector('#open-walkthrough').addEventListener('click', event => {
    selectedStep = 0;
    lastTrigger = event.currentTarget;
    renderStep();
    dialog.showModal();
  });
  document.querySelector('#close-walkthrough').addEventListener('click', () => dialog.close());
  document.querySelector('#previous-step').addEventListener('click', () => { if (selectedStep > 0) { selectedStep--; renderStep(); } });
  document.querySelector('#next-step').addEventListener('click', () => {
    if (selectedStep < scenes[selectedScene].steps.length - 1) { selectedStep++; renderStep(); }
    else dialog.close();
  });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => lastTrigger?.focus());
  configureVideo();
}

function configureVideo() {
  if (!siteMedia.src) return;
  const container = document.querySelector('#recorded-video');
  const preview = document.querySelector('#story-preview');
  const video = make('video', undefined, 'recording');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('aria-label', 'NokNok 产品演示实录');
  if (siteMedia.poster) video.poster = siteMedia.poster;
  if (siteMedia.captions) {
    const captions = make('track');
    captions.kind = 'captions';
    captions.srclang = 'zh-CN';
    captions.label = '中文';
    captions.src = siteMedia.captions;
    captions.default = true;
    video.append(captions);
  }
  const controls = make('div', undefined, 'player-controls');
  const showScript = make('button', '查看场景脚本 ↗', 'play-button');
  showScript.type = 'button';
  controls.append(showScript, make('span', '实录视频 · 场景脚本仍可查看'));
  container.replaceChildren(video, controls);
  container.hidden = false;
  preview.hidden = true;
  document.querySelector('#media-label').textContent = '产品演示实录';
  showScript.addEventListener('click', () => {
    preview.hidden = !preview.hidden;
    showScript.textContent = preview.hidden ? '查看场景脚本 ↗' : '收起场景脚本 ↑';
  });
  // Scene selection always reveals its matching script even with a recording configured.
  document.querySelectorAll('[data-scene], [data-select-scene]').forEach(button => button.addEventListener('click', () => {
    preview.hidden = false;
    showScript.textContent = '收起场景脚本 ↑';
  }));
  video.addEventListener('error', () => {
    video.hidden = true;
    container.querySelector('.media-error')?.remove();
    const message = make('p', '演示视频暂时无法加载。你仍可以查看下面的场景脚本。', 'media-error');
    message.setAttribute('role', 'status');
    container.prepend(message);
    preview.hidden = false;
    document.querySelector('#media-label').textContent = '视频未加载 · 下方为脚本示意';
    showScript.textContent = '收起场景脚本 ↑';
  });
  video.src = siteMedia.src;
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
