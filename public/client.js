const statusEl = document.querySelector('#status');
const metaEl = document.querySelector('#meta');
const stage = document.querySelector('#stage');
const scaler = document.querySelector('#scaler');

let snapshot = null;
let activeNodeId = null;
let socket = null;
let lastPointerSent = 0;
let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener('open', () => setStatus('已连接桥接服务', true));
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'status') {
      if (message.attached) {
        setStatus('QQ NT 已连接', true);
        metaEl.textContent = message.target?.title || '';
      } else {
        setStatus(message.error ? `宿主连接失败：${message.error}` : '等待宿主 QQ NT…', false);
        metaEl.textContent = '';
      }
      return;
    }
    if (message.type === 'snapshot') {
      snapshot = message.snapshot;
      renderSnapshot(snapshot);
    }
  });
  socket.addEventListener('close', () => {
    setStatus('桥接服务已断开，正在重连…', false);
    reconnectTimer = setTimeout(connect, 1000);
  });
  socket.addEventListener('error', () => socket.close());
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  document.body.dataset.connected = ok ? 'true' : 'false';
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setAttributes(element, node) {
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (/^on/i.test(name) || name === 'srcdoc') continue;
    try {
      if (name === 'readonly') element.setAttribute('readonly', '');
      else element.setAttribute(name, String(value));
    } catch {}
  }
  element.dataset.wbId = String(node.id);
}

function setStyles(element, node) {
  for (const [property, value] of Object.entries(node.style ?? {})) {
    try { element.style.setProperty(property, value); } catch {}
  }
}

function setState(element, node) {
  const state = node.state ?? {};
  if (element instanceof HTMLInputElement) {
    element.readOnly = true;
    if (state.type === 'password') {
      element.value = '';
      element.placeholder = element.placeholder || '••••••';
    } else if (typeof state.value === 'string') {
      element.value = state.value;
    }
    if (typeof state.checked === 'boolean') element.checked = state.checked;
    if (typeof state.disabled === 'boolean') element.disabled = state.disabled;
  } else if (element instanceof HTMLTextAreaElement) {
    element.readOnly = true;
    if (typeof state.value === 'string') element.value = state.value;
    if (typeof state.disabled === 'boolean') element.disabled = state.disabled;
  } else if (element instanceof HTMLSelectElement) {
    if (Number.isInteger(state.selectedIndex)) element.selectedIndex = state.selectedIndex;
    if (typeof state.disabled === 'boolean') element.disabled = state.disabled;
  }
  if (typeof state.scrollLeft === 'number') element.scrollLeft = state.scrollLeft;
  if (typeof state.scrollTop === 'number') element.scrollTop = state.scrollTop;
}

function buildNode(node) {
  if (!node) return document.createTextNode('');
  if (node.type === 'text') return document.createTextNode(node.text ?? '');

  let element;
  try {
    if (node.ns && node.ns !== 'http://www.w3.org/1999/xhtml') {
      element = document.createElementNS(node.ns, node.tag || 'g');
    } else {
      const tag = node.tag === 'body' || node.tag === 'html' ? 'div' : (node.tag || 'div');
      element = document.createElement(tag);
    }
  } catch {
    element = document.createElement('div');
  }

  setAttributes(element, node);
  setStyles(element, node);

  for (const child of node.children ?? []) element.append(buildNode(child));

  if (node.shadow?.length) {
    try {
      const shadowRoot = element.attachShadow({ mode: 'open' });
      for (const child of node.shadow) shadowRoot.append(buildNode(child));
    } catch {
      for (const child of node.shadow) element.append(buildNode(child));
    }
  }

  setState(element, node);

  if (node.tag === 'canvas' && node.surface && element instanceof HTMLCanvasElement) {
    const image = new Image();
    image.onload = () => {
      try {
        if (!element.width) element.width = image.naturalWidth;
        if (!element.height) element.height = image.naturalHeight;
        element.getContext('2d')?.drawImage(image, 0, 0, element.width, element.height);
      } catch {}
    };
    image.src = node.surface;
  }

  return element;
}

