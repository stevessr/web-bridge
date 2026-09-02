const statusEl = document.querySelector('#status');
const metaEl = document.querySelector('#meta');
const viewport = document.querySelector('#viewport');
const stage = document.querySelector('#stage');
const scaler = document.querySelector('#scaler');
const screenTabs = document.querySelector('#screen-tabs');
const takeControlButton = document.querySelector('#take-control');
const resyncButton = document.querySelector('#resync');
const zoomOutButton = document.querySelector('#zoom-out');
const zoomInButton = document.querySelector('#zoom-in');
const fitViewButton = document.querySelector('#fit-view');
const fullscreenButton = document.querySelector('#fullscreen');
const retryButton = document.querySelector('#retry');
const scaleLabel = document.querySelector('#scale-label');
const viewerScale = document.querySelector('#viewer-scale');
const viewerMode = document.querySelector('#viewer-mode');
const connectionTitle = document.querySelector('#connection-title');
const connectionDetail = document.querySelector('#connection-detail');
const browserEndpoint = document.querySelector('#browser-endpoint');
const hostState = document.querySelector('#host-state');
const nodes = new Map();
const fontStyle = document.createElement('style');
fontStyle.id = 'web-bridge-font-faces';
document.head.append(fontStyle);

let snapshot = null;
let revision = 0;
let activeNodeId = null;
let activeScreenId = null;
let screens = [];
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 500;
let lastPointerSent = 0;
let hasControl = false;
let attached = false;
let socketOpen = false;
let instanceId = null;
let lastKeyboardInputAt = 0;
let fitMode = true;
let manualScale = 1;
let currentScale = 1;

const SCREEN_SCOPED_TYPES = new Set([
  'resync', 'takeControl', 'releaseControl', 'fileCommit', 'focus', 'select',
  'pointer', 'click', 'wheel', 'key', 'text'
]);

if (browserEndpoint) browserEndpoint.textContent = location.host || '本机';

function updateConnectionCopy(kind) {
  const copies = {
    connecting: ['正在连接桥接服务', '正在建立本地 WebSocket 连接。', '连接中'],
    disconnected: ['桥接服务已断开', '连接已中断，Web Bridge 会自动重试。', '已断开'],
    waiting: ['等待宿主 QQ NT', '桥接服务已经就绪，正在等待可用的 QQ Screen。', '等待 QQ'],
    syncing: ['正在同步 QQ Screen', '已选择 QQ 窗口，正在获取完整界面与初始状态。', '同步中'],
    error: ['连接出现问题', 'Web Bridge 暂时无法完成同步，可立即重试。', '异常'],
    ready: ['QQ Screen 已连接', '当前 QQ 窗口已经准备就绪。', hasControl ? '可控制' : '只读']
  };
  const [title, detail, host] = copies[kind] || copies.connecting;
  if (connectionTitle) connectionTitle.textContent = title;
  if (connectionDetail) connectionDetail.textContent = detail;
  if (hostState) hostState.textContent = host;
}

function updateControls() {
  document.body.dataset.control = hasControl ? 'granted' : attached ? 'readonly' : 'none';
  if (takeControlButton) {
    takeControlButton.disabled = !socketOpen || !attached || hasControl;
    const label = takeControlButton.querySelector('.button-label');
    if (label) label.textContent = hasControl ? '已接管' : '接管控制';
    takeControlButton.title = hasControl ? '当前客户端拥有这个 Screen 的控制权' : '请求当前 Screen 控制权';
  }
  if (resyncButton) resyncButton.disabled = !socketOpen || !attached;
  const canScale = Boolean(snapshot?.viewport);
  if (zoomOutButton) zoomOutButton.disabled = !canScale;
  if (zoomInButton) zoomInButton.disabled = !canScale;
  if (fitViewButton) fitViewButton.disabled = !canScale;
}

