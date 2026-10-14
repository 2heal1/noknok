import type { CallDetails, CallSummary, ViewAccess } from './types.js';
interface ViewerElements {
  'sidebarToggle': HTMLButtonElement;
  'brandLink': HTMLAnchorElement;
  'topbarCall': HTMLButtonElement;
  'callerName': HTMLElement;
  'calleeName': HTMLElement;
  'callState': HTMLElement;
  'autoRefresh': HTMLButtonElement;
  'autoRefreshLabel': HTMLElement;
  'toolsToggle': HTMLButtonElement;
  'sidebar': HTMLDialogElement;
  'sidebarTitle': HTMLElement;
  'callCount': HTMLElement;
  'callSearchField': HTMLElement;
  'callSearch': HTMLInputElement;
  'remoteAccess': HTMLElement;
  'viewLinkForm': HTMLFormElement;
  'viewLinkInput': HTMLInputElement;
  'viewLinkHint': HTMLElement;
  'viewLinkError': HTMLElement;
  'sidebarCaption': HTMLElement;
  'listWarnings': HTMLElement;
  'callList': HTMLElement;
  'listEmpty': HTMLElement;
  'sourceLabel': HTMLElement;
  'sourceDescription': HTMLElement;
  'sourceDetails': HTMLDetailsElement;
  'sourceDirectory': HTMLElement;
  'emptyDetail': HTMLElement;
  'emptyTitle': HTMLElement;
  'emptyDescription': HTMLElement;
  'emptyAction': HTMLButtonElement;
  'emptyNote': HTMLElement;
  'callDetail': HTMLElement;
  'messageScroll': HTMLElement;
  'callPresence': HTMLElement;
  'presenceStatus': HTMLElement;
  'presenceNote': HTMLElement;
  'presenceExpiry': HTMLTimeElement;
  'messageList': HTMLElement;
  'messagesEmpty': HTMLElement;
  'jumpToLatest': HTMLButtonElement;
  'apiError': HTMLElement;
  'infoPanel': HTMLDialogElement;
  'infoTitle': HTMLElement;
  'infoState': HTMLElement;
  'callPurpose': HTMLElement;
  'callCreated': HTMLElement;
  'callShortId': HTMLElement;
  'callerSource': HTMLElement;
  'calleeSource': HTMLElement;
  'contextDetails': HTMLDetailsElement;
  'contextHint': HTMLElement;
  'callContext': HTMLElement;
  'coverageNote': HTMLElement;
  'detailWarnings': HTMLElement;
  'recordNote': HTMLElement;
  'stateNote': HTMLElement;
  'toolsPanel': HTMLDialogElement;
  'toolsTitle': HTMLElement;
  'messageSearch': HTMLInputElement;
  'roleFilter': HTMLSelectElement;
  'messageCount': HTMLElement;
  'showResults': HTMLButtonElement;
  'clearFilters': HTMLButtonElement;
  'copyConversation': HTMLButtonElement;
  'downloadConversation': HTMLButtonElement;
  'refreshStatus': HTMLElement;
  'refreshButton': HTMLButtonElement;
  'filterNotice': HTMLElement;
  'filterNoticeText': HTMLElement;
  'resetFilters': HTMLButtonElement;
  'toast': HTMLElement;
}
'use strict';

