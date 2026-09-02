import { readFile, writeFile } from 'node:fs/promises';

async function replaceOnce(path, oldText, newText) {
  const source = await readFile(path, 'utf8');
  if (!source.includes(oldText)) throw new Error(`patch anchor missing in ${path}: ${oldText.slice(0, 100)}`);
  await writeFile(path, source.replace(oldText, newText));
}

await replaceOnce(
  'src/protocol.mjs',
  "    case 'resizeWindow': {\n      const width = Math.trunc(number(message.width, 0));\n      const height = Math.trunc(number(message.height, 0));\n      if (width < 320 || width > 7680 || height < 240 || height > 4320) return null;\n      return scoped(message, { type: 'resizeWindow', width, height });\n    }\n",
  "    case 'resizeWindow': {\n      const width = Math.trunc(number(message.width, 0));\n      const height = Math.trunc(number(message.height, 0));\n      if (width < 320 || width > 7680 || height < 240 || height > 4320) return null;\n      return scoped(message, { type: 'resizeWindow', width, height });\n    }\n    case 'getWindowState':\n      return scoped(message, { type: 'getWindowState' });\n    case 'setWindowState': {\n      const state = String(message.state || '');\n      return ['normal', 'maximized', 'minimized', 'fullscreen'].includes(state)\n        ? scoped(message, { type: 'setWindowState', state })\n        : null;\n    }\n"
);

await replaceOnce(
  'src/host-multi.mjs',
  "async function resizeHostWindow(session, width, height) {\n  if (!session?.cdp) throw new Error('QQ screen is not attached');\n  const current = await session.cdp.call('Browser.getWindowForTarget');\n  const windowId = Number(current?.windowId);\n  if (!Number.isInteger(windowId)) throw new Error('QQ window id is unavailable');\n  const state = String(current?.bounds?.windowState || 'normal');\n  if (state !== 'normal') {\n    await session.cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });\n  }\n  await session.cdp.call('Browser.setWindowBounds', { windowId, bounds: { width, height } });\n  const updated = await session.cdp.call('Browser.getWindowForTarget').catch(() => null);\n  return updated?.bounds || { width, height, windowState: 'normal' };\n}\n",
  "async function readHostWindow(session) {\n  if (!session?.cdp) throw new Error('QQ screen is not attached');\n  const current = await session.cdp.call('Browser.getWindowForTarget');\n  const windowId = Number(current?.windowId);\n  if (!Number.isInteger(windowId)) throw new Error('QQ window id is unavailable');\n  return { windowId, bounds: current?.bounds || null };\n}\n\nasync function resizeHostWindow(session, width, height) {\n  const current = await readHostWindow(session);\n  const state = String(current.bounds?.windowState || 'normal');\n  if (state !== 'normal') {\n    await session.cdp.call('Browser.setWindowBounds', { windowId: current.windowId, bounds: { windowState: 'normal' } });\n  }\n  await session.cdp.call('Browser.setWindowBounds', { windowId: current.windowId, bounds: { width, height } });\n  const updated = await readHostWindow(session).catch(() => null);\n  return updated?.bounds || { width, height, windowState: 'normal' };\n}\n\nasync function setHostWindowState(session, windowState) {\n  const current = await readHostWindow(session);\n  await session.cdp.call('Browser.setWindowBounds', { windowId: current.windowId, bounds: { windowState } });\n  const updated = await readHostWindow(session).catch(() => null);\n  return updated?.bounds || { ...(current.bounds || {}), windowState };\n}\n"
);

await replaceOnce(
  'src/host-multi.mjs',
  "  if (message.type === 'resync') {\n",
  "  if (message.type === 'getWindowState') {\n    if (!session?.cdp) return sendStatus(state);\n    const current = await readHostWindow(session);\n    send(state, { type: 'windowBounds', screenId: session.id, bounds: current.bounds }, { force: true });\n    return;\n  }\n  if (message.type === 'resync') {\n"
);

