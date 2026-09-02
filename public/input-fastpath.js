(() => {
  const nativeSend = WebSocket.prototype.send;
  const state = {
    socket: null,
    activeNodeId: null,
    activeEditable: false,
    composing: false,
    pendingPointer: null,
    pointerFrame: 0,
    pendingWheel: null,
    wheelFrame: 0,
    lastTextKey: null,
    lastComposition: null
  };

  function isBridgeSocket(socket) {
    try {
      const url = new URL(socket.url);
      return url.host === location.host && url.pathname === '/ws';
    } catch {
      return false;
    }
  }

  WebSocket.prototype.send = function patchedSend(data) {
    if (isBridgeSocket(this)) state.socket = this;
    return nativeSend.call(this, data);
  };

  function send(message) {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      nativeSend.call(socket, JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  const stage = document.querySelector('#stage');
  if (!stage) return;

  const inputProxy = document.createElement('textarea');
  inputProxy.id = 'web-bridge-input-proxy';
  inputProxy.tabIndex = -1;
  inputProxy.autocomplete = 'off';
  inputProxy.setAttribute('autocorrect', 'off');
  inputProxy.setAttribute('autocapitalize', 'off');
  inputProxy.setAttribute('spellcheck', 'false');
  inputProxy.setAttribute('aria-label', 'Remote text input');
  Object.assign(inputProxy.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
    resize: 'none',
    zIndex: '-1'
  });
  document.body.append(inputProxy);

  const windowSizeButton = document.querySelector('#window-size');
  const windowSizePopover = document.querySelector('#window-size-popover');
  const windowWidthInput = document.querySelector('#window-width');
  const windowHeightInput = document.querySelector('#window-height');
  const windowSizeApply = document.querySelector('#window-size-apply');
  const windowSizeLabel = document.querySelector('#window-size-label');

  function stageSize() {
    const width = Math.round(Number.parseFloat(stage.style.width) || stage.clientWidth || 0);
    const height = Math.round(Number.parseFloat(stage.style.height) || stage.clientHeight || 0);
    return { width, height };
  }

  function clampWindowSize(width, height) {
    return {
      width: Math.max(320, Math.min(7680, Math.round(Number(width) || 0))),
      height: Math.max(240, Math.min(4320, Math.round(Number(height) || 0)))
    };
  }

  function fillWindowSize(size = stageSize()) {
    if (windowWidthInput && size.width) windowWidthInput.value = String(size.width);
    if (windowHeightInput && size.height) windowHeightInput.value = String(size.height);
    if (windowSizeLabel && size.width && size.height) windowSizeLabel.textContent = `${size.width}×${size.height}`;
  }

  function closeWindowSize() {
    if (!windowSizePopover || !windowSizeButton) return;
    windowSizePopover.hidden = true;
    windowSizeButton.setAttribute('aria-expanded', 'false');
  }

  function toggleWindowSize() {
    if (!windowSizePopover || !windowSizeButton || !hasControl()) return;
    const opening = windowSizePopover.hidden;
    if (opening) fillWindowSize();
    windowSizePopover.hidden = !opening;
    windowSizeButton.setAttribute('aria-expanded', String(opening));
    if (opening) windowWidthInput?.focus({ preventScroll: true });
  }

  function applyWindowSize() {
    if (!hasControl()) return;
    const size = clampWindowSize(windowWidthInput?.value, windowHeightInput?.value);
    if (windowWidthInput) windowWidthInput.value = String(size.width);
    if (windowHeightInput) windowHeightInput.value = String(size.height);
    if (send({ type: 'resizeWindow', width: size.width, height: size.height })) {
      if (windowSizeLabel) windowSizeLabel.textContent = `${size.width}×${size.height}`;
      closeWindowSize();
    }
  }

  windowSizeButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleWindowSize();
  });
  windowSizeApply?.addEventListener('click', applyWindowSize);
  windowSizePopover?.querySelectorAll('[data-window-size]').forEach((button) => {
    button.addEventListener('click', () => {
      const match = String(button.dataset.windowSize || '').match(/^(\d+)x(\d+)$/);
      if (!match) return;
      if (windowWidthInput) windowWidthInput.value = match[1];
      if (windowHeightInput) windowHeightInput.value = match[2];
      applyWindowSize();
    });
  });
  for (const input of [windowWidthInput, windowHeightInput]) {
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); applyWindowSize(); }
      if (event.key === 'Escape') { event.preventDefault(); closeWindowSize(); windowSizeButton?.focus(); }
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (windowSizePopover?.hidden) return;
    if (windowSizePopover?.contains(event.target) || windowSizeButton?.contains(event.target)) return;
    closeWindowSize();
  }, true);

  const localWindowSizeEvent = (event) => Boolean(windowSizePopover && eventPath(event).includes(windowSizePopover));
  for (const type of ['keydown', 'beforeinput', 'compositionstart', 'compositionend', 'paste']) {
    window.addEventListener(type, (event) => {
      if (localWindowSizeEvent(event)) event.stopImmediatePropagation();
    }, true);
  }

  const updateWindowSizeControl = () => {
    if (windowSizeButton) windowSizeButton.disabled = !hasControl();
    if (!hasControl()) closeWindowSize();
  };
  new MutationObserver(updateWindowSizeControl).observe(document.body, { attributes: true, attributeFilter: ['data-control'] });
  new MutationObserver(() => {
    if (windowSizePopover?.hidden) fillWindowSize();
  }).observe(stage, { attributes: true, attributeFilter: ['style'] });
  updateWindowSizeControl();

  function hasControl() {
    return document.body.dataset.control === 'granted';
  }

  function eventPath(event) {
    return event.composedPath?.() || [];
  }

  function isInsideStage(event) {
    return eventPath(event).includes(stage);
  }

  function keyboardScope(event) {
    return event.target === inputProxy || isInsideStage(event);
  }

  function elementId(element) {
    const id = Number(element?.dataset?.wbId);
    return Number.isFinite(id) ? id : null;
  }

  function mirroredTarget(event) {
    for (const item of eventPath(event)) {
      if (!(item instanceof Element) || !item.dataset?.wbId) continue;
      const nodeId = elementId(item);
      if (nodeId == null) continue;
      const rect = item.getBoundingClientRect();
      return {
        element: item,
        nodeId,
        nx: rect.width ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0.5,
        ny: rect.height ? Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) : 0.5
      };
    }
    return null;
  }

  function isTextInput(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type);
  }

  function isEditable(element) {
    if (!(element instanceof HTMLElement)) return false;
    const contentEditable = String(element.getAttribute('contenteditable') || '').toLowerCase();
    return isTextInput(element) || element.isContentEditable || contentEditable === 'true' || contentEditable === 'plaintext-only';
  }

  function editableTarget(event) {
    for (const item of eventPath(event)) {
      if (!(item instanceof HTMLElement) || !item.dataset?.wbId || !isEditable(item)) continue;
      const nodeId = elementId(item);
      if (nodeId != null) return { element: item, nodeId };
    }
    return null;
  }

  function modifiers(event) {
    return { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey };
  }

  function focusInputProxy() {
    if (!state.activeEditable || !state.activeNodeId) return;
    try {
      inputProxy.value = '';
      inputProxy.focus({ preventScroll: true });
      inputProxy.setSelectionRange(0, 0);
    } catch {}
  }

  function rememberStageTarget(event) {
    const editable = editableTarget(event);
    const target = mirroredTarget(event);
    const selected = editable || target;
    if (!selected) return;
    state.activeNodeId = selected.nodeId;
    state.activeEditable = Boolean(editable);
    if (editable) queueMicrotask(focusInputProxy);
  }

  window.addEventListener('pointerdown', (event) => {
    if (!isInsideStage(event)) {
      state.activeNodeId = null;
      state.activeEditable = false;
      state.composing = false;
      try { inputProxy.blur(); } catch {}
      return;
    }
    rememberStageTarget(event);
  }, true);

  window.addEventListener('focusin', (event) => {
    if (isInsideStage(event)) rememberStageTarget(event);
  }, true);

  function flushPointer() {
    state.pointerFrame = 0;
    const pending = state.pendingPointer;
    state.pendingPointer = null;
    if (!pending || !hasControl()) return;
    send(pending);
  }

  window.addEventListener('pointermove', (event) => {
    if (!hasControl() || !isInsideStage(event)) return;
    const target = mirroredTarget(event);
    if (!target) return;

    state.pendingPointer = {
      type: 'pointer',
      nodeId: target.nodeId,
      nx: target.nx,
      ny: target.ny,
      modifiers: modifiers(event)
    };
    if (!state.pointerFrame) state.pointerFrame = requestAnimationFrame(flushPointer);
    event.stopImmediatePropagation();
  }, true);

  function normalizedWheelDelta(event, target) {
    let deltaX = Number(event.deltaX) || 0;
    let deltaY = Number(event.deltaY) || 0;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      const lineHeight = Number.parseFloat(getComputedStyle(target.element).lineHeight);
      const pixelsPerLine = Number.isFinite(lineHeight) && lineHeight > 0 ? Math.max(24, lineHeight * 1.5) : 40;
      deltaX *= pixelsPerLine;
      deltaY *= pixelsPerLine;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      const width = Math.max(1, stage.clientWidth || target.element.clientWidth || window.innerWidth);
      const height = Math.max(1, stage.clientHeight || target.element.clientHeight || window.innerHeight);
      deltaX *= width;
      deltaY *= height;
    }
    return {
      deltaX: Math.max(-5000, Math.min(5000, deltaX)),
      deltaY: Math.max(-5000, Math.min(5000, deltaY))
    };
  }

  function flushWheel() {
    state.wheelFrame = 0;
    const pending = state.pendingWheel;
    state.pendingWheel = null;
    if (!pending || !hasControl()) return;
    send(pending);
  }

  window.addEventListener('wheel', (event) => {
    if (!hasControl() || !isInsideStage(event)) return;
    const target = mirroredTarget(event);
    if (!target) return;

    const delta = normalizedWheelDelta(event, target);
    if (!delta.deltaX && !delta.deltaY) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (state.pendingWheel && state.pendingWheel.nodeId !== target.nodeId) flushWheel();
    if (state.pendingWheel) {
      state.pendingWheel.deltaX = Math.max(-5000, Math.min(5000, state.pendingWheel.deltaX + delta.deltaX));
      state.pendingWheel.deltaY = Math.max(-5000, Math.min(5000, state.pendingWheel.deltaY + delta.deltaY));
      state.pendingWheel.nx = target.nx;
      state.pendingWheel.ny = target.ny;
      state.pendingWheel.modifiers = modifiers(event);
    } else {
      state.pendingWheel = {
        type: 'wheel',
        nodeId: target.nodeId,
        nx: target.nx,
        ny: target.ny,
        deltaX: delta.deltaX,
        deltaY: delta.deltaY,
        modifiers: modifiers(event)
      };
    }
    if (!state.wheelFrame) state.wheelFrame = requestAnimationFrame(flushWheel);
  }, { capture: true, passive: false });

  function reservedViewerShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return false;
    return /^[0-9]$/.test(event.key) || event.key === '-' || event.key === '=' || event.key === '+';
  }

  function reservedBrowserShortcut(event) {
    if (event.key === 'F5') return true;
    return (event.ctrlKey || event.metaKey) && ['l', 'r'].includes(event.key.toLowerCase());
  }

  window.addEventListener('compositionstart', (event) => {
    if (!hasControl() || !state.activeEditable || !state.activeNodeId || !keyboardScope(event)) return;
    state.composing = true;
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('compositionend', (event) => {
    if (!hasControl() || !state.activeEditable || !state.activeNodeId || !keyboardScope(event)) {
      state.composing = false;
      return;
    }
    state.composing = false;
    event.stopImmediatePropagation();
    const text = String(event.data || '');
    if (text) {
      state.lastComposition = { text, at: performance.now() };
      send({ type: 'text', nodeId: state.activeNodeId, text });
    }
    queueMicrotask(() => { inputProxy.value = ''; });
  }, true);

  window.addEventListener('keydown', (event) => {
    if (!hasControl() || !state.activeNodeId || !keyboardScope(event)) return;
    if (reservedBrowserShortcut(event) || reservedViewerShortcut(event)) return;

    if (state.activeEditable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      event.stopImmediatePropagation();
      return;
    }

    if (event.isComposing || state.composing || event.key === 'Process' || event.key === 'Dead') {
      event.stopImmediatePropagation();
      return;
    }

    const altGraph = Boolean(event.getModifierState?.('AltGraph'));
    const printable = event.key.length === 1 && !event.metaKey && ((!event.ctrlKey && !event.altKey) || altGraph);
    if (state.activeEditable && printable) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.lastTextKey = { text: event.key, at: performance.now() };
      send({ type: 'text', nodeId: state.activeNodeId, text: event.key });
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    send({
      type: 'key',
      nodeId: state.activeNodeId,
      key: event.key,
      code: event.code,
      text: printable ? event.key : '',
      repeat: event.repeat,
      modifiers: modifiers(event)
    });
  }, true);

  window.addEventListener('beforeinput', (event) => {
    if (!hasControl() || !state.activeEditable || !state.activeNodeId || !keyboardScope(event)) return;

    if (event.isComposing || state.composing || event.inputType === 'insertCompositionText') {
      event.stopImmediatePropagation();
      return;
    }

    const data = typeof event.data === 'string' ? event.data : '';
    if ((event.inputType === 'insertText' || event.inputType === 'insertReplacementText') && data) {
      const now = performance.now();
      const recentKey = state.lastTextKey;
      const recentComposition = state.lastComposition;
      if ((recentKey && recentKey.text === data && now - recentKey.at < 120) ||
          (recentComposition && recentComposition.text === data && now - recentComposition.at < 160)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'text', nodeId: state.activeNodeId, text: data });
      return;
    }

    const keyByInputType = {
      insertLineBreak: 'Enter',
      insertParagraph: 'Enter',
      deleteContentBackward: 'Backspace',
      deleteContentForward: 'Delete'
    };
    const key = keyByInputType[event.inputType];
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'key', nodeId: state.activeNodeId, key, code: key, text: '', modifiers: {} });
  }, true);

  window.addEventListener('paste', (event) => {
    if (!hasControl() || !state.activeEditable || !state.activeNodeId || !keyboardScope(event)) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'text', nodeId: state.activeNodeId, text });
    queueMicrotask(() => { inputProxy.value = ''; });
  }, true);
})();