function setStatus(text, ok, kind = ok ? 'ready' : 'error') {
  statusEl.textContent = text;
  document.body.dataset.connected = ok ? 'true' : 'false';
  document.body.dataset.status = kind;
  updateConnectionCopy(kind);
  updateControls();
}

function screenLabel(screen, index = 0) {
  const label = String(screen?.label || screen?.title || '').trim();
  if (label) return label.length > 64 ? `${label.slice(0, 61)}…` : label;
  return `Screen ${index + 1}`;
}

function renderScreenTabs(nextScreens, selectedId) {
  screens = Array.isArray(nextScreens) ? nextScreens : [];
  if (!screenTabs) return;
  screenTabs.hidden = screens.length <= 1;
  const fragment = document.createDocumentFragment();
  screens.forEach((screen, index) => {
    const id = String(screen.id || '');
    if (!id) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'screen-tab';
    button.dataset.screenId = id;
    button.dataset.ready = String(Boolean(screen.ready));
    button.dataset.visible = String(Boolean(screen.visible));
    button.dataset.focused = String(Boolean(screen.focused));
    button.classList.toggle('active', id === selectedId);
    button.setAttribute('aria-pressed', String(id === selectedId));
    button.title = `${screenLabel(screen, index)} · Alt+${index + 1}`;

    const dot = document.createElement('span');
    dot.className = 'screen-tab-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'screen-tab-label';
    label.textContent = screenLabel(screen, index);
    button.append(dot, label);
    button.addEventListener('click', () => requestScreen(id));
    fragment.append(button);
  });
  screenTabs.replaceChildren(fragment);
  const active = screenTabs.querySelector('.screen-tab.active');
  active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function unregisterTree(node) {
  if (!node) return;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const id = Number(node.dataset?.wbId);
    if (Number.isFinite(id)) nodes.delete(id);
    if (node.shadowRoot) for (const child of [...node.shadowRoot.childNodes]) unregisterTree(child);
  }
  for (const child of [...node.childNodes]) unregisterTree(child);
}

function clearStage() {
  for (const child of [...stage.childNodes]) unregisterTree(child);
  nodes.clear();
  stage.replaceChildren();
  fontStyle.textContent = '';
  snapshot = null;
  revision = 0;
  activeNodeId = null;
  stage.style.width = '';
  stage.style.height = '';
  scaler.style.width = '';
  scaler.style.height = '';
}

function requestScreen(screenId) {
  const id = String(screenId || '');
  if (!id || id === activeScreenId) return;
  activeScreenId = id;
  try { sessionStorage.setItem('web-bridge-screen', id); } catch {}
  clearStage();
  attached = false;
  hasControl = false;
  renderScreenTabs(screens, id);
  setStatus('正在切换 QQ Screen…', false, 'syncing');
  send({ type: 'selectScreen', screenId: id });
}

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socketOpen = false;
  attached = false;
  hasControl = false;
  setStatus('正在连接桥接服务…', false, 'connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('open', () => {
    socketOpen = true;
    reconnectDelay = 500;
    setStatus('桥接服务已连接 · 正在发现 QQ Screen', false, 'waiting');
    const remembered = (() => { try { return sessionStorage.getItem('web-bridge-screen'); } catch { return null; } })();
    if (remembered) send({ type: 'selectScreen', screenId: remembered });
    else send({ type: 'resync' });
  });
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', () => {
    socketOpen = false;
    attached = false;
    hasControl = false;
    setStatus('桥接服务已断开 · 正在重连', false, 'disconnected');
    const delay = reconnectDelay + Math.random() * reconnectDelay * 0.2;
    reconnectDelay = Math.min(10000, reconnectDelay * 1.7);
    reconnectTimer = setTimeout(connect, delay);
  });
  socket.addEventListener('error', () => socket.close());
}

function onMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'status') {
    if (instanceId && message.instanceId && instanceId !== message.instanceId) {
      clearStage();
      activeScreenId = null;
    }
    instanceId = message.instanceId || instanceId;
    const nextScreenId = message.activeScreenId ? String(message.activeScreenId) : null;
    if (nextScreenId && activeScreenId !== nextScreenId) {
      activeScreenId = nextScreenId;
      clearStage();
      try { sessionStorage.setItem('web-bridge-screen', nextScreenId); } catch {}
    }
    renderScreenTabs(message.screens, activeScreenId);
    attached = Boolean(message.attached);
    hasControl = message.control === 'granted';
    if (attached) {
      const ready = Boolean(snapshot?.root);
      const count = Number(message.screenCount || message.screens?.length || 1);
      setStatus(hasControl ? `QQ Screen 已连接 · 可控制 · ${count} 屏` : `QQ Screen 已连接 · 只读 · ${count} 屏`, ready, ready ? 'ready' : 'syncing');
      metaEl.textContent = `${message.target?.title || 'QQ NT'} · r${message.revision ?? revision}`;
    } else if (screens.length) {
      setStatus('正在连接所选 QQ Screen…', false, 'syncing');
      metaEl.textContent = '';
    } else {
      setStatus('等待宿主 QQ NT…', false, 'waiting');
      metaEl.textContent = '';
    }
    return;
  }
  if (message.type === 'snapshot') {
    if (message.screenId && activeScreenId && String(message.screenId) !== activeScreenId) return;
    if (message.screenId) activeScreenId = String(message.screenId);
    renderSnapshot(message.snapshot);
    return;
  }
  if (message.type === 'patch') {
    if (message.screenId && activeScreenId && String(message.screenId) !== activeScreenId) return;
    if (message.baseRevision !== revision) {
      setStatus('Screen 版本发生变化 · 正在重新同步', false, 'syncing');
      send({ type: 'resync' });
      return;
    }
    applyPatchBatch(message);
    return;
  }
  if (message.type === 'resyncRequired') {
    if (message.screenId && activeScreenId && String(message.screenId) !== activeScreenId) return;
    setStatus('宿主要求重新同步当前 Screen…', false, 'syncing');
    send({ type: 'resync' });
    return;
  }
  if (message.type === 'screenUnavailable') {
    setStatus('所选 QQ Screen 已关闭 · 正在切换', false, 'syncing');
    return;
  }
  if (message.type === 'controlDenied') {
    hasControl = false;
    setStatus('当前 Screen 正由另一客户端控制', true, 'ready');
    return;
  }
  if (message.type === 'rateLimited') setStatus('输入过快 · 已临时限流', true, 'ready');
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  let payload = message;
  if (activeScreenId && SCREEN_SCOPED_TYPES.has(message?.type) && !message.screenId) {
    payload = { ...message, screenId: activeScreenId };
  }
  socket.send(JSON.stringify(payload));
}

function clearAttributes(element) {
  for (const attr of [...element.attributes]) {
    if (attr.name === 'data-wb-id') continue;
    try { element.removeAttribute(attr.name); } catch {}
  }
}

function setAttributes(element, node) {
  clearAttributes(element);
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (/^on/i.test(name) || name === 'srcdoc') continue;
    try {
      if (name === 'readonly') continue;
      element.setAttribute(name, String(value));
    } catch {}
  }
  element.dataset.wbId = String(node.id);
}

function setStyles(element, node) {
  element.style.cssText = '';
  for (const [property, value] of Object.entries(node.style ?? {})) {
    try { element.style.setProperty(property, value); } catch {}
  }
}

function isTextLikeInput(element) {
  if (!(element instanceof HTMLInputElement)) return element instanceof HTMLTextAreaElement;
  return !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(element.type);
}

