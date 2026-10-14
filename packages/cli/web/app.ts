import type { CallDetails, CallSummary, ViewAccess } from './types.js';
import { avatarIdentity } from './avatar-catalog.js';
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
  const stateLabels = { waiting: 'Waiting for answer', connected: 'Connected', completed: 'Completed', cancelled: 'Cancelled', canceled: 'Cancelled', expired: 'Expired', closed: 'Ended', unknown: 'Unknown state' };
  const typeLabels = { message: 'Message', request: 'Request', result: 'Result', progress: 'Progress', waiting_for_user: 'Waiting for owner', done: 'Ready to finish', finish: 'Ready to finish', joined: 'Joined the call', closed: 'Call ended' };
  const state = { calls: [] as CallSummary[], selected: null as string | null, detail: null as CallDetails | null, auto: true, refreshing: false, detailRequest: 0, listNodes: new Map(), eventNodes: new Map(), detailSignature: '', warningSignature: '', loaded: false, initialScroll: true, listWarnings: [], toastTimer: undefined as number | undefined };

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: unknown) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function text(node, value) { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; }
  function renderAvatar(node: HTMLElement, name: string, role: string) {
    if (node.dataset.identity === name) return;
    node.dataset.identity = name;
    const identity = avatarIdentity(name, role);
    node.replaceChildren();
    node.classList.toggle('has-logo', Boolean(identity.icon));
    node.dataset.tone = identity.tone;
    const fallback = () => { node.classList.remove('has-logo'); node.replaceChildren(document.createTextNode(identity.initials)); };
    if (identity.icon) {
      const image = el('img'); image.src = identity.icon; image.alt = ''; image.width = 32; image.height = 32;
      image.addEventListener('error', fallback, { once: true });
      node.append(image);
    } else fallback();
  }
  function date(value, mode = 'full') {
    if (!value) return 'Unknown time';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'Unknown time';
    if (mode === 'clock') return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    if (mode === 'short') return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function badge(node, value) { text(node, stateLabels[value] || value || 'Unknown state'); node.dataset.state = value || 'unknown'; }
  function participant(call, role) { return call?.participants?.[role]?.name || (role === 'caller' ? 'Caller' : 'Awaiting answer'); }
  function coverage(call) { return call.coverage === 'relay' ? 'Server records' : call.coverage === 'both' ? 'Both sides recorded' : call.coverage === 'callee' ? 'Callee records' : 'Caller records'; }
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
    if (/^ac_/i.test(value)) throw new Error('Enter the Session from the invitation. IDs starting with ac_ are local session IDs.');
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid Session. Copy the complete ID from the invitation.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter a valid Session or viewing link.');
    if (url.origin !== location.origin) throw new Error('This link belongs to another server. Open the original link to view it.');
    if (!/^\/view\/?$/.test(url.pathname) || url.search) throw new Error('This is not a viewing link. Copy the Session from the invitation.');
    const params = new URLSearchParams(url.hash.slice(1));
    if (params.has('session')) {
      const session = params.get('session');
      if (params.getAll('session').length !== 1 || Array.from(params.keys()).some((key) => key !== 'session') || !sessionPattern.test(session || '')) throw new Error('The viewing link contains an incomplete Session.');
      return parseViewLink(session);
    }
    const callId = params.get('call');
    const token = params.get('token');
    if (params.getAll('call').length !== 1 || params.getAll('token').length !== 1 || Array.from(params.keys()).some((key) => key !== 'call' && key !== 'token') || !sessionPattern.test(callId || '') || !/^acv_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('Incomplete viewing link. Copy the Session from the invitation.');
    return { callId, token, kind: 'legacy', hash: url.hash };
  }
  function retentionNote(source: NonNullable<CallDetails['source']> = {}) {
    const ms = Number(source.retentionMs);
    const duration = Number.isFinite(ms) && ms > 0 ? (ms >= 3600000 ? `${Number((ms / 3600000).toFixed(1))} hours` : `${Math.ceil(ms / 60000)} minutes`) : 'a limited time';
    const ending = source.availableUntil ? `These records are available until ${date(source.availableUntil)}. ` : `Records are retained after the call for ${duration}. `;
    return `Records are stored in server memory and are lost on restart. ${ending}`;
  }
  function nearBottom() { const s = ui.messageScroll; return s.scrollHeight - s.scrollTop - s.clientHeight < 90; }
  function scrollBottom() { ui.messageScroll.scrollTop = ui.messageScroll.scrollHeight; ui.jumpToLatest.hidden = true; }

  async function json(path, access: ViewAccess | null = null) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (access) headers.Authorization = `Bearer ${access.token}`;
    const response = await fetch(path, { headers, cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      const message = access && response.status === 401 ? 'Invalid Session or viewing link. The records may have expired or been cleared on restart.' : access && response.status === 404 ? 'Call not found. The records may have expired or been cleared on restart.' : `Unable to load records (HTTP ${response.status}). Make sure the ${access ? 'relay server' : 'record viewer'} is still running.`;
      const error = Object.assign(new Error(message), { status: response.status }); throw error;
    }
    const result = await response.json();
    if (!result || typeof result !== 'object') throw new Error('The server returned unrecognized data. Refresh to try again.');
    return result;
  }
  function showError(error) { text(ui.apiError, error instanceof Error ? error.message : `Unable to load ${remoteMode ? 'server' : 'local'} records. Refresh to try again.`); ui.apiError.hidden = false; text(ui.refreshStatus, 'Unable to load · Try refreshing'); }
  function warnings(node, items) {
    const signature = JSON.stringify(items || []);
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.replaceChildren();
    for (const item of items || []) node.append(el('p', '', item.message || item.code || 'Some local records could not be read.'));
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
      text(node.querySelector('.call-item-title'), call.purpose || 'Untitled call');
      text(node.querySelector('.call-item-people'), `${participant(call, 'caller')} ↔ ${participant(call, 'callee')}`);
      text(node.querySelector('.call-item-preview'), call.preview || 'No messages yet');
      text(node.querySelector('.call-item-coverage'), coverage(call));
      text(node.querySelector('.call-item-count'), `${call.messageCount ?? 0} messages`);
      node.classList.toggle('is-selected', call.key === state.selected);
      node.setAttribute('aria-current', call.key === state.selected ? 'true' : 'false');
      node.setAttribute('aria-label', `${call.purpose || 'Untitled call'}, ${stateLabels[call.state] || 'Unknown state'}, ${participant(call, 'caller')} and ${participant(call, 'callee')}`);
      if (ui.callList.children[index] !== node) ui.callList.insertBefore(node, ui.callList.children[index] || null);
    });
    const allKeys = new Set(state.calls.map((call) => call.key));
    for (const key of state.listNodes.keys()) if (!allKeys.has(key)) state.listNodes.delete(key);
    ui.listEmpty.hidden = visible.length > 0;
    text(ui.listEmpty, state.calls.length ? 'No matching calls. Try another search.' : remoteMode ? 'Enter a Session to open a call.' : 'No local call records yet.');
  }

  function safeRichText(container, content) {
    container.replaceChildren();
    const lines = String(content ?? '').split('\n');
    let plain: string[] = [], code: string[] = [], language = '', fenced = false;
    const appendPlain = () => { if (plain.length) { container.append(el('p', 'text-block', plain.join('\n'))); plain = []; } };
    const appendCode = () => {
      const block = el('div', 'code-block');
      const heading = el('div', 'code-heading');
      const copy = el('button', 'copy-code', 'Copy code'); copy.type = 'button';
      const raw = code.join('\n');
      copy.addEventListener('click', () => copyText(raw, 'Code copied'));
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
    text(ui.presenceStatus, waiting ? 'Calling another agent' : connected ? 'Both agents are connected' : stateLabels[call.state] || 'Unknown call state');
    text(ui.presenceNote, waiting ? 'Invitation sent. Waiting for the other agent to join.' : connected ? 'Their conversation will appear here' : 'The call records appear below');
    if (!remoteMode) text(ui.presenceNote, 'Last observed state in local records');
    const expiry = waiting && remoteMode && call.expiresAt && !Number.isNaN(new Date(call.expiresAt).getTime());
    ui.presenceExpiry.hidden = !expiry;
    if (expiry) { text(ui.presenceExpiry, `Invitation expires at ${date(call.expiresAt, 'clock')}`); ui.presenceExpiry.dateTime = call.expiresAt; }
    else { text(ui.presenceExpiry, ''); ui.presenceExpiry.removeAttribute('datetime'); }
    if (joining) presenceTimer = setTimeout(finishJoining, 1500);
  }
  function updateHeader(detail) {
    const call = detail.call;
    const signature = JSON.stringify({ call, sessions: detail.sessions, warnings: detail.warnings, source: detail.source });
    if (state.detailSignature === signature) return;
    state.detailSignature = signature;
    text(ui.callPurpose, call.purpose || 'Untitled call');
    badge(ui.callState, call.state);
    badge(ui.infoState, call.state);
    ui.topbarCall.setAttribute('aria-label', `${participant(call, 'caller')} and ${participant(call, 'callee')}, ${stateLabels[call.state] || 'Unknown state'}. View call details and context`);
    ui.callState.title = remoteMode ? 'Server state at the last refresh' : 'Last locally recorded state; the current server state may differ';
    text(ui.callCreated, `Started ${date(call.createdAt)}`);
    text(ui.callShortId, `Session ${call.callId || '—'}`);
    ui.callShortId.title = call.callId || '';
    text(ui.callerName, participant(call, 'caller'));
    text(ui.calleeName, participant(call, 'callee'));
    for (const role of ['caller', 'callee']) {
      for (const id of [`${role}Avatar`, `${role}PresenceAvatar`]) renderAvatar($(id), participant(call, role), role);
    }
    const roles = new Set((detail.sessions || []).map((session) => session.role));
    text(ui.callerSource, remoteMode ? 'Recorded by the server' : roles.has('caller') ? 'Recorded on this device' : 'From peer messages');
    text(ui.calleeSource, remoteMode ? call.participants?.callee ? 'Recorded by the server' : 'Waiting for the other agent' : roles.has('callee') ? 'Recorded on this device' : call.participants?.callee ? 'From peer messages' : 'Waiting for the other agent');
    text(ui.coverageNote, remoteMode ? `Shows all messages and events sent to the server during this call. ${retentionNote(detail.source)}` : call.coverage === 'both' ? `Merged ${call.localSessionCount || detail.sessions.length} local session records. Each event appears once.` : `Only ${call.coverage === 'callee' ? 'Callee' : 'Caller'} records are available locally. Messages not observed by this side may be missing.`);
    const context = typeof call.context === 'string' ? call.context : call.context ? JSON.stringify(call.context, null, 2) : '';
    if (ui.callContext.dataset.value !== context) { safeRichText(ui.callContext, context || 'No context was provided for this call.'); ui.callContext.dataset.value = context; }
    text(ui.contextHint, context ? `${context.length.toLocaleString()} characters` : 'Not provided');
    warnings(ui.detailWarnings, detail.warnings);
    text(ui.recordNote, `${remoteMode ? 'Server records' : 'Locally observed records'} · ${call.eventCount ?? detail.events.length} events · ${remoteMode ? 'All events from both sides' : coverage(call)}`);
    if (remoteMode) text(ui.sourceDescription, retentionNote(detail.source));
    document.title = `${call.purpose || 'Call records'} · NokNok`;
  }

  function createEvent(event, detail) {
    const data = event.data || {};
    if (event.from === 'system') {
      const node = el('div', 'system-event'); node.setAttribute('role', 'listitem'); node.dataset.seq = event.seq;
      const content = el('div', 'system-event-content');
      const names = data.participants || detail.call.participants;
      let label = event.type === 'joined' ? `${names?.callee?.name || 'Callee'} joined the call` : event.type === 'closed' ? `Call ${stateLabels[data.state] || 'ended'}` : typeLabels[event.type] || event.type;
      if (event.type === 'closed' && data.reason === 'both_participants_finished') label = 'Both sides confirmed completion · Call ended';
      const time = el('time', '', date(event.at, 'clock')); time.title = date(event.at); if (event.at) time.dateTime = event.at;
      content.append(el('span', '', label), time);
      const reason = data.text || (data.reason && data.reason !== 'both_participants_finished' ? data.reason : '');
      if (reason) content.append(el('span', 'system-reason', reason));
      node.append(content); return node;
    }
    const node = el('div', 'message'); node.dataset.role = event.from; node.dataset.type = event.type; node.dataset.seq = event.seq; node.setAttribute('role', 'listitem');
    const heading = el('div', 'message-heading');
    const time = el('time', 'message-time', date(event.at, 'clock')); time.title = date(event.at); if (event.at) time.dateTime = event.at;
    const avatar = el('span', 'agent-avatar message-avatar'); avatar.setAttribute('aria-hidden', 'true');
    renderAvatar(avatar, participant(detail.call, event.from), event.from);
    heading.append(el('strong', '', participant(detail.call, event.from)));
    if (event.type !== 'message') heading.append(el('span', 'message-type', typeLabels[event.type] || event.type));
    heading.append(time);
    const bubble = el('div', 'message-bubble');
    safeRichText(bubble, data.text ?? '(No text content)');
    const provenance = el('div', 'message-provenance');
    const sources = new Set((event.observedBy || []).map((id) => detail.sessions.find((session) => session.id === id)?.role).filter(Boolean));
    const sourceLabel = remoteMode ? 'Server records' : sources.has('caller') && sources.has('callee') ? 'Recorded by both sides' : sources.has('callee') ? 'Callee records' : sources.has('caller') ? 'Caller records' : 'Local records';
    provenance.append(el('span', 'message-seq', `#${event.seq}`), el('span', '', `${event.from === 'caller' ? 'Caller' : 'Callee'} · ${sourceLabel}`));
    if (data.replyTo) provenance.append(el('span', '', `Reply to ${data.replyTo}`));
    const metadata = el('details', 'message-details');
    const summary = el('summary', '', '···'); summary.setAttribute('aria-label', `View message ${event.seq} record details`); summary.title = 'Message record details';
    metadata.append(summary, provenance); heading.append(metadata);
    const body = el('div', 'message-body'); body.append(heading, bubble);
    node.append(avatar, body); return node;
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
    const events = detail.events.filter((event) => (role === 'all' || event.from === role) && [event.data?.text, event.data?.reason, typeLabels[event.type], event.type, event.from === 'system' ? 'System' : participant(detail.call, event.from)].join(' ').toLocaleLowerCase().includes(query));
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
    text(ui.messageCount, query || role !== 'all' ? `${events.length} / ${detail.events.length} events` : `${detail.events.length} records`);
    ui.filterNotice.hidden = !query && role === 'all';
    text(ui.filterNoticeText, `Filtered · ${events.length} events`);
    ui.toolsToggle.classList.toggle('has-filter', Boolean(query || role !== 'all'));
    ui.messagesEmpty.hidden = events.length > 0 || (!detail.events.length && detail.call.state === 'waiting');
    text(ui.messagesEmpty, detail.events.length ? 'No matching messages. Try another search or source filter.' : 'No messages yet. Records will appear after agents connect and exchange messages.');
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
    document.title = 'NokNok · Call records';
    for (const id of ['callPurpose', 'callState', 'infoState', 'callCreated', 'callShortId', 'callerName', 'calleeName', 'callerSource', 'calleeSource', 'coverageNote', 'contextHint', 'recordNote', 'messageCount', 'apiError']) text(ui[id], '');
    delete ui.infoState.dataset.state;
    ui.topbarCall.setAttribute('aria-label', 'View call details and context');
    ui.callState.removeAttribute('title'); delete ui.callState.dataset.state;
    ui.callShortId.removeAttribute('title');
    ui.callContext.replaceChildren(); delete ui.callContext.dataset.value; ui.contextDetails.open = false;
    ui.detailWarnings.replaceChildren(); delete ui.detailWarnings.dataset.signature; ui.detailWarnings.hidden = true;
    text(ui.sourceDescription, 'Records are stored in server memory and are lost on restart. They remain available for a limited time after the call.');
  }
  async function loadDetail(key) {
    const request = ++state.detailRequest;
    const access = remoteMode ? viewAccess : null;
    if (remoteMode && (!access || key !== access.callId)) return;
    try {
      const path = remoteMode && access?.kind === 'session' ? '/v1/session-view' : `${remoteMode ? '/v1/views/' : '/api/calls/'}${encodeURIComponent(key)}`;
      const detail = await json(path, access);
      if (request !== state.detailRequest || key !== state.selected || (remoteMode && access !== viewAccess)) return;
      if (!detail.call || !Array.isArray(detail.events)) throw new Error('Incomplete call data. Refresh to try again.');
      if (remoteMode && detail.call.callId !== access?.callId) throw new Error('The returned call does not match the viewing link. Refresh to try again.');
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
      if (!state.detail) empty('This call is currently unavailable', remoteMode ? error.message || 'Check the server or enter the Session again.' : 'Check the viewer service or choose another call from the list.');
    }
  }
  async function selectCall(key, { updateHash = true } = {}) {
    if (!key) return;
    if (state.selected !== key) {
      resetPresence();
      state.selected = key; state.detail = null; state.detailSignature = ''; state.eventNodes.clear(); state.initialScroll = true;
      ui.messageList.replaceChildren(); ui.messageSearch.value = ''; ui.roleFilter.value = 'all'; ui.contextDetails.open = false; ui.callContext.dataset.value = '';
      ui.apiError.hidden = true; ui.jumpToLatest.hidden = true;
      empty('Opening call', remoteMode ? 'Loading both agents’ messages and events from the server.' : 'Loading locally observed messages and events.');
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
        if (access === viewAccess && ui.apiError.hidden) text(ui.refreshStatus, `${state.auto ? 'Updated' : 'Auto-refresh paused'} · ${date(new Date().toISOString(), 'clock')}`);
        return;
      }
      const data = await json('/api/calls');
      state.calls = Array.isArray(data.calls) ? data.calls.slice().sort((a, b) => String(b.lastActivityAt || b.createdAt || '').localeCompare(String(a.lastActivityAt || a.createdAt || ''))) : [];
      state.loaded = true;
      text(ui.sourceDirectory, data.source?.directory || 'Path unavailable');
      warnings(ui.listWarnings, data.warnings);
      renderCalls();
      ui.apiError.hidden = true;
      if (!state.selected) {
        const key = hashKey() || state.calls[0]?.key;
        if (key) await selectCall(key); else empty('No call records yet', 'Create or accept a NokNok call, then refresh. Messages received by the CLI are saved locally and appear here.');
      } else await loadDetail(state.selected);
      if (ui.apiError.hidden) text(ui.refreshStatus, `${state.auto ? 'Updated' : 'Auto-refresh paused'} · ${date(new Date().toISOString(), 'clock')}`);
    } catch (error) { showError(error); if (!state.loaded) empty(`Unable to load ${remoteMode ? 'server' : 'local'} records`, 'Make sure the viewer is running, then open Search and export and select Refresh now.'); }
    finally { state.refreshing = false; ui.refreshButton.disabled = false; }
  }
  async function copyText(value, success = 'Conversation copied') {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const previous = document.activeElement;
        const area = el('textarea', '', value); area.style.position = 'fixed'; area.style.opacity = '0'; area.setAttribute('aria-label', 'Copy content'); document.body.append(area); area.select();
        const copied = document.execCommand('copy'); area.remove(); if (previous instanceof HTMLElement) previous.focus(); if (!copied) throw new Error('copy');
      }
      toast(success);
    } catch { toast('Copy failed. Use Download Markdown to save the conversation.'); }
  }
  function markdown() {
    if (!state.detail) return '';
    const { call, events } = state.detail;
    const lines = [`# ${call.purpose || 'NokNok call records'}`, '', `- Call: ${call.callId}`, `- Caller: ${participant(call, 'caller')}`, `- Callee: ${participant(call, 'callee')}`, `- Started: ${date(call.createdAt)}`, `- Last recorded state: ${stateLabels[call.state] || call.state}`, `- Source: ${coverage(call)}; ${remoteMode ? 'All messages and events sent to the server during this call.' : 'Contains locally observed records only.'}`, ''];
    if (call.context) lines.push('## Call context', '', typeof call.context === 'string' ? call.context : JSON.stringify(call.context, null, 2), '');
    lines.push('## Conversation', '');
    for (const event of events) {
      lines.push(`### #${event.seq} · ${event.from === 'system' ? 'System' : participant(call, event.from)} · ${typeLabels[event.type] || event.type} · ${date(event.at)}`, '', event.data?.text || event.data?.reason || typeLabels[event.type] || event.type, '');
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
      empty('Open a call', 'Enter the Session from the invitation to follow the conversation.');
      text(ui.refreshStatus, 'Waiting for a Session');
      document.title = 'NokNok · Call records';
      return;
    }
    text(ui.refreshStatus, 'Loading server records…');
    selectCall(access.callId, { updateHash: false }).then(() => {
      if (access === viewAccess && ui.apiError.hidden) text(ui.refreshStatus, `${state.auto ? 'Updated' : 'Auto-refresh paused'} · ${date(new Date().toISOString(), 'clock')}`);
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
  ui.autoRefresh.addEventListener('click', () => { state.auto = !state.auto; ui.autoRefresh.setAttribute('aria-pressed', String(state.auto)); ui.autoRefresh.setAttribute('aria-label', state.auto ? 'Pause auto-refresh' : 'Enable auto-refresh'); ui.autoRefresh.title = state.auto ? 'Pause auto-refresh' : 'Enable auto-refresh'; text(ui.autoRefreshLabel, state.auto ? 'Auto-refresh' : 'Paused'); text(ui.refreshStatus, state.auto ? 'Auto-refresh enabled' : 'Auto-refresh paused'); toast(state.auto ? 'Auto-refresh enabled' : 'Auto-refresh paused'); if (state.auto) refresh(); });
  ui.jumpToLatest.addEventListener('click', scrollBottom);
  ui.messageScroll.addEventListener('scroll', () => { if (nearBottom()) ui.jumpToLatest.hidden = true; }, { passive: true });
  ui.copyConversation.addEventListener('click', () => { if (state.detail) copyText(markdown()); });
  ui.downloadConversation.addEventListener('click', () => {
    if (!state.detail) return;
    const url = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `noknok-${state.detail.call.callId || 'conversation'}.md`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Conversation downloaded');
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
    ui.sidebar.setAttribute('aria-label', 'Current call');
    ui.callList.setAttribute('aria-label', 'Authorized calls');
    text(ui.sidebarTitle, 'View call'); text(ui.sidebarCaption, 'Current call');
    ui.callSearchField.hidden = true; ui.remoteAccess.hidden = false; ui.sourceDetails.hidden = true;
    text(ui.sourceLabel, 'Server records · Read only');
    text(ui.emptyNote, 'Viewing does not join the call. Share the Session only with intended viewers.');
    text(ui.emptyAction, 'Enter Session');
    text(ui.stateNote, 'State at the last refresh');
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
