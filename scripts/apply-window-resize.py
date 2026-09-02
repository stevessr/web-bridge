from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"patch anchor missing in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/protocol.mjs",
    "    case 'releaseControl':\n      return scoped(message, { type: 'releaseControl' });\n    case 'fileCommit': {",
    "    case 'releaseControl':\n      return scoped(message, { type: 'releaseControl' });\n    case 'resizeWindow': {\n      const width = Math.trunc(number(message.width, 0));\n      const height = Math.trunc(number(message.height, 0));\n      if (width < 320 || width > 7680 || height < 240 || height > 4320) return null;\n      return scoped(message, { type: 'resizeWindow', width, height });\n    }\n    case 'fileCommit': {",
)

replace_once(
    "src/host-multi.mjs",
    "  const table = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/style.css': 'style.css', '/screens.css': 'screens.css' };",
    "  const table = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/input-fastpath.js': 'input-fastpath.js', '/style.css': 'style.css', '/screens.css': 'screens.css' };",
)

replace_once(
    "src/host-multi.mjs",
    """async function markVisual(session, nodeId) {
  if (!session?.cdp || !nodeId) return;
  await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.markVisual(${nodeId})`, returnByValue: true });
}

async function selectScreen(state, screenId) {""",
    """async function markVisual(session, nodeId) {
  if (!session?.cdp || !nodeId) return;
  await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.markVisual(${nodeId})`, returnByValue: true });
}

async function resizeHostWindow(session, width, height) {
  if (!session?.cdp) throw new Error('QQ screen is not attached');
  const current = await session.cdp.call('Browser.getWindowForTarget');
  const windowId = Number(current?.windowId);
  if (!Number.isInteger(windowId)) throw new Error('QQ window id is unavailable');
  const state = String(current?.bounds?.windowState || 'normal');
  if (state !== 'normal') {
    await session.cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  }
  await session.cdp.call('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  const updated = await session.cdp.call('Browser.getWindowForTarget').catch(() => null);
  return updated?.bounds || { width, height, windowState: 'normal' };
}

async function selectScreen(state, screenId) {""",
)

replace_once(
    "src/host-multi.mjs",
    """  metrics.inputEvents += 1;

  if (message.type === 'focus') return focusNode(session, message.nodeId);""",
    """  metrics.inputEvents += 1;

  if (message.type === 'resizeWindow') {
    const bounds = await resizeHostWindow(session, message.width, message.height);
    broadcastToScreen(session.id, { type: 'windowBounds', screenId: session.id, bounds });
    const timer = setTimeout(() => {
      captureSnapshot(session, 'window-resize').catch((error) => log('warn', 'window resize snapshot failed', { screenId: session.id, error: error.message }));
    }, 40);
    timer.unref?.();
    return;
  }
  if (message.type === 'focus') return focusNode(session, message.nodeId);""",
)