function setState(element, node) {
  const state = node.state ?? {};
  if (element instanceof HTMLMediaElement) {
    if (typeof state.muted === 'boolean') element.muted = state.muted;
    if (typeof state.volume === 'number') element.volume = Math.min(1, Math.max(0, state.volume));
    if (typeof state.playbackRate === 'number' && state.playbackRate > 0) element.playbackRate = state.playbackRate;
    if (typeof state.loop === 'boolean') element.loop = state.loop;
    if (typeof state.currentTime === 'number' && Number.isFinite(element.duration) && Math.abs(element.currentTime - state.currentTime) > 0.75) { try { element.currentTime = state.currentTime; } catch {} }
    if (state.paused === false && element.paused) element.play().catch(() => {});
    if (state.paused === true && !element.paused) element.pause();
  }
  if (element instanceof HTMLInputElement) {
    if (state.type === 'password' || state.type === 'file') element.value = '';
    else if (typeof state.value === 'string' && element.value !== state.value) element.value = state.value;
    if (typeof state.checked === 'boolean') element.checked = state.checked;
    if (typeof state.disabled === 'boolean') element.disabled = state.disabled;
    element.readOnly = false;
  } else if (element instanceof HTMLTextAreaElement) {
    if (typeof state.value === 'string' && element.value !== state.value) element.value = state.value;
    if (typeof state.disabled === 'boolean') element.disabled = state.disabled;
    element.readOnly = false;
  } else if (element instanceof HTMLSelectElement) {
    if (Number.isInteger(state.selectedIndex) && element.selectedIndex !== state.selectedIndex) element.selectedIndex = state.selectedIndex;
    if (typeof state.disabled === 'boolean') element.disabled = state.disabled;
  }
  if (typeof state.scrollLeft === 'number' && Math.abs(element.scrollLeft - state.scrollLeft) > 1) element.scrollLeft = state.scrollLeft;
  if (typeof state.scrollTop === 'number' && Math.abs(element.scrollTop - state.scrollTop) > 1) element.scrollTop = state.scrollTop;
}

function drawSurface(element, surface) {
  if (!(element instanceof HTMLCanvasElement) || !surface) return;
  const image = new Image();
  image.onload = () => {
    try {
      if (!element.width) element.width = image.naturalWidth;
      if (!element.height) element.height = image.naturalHeight;
      element.getContext('2d')?.drawImage(image, 0, 0, element.width, element.height);
    } catch {}
  };
  image.src = surface;
}

function buildNode(node) {
  if (!node) return document.createTextNode('');
  if (node.type === 'text') {
    const text = document.createTextNode(node.text ?? '');
    nodes.set(Number(node.id), text);
    return text;
  }
  let element;
  try {
    if (node.ns && node.ns !== 'http://www.w3.org/1999/xhtml') element = document.createElementNS(node.ns, node.tag || 'g');
    else element = document.createElement(node.tag === 'body' || node.tag === 'html' ? 'div' : (node.tag || 'div'));
  } catch { element = document.createElement('div'); }
  nodes.set(Number(node.id), element);
  setAttributes(element, node);
  setStyles(element, node);
  for (const child of node.children ?? []) element.append(buildNode(child));
  if (node.shadow) replaceShadow(element, node.shadow);
  setState(element, node);
  drawSurface(element, node.surface);
  return element;
}

function replaceShadow(element, children) {
  let root = element.shadowRoot;
  if (!root) {
    try { root = element.attachShadow({ mode: 'open' }); } catch { return; }
  }
  for (const child of [...root.childNodes]) unregisterTree(child);
  root.replaceChildren(...(children ?? []).map(buildNode));
}

function renderSnapshot(next) {
  if (!next?.root) return;
  const previousActive = activeNodeId;
  for (const child of [...stage.childNodes]) unregisterTree(child);
  nodes.clear();
  stage.replaceChildren(buildNode(next.root));
  snapshot = next;
  revision = Number(next.revision) || 0;
  applyMeta(next);
  if (previousActive) focusMirror(previousActive);
  attached = true;
  setStatus(hasControl ? 'QQ Screen 已连接 · 可控制' : 'QQ Screen 已连接 · 只读', true, 'ready');
}

