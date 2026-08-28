const statusEl = document.querySelector('#status');
const metaEl = document.querySelector('#meta');
const stage = document.querySelector('#stage');
const scaler = document.querySelector('#scaler');
const takeControlButton = document.querySelector('#take-control');
const resyncButton = document.querySelector('#resync');
const nodes = new Map();
const fontStyle = document.createElement('style');
fontStyle.id = 'web-bridge-font-faces';
document.head.append(fontStyle);

let snapshot = null;
let revision = 0;
let activeNodeId = null;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 500;
let lastPointerSent = 0;
let hasControl = false;
let instanceId = null;
let lastKeyboardInputAt = 0;

function setStatus(text, ok) {
  statusEl.textContent = text;
  document.body.dataset.connected = ok ? 'true' : 'false';
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('open', () => {
    reconnectDelay = 500;
    setStatus('已连接桥接服务，正在同步…', true);
    send({ type: 'resync' });
  });
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', () => {
    hasControl = false;
    setStatus('桥接服务已断开，正在重连…', false);
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
      revision = 0;
      snapshot = null;
      send({ type: 'resync' });
    }
    instanceId = message.instanceId || instanceId;
    hasControl = message.control === 'granted';
    if (message.attached) {
      setStatus(hasControl ? 'QQ NT 已连接 · 可控制' : 'QQ NT 已连接 · 只读', true);
      metaEl.textContent = `${message.target?.title || 'QQ NT'} · r${message.revision ?? revision}`;
    } else {
      setStatus('等待宿主 QQ NT…', false);
      metaEl.textContent = '';
    }
    return;
  }
  if (message.type === 'snapshot') {
    renderSnapshot(message.snapshot);
    return;
  }
  if (message.type === 'patch') {
    if (message.baseRevision !== revision) {
      send({ type: 'resync' });
      return;
    }
    applyPatchBatch(message);
    return;
  }
  if (message.type === 'resyncRequired') {
    send({ type: 'resync' });
    return;
  }
  if (message.type === 'controlDenied') {
    hasControl = false;
    setStatus('QQ NT 已连接 · 当前由另一客户端控制', true);
    return;
  }
  if (message.type === 'rateLimited') setStatus('输入过快，已限流', true);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
}

function applyMeta(meta) {
  if (Array.isArray(meta.fontFaces)) fontStyle.textContent = meta.fontFaces.join('\n');
  if (meta.title) document.title = `${meta.title} · Web Bridge`;
  const viewport = meta.viewport || snapshot?.viewport;
  if (viewport) {
    snapshot = { ...(snapshot || {}), ...meta, viewport };
    const width = Math.max(1, Number(viewport.width) || 1);
    const height = Math.max(1, Number(viewport.height) || 1);
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    scaler.style.width = `${width}px`;
    scaler.style.height = `${height}px`;
    fitStage();
  }
  metaEl.textContent = `${meta.title || snapshot?.title || 'QQ NT'} · r${revision}`;
}

function applyPatchBatch(message) {
  const previousActive = activeNodeId;
  for (const patch of message.patches ?? []) {
    const target = nodes.get(Number(patch.id));
    if (!target) {
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

function fitStage() {
  if (!snapshot?.viewport) return;
  const availableWidth = Math.max(1, window.innerWidth);
  const availableHeight = Math.max(1, window.innerHeight - 32);
  const sourceWidth = Math.max(1, Number(snapshot.viewport.width) || 1);
  const sourceHeight = Math.max(1, Number(snapshot.viewport.height) || 1);
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight, 1);
  scaler.style.transform = `scale(${scale})`;
  scaler.parentElement.style.setProperty('--scaled-width', `${sourceWidth * scale}px`);
  scaler.parentElement.style.setProperty('--scaled-height', `${sourceHeight * scale}px`);
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
    if (!Number.isFinite(id) || !files.length) return;
    try {
      setStatus(`正在上传 ${files.length} 个文件到宿主…`, true);
      const uploadTokens = [];
      for (const file of files) {
        const response = await fetch(`/upload?nodeId=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'same-origin'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (!result.uploadToken) throw new Error('missing upload token');
        uploadTokens.push(result.uploadToken);
      }
      send({ type: 'fileCommit', nodeId: id, uploadTokens });
      event.target.value = '';
      setStatus('文件已交给 QQ NT 处理', true);
    } catch (error) {
      setStatus(`文件上传失败：${error.message}`, false);
    }
  }
}, true);

document.addEventListener('keydown', (event) => {
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
resyncButton?.addEventListener('click', () => send({ type: 'resync' }));
window.addEventListener('resize', fitStage);
connect();