replace_once(
    "src/qq-main-shim.mjs",
    "    async function command(method, params) {\n",
    """    function ownerWindow() {
      if (!target || target.isDestroyed()) throw new Error('no renderer target attached');
      const owner = target.getOwnerBrowserWindow?.();
      if (!owner || owner.isDestroyed?.()) throw new Error('renderer target has no BrowserWindow owner');
      return owner;
    }

    function ownerWindowState(owner) {
      try { if (owner.isFullScreen?.()) return 'fullscreen'; } catch {}
      try { if (owner.isMaximized?.()) return 'maximized'; } catch {}
      try { if (owner.isMinimized?.()) return 'minimized'; } catch {}
      return 'normal';
    }

    function ownerBounds(owner) {
      const bounds = owner.getBounds();
      return { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, windowState: ownerWindowState(owner) };
    }

    async function getWindowForTarget() {
      const owner = ownerWindow();
      return { windowId: Number(owner.id), bounds: ownerBounds(owner) };
    }

    async function setWindowBounds(params) {
      const owner = ownerWindow();
      const expectedWindowId = Number(params?.windowId);
      if (Number.isFinite(expectedWindowId) && expectedWindowId !== Number(owner.id)) throw new Error('windowId does not match attached BrowserWindow');
      const requested = params?.bounds && typeof params.bounds === 'object' ? params.bounds : {};
      const requestedState = String(requested.windowState || '');
      if (requestedState === 'normal') {
        try { if (owner.isFullScreen?.()) owner.setFullScreen(false); } catch {}
        try { if (owner.isMaximized?.()) owner.unmaximize(); } catch {}
        try { if (owner.isMinimized?.()) owner.restore(); } catch {}
      } else if (requestedState === 'maximized') {
        owner.maximize();
      } else if (requestedState === 'minimized') {
        owner.minimize();
      } else if (requestedState === 'fullscreen') {
        owner.setFullScreen(true);
      }
      const current = owner.getBounds();
      const next = { ...current };
      let hasBounds = false;
      const width = Number(requested.width);
      const height = Number(requested.height);
      const left = Number(requested.left);
      const top = Number(requested.top);
      if (Number.isFinite(width)) { next.width = Math.max(320, Math.min(7680, Math.round(width))); hasBounds = true; }
      if (Number.isFinite(height)) { next.height = Math.max(240, Math.min(4320, Math.round(height))); hasBounds = true; }
      if (Number.isFinite(left)) { next.x = Math.round(left); hasBounds = true; }
      if (Number.isFinite(top)) { next.y = Math.round(top); hasBounds = true; }
      if (hasBounds) owner.setBounds(next, false);
      return {};
    }

    async function command(method, params) {
""",
)

replace_once(
    "src/qq-main-shim.mjs",
    "      if (method === 'Runtime.evaluate') return evaluate(params || {});\n      if (method === 'Input.dispatchMouseEvent') return dispatchMouse(params || {});",
    "      if (method === 'Runtime.evaluate') return evaluate(params || {});\n      if (method === 'Browser.getWindowForTarget') return getWindowForTarget();\n      if (method === 'Browser.setWindowBounds') return setWindowBounds(params || {});\n      if (method === 'Input.dispatchMouseEvent') return dispatchMouse(params || {});",
)

replace_once(
    "public/index.html",
    """      <button id="resync" class="toolbar-button" type="button" title="重新获取当前窗口完整界面">
        <span class="button-icon" aria-hidden="true">↻</span>
        <span class="button-label">重新同步</span>
      </button>
      <span class="toolbar-divider" aria-hidden="true"></span>""",
    """      <button id="resync" class="toolbar-button" type="button" title="重新获取当前窗口完整界面">
        <span class="button-icon" aria-hidden="true">↻</span>
        <span class="button-label">重新同步</span>
      </button>
      <div id="window-size-control" class="window-size-control">
        <button id="window-size" class="toolbar-button compact" type="button" title="调整远端 QQ 原生窗口大小" aria-expanded="false" aria-controls="window-size-popover">
          <span id="window-size-label">窗口</span>
        </button>
        <div id="window-size-popover" class="window-size-popover" hidden>
          <div class="window-size-heading">远端 QQ 窗口</div>
          <div class="window-size-fields">
            <label>宽<input id="window-width" type="number" min="320" max="7680" step="16" inputmode="numeric" aria-label="窗口宽度"></label>
            <span aria-hidden="true">×</span>
            <label>高<input id="window-height" type="number" min="240" max="4320" step="16" inputmode="numeric" aria-label="窗口高度"></label>
          </div>
          <div class="window-size-presets" aria-label="常用窗口大小">
            <button type="button" data-window-size="800x600">800×600</button>
            <button type="button" data-window-size="1024x768">1024×768</button>
            <button type="button" data-window-size="1280x800">1280×800</button>
            <button type="button" data-window-size="1440x900">1440×900</button>
          </div>
          <button id="window-size-apply" class="toolbar-button primary" type="button">应用到 QQ</button>
        </div>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>""",
)