function applyMeta(meta) {
  if (Array.isArray(meta.fontFaces)) fontStyle.textContent = meta.fontFaces.join('\n');
  if (meta.title) document.title = `${meta.title} · Web Bridge`;
  const sourceViewport = meta.viewport || snapshot?.viewport;
  if (sourceViewport) {
    snapshot = { ...(snapshot || {}), ...meta, viewport: sourceViewport };
    const width = Math.max(1, Number(sourceViewport.width) || 1);
    const height = Math.max(1, Number(sourceViewport.height) || 1);
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    scaler.style.width = `${width}px`;
    scaler.style.height = `${height}px`;
    fitStage();
  }
  metaEl.textContent = `${meta.title || snapshot?.title || 'QQ NT'} · r${revision}`;
  updateControls();
}

function applyPatchBatch(message) {
  const previousActive = activeNodeId;
  for (const patch of message.patches ?? []) {
    const target = nodes.get(Number(patch.id));
    if (!target) {
      setStatus('界面状态失配 · 正在重新同步', false, 'syncing');
      send({ type: 'resync' });
      return;
    }
    if (patch.op === 'text') {
      if (target.nodeType !== Node.TEXT_NODE) { send({ type: 'resync' }); return; }
      target.nodeValue = patch.text ?? '';
      continue;
    }
    if (!(target instanceof Element)) { send({ type: 'resync' }); return; }
    if (patch.op === 'children') {
      for (const child of [...target.childNodes]) unregisterTree(child);
      target.replaceChildren(...(patch.children ?? []).map(buildNode));
      if ('shadow' in patch) replaceShadow(target, patch.shadow ?? []);
      continue;
    }
    if (patch.op === 'update') {
      setAttributes(target, patch);
      setStyles(target, patch);
      setState(target, patch);
      if ('shadow' in patch) replaceShadow(target, patch.shadow ?? []);
      drawSurface(target, patch.surface);
      continue;
    }
  }
  revision = Number(message.revision) || revision;
  if (message.meta) applyMeta(message.meta);
  else metaEl.textContent = `${snapshot?.title || 'QQ NT'} · r${revision}`;
  if (previousActive) focusMirror(previousActive);
}

function clampScale(value) {
  return Math.min(2, Math.max(.25, value));
}

function fitStage() {
  if (!snapshot?.viewport || !viewport) return;
  const availableWidth = Math.max(1, viewport.clientWidth);
  const availableHeight = Math.max(1, viewport.clientHeight);
  const sourceWidth = Math.max(1, Number(snapshot.viewport.width) || 1);
  const sourceHeight = Math.max(1, Number(snapshot.viewport.height) || 1);
  const autoScale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight, 1);
  const scale = fitMode ? autoScale : clampScale(manualScale);
  currentScale = scale;
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  const offsetX = Math.max(0, (availableWidth - scaledWidth) / 2);
  const offsetY = Math.max(0, (availableHeight - scaledHeight) / 2);
  scaler.style.transform = `scale(${scale})`;
  scaler.style.left = `${offsetX}px`;
  scaler.style.top = `${offsetY}px`;
  viewport.style.setProperty('--scaled-width', `${Math.max(availableWidth, scaledWidth + offsetX * 2)}px`);
  viewport.style.setProperty('--scaled-height', `${Math.max(availableHeight, scaledHeight + offsetY * 2)}px`);
  const percent = `${Math.round(scale * 100)}%`;
  if (scaleLabel) scaleLabel.textContent = fitMode ? '适应' : percent;
  if (viewerScale) viewerScale.textContent = percent;
  if (viewerMode) viewerMode.textContent = fitMode ? '自动适应' : '手动缩放';
  if (fitViewButton) {
    fitViewButton.classList.toggle('active', fitMode);
    fitViewButton.setAttribute('aria-pressed', String(fitMode));
  }
}

function setManualScale(value) {
  if (fitMode) manualScale = currentScale;
  fitMode = false;
  manualScale = clampScale(value);
  fitStage();
}