await replaceOnce(
  'src/host-multi.mjs',
  "  if (message.type === 'resizeWindow') {\n",
  "  if (message.type === 'setWindowState') {\n    const bounds = await setHostWindowState(session, message.state);\n    broadcastToScreen(session.id, { type: 'windowBounds', screenId: session.id, bounds });\n    const timer = setTimeout(() => {\n      captureSnapshot(session, 'window-state').catch((error) => log('warn', 'window state snapshot failed', { screenId: session.id, error: error.message }));\n    }, 40);\n    timer.unref?.();\n    return;\n  }\n  if (message.type === 'resizeWindow') {\n"
);

await replaceOnce(
  'src/host-multi.mjs',
  "  if (next.cdp) await captureSnapshot(next, 'screen-select');\n",
  "  if (next.cdp) {\n    await captureSnapshot(next, 'screen-select');\n    const current = await readHostWindow(next).catch(() => null);\n    if (current?.bounds) send(state, { type: 'windowBounds', screenId, bounds: current.bounds }, { force: true });\n  }\n"
);

await replaceOnce(
  'public/index.html',
  "          <div class=\"window-size-heading\">远端 QQ 窗口</div>\n",
  "          <div class=\"window-size-heading\">远端 QQ 窗口 <span id=\"window-state-label\">读取中</span></div>\n"
);

await replaceOnce(
  'public/index.html',
  "          <button id=\"window-size-apply\" class=\"toolbar-button primary\" type=\"button\">应用到 QQ</button>\n",
  "          <div class=\"window-state-actions\" aria-label=\"窗口状态\">\n            <button type=\"button\" data-window-state=\"normal\">恢复</button>\n            <button type=\"button\" data-window-state=\"maximized\">最大化</button>\n            <button type=\"button\" data-window-state=\"minimized\">最小化</button>\n            <button type=\"button\" data-window-state=\"fullscreen\">全屏</button>\n          </div>\n          <div class=\"window-size-footer\">\n            <button id=\"window-state-refresh\" class=\"toolbar-button\" type=\"button\">刷新状态</button>\n            <button id=\"window-size-apply\" class=\"toolbar-button primary\" type=\"button\">应用到 QQ</button>\n          </div>\n"
);

const cssPath = 'public/screens.css';
let css = await readFile(cssPath, 'utf8');
css += `\n#window-state-label { float: right; color: rgba(255,255,255,.42); font-weight: 500; font-variant-numeric: tabular-nums; }\n.window-state-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin: 9px 0; }\n.window-state-actions button { height: 27px; border: 1px solid rgba(255,255,255,.08); border-radius: 7px; background: rgba(255,255,255,.035); color: rgba(255,255,255,.62); cursor: pointer; font: inherit; font-size: 9px; }\n.window-state-actions button:hover { background: rgba(255,255,255,.07); color: rgba(255,255,255,.9); }\n.window-state-actions button.active { border-color: rgba(110,168,255,.42); background: rgba(110,168,255,.12); color: #d7e5ff; }\n.window-size-footer { display: grid; grid-template-columns: .8fr 1.2fr; gap: 6px; }\n.window-size-footer .toolbar-button { width: 100%; }\n`;
await writeFile(cssPath, css);

await replaceOnce(
  'public/input-fastpath.js',
  "    lastComposition: null\n",
  "    lastComposition: null,\n    observedSockets: new WeakSet(),\n    windowBoundsByScreen: new Map()\n"
);

await replaceOnce(
  'public/input-fastpath.js',
  "  WebSocket.prototype.send = function patchedSend(data) {\n    if (isBridgeSocket(this)) state.socket = this;\n    return nativeSend.call(this, data);\n  };\n",
  "  function handleBridgeMessage(event) {\n    let message;\n    try { message = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }\n    if (message?.type !== 'windowBounds' || !message.bounds) return;\n    const id = String(message.screenId || '');\n    if (id) state.windowBoundsByScreen.set(id, message.bounds);\n    renderWindowBounds(message.bounds);\n  }\n\n  function observeBridgeSocket(socket) {\n    if (state.observedSockets.has(socket)) return;\n    state.observedSockets.add(socket);\n    socket.addEventListener('message', handleBridgeMessage);\n  }\n\n  WebSocket.prototype.send = function patchedSend(data) {\n    if (isBridgeSocket(this)) { state.socket = this; observeBridgeSocket(this); }\n    return nativeSend.call(this, data);\n  };\n"
);