(() => {
  function $<K extends keyof ViewerElements>(id: K): ViewerElements[K];
  function $(id: string): HTMLElement;
  function $(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing NokNok page element: ${id}`);
    return element;
  }
  const ui = Object.fromEntries(['autoRefresh', 'autoRefreshLabel', 'refreshButton', 'refreshStatus', 'callSearch', 'callCount', 'callList', 'listEmpty', 'listWarnings', 'sourceDirectory', 'emptyDetail', 'emptyTitle', 'emptyDescription', 'callDetail', 'callState', 'callPurpose', 'callCreated', 'callShortId', 'callerName', 'calleeName', 'callerSource', 'calleeSource', 'coverageNote', 'contextDetails', 'contextHint', 'callContext', 'detailWarnings', 'messageSearch', 'roleFilter', 'messageCount', 'messageScroll', 'messageList', 'messagesEmpty', 'jumpToLatest', 'copyConversation', 'downloadConversation', 'recordNote', 'apiError', 'toast', 'brandLink', 'sidebar', 'sidebarTitle', 'sidebarCaption', 'callSearchField', 'remoteAccess', 'viewLinkForm', 'viewLinkInput', 'viewLinkError', 'sourceLabel', 'sourceDescription', 'sourceDetails', 'emptyNote', 'stateNote'].map((id) => [id, $(id)])) as ViewerElements & Record<string, HTMLElement>;
  for (const id of ['sidebarToggle', 'topbarCall', 'toolsToggle', 'infoPanel', 'toolsPanel', 'emptyAction', 'showResults', 'clearFilters', 'filterNotice', 'filterNoticeText', 'resetFilters', 'infoState', 'callPresence', 'presenceStatus', 'presenceNote', 'presenceExpiry']) ui[id] = $(id);
  const remoteMode = /^\/view\/?$/.test(location.pathname);
  let viewAccess: ViewAccess | null = null;
  let remoteUnavailable = false;
  let presenceCall: string | null = null, presenceState: string | null = null, presenceTimer: number | undefined;
  const sessionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const stateLabels = { waiting: '等待接听', connected: '已接通', completed: '已完成', cancelled: '已取消', canceled: '已取消', expired: '已过期', closed: '已结束', unknown: '状态未知' };
  const typeLabels = { message: '消息', request: '请求协助', result: '结果', progress: '进展', waiting_for_user: '等待主人', done: '完成提议', finish: '完成提议', joined: '加入通话', closed: '通话结束' };
  const state = { calls: [] as CallSummary[], selected: null as string | null, detail: null as CallDetails | null, auto: true, refreshing: false, detailRequest: 0, listNodes: new Map(), eventNodes: new Map(), detailSignature: '', warningSignature: '', loaded: false, initialScroll: true, listWarnings: [], toastTimer: undefined as number | undefined };

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: unknown) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function text(node, value) { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; }
  function date(value, mode = 'full') {
    if (!value) return '时间未知';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '时间未知';
    if (mode === 'clock') return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    if (mode === 'short') return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function badge(node, value) { text(node, stateLabels[value] || value || '状态未知'); node.dataset.state = value || 'unknown'; }
  function participant(call, role) { return call?.participants?.[role]?.name || (role === 'caller' ? '发起方' : '尚未接听'); }
  function coverage(call) { return call.coverage === 'relay' ? '服务器记录' : call.coverage === 'both' ? '双端记录' : call.coverage === 'callee' ? '接听端记录' : '发起端记录'; }
  function toast(message) { (document.querySelector('dialog[open]') || document.body).append(ui.toast); text(ui.toast, message); ui.toast.hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2600); }
  const panelButtons = { sidebar: ui.sidebarToggle, infoPanel: ui.topbarCall, toolsPanel: ui.toolsToggle };
  function openPanel(id, focusTarget) {
    const panel = ui[id] as HTMLDialogElement;
    if (!panel.open) panel.showModal();
    panelButtons[id].setAttribute('aria-expanded', 'true');
    focusTarget?.focus();
  }
  function clearFilters() {
    ui.messageSearch.value = ''; ui.roleFilter.value = 'all'; renderEvents({ filterChanged: true });
  }
  function hashKey() { const key = new URLSearchParams(location.hash.slice(1)).get('call'); return /^[a-f0-9]{64}$/i.test(key || '') ? key : null; }
  function parseViewLink(raw) {
    const value = raw.trim();
    if (sessionPattern.test(value)) return { callId: value.toLowerCase(), token: value.toLowerCase(), kind: 'session', hash: `#session=${value.toLowerCase()}` };
    if (/^ac_/i.test(value)) throw new Error('请填写邀请中的 Session，ac_ 开头的是本地会话编号。');
    let url;
    try { url = new URL(value); } catch { throw new Error('Session 格式不正确，请复制邀请中的完整编号。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写有效的 Session 或查看链接。');
    if (url.origin !== location.origin) throw new Error('这个链接属于其他交换机，请直接打开原链接查看。');
    if (!/^\/view\/?$/.test(url.pathname) || url.search) throw new Error('这不是查看链接，请复制邀请中的 Session。');
    const params = new URLSearchParams(url.hash.slice(1));
    if (params.has('session')) {
      const session = params.get('session');
      if (params.getAll('session').length !== 1 || Array.from(params.keys()).some((key) => key !== 'session') || !sessionPattern.test(session || '')) throw new Error('查看链接中的 Session 不完整。');
      return parseViewLink(session);
    }
    const callId = params.get('call');
    const token = params.get('token');
    if (params.getAll('call').length !== 1 || params.getAll('token').length !== 1 || Array.from(params.keys()).some((key) => key !== 'call' && key !== 'token') || !sessionPattern.test(callId || '') || !/^acv_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('查看链接不完整，请复制邀请中的 Session。');
    return { callId, token, kind: 'legacy', hash: url.hash };
  }
  function retentionNote(source: NonNullable<CallDetails['source']> = {}) {
    const ms = Number(source.retentionMs);
    const duration = Number.isFinite(ms) && ms > 0 ? (ms >= 3600000 ? `${Number((ms / 3600000).toFixed(1))} 小时` : `${Math.ceil(ms / 60000)} 分钟`) : '有限时间';
    const ending = source.availableUntil ? `本次记录预计保留至 ${date(source.availableUntil)}。` : `通话结束后保留 ${duration}。`;
    return `记录保存在服务器内存中，服务重启会丢失。${ending}`;
  }
  function nearBottom() { const s = ui.messageScroll; return s.scrollHeight - s.scrollTop - s.clientHeight < 90; }
  function scrollBottom() { ui.messageScroll.scrollTop = ui.messageScroll.scrollHeight; ui.jumpToLatest.hidden = true; }

  async function json(path, access: ViewAccess | null = null) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (access) headers.Authorization = `Bearer ${access.token}`;
    const response = await fetch(path, { headers, cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      const message = access && response.status === 401 ? 'Session 或查看链接无效，记录也可能已过期或因服务重启清空。' : access && response.status === 404 ? '未找到这次通话，记录可能已过期或因服务重启清空。' : `读取失败（HTTP ${response.status}）。请确认${access ? '交换机' : '记录查看服务'}仍在运行。`;
      const error = Object.assign(new Error(message), { status: response.status }); throw error;
    }
    const result = await response.json();
    if (!result || typeof result !== 'object') throw new Error('服务返回了无法识别的数据。请刷新重试。');
    return result;
  }
  function showError(error) { text(ui.apiError, error instanceof Error ? error.message : `无法读取${remoteMode ? '服务器' : '本地'}记录，请刷新重试。`); ui.apiError.hidden = false; text(ui.refreshStatus, '读取失败 · 可手动重试'); }
  function warnings(node, items) {
    const signature = JSON.stringify(items || []);
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.replaceChildren();
    for (const item of items || []) node.append(el('p', '', item.message || item.code || '部分本地记录无法读取。'));
    node.hidden = !(items || []).length;
  }

  function createCallNode(call) {
    const button = el('button', 'call-item');
    button.type = 'button';
    button.dataset.callKey = call.key;
    const top = el('div', 'call-item-top');
    top.append(el('span', 'state-badge'), el('time', 'call-item-time'));
    const bottom = el('div', 'call-item-bottom');
    bottom.append(el('span', 'call-item-coverage'), el('span', 'call-item-count'));
    button.append(top, el('div', 'call-item-title'), el('div', 'call-item-people'), el('div', 'call-item-preview'), bottom);
    button.addEventListener('click', () => { ui.sidebar.close(); selectCall(button.dataset.callKey); });
    return button;
  }
  function renderCalls() {
    const query = ui.callSearch.value.trim().toLocaleLowerCase();
    const visible = state.calls.filter((call) => [call.purpose, participant(call, 'caller'), participant(call, 'callee'), call.callId, call.preview].join(' ').toLocaleLowerCase().includes(query));
    text(ui.callCount, state.calls.length);
    const visibleKeys = new Set(visible.map((call) => call.key));
    for (const child of (Array.from(ui.callList.children) as HTMLElement[])) if (!visibleKeys.has(child.dataset.callKey ?? '')) child.remove();
    visible.forEach((call, index) => {
      let node = state.listNodes.get(call.key);
      if (!node) { node = createCallNode(call); state.listNodes.set(call.key, node); }
      badge(node.querySelector('.state-badge'), call.state);
      text(node.querySelector('.call-item-time'), date(call.lastActivityAt || call.createdAt, 'short'));
      text(node.querySelector('.call-item-title'), call.purpose || '未命名通话');
      text(node.querySelector('.call-item-people'), `${participant(call, 'caller')} ↔ ${participant(call, 'callee')}`);
      text(node.querySelector('.call-item-preview'), call.preview || '暂无消息');
      text(node.querySelector('.call-item-coverage'), coverage(call));
      text(node.querySelector('.call-item-count'), `${call.messageCount ?? 0} 条消息`);
      node.classList.toggle('is-selected', call.key === state.selected);
      node.setAttribute('aria-current', call.key === state.selected ? 'true' : 'false');
      node.setAttribute('aria-label', `${call.purpose || '未命名通话'}，${stateLabels[call.state] || '状态未知'}，${participant(call, 'caller')} 与 ${participant(call, 'callee')}`);
      if (ui.callList.children[index] !== node) ui.callList.insertBefore(node, ui.callList.children[index] || null);
    });
    const allKeys = new Set(state.calls.map((call) => call.key));
    for (const key of state.listNodes.keys()) if (!allKeys.has(key)) state.listNodes.delete(key);
    ui.listEmpty.hidden = visible.length > 0;
    text(ui.listEmpty, state.calls.length ? '没有匹配的通话，试试其他关键词。' : remoteMode ? '输入 Session 打开通话。' : '还没有本地通话记录。');
  }

  function safeRichText(container, content) {
    container.replaceChildren();
    const lines = String(content ?? '').split('\n');
    let plain: string[] = [], code: string[] = [], language = '', fenced = false;
    const appendPlain = () => { if (plain.length) { container.append(el('p', 'text-block', plain.join('\n'))); plain = []; } };
    const appendCode = () => {
      const block = el('div', 'code-block');
      const heading = el('div', 'code-heading');
      const copy = el('button', 'copy-code', '复制代码'); copy.type = 'button';
      const raw = code.join('\n');
      copy.addEventListener('click', () => copyText(raw, '代码已复制'));
      heading.append(el('span', '', language || 'text'), copy);
      const pre = el('pre'); pre.append(el('code', '', raw));
      block.append(heading, pre); container.append(block); code = [];
    };
    for (const line of lines) {
      const fence = /^\s*```([^`]*)$/.exec(line);
      if (fence && !fenced) { appendPlain(); fenced = true; language = fence[1].trim(); }
      else if (fence && fenced && !fence[1].trim()) { appendCode(); fenced = false; }
      else if (fenced) code.push(line);
      else plain.push(line);
    }
    if (fenced) appendCode(); else appendPlain();
  }
  function resetPresence() {
    clearTimeout(presenceTimer);
    presenceCall = null; presenceState = null;
    ui.callPresence.hidden = true; ui.callPresence.classList.remove('is-joining'); delete ui.callPresence.dataset.state;
    text(ui.presenceStatus, ''); text(ui.presenceNote, ''); text(ui.presenceExpiry, ''); ui.presenceExpiry.hidden = true;
  }
  function finishJoining() {
    clearTimeout(presenceTimer);
    if (!ui.callPresence.classList.contains('is-joining')) return;
    const follow = nearBottom();
    const box = ui.messageScroll.getBoundingClientRect();
    const anchor = (Array.from(ui.messageList.children) as HTMLElement[]).find((node) => node.getBoundingClientRect().bottom > box.top);
    const top = anchor?.getBoundingClientRect().top;
    ui.callPresence.classList.remove('is-joining');
    if (follow) scrollBottom();
    else if (anchor && top !== undefined) ui.messageScroll.scrollTop += anchor.getBoundingClientRect().top - top;
  }
  function updatePresence(call) {
    if (presenceCall === call.callId && presenceState === call.state) return;
    const joining = remoteMode && presenceCall === call.callId && presenceState === 'waiting' && call.state === 'connected' && !document.hidden && !reducedMotion.matches;
    clearTimeout(presenceTimer);
    presenceCall = call.callId; presenceState = call.state;
    ui.callPresence.hidden = false; ui.callPresence.dataset.state = call.state || 'unknown';
    ui.callPresence.classList.toggle('is-joining', joining);
    const waiting = call.state === 'waiting';
    const connected = call.state === 'connected';
    text(ui.presenceStatus, waiting ? '正在呼叫另一位 agent' : connected ? '双方已接通' : stateLabels[call.state] || '通话状态未知');
    text(ui.presenceNote, waiting ? '邀请已发出，等待对方加入' : connected ? '他们的对话会出现在这里' : '通话记录保留在下方');
    if (!remoteMode) text(ui.presenceNote, '本地最后一次观察到的状态');
    const expiry = waiting && remoteMode && call.expiresAt && !Number.isNaN(new Date(call.expiresAt).getTime());
    ui.presenceExpiry.hidden = !expiry;
    if (expiry) { text(ui.presenceExpiry, `邀请有效至 ${date(call.expiresAt, 'clock')}`); ui.presenceExpiry.dateTime = call.expiresAt; }
    else { text(ui.presenceExpiry, ''); ui.presenceExpiry.removeAttribute('datetime'); }
    if (joining) presenceTimer = setTimeout(finishJoining, 1500);
  }
  function updateHeader(detail) {
    const call = detail.call;
    const signature = JSON.stringify({ call, sessions: detail.sessions, warnings: detail.warnings, source: detail.source });
    if (state.detailSignature === signature) return;
    state.detailSignature = signature;
    text(ui.callPurpose, call.purpose || '未命名通话');
    badge(ui.callState, call.state);
    badge(ui.infoState, call.state);
    ui.topbarCall.setAttribute('aria-label', `${participant(call, 'caller')} 与 ${participant(call, 'callee')}，${stateLabels[call.state] || '状态未知'}。查看通话详情与背景`);
    ui.callState.title = remoteMode ? '最近一次刷新时的交换机状态' : '本地最后一次记录中的状态，不代表交换机当前状态';
    text(ui.callCreated, `${date(call.createdAt)} 发起`);
    text(ui.callShortId, `Session ${call.callId || '—'}`);
    ui.callShortId.title = call.callId || '';
    text(ui.callerName, participant(call, 'caller'));
    text(ui.calleeName, participant(call, 'callee'));
    const roles = new Set((detail.sessions || []).map((session) => session.role));
    text(ui.callerSource, remoteMode ? '由交换机记录' : roles.has('caller') ? '本机有此端记录' : '来自对方消息');
    text(ui.calleeSource, remoteMode ? call.participants?.callee ? '由交换机记录' : '等待另一端加入' : roles.has('callee') ? '本机有此端记录' : call.participants?.callee ? '来自对方消息' : '等待另一端加入');
    text(ui.coverageNote, remoteMode ? `显示本次通话双方发送到交换机的完整消息与事件。${retentionNote(detail.source)}` : call.coverage === 'both' ? `已合并本机 ${call.localSessionCount || detail.sessions.length} 份会话记录，同一事件只显示一次。` : `仅有${call.coverage === 'callee' ? '接听端' : '发起端'}的本地记录，未被此端观察到的消息可能缺失。`);
    const context = typeof call.context === 'string' ? call.context : call.context ? JSON.stringify(call.context, null, 2) : '';
    if (ui.callContext.dataset.value !== context) { safeRichText(ui.callContext, context || '这次通话没有附带背景。'); ui.callContext.dataset.value = context; }
    text(ui.contextHint, context ? `${context.length.toLocaleString()} 字符` : '未提供');
    warnings(ui.detailWarnings, detail.warnings);
    text(ui.recordNote, `${remoteMode ? '服务器记录' : '本地已观察记录'} · ${call.eventCount ?? detail.events.length} 个事件 · ${remoteMode ? '双方完整事件' : coverage(call)}`);
    if (remoteMode) text(ui.sourceDescription, retentionNote(detail.source));
    document.title = `${call.purpose || '通话记录'} · NokNok`;
  }

  function createEvent(event, detail) {
    const data = event.data || {};
    if (event.from === 'system') {
      const node = el('div', 'system-event'); node.setAttribute('role', 'listitem'); node.dataset.seq = event.seq;
      const content = el('div', 'system-event-content');
      const names = data.participants || detail.call.participants;
      let label = event.type === 'joined' ? `${names?.callee?.name || '接听方'} 加入通话` : event.type === 'closed' ? `通话${stateLabels[data.state] || '已结束'}` : typeLabels[event.type] || event.type;
      if (event.type === 'closed' && data.reason === 'both_participants_finished') label = '双方确认完成 · 通话结束';
      const time = el('time', '', date(event.at, 'clock')); time.title = date(event.at); if (event.at) time.dateTime = event.at;
      content.append(el('span', '', label), time);
      const reason = data.text || (data.reason && data.reason !== 'both_participants_finished' ? data.reason : '');
      if (reason) content.append(el('span', 'system-reason', reason));
      node.append(content); return node;
    }
    const node = el('div', 'message'); node.dataset.role = event.from; node.dataset.type = event.type; node.dataset.seq = event.seq; node.setAttribute('role', 'listitem');
    const heading = el('div', 'message-heading');
    const time = el('time', 'message-time', date(event.at, 'clock')); time.title = date(event.at); if (event.at) time.dateTime = event.at;
    const avatar = el('span', 'message-avatar', event.from === 'caller' ? 'A' : 'B'); avatar.setAttribute('aria-hidden', 'true');
    heading.append(avatar, el('strong', '', participant(detail.call, event.from)));
    if (event.type !== 'message') heading.append(el('span', 'message-type', typeLabels[event.type] || event.type));
    heading.append(time);
    const bubble = el('div', 'message-bubble');
    safeRichText(bubble, data.text ?? '（无文本内容）');
    const provenance = el('div', 'message-provenance');
    const sources = new Set((event.observedBy || []).map((id) => detail.sessions.find((session) => session.id === id)?.role).filter(Boolean));
    const sourceLabel = remoteMode ? '服务器记录' : sources.has('caller') && sources.has('callee') ? '双端均有记录' : sources.has('callee') ? '接听端记录' : sources.has('caller') ? '发起端记录' : '本地记录';
    provenance.append(el('span', 'message-seq', `#${event.seq}`), el('span', '', `${event.from === 'caller' ? '发起端' : '接听端'} · ${sourceLabel}`));
    if (data.replyTo) provenance.append(el('span', '', `回复 ${data.replyTo}`));
    const metadata = el('details', 'message-details');
    const summary = el('summary', '', '···'); summary.setAttribute('aria-label', `查看消息 ${event.seq} 的记录信息`); summary.title = '消息记录信息';
    metadata.append(summary, provenance); heading.append(metadata);
    node.append(heading, bubble); return node;
  }
  function renderEvents({ filterChanged = false } = {}) {
    const detail = state.detail;
    if (!detail) return;
    const follow = state.initialScroll || nearBottom();
    const scrollTop = ui.messageScroll.scrollTop;
    const oldHeight = ui.messageScroll.scrollHeight;
    const scrollRect = ui.messageScroll.getBoundingClientRect();
    const oldAnchor = !follow && !filterChanged ? (Array.from(ui.messageList.children) as HTMLElement[]).find((node) => node.getBoundingClientRect().bottom > scrollRect.top) : null;
    const anchor = oldAnchor ? { seq: oldAnchor.dataset.seq, top: oldAnchor.getBoundingClientRect().top } : null;
    const query = ui.messageSearch.value.trim().toLocaleLowerCase();
    const role = ui.roleFilter.value;
    const events = detail.events.filter((event) => (role === 'all' || event.from === role) && [event.data?.text, event.data?.reason, typeLabels[event.type], event.type, event.from === 'system' ? '系统' : participant(detail.call, event.from)].join(' ').toLocaleLowerCase().includes(query));
    const keys = new Set(events.map((event) => String(event.seq)));
    for (const child of (Array.from(ui.messageList.children) as HTMLElement[])) if (!keys.has(child.dataset.seq ?? '')) child.remove();
    events.forEach((event, index) => {
      const key = String(event.seq);
      const signature = JSON.stringify({ event, participants: detail.call.participants, sessions: detail.sessions });
      let saved = state.eventNodes.get(key);
      if (!saved || saved.signature !== signature) {
        const node = createEvent(event, detail);
        if (!saved && !state.initialScroll && !filterChanged && node.classList.contains('message')) node.classList.add('is-arriving');
        if (saved?.node.parentNode) saved.node.replaceWith(node);
        saved = { node, signature }; state.eventNodes.set(key, saved);
      }
      if (ui.messageList.children[index] !== saved.node) ui.messageList.insertBefore(saved.node, ui.messageList.children[index] || null);
    });
    const allKeys = new Set(detail.events.map((event) => String(event.seq)));
    for (const key of state.eventNodes.keys()) if (!allKeys.has(key)) state.eventNodes.delete(key);
    text(ui.messageCount, query || role !== 'all' ? `${events.length} / ${detail.events.length} 条` : `${detail.events.length} 条记录`);
    ui.filterNotice.hidden = !query && role === 'all';
    text(ui.filterNoticeText, `已筛选 · ${events.length} 条`);
    ui.toolsToggle.classList.toggle('has-filter', Boolean(query || role !== 'all'));
    ui.messagesEmpty.hidden = events.length > 0 || (!detail.events.length && detail.call.state === 'waiting');
    text(ui.messagesEmpty, detail.events.length ? '没有匹配的消息。调整关键词或来源筛选后再试。' : '这次通话尚无消息记录。接听或收发消息后，记录会出现在这里。');
    if (filterChanged) { ui.messageScroll.scrollTop = 0; ui.jumpToLatest.hidden = true; }
    else if (follow) scrollBottom();
    else {
      ui.messageScroll.scrollTop = scrollTop;
      const newAnchor = anchor && state.eventNodes.get(anchor.seq)?.node;
      if (anchor && newAnchor?.isConnected) ui.messageScroll.scrollTop += newAnchor.getBoundingClientRect().top - anchor.top;
      if (ui.messageScroll.scrollHeight > oldHeight) ui.jumpToLatest.hidden = false;
    }
    state.initialScroll = false;
  }

  function empty(title, description) { ui.callDetail.hidden = true; ui.topbarCall.hidden = true; ui.filterNotice.hidden = true; ui.toolsToggle.classList.remove('has-filter'); ui.emptyDetail.hidden = false; text(ui.emptyTitle, title); text(ui.emptyDescription, description); }
  function clearRemoteDisplay() {
    resetPresence();
    document.title = 'NokNok · 通话记录';
    for (const id of ['callPurpose', 'callState', 'infoState', 'callCreated', 'callShortId', 'callerName', 'calleeName', 'callerSource', 'calleeSource', 'coverageNote', 'contextHint', 'recordNote', 'messageCount', 'apiError']) text(ui[id], '');
    delete ui.infoState.dataset.state;
    ui.topbarCall.setAttribute('aria-label', '查看通话详情与背景');
    ui.callState.removeAttribute('title'); delete ui.callState.dataset.state;
    ui.callShortId.removeAttribute('title');
    ui.callContext.replaceChildren(); delete ui.callContext.dataset.value; ui.contextDetails.open = false;
    ui.detailWarnings.replaceChildren(); delete ui.detailWarnings.dataset.signature; ui.detailWarnings.hidden = true;
    text(ui.sourceDescription, '记录保存在服务器内存中，服务重启会丢失；通话结束后仅保留有限时间。');
  }
  async function loadDetail(key) {
    const request = ++state.detailRequest;
    const access = remoteMode ? viewAccess : null;
    if (remoteMode && (!access || key !== access.callId)) return;
    try {
      const path = remoteMode && access?.kind === 'session' ? '/v1/session-view' : `${remoteMode ? '/v1/views/' : '/api/calls/'}${encodeURIComponent(key)}`;
      const detail = await json(path, access);
      if (request !== state.detailRequest || key !== state.selected || (remoteMode && access !== viewAccess)) return;
      if (!detail.call || !Array.isArray(detail.events)) throw new Error('通话数据不完整，请刷新重试。');
      if (remoteMode && detail.call.callId !== access?.callId) throw new Error('服务返回的通话与查看链接不一致，请刷新重试。');
      detail.sessions ||= [];
      detail.events.sort((a, b) => a.seq - b.seq);
      state.detail = detail;
      if (remoteMode) { state.calls = [detail.call]; state.loaded = true; remoteUnavailable = false; renderCalls(); }
      ui.emptyDetail.hidden = true; ui.callDetail.hidden = false; ui.topbarCall.hidden = false;
      updateHeader(detail); updatePresence(detail.call); renderEvents();
      ui.apiError.hidden = true;
    } catch (error) {
      if (request !== state.detailRequest || key !== state.selected || (remoteMode && access !== viewAccess)) return;
      if (remoteMode) {
        remoteUnavailable = error.status === 401 || error.status === 404; state.calls = []; state.detail = null; state.detailSignature = ''; state.eventNodes.clear(); ui.messageList.replaceChildren(); renderCalls();
        clearRemoteDisplay();
      }
      showError(error);
      if (!state.detail) empty('暂时无法读取这次通话', remoteMode ? error.message || '请检查交换机服务，或重新填写 Session。' : '请检查查看服务，或打开通话列表选择其他通话。');
    }
  }
  async function selectCall(key, { updateHash = true } = {}) {
    if (!key) return;
    if (state.selected !== key) {
      resetPresence();
      state.selected = key; state.detail = null; state.detailSignature = ''; state.eventNodes.clear(); state.initialScroll = true;
      ui.messageList.replaceChildren(); ui.messageSearch.value = ''; ui.roleFilter.value = 'all'; ui.contextDetails.open = false; ui.callContext.dataset.value = '';
      ui.apiError.hidden = true; ui.jumpToLatest.hidden = true;
      empty('正在打开通话', remoteMode ? '正在读取交换机保存的双方消息与事件。' : '读取本机已观察到的对话与事件。');
      renderCalls();
    }
    if (updateHash && !remoteMode) history.replaceState(null, '', `#call=${encodeURIComponent(key)}`);
    await loadDetail(key);
  }
  async function refresh({ automatic = false } = {}) {
    if (state.refreshing) return;
    if (remoteMode && (!viewAccess || (automatic && remoteUnavailable))) return;
    state.refreshing = true; ui.refreshButton.disabled = true;
    try {
      if (remoteMode) {
        const access = viewAccess!;
        await selectCall(access.callId, { updateHash: false });
        if (access === viewAccess && ui.apiError.hidden) text(ui.refreshStatus, `${state.auto ? '已更新' : '已暂停自动刷新'} · ${date(new Date().toISOString(), 'clock')}`);
        return;
      }
      const data = await json('/api/calls');
      state.calls = Array.isArray(data.calls) ? data.calls.slice().sort((a, b) => String(b.lastActivityAt || b.createdAt || '').localeCompare(String(a.lastActivityAt || a.createdAt || ''))) : [];
      state.loaded = true;
      text(ui.sourceDirectory, data.source?.directory || '未提供路径');
      warnings(ui.listWarnings, data.warnings);
      renderCalls();
      ui.apiError.hidden = true;
      if (!state.selected) {
        const key = hashKey() || state.calls[0]?.key;
        if (key) await selectCall(key); else empty('还没有通话记录', '使用 NokNok 创建或接听一次通话，然后刷新。CLI 收到的消息会保存在本地，并出现在这里。');
      } else await loadDetail(state.selected);
      if (ui.apiError.hidden) text(ui.refreshStatus, `${state.auto ? '已更新' : '已暂停自动刷新'} · ${date(new Date().toISOString(), 'clock')}`);
    } catch (error) { showError(error); if (!state.loaded) empty(`无法读取${remoteMode ? '服务器' : '本地'}记录`, '请确认查看服务仍在运行，再打开右上角工具，点击“立即刷新”。'); }
    finally { state.refreshing = false; ui.refreshButton.disabled = false; }
  }
  async function copyText(value, success = '对话已复制') {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const previous = document.activeElement;
        const area = el('textarea', '', value); area.style.position = 'fixed'; area.style.opacity = '0'; area.setAttribute('aria-label', '复制内容'); document.body.append(area); area.select();
        const copied = document.execCommand('copy'); area.remove(); if (previous instanceof HTMLElement) previous.focus(); if (!copied) throw new Error('copy');
      }
      toast(success);
    } catch { toast('复制失败，可使用“下载 Markdown”保存对话。'); }
  }
  function markdown() {
    if (!state.detail) return '';
    const { call, events } = state.detail;
    const lines = [`# ${call.purpose || 'NokNok 通话记录'}`, '', `- 通话：${call.callId}`, `- 发起端：${participant(call, 'caller')}`, `- 接听端：${participant(call, 'callee')}`, `- 发起时间：${date(call.createdAt)}`, `- 最近记录状态：${stateLabels[call.state] || call.state}`, `- 来源：${coverage(call)}；${remoteMode ? '本次通话双方发送到交换机的完整消息与事件。' : '仅包含本地已观察记录。'}`, ''];
    if (call.context) lines.push('## 通话背景', '', typeof call.context === 'string' ? call.context : JSON.stringify(call.context, null, 2), '');
    lines.push('## 对话', '');
    for (const event of events) {
      lines.push(`### #${event.seq} · ${event.from === 'system' ? '系统' : participant(call, event.from)} · ${typeLabels[event.type] || event.type} · ${date(event.at)}`, '', event.data?.text || event.data?.reason || typeLabels[event.type] || event.type, '');
    }
    return lines.join('\n');
  }

  function setViewAccess(access) {
    if (access && viewAccess?.callId === access.callId && viewAccess?.token === access.token) {
      ui.viewLinkInput.value = ''; ui.viewLinkError.hidden = true;
      refresh(); return;
    }
    viewAccess = access; remoteUnavailable = false; state.detailRequest += 1;
    state.calls = []; state.selected = null; state.detail = null; state.loaded = false;
    state.detailSignature = ''; state.eventNodes.clear(); state.listNodes.clear();
    ui.messageList.replaceChildren(); ui.callList.replaceChildren(); ui.apiError.hidden = true;
    ui.viewLinkInput.value = ''; ui.viewLinkError.hidden = true;
    clearRemoteDisplay();
    renderCalls();
    if (!access) {
      empty('打开一段通话', '输入邀请中的 Session，看看双方聊到哪里。');
      text(ui.refreshStatus, '等待 Session');
      document.title = 'NokNok · 通话记录';
      return;
    }
    text(ui.refreshStatus, '正在读取服务器记录…');
    selectCall(access.callId, { updateHash: false }).then(() => {
      if (access === viewAccess && ui.apiError.hidden) text(ui.refreshStatus, `${state.auto ? '已更新' : '已暂停自动刷新'} · ${date(new Date().toISOString(), 'clock')}`);
    });
  }
  function loadRemoteHash() {
    try { setViewAccess(location.hash ? parseViewLink(location.href) : null); }
    catch (error) { setViewAccess(null); text(ui.viewLinkError, error.message); ui.viewLinkError.hidden = false; showError(error); }
  }

  ui.callSearch.addEventListener('input', renderCalls);
  for (const [id, button] of Object.entries(panelButtons)) {
    const panel = ui[id] as HTMLDialogElement;
    button.addEventListener('click', () => openPanel(id, id === 'toolsPanel' ? ui.messageSearch : undefined));
    panel.addEventListener('close', () => {
      button.setAttribute('aria-expanded', 'false');
      if (panel.contains(ui.toast)) document.body.append(ui.toast);
      if (id === 'sidebar') ui.viewLinkInput.value = '';
    });
    panel.addEventListener('click', (event) => {
      if (event.target !== panel) return;
      const box = panel.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) panel.close();
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-close-panel]').forEach((button) => button.addEventListener('click', () => (ui[button.dataset.closePanel!] as HTMLDialogElement).close()));
  ui.emptyAction.addEventListener('click', () => {
    openPanel('sidebar', remoteMode ? ui.viewLinkInput : ui.callSearch);
  });
  ui.showResults.addEventListener('click', () => ui.toolsPanel.close());
  ui.clearFilters.addEventListener('click', clearFilters);
  ui.resetFilters.addEventListener('click', clearFilters);
  ui.messageSearch.addEventListener('input', () => renderEvents({ filterChanged: true }));
  ui.roleFilter.addEventListener('change', () => renderEvents({ filterChanged: true }));
  ui.refreshButton.addEventListener('click', () => refresh());
  ui.autoRefresh.addEventListener('click', () => { state.auto = !state.auto; ui.autoRefresh.setAttribute('aria-pressed', String(state.auto)); ui.autoRefresh.setAttribute('aria-label', state.auto ? '暂停自动刷新' : '开启自动刷新'); ui.autoRefresh.title = state.auto ? '暂停自动刷新' : '开启自动刷新'; text(ui.autoRefreshLabel, state.auto ? '自动刷新' : '已暂停'); text(ui.refreshStatus, state.auto ? '自动刷新已开启' : '已暂停自动刷新'); toast(state.auto ? '自动刷新已开启' : '自动刷新已暂停'); if (state.auto) refresh(); });
  ui.jumpToLatest.addEventListener('click', scrollBottom);
  ui.messageScroll.addEventListener('scroll', () => { if (nearBottom()) ui.jumpToLatest.hidden = true; }, { passive: true });
  ui.copyConversation.addEventListener('click', () => { if (state.detail) copyText(markdown()); });
  ui.downloadConversation.addEventListener('click', () => {
    if (!state.detail) return;
    const url = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `noknok-${state.detail.call.callId || 'conversation'}.md`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已下载对话记录');
  });
  window.addEventListener('hashchange', () => { if (remoteMode) loadRemoteHash(); else { const key = hashKey(); if (key && key !== state.selected) selectCall(key, { updateHash: false }); } });
  setInterval(() => { if (state.auto && !document.hidden) refresh({ automatic: true }); }, 2000);
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-hidden', document.hidden);
    if (document.hidden) finishJoining();
    else if (state.auto) refresh({ automatic: true });
  });
  document.body.classList.toggle('page-hidden', document.hidden);
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) finishJoining(); });
  if (remoteMode) {
    document.body.classList.add('remote-mode');
    ui.brandLink.addEventListener('click', (event) => event.preventDefault());
    ui.sidebar.setAttribute('aria-label', '当前通话');
    ui.callList.setAttribute('aria-label', '获准查看的通话');
    text(ui.sidebarTitle, '查看通话'); text(ui.sidebarCaption, '当前通话');
    ui.callSearchField.hidden = true; ui.remoteAccess.hidden = false; ui.sourceDetails.hidden = true;
    text(ui.sourceLabel, '服务器记录 · 只读');
    text(ui.emptyNote, '查看不会加入通话。请仅向需要查看的人分享 Session。');
    text(ui.emptyAction, '输入 Session');
    text(ui.stateNote, '状态以最近一次刷新为准');
    ui.viewLinkForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = ui.viewLinkInput.value; ui.viewLinkInput.value = '';
      try {
        const access = parseViewLink(raw);
        history.replaceState(null, '', `/view${access.hash}`);
        ui.sidebar.close();
        setViewAccess(access);
      } catch (error) { text(ui.viewLinkError, error.message); ui.viewLinkError.hidden = false; ui.viewLinkInput.focus(); }
    });
    loadRemoteHash();
  } else refresh();
})();