function renderSnapshot(next) {
  if (!next?.root) return;
  const previousActive = activeNodeId;
  const root = buildNode(next.root);
  stage.replaceChildren(root);

  const width = Math.max(1, Number(next.viewport?.width) || 1);
  const height = Math.max(1, Number(next.viewport?.height) || 1);
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  scaler.style.width = `${width}px`;
  scaler.style.height = `${height}px`;
  fitStage();

  document.title = next.title ? `${next.title} · Web Bridge` : 'QQ NT Web Bridge';
  metaEl.textContent = `${next.nodeCount ?? '?'} nodes${next.truncated ? ' · truncated' : ''}`;

  if (previousActive) {
    const target = stage.querySelector(`[data-wb-id="${CSS.escape(String(previousActive))}"]`);
    if (target instanceof HTMLElement) {
      try { target.focus({ preventScroll: true }); } catch {}
    }
  }
}

function fitStage() {
  if (!snapshot?.viewport) return;
  const availableWidth = Math.max(1, window.innerWidth);
  const availableHeight = Math.max(1, window.innerHeight - 32);
  const sourceWidth = Math.max(1, Number(snapshot.viewport.width));
  const sourceHeight = Math.max(1, Number(snapshot.viewport.height));
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight, 1);
  scaler.style.transform = `scale(${scale})`;
  scaler.parentElement.style.setProperty('--scaled-width', `${sourceWidth * scale}px`);
  scaler.parentElement.style.setProperty('--scaled-height', `${sourceHeight * scale}px`);
}

function remoteTarget(event) {
  const element = event.target instanceof Element ? event.target.closest('[data-wb-id]') : null;
  if (!element || !stage.contains(element)) return null;
  const nodeId = Number(element.dataset.wbId);
  if (!Number.isFinite(nodeId)) return null;
  const rect = element.getBoundingClientRect();
  const nx = rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
  const ny = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
  return { element, nodeId, nx, ny };
}

function modifiers(event) {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey
  };
}

stage.addEventListener('pointerdown', (event) => {
  const target = remoteTarget(event);
  if (!target) return;
  activeNodeId = target.nodeId;
  send({ type: 'focus', nodeId: target.nodeId });
}, true);

stage.addEventListener('click', (event) => {
  const target = remoteTarget(event);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  activeNodeId = target.nodeId;
  send({
    type: 'click', nodeId: target.nodeId, nx: target.nx, ny: target.ny,
    button: event.button, modifiers: modifiers(event)
  });
}, true);

stage.addEventListener('contextmenu', (event) => {
  const target = remoteTarget(event);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  activeNodeId = target.nodeId;
  send({
    type: 'click', nodeId: target.nodeId, nx: target.nx, ny: target.ny,
    button: 2, modifiers: modifiers(event)
  });
}, true);

stage.addEventListener('pointermove', (event) => {
  const now = performance.now();
  if (now - lastPointerSent < 40) return;
  const target = remoteTarget(event);
  if (!target) return;
  lastPointerSent = now;
  send({
    type: 'pointer', nodeId: target.nodeId, nx: target.nx, ny: target.ny,
    modifiers: modifiers(event)
  });
}, true);

stage.addEventListener('wheel', (event) => {
  const target = remoteTarget(event);
  if (!target) return;
  event.preventDefault();
  send({
    type: 'wheel', nodeId: target.nodeId, nx: target.nx, ny: target.ny,
    deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event)
  });
}, { capture: true, passive: false });

document.addEventListener('keydown', (event) => {
  if (!activeNodeId) return;
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && ['l', 'r'].includes(event.key.toLowerCase()))) return;
  event.preventDefault();
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  send({
    type: 'key', nodeId: activeNodeId, key: event.key, code: event.code,
    text: printable ? event.key : '', repeat: event.repeat, modifiers: modifiers(event)
  });
}, true);

document.addEventListener('compositionend', (event) => {
  if (!activeNodeId || !event.data) return;
  event.preventDefault();
  send({ type: 'text', nodeId: activeNodeId, text: event.data });
}, true);

document.addEventListener('paste', (event) => {
  if (!activeNodeId) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  send({ type: 'text', nodeId: activeNodeId, text });
}, true);

window.addEventListener('resize', fitStage);
connect();