screens = Path("public/screens.css")
screens.write_text(
    screens.read_text()
    + """

.window-size-control { position: relative; flex: 0 0 auto; }
.window-size-popover {
  position: absolute;
  z-index: 90;
  top: calc(100% + 8px);
  right: 0;
  width: 254px;
  padding: 12px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 12px;
  background: rgba(23,26,32,.98);
  box-shadow: 0 18px 54px rgba(0,0,0,.42);
  user-select: none;
}
.window-size-popover[hidden] { display: none !important; }
.window-size-heading { margin: 0 0 10px; color: rgba(255,255,255,.78); font-size: 11px; font-weight: 650; }
.window-size-fields { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 7px; }
.window-size-fields label { display: grid; gap: 4px; color: rgba(255,255,255,.48); font-size: 9px; }
.window-size-fields > span { padding-bottom: 7px; color: rgba(255,255,255,.38); font-size: 11px; }
.window-size-fields input {
  width: 100%;
  height: 30px;
  padding: 0 7px;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 8px;
  outline: 0;
  background: rgba(255,255,255,.045);
  color: rgba(255,255,255,.9);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.window-size-fields input:focus { border-color: rgba(110,168,255,.5); box-shadow: 0 0 0 2px rgba(110,168,255,.1); }
.window-size-presets { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin: 9px 0; }
.window-size-presets button {
  height: 26px;
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 7px;
  background: rgba(255,255,255,.035);
  color: rgba(255,255,255,.62);
  cursor: pointer;
  font: inherit;
  font-size: 9px;
}
.window-size-presets button:hover { background: rgba(255,255,255,.07); color: rgba(255,255,255,.9); }
#window-size-apply { width: 100%; }
body:not([data-control="granted"]) #window-size { opacity: .42; }
@media (max-width: 760px) {
  #window-size-label { font-size: 0; }
  #window-size-label::after { content: "↔"; font-size: 14px; }
  #window-size { min-width: 30px; width: 30px; padding: 0; }
}
"""
)

fast = Path("public/input-fastpath.js")
text = fast.read_text()
anchor = "  document.body.append(inputProxy);\n\n  function hasControl() {"
addition = """  document.body.append(inputProxy);

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
      const match = String(button.dataset.windowSize || '').match(/^(\\d+)x(\\d+)$/);
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

  function hasControl() {"""
if anchor not in text:
    raise SystemExit("input fastpath anchor missing")
fast.write_text(text.replace(anchor, addition, 1))

Path("test/window-resize.test.mjs").write_text(
    """import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseClientMessage } from '../src/protocol.mjs';
import { buildLoaderSource } from '../src/qq-main-shim.mjs';

test('resizeWindow protocol is screen-scoped and validates sane bounds', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'resizeWindow', screenId: '12', width: 1024, height: 768 })), {
    type: 'resizeWindow', screenId: '12', width: 1024, height: 768
  });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resizeWindow', width: 120, height: 80 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resizeWindow', width: 99999, height: 768 })), null);
});

test('host exposes fastpath and resizes the real target window through CDP Browser bounds', async () => {
  const host = await readFile(new URL('../src/host-multi.mjs', import.meta.url), 'utf8');
  assert.match(host, /'\\/input-fastpath\\.js': 'input-fastpath\\.js'/);
  assert.match(host, /Browser\\.getWindowForTarget/);
  assert.match(host, /Browser\\.setWindowBounds/);
  assert.match(host, /message\\.type === 'resizeWindow'/);
});

test('Electron hybrid CDP shim implements Browser window bounds', () => {
  const loader = buildLoaderSource('/opt/QQ/resources/app/app_launcher/index.js');
  assert.match(loader, /Browser\\.getWindowForTarget/);
  assert.match(loader, /Browser\\.setWindowBounds/);
  assert.match(loader, /getOwnerBrowserWindow/);
  assert.match(loader, /owner\\.setBounds/);
});

test('web UI offers real remote window size controls', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const fastpath = await readFile(new URL('../public/input-fastpath.js', import.meta.url), 'utf8');
  assert.match(index, /id="window-size"/);
  assert.match(index, /id="window-width"/);
  assert.match(index, /id="window-height"/);
  assert.match(fastpath, /type: 'resizeWindow'/);
  assert.match(fastpath, /data-window-size/);
});
"""
)