function elementFromEvent(event) {
  for (const item of event.composedPath?.() ?? []) {
    if (item instanceof Element && item.dataset?.wbId) return item;
  }
  return event.target instanceof Element ? event.target.closest?.('[data-wb-id]') : null;
}

function remoteTarget(event) {
  const element = elementFromEvent(event);
  if (!element) return null;
  const nodeId = Number(element.dataset.wbId);
  if (!Number.isFinite(nodeId)) return null;
  const rect = element.getBoundingClientRect();
  return {
    element, nodeId,
    nx: rect.width ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0.5,
    ny: rect.height ? Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) : 0.5
  };
}

function modifiers(event) {
  return { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey };
}

function focusMirror(id) {
  const target = nodes.get(Number(id));
  if (target instanceof HTMLElement) {
    try { target.focus({ preventScroll: true }); } catch {}
  }
}

stage.addEventListener('pointerdown', (event) => {
  const target = remoteTarget(event);
  if (!target || !hasControl) return;
  activeNodeId = target.nodeId;
  if (target.element instanceof HTMLElement) {
    try { target.element.focus({ preventScroll: true }); } catch {}
  }
  send({ type: 'focus', nodeId: target.nodeId });
}, true);

stage.addEventListener('click', (event) => {
  const target = remoteTarget(event);
  if (!target || !hasControl) return;
  if (target.element instanceof HTMLSelectElement || target.element instanceof HTMLInputElement && target.element.type === 'file') return;
  event.preventDefault(); event.stopPropagation();
  activeNodeId = target.nodeId;
  send({ type: 'click', nodeId: target.nodeId, nx: target.nx, ny: target.ny, button: event.button, modifiers: modifiers(event) });
}, true);

stage.addEventListener('contextmenu', (event) => {
  const target = remoteTarget(event);
  if (!target || !hasControl) return;
  event.preventDefault(); event.stopPropagation(); activeNodeId = target.nodeId;
  send({ type: 'click', nodeId: target.nodeId, nx: target.nx, ny: target.ny, button: 2, modifiers: modifiers(event) });
}, true);

stage.addEventListener('pointermove', (event) => {
  if (!hasControl) return;
  const now = performance.now();
  if (now - lastPointerSent < 40) return;
  const target = remoteTarget(event);
  if (!target) return;
  lastPointerSent = now;
  send({ type: 'pointer', nodeId: target.nodeId, nx: target.nx, ny: target.ny, modifiers: modifiers(event) });
}, true);

stage.addEventListener('wheel', (event) => {
  const target = remoteTarget(event);
  if (!target || !hasControl) return;
  event.preventDefault();
  send({ type: 'wheel', nodeId: target.nodeId, nx: target.nx, ny: target.ny, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) });
}, { capture: true, passive: false });