await replaceOnce(
  'public/input-fastpath.js',
  "  const windowSizeLabel = document.querySelector('#window-size-label');\n",
  "  const windowSizeLabel = document.querySelector('#window-size-label');\n  const windowStateLabel = document.querySelector('#window-state-label');\n  const windowStateRefresh = document.querySelector('#window-state-refresh');\n"
);

await replaceOnce(
  'public/input-fastpath.js',
  "  function fillWindowSize(size = stageSize()) {\n",
  "  function stateText(value) {\n    return ({ normal: '普通', maximized: '最大化', minimized: '最小化', fullscreen: '全屏' })[value] || '未知';\n  }\n\n  function renderWindowBounds(bounds) {\n    if (!bounds) return;\n    const width = Math.round(Number(bounds.width) || 0);\n    const height = Math.round(Number(bounds.height) || 0);\n    if (windowWidthInput && width) windowWidthInput.value = String(width);\n    if (windowHeightInput && height) windowHeightInput.value = String(height);\n    if (windowSizeLabel && width && height) windowSizeLabel.textContent = `${width}×${height}`;\n    if (windowStateLabel) windowStateLabel.textContent = stateText(bounds.windowState);\n    for (const button of document.querySelectorAll('[data-window-state]')) {\n      button.classList.toggle('active', button.dataset.windowState === bounds.windowState);\n    }\n  }\n\n  function requestWindowState() {\n    send({ type: 'getWindowState' });\n  }\n\n  function fillWindowSize(size = stageSize()) {\n"
);

await replaceOnce(
  'public/input-fastpath.js',
  "  windowSizeButton?.addEventListener('click', () => {\n",
  "  windowStateRefresh?.addEventListener('click', (event) => { event.stopPropagation(); requestWindowState(); });\n  for (const button of document.querySelectorAll('[data-window-state]')) {\n    button.addEventListener('click', (event) => {\n      event.stopPropagation();\n      if (!hasControl()) return;\n      send({ type: 'setWindowState', state: button.dataset.windowState });\n    });\n  }\n\n  windowSizeButton?.addEventListener('click', () => {\n"
);

await replaceOnce(
  'public/input-fastpath.js',
  "    const opening = windowSizePopover.hidden;\n",
  "    const opening = windowSizePopover.hidden;\n    if (opening) requestWindowState();\n"
);

const testPath = 'test/window-state-sync.test.mjs';
await writeFile(testPath, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { parseClientMessage } from '../src/protocol.mjs';\n\ntest('window state protocol validates commands', () => {\n  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'getWindowState', screenId: '12' })), { type: 'getWindowState', screenId: '12' });\n  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'setWindowState', state: 'maximized' })), { type: 'setWindowState', state: 'maximized' });\n  assert.equal(parseClientMessage(JSON.stringify({ type: 'setWindowState', state: 'floating' })), null);\n});\n\ntest('host and Web UI expose state synchronization', async () => {\n  const host = await readFile(new URL('../src/host-multi.mjs', import.meta.url), 'utf8');\n  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');\n  const fast = await readFile(new URL('../public/input-fastpath.js', import.meta.url), 'utf8');\n  assert.match(host, /getWindowState/);\n  assert.match(host, /setHostWindowState/);\n  assert.match(html, /data-window-state=\\"maximized\\"/);\n  assert.match(html, /window-state-refresh/);\n  assert.match(fast, /windowBounds/);\n  assert.match(fast, /requestWindowState/);\n});\n`);
