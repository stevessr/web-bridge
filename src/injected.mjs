export const INJECTED_BRIDGE_SOURCE = String.raw`(() => {
  if (globalThis.__WEB_BRIDGE__?.version === 2) return;

  const STYLE_PROPS = [
    'display','position','z-index','box-sizing','top','right','bottom','left','width','height','min-width','min-height','max-width','max-height',
    'margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left',
    'overflow','overflow-x','overflow-y','opacity','visibility','color','background','background-color','background-image','background-size','background-position','background-repeat',
    'border-top','border-right','border-bottom','border-left','border-radius','box-shadow','outline','transform','transform-origin','filter','backdrop-filter',
    'font-family','font-size','font-style','font-weight','font-variant','line-height','letter-spacing','word-spacing','text-align','text-decoration','text-transform','text-overflow','text-shadow','white-space','word-break','overflow-wrap',
    'vertical-align','cursor','pointer-events','user-select','object-fit','object-position','flex','flex-basis','flex-direction','flex-grow','flex-shrink','flex-wrap','align-content','align-items','align-self','justify-content','justify-items','justify-self','gap','row-gap','column-gap',
    'grid','grid-area','grid-template','grid-template-columns','grid-template-rows','grid-column','grid-row','place-content','place-items','place-self'
  ];
  const BLOCKED_TAGS = new Set(['SCRIPT','NOSCRIPT','IFRAME','FRAME','OBJECT','EMBED','WEBVIEW']);
  const URL_ATTRS = new Set(['src','href','poster','xlink:href']);
  const nodeToId = new WeakMap();
  const idToNode = new Map();
  const observedRoots = new WeakSet();
  const observers = [];
  const pendingChildren = new Set();
  const pendingUpdate = new Set();
  const pendingText = new Set();
  let nextNodeId = 1;
  let metaDirty = false;
  let dirtyQueued = false;
  let documentGeneration = 1;
  let lastVisualId = null;

  function idFor(node) {
    let id = nodeToId.get(node);
    if (id) return id;
    id = nextNodeId++;
    nodeToId.set(node, id);
    idToNode.set(id, node);
    return id;
  }

  function getNode(id) {
    const node = idToNode.get(Number(id));
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE && !node.isConnected) return null;
    return node;
  }

  function signalDirty(reason) {
    if (dirtyQueued) return;
    dirtyQueued = true;
    queueMicrotask(() => {
      dirtyQueued = false;
      try { globalThis.__webBridgeDirty?.(String(reason || 'dirty')); } catch {}
    });
  }

  function safeAttributes(element) {
    const attrs = {};
    for (const attr of element.attributes ?? []) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'srcset') continue;
      let value = String(attr.value ?? '');
      if (URL_ATTRS.has(name) && /^\s*javascript:/i.test(value)) value = '#';
      if (value.length > 262144) value = '';
      attrs[attr.name] = value;
    }
    if (element instanceof HTMLImageElement && element.currentSrc) attrs.src = element.currentSrc;
    if (element instanceof HTMLMediaElement && element.currentSrc) attrs.src = element.currentSrc;
    if (element instanceof HTMLInputElement) {
      if ((element.type || '').toLowerCase() === 'password') {
        attrs.value = '';
        attrs['data-web-bridge-redacted'] = 'password';
      }
      if ((element.type || '').toLowerCase() !== 'file') attrs.readonly = '';
    }
    if (element instanceof HTMLTextAreaElement) attrs.readonly = '';
    if (element.isContentEditable) attrs.contenteditable = 'false';
    return attrs;
  }

  function styleFor(element) {
    const style = getComputedStyle(element);
    const out = {};
    for (const prop of STYLE_PROPS) {
      const value = style.getPropertyValue(prop);
      if (value) out[prop] = value;
    }
    return out;
  }

  function stateFor(element) {
    const state = { scrollLeft: element.scrollLeft || 0, scrollTop: element.scrollTop || 0 };
    if (element instanceof HTMLMediaElement) {
      state.paused = element.paused; state.currentTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
      state.volume = element.volume; state.muted = element.muted; state.playbackRate = element.playbackRate; state.loop = element.loop;
    }
    if (element instanceof HTMLInputElement) {
      state.checked = element.checked;
      state.disabled = element.disabled;
      state.type = element.type;
      state.value = element.type === 'password' || element.type === 'file' ? '' : element.value;
    } else if (element instanceof HTMLTextAreaElement) {
      state.disabled = element.disabled;
      state.value = element.value;
    } else if (element instanceof HTMLSelectElement) {
      state.disabled = element.disabled;
      state.selectedIndex = element.selectedIndex;
      state.value = element.value;
    }
    return state;
  }

  function surfaceFor(element) {
    if (!(element instanceof HTMLCanvasElement)) return null;
    if (!element.width || !element.height || element.width * element.height > 4000000) return null;
    try { return element.toDataURL('image/png'); } catch { return null; }
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    const observer = new MutationObserver(onMutations);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    observers.push(observer);
  }

  function serializeNode(node, budget) {
    if (!node || budget.count++ >= budget.max) {
      budget.truncated = true;
      return null;
    }
    if (node.nodeType === Node.TEXT_NODE) return { id: idFor(node), type: 'text', text: node.nodeValue ?? '' };
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node;
    if (BLOCKED_TAGS.has(element.tagName)) {
      return { id: idFor(element), type: 'element', tag: 'div', ns: 'http://www.w3.org/1999/xhtml', attrs: { 'data-web-bridge-placeholder': element.tagName.toLowerCase() }, style: styleFor(element), state: stateFor(element), children: [], shadow: null, surface: null };
    }
    const children = [];
    for (const child of element.childNodes) {
      const serialized = serializeNode(child, budget);
      if (serialized) children.push(serialized);
      if (budget.truncated) break;
    }
    let shadow = null;
    if (element.shadowRoot) {
      observeRoot(element.shadowRoot);
      shadow = [];
      for (const child of element.shadowRoot.childNodes) {
        const serialized = serializeNode(child, budget);
        if (serialized) shadow.push(serialized);
        if (budget.truncated) break;
      }
    }
    return {
      id: idFor(element), type: 'element', tag: element.tagName.toLowerCase(), ns: element.namespaceURI || 'http://www.w3.org/1999/xhtml',
      attrs: safeAttributes(element), style: styleFor(element), state: stateFor(element), surface: surfaceFor(element), children, shadow
    };
  }

  function serializeChildren(node, budget) {
    const children = [];
    const source = node instanceof ShadowRoot ? node.childNodes : node.childNodes;
    for (const child of source) {
      const serialized = serializeNode(child, budget);
      if (serialized) children.push(serialized);
      if (budget.truncated) break;
    }
    return children;
  }

  function updatePayload(element) {
    return { attrs: safeAttributes(element), style: styleFor(element), state: stateFor(element), surface: surfaceFor(element) };
  }

  function markUpdate(node) {
    if (node?.nodeType === Node.ELEMENT_NODE) pendingUpdate.add(idFor(node));
  }

  function markChildren(node) {
    if (node instanceof ShadowRoot) {
      if (node.host) pendingUpdate.add(idFor(node.host));
    } else if (node?.nodeType === Node.ELEMENT_NODE) {
      pendingChildren.add(idFor(node));
    }
  }

  function onMutations(records) {
    for (const mutation of records) {
      if (mutation.type === 'childList') markChildren(mutation.target);
      else if (mutation.type === 'attributes') markUpdate(mutation.target);
      else if (mutation.type === 'characterData') pendingText.add(idFor(mutation.target));
    }
    signalDirty('mutation');
  }

  function cleanupDetachedNodes() {
    for (const [id, node] of idToNode) {
      if (node.nodeType === Node.ELEMENT_NODE && !node.isConnected) idToNode.delete(id);
      else if (node.nodeType === Node.TEXT_NODE && !node.parentNode) idToNode.delete(id);
    }
  }

  function collectFontFaces() {
    const faces = [];
    const visit = (rules) => {
      for (const rule of rules || []) {
        if (faces.length >= 256) return;
        if (rule.type === 5 && typeof rule.cssText === 'string') faces.push(rule.cssText.slice(0, 16384));
        else if (rule.cssRules) { try { visit(rule.cssRules); } catch {} }
      }
    };
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch {} }
    return faces;
  }

  function meta() {
    return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio || 1 }, fontFaces: collectFontFaces() };
  }

  function snapshot() {
    cleanupDetachedNodes();
    pendingChildren.clear(); pendingUpdate.clear(); pendingText.clear(); metaDirty = false;
    const budget = { count: 0, max: 30000, truncated: false };
    const root = document.body || document.documentElement;
    return { version: 2, generation: documentGeneration, ...meta(), root: root ? serializeNode(root, budget) : null, nodeCount: budget.count, truncated: budget.truncated };
  }

  function flushPatches() {
    cleanupDetachedNodes();
    const totalDirty = pendingChildren.size + pendingUpdate.size + pendingText.size;
    if (totalDirty > 1200) {
      pendingChildren.clear(); pendingUpdate.clear(); pendingText.clear(); metaDirty = false;
      return { reset: true, reason: 'dirty-overflow' };
    }
    const budget = { count: 0, max: 12000, truncated: false };
    const patches = [];

    for (const id of pendingChildren) {
      const node = getNode(id);
      if (!(node instanceof Element)) continue;
      patches.push({ op: 'children', id, children: serializeChildren(node, budget), shadow: node.shadowRoot ? serializeChildren(node.shadowRoot, budget) : null });
      if (budget.truncated) break;
    }
    if (!budget.truncated) {
      for (const id of pendingUpdate) {
        const node = getNode(id);
        if (!(node instanceof Element)) continue;
        const update = updatePayload(node);
        if (node.shadowRoot) update.shadow = serializeChildren(node.shadowRoot, budget);
        patches.push({ op: 'update', id, ...update });
        if (budget.truncated) break;
      }
    }
    if (!budget.truncated) {
      for (const id of pendingText) {
        const node = getNode(id);
        if (node?.nodeType === Node.TEXT_NODE) patches.push({ op: 'text', id, text: node.nodeValue ?? '' });
      }
    }

    pendingChildren.clear(); pendingUpdate.clear(); pendingText.clear();
    const includeMeta = metaDirty;
    metaDirty = false;
    if (budget.truncated) return { reset: true, reason: 'patch-budget' };
    return { reset: false, patches, meta: includeMeta ? meta() : null };
  }

  function point(id, nx, ny) {
    const node = getNode(id);
    if (!(node instanceof Element)) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: rect.left + Math.min(1, Math.max(0, Number(nx) || 0)) * rect.width,
      y: rect.top + Math.min(1, Math.max(0, Number(ny) || 0)) * rect.height,
      width: rect.width,
      height: rect.height
    };
  }

  function focus(id) {
    const node = getNode(id);
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
    try { node.focus?.({ preventScroll: true }); return true; } catch { return false; }
  }

  function objectFor(id) { return getNode(id); }

  function markVisual(id) {
    for (const candidate of [lastVisualId, Number(id)]) {
      let node = getNode(candidate);
      let depth = 0;
      while (node instanceof Element && depth++ < 5) { pendingUpdate.add(idFor(node)); node = node.parentElement; }
    }
    lastVisualId = Number(id) || null;
    signalDirty('visual');
  }

  function selectOption(id, index) {
    const node = getNode(id);
    if (!(node instanceof HTMLSelectElement)) return false;
    const next = Math.max(0, Math.min(node.options.length - 1, Number(index) || 0));
    node.selectedIndex = next;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    markUpdate(node); signalDirty('select');
    return true;
  }

  async function fetchResource(url, maxBytes) {
    const response = await fetch(String(url), { credentials: 'include' });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > Number(maxBytes || 0)) throw new Error('resource-too-large');
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (maxBytes && buffer.byteLength > Number(maxBytes)) throw new Error('resource-too-large');
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    return { ok: response.ok, status: response.status, mime: response.headers.get('content-type') || 'application/octet-stream', base64: btoa(binary) };
  }

  function install() {
    observeRoot(document.documentElement);
    addEventListener('input', (event) => { markUpdate(event.target); signalDirty('input'); }, true);
    addEventListener('change', (event) => { markUpdate(event.target); signalDirty('change'); }, true);
    addEventListener('scroll', (event) => { markUpdate(event.target === document ? document.scrollingElement : event.target); signalDirty('scroll'); }, true);
    for (const type of ['play','pause','seeking','seeked','volumechange','ratechange','loadedmetadata','timeupdate']) addEventListener(type, (event) => { markUpdate(event.target); signalDirty('media'); }, true);
    addEventListener('resize', () => { metaDirty = true; signalDirty('resize'); }, true);
    new MutationObserver(() => { metaDirty = true; signalDirty('title'); }).observe(document.querySelector('title') || document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  globalThis.__WEB_BRIDGE__ = { version: 2, snapshot, flushPatches, point, focus, objectFor, selectOption, markVisual, fetchResource, signalDirty };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  metaDirty = true;
  signalDirty('install');
})();`;