stage.addEventListener('change', async (event) => {
  if (!hasControl) return;
  if (event.target instanceof HTMLSelectElement) {
    const id = Number(event.target.dataset.wbId);
    if (Number.isFinite(id)) send({ type: 'select', nodeId: id, index: event.target.selectedIndex });
    return;
  }
  if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
    const id = Number(event.target.dataset.wbId);
    const files = [...(event.target.files || [])];
    const uploadScreenId = activeScreenId;
    if (!Number.isFinite(id) || !files.length || !uploadScreenId) return;
    try {
      setStatus(`正在上传 ${files.length} 个文件到当前 Screen…`, true, 'ready');
      const uploadTokens = [];
      for (const file of files) {
        const response = await fetch(`/upload?screenId=${encodeURIComponent(uploadScreenId)}&nodeId=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'same-origin'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (!result.uploadToken) throw new Error('missing upload token');
        uploadTokens.push(result.uploadToken);
      }
      send({ type: 'fileCommit', screenId: uploadScreenId, nodeId: id, uploadTokens });
      event.target.value = '';
      setStatus('文件已交给当前 QQ Screen 处理', true, 'ready');
    } catch (error) {
      setStatus(`文件上传失败：${error.message}`, true, 'ready');
    }
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (/^[1-9]$/.test(event.key)) {
      const screen = screens[Number(event.key) - 1];
      if (screen?.id) {
        event.preventDefault(); requestScreen(screen.id); return;
      }
    }
    if (event.key === '0') {
      event.preventDefault(); fitMode = true; fitStage(); return;
    }
    if (event.key === '-' && snapshot?.viewport) {
      event.preventDefault(); setManualScale(currentScale / 1.15); return;
    }
    if ((event.key === '=' || event.key === '+') && snapshot?.viewport) {
      event.preventDefault(); setManualScale(currentScale * 1.15); return;
    }
  }
  if (!activeNodeId || !hasControl || event.isComposing) return;
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && ['l', 'r'].includes(event.key.toLowerCase()))) return;
  event.preventDefault();
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  if (printable || ['Backspace','Delete','Enter'].includes(event.key)) lastKeyboardInputAt = performance.now();
  send({ type: 'key', nodeId: activeNodeId, key: event.key, code: event.code, text: printable ? event.key : '', repeat: event.repeat, modifiers: modifiers(event) });
}, true);

document.addEventListener('beforeinput', (event) => {
  if (!activeNodeId || !hasControl || event.isComposing) return;
  if (performance.now() - lastKeyboardInputAt < 80) return;
  const mirror = nodes.get(activeNodeId);
  if (!isTextLikeInput(mirror)) return;
  if (event.inputType === 'insertText' && event.data) {
    event.preventDefault(); send({ type: 'text', nodeId: activeNodeId, text: event.data });
  } else if (event.inputType === 'insertLineBreak') {
    event.preventDefault(); send({ type: 'key', nodeId: activeNodeId, key: 'Enter', code: 'Enter', text: '', modifiers: {} });
  } else if (event.inputType === 'deleteContentBackward') {
    event.preventDefault(); send({ type: 'key', nodeId: activeNodeId, key: 'Backspace', code: 'Backspace', text: '', modifiers: {} });
  } else if (event.inputType === 'deleteContentForward') {
    event.preventDefault(); send({ type: 'key', nodeId: activeNodeId, key: 'Delete', code: 'Delete', text: '', modifiers: {} });
  }
}, true);

document.addEventListener('compositionend', (event) => {
  if (!activeNodeId || !hasControl || !event.data) return;
  event.preventDefault(); send({ type: 'text', nodeId: activeNodeId, text: event.data });
}, true);

document.addEventListener('paste', (event) => {
  if (!activeNodeId || !hasControl) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  event.preventDefault(); send({ type: 'text', nodeId: activeNodeId, text });
}, true);

takeControlButton?.addEventListener('click', () => send({ type: 'takeControl' }));
resyncButton?.addEventListener('click', () => {
  setStatus('正在重新同步当前 QQ Screen…', false, 'syncing');
  send({ type: 'resync' });
});
zoomOutButton?.addEventListener('click', () => setManualScale(currentScale / 1.15));
zoomInButton?.addEventListener('click', () => setManualScale(currentScale * 1.15));
fitViewButton?.addEventListener('click', () => { fitMode = true; fitStage(); });
retryButton?.addEventListener('click', () => {
  if (socket?.readyState === WebSocket.OPEN) {
    setStatus('正在重新发现并同步 QQ Screen…', false, attached ? 'syncing' : 'waiting');
    send({ type: 'resync' });
  } else {
    try { socket?.close(); } catch {}
    socket = null;
    connect();
  }
});
fullscreenButton?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {}
});
document.addEventListener('fullscreenchange', () => {
  if (fullscreenButton) fullscreenButton.title = document.fullscreenElement ? '退出全屏' : '全屏';
  fitStage();
});
window.addEventListener('resize', fitStage);
if ('ResizeObserver' in window && viewport) new ResizeObserver(fitStage).observe(viewport);
updateControls();
connect();
