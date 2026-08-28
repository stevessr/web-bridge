export const INJECTED_BRIDGE_SOURCE = String.raw`(() => {
  if (globalThis.__WEB_BRIDGE__?.version === 1) return;

  const STYLE_PROPS = [
    'display','position','z-index','box-sizing','top','right','bottom','left',
    'width','height','min-width','min-height','max-width','max-height',
    'margin-top','margin-right','margin-bottom','margin-left',
    'padding-top','padding-right','padding-bottom','padding-left',
    'overflow','overflow-x','overflow-y','opacity','visibility',
    'color','background','background-color','background-image','background-size','background-position','background-repeat',
    'border-top','border-right','border-bottom','border-left','border-radius',
    'box-shadow','outline','transform','transform-origin','filter','backdrop-filter',
    'font-family','font-size','font-style','font-weight','font-variant','line-height','letter-spacing','word-spacing',
    'text-align','text-decoration','text-transform','text-overflow','text-shadow','white-space','word-break','overflow-wrap',
    'vertical-align','cursor','pointer-events','user-select','object-fit','object-position',
    'flex','flex-basis','flex-direction','flex-grow','flex-shrink','flex-wrap','align-content','align-items','align-self','justify-content','justify-items','justify-self','gap','row-gap','column-gap',
    'grid','grid-area','grid-template','grid-template-columns','grid-template-rows','grid-column','grid-row','place-content','place-items','place-self'
  ];

  const BLOCKED_TAGS = new Set(['SCRIPT','NOSCRIPT','IFRAME','FRAME','OBJECT','EMBED','WEBVIEW']);
  const URL_ATTRS = new Set(['src','href','poster','xlink:href']);
  const nodeToId = new WeakMap();
  const idToNode = new Map();
  let nextNodeId = 1;
  let observer = null;
  let dirtyQueued = false;

  function idFor(node) {
    let id = nodeToId.get(node);
    if (id) return id;
    id = nextNodeId++;
    nodeToId.set(node, id);
    idToNode.set(id, node);
    return id;
  }

  function signalDirty(reason = 'mutation') {
    if (dirtyQueued) return;
    dirtyQueued = true;
    queueMicrotask(() => {
      dirtyQueued = false;
      try {
        if (typeof globalThis.__webBridgeDirty === 'function') {
          globalThis.__webBridgeDirty(String(reason));
        }
      } catch {}
    });
  }

  function safeAttributes(element) {
    const attrs = {};
    for (const attr of element.attributes ?? []) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'srcset') continue;
      let value = attr.value;
      if (URL_ATTRS.has(name) && /^\s*javascript:/i.test(value)) value = '#';
      attrs[attr.name] = value;
    }

    if (element instanceof HTMLInputElement) {
      if ((element.type || '').toLowerCase() === 'password') {
        attrs.value = '';
        attrs['data-web-bridge-redacted'] = 'password';
      }
      attrs.readonly = '';
    }
    if (element instanceof HTMLTextAreaElement) attrs.readonly = '';
    if (element.isContentEditable) attrs.contenteditable = 'false';
    return attrs;
  }

  function computedStyleObject(element) {
    const style = getComputedStyle(element);
    const out = {};
    for (const prop of STYLE_PROPS) {
      const value = style.getPropertyValue(prop);
      if (value) out[prop] = value;
    }
    return out;
  }

  function elementState(element) {
    const state = {
      scrollLeft: element.scrollLeft || 0,
      scrollTop: element.scrollTop || 0
    };
    if (element instanceof HTMLInputElement) {
      state.checked = element.checked;
      state.disabled = element.disabled;
      state.type = element.type;
      state.value = element.type === 'password' ? '' : element.value;
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

  function serializeNode(node, budget) {
    if (budget.count++ > budget.max) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      return { id: idFor(node), type: 'text', text: node.nodeValue ?? '' };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const element = node;
    if (BLOCKED_TAGS.has(element.tagName)) {
      return {
        id: idFor(element),
        type: 'element',
        tag: 'div',
        ns: 'http://www.w3.org/1999/xhtml',
        attrs: { 'data-web-bridge-placeholder': element.tagName.toLowerCase() },
        style: computedStyleObject(element),
        state: elementState(element),
        children: []
      };
    }

    const children = [];
    for (const child of element.childNodes) {
      const serialized = serializeNode(child, budget);
      if (serialized) children.push(serialized);
      if (budget.count > budget.max) break;
    }

    let shadow = null;
    if (element.shadowRoot) {
      shadow = [];
      for (const child of element.shadowRoot.childNodes) {
        const serialized = serializeNode(child, budget);
        if (serialized) shadow.push(serialized);
        if (budget.count > budget.max) break;
      }
    }

    let surface = null;
    if (element instanceof HTMLCanvasElement && element.width * element.height <= 4000000) {
      try { surface = element.toDataURL('image/png'); } catch {}
    }

    return {
      id: idFor(element),
      type: 'element',
      tag: element.tagName.toLowerCase(),
      ns: element.namespaceURI || 'http://www.w3.org/1999/xhtml',
      attrs: safeAttributes(element),
      style: computedStyleObject(element),
      state: elementState(element),
      surface,
      children,
      shadow
    };
  }

  function cleanupDetachedNodes() {
    for (const [id, node] of idToNode) {
      if (node.nodeType === Node.ELEMENT_NODE && !node.isConnected) idToNode.delete(id);
    }
  }

  function snapshot() {
    cleanupDetachedNodes();
    const root = document.body || document.documentElement;
    const budget = { count: 0, max: 25000 };
    return {
      version: 1,
      title: document.title,
      url: location.href,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio: devicePixelRatio || 1
      },
      truncated: false,
      root: root ? serializeNode(root, budget) : null,
      nodeCount: budget.count,
      truncated: budget.count > budget.max
    };
  }

  function getNode(id) {
    const node = idToNode.get(Number(id));
    return node && node.isConnected ? node : null;
  }

  function point(id, nx = 0.5, ny = 0.5) {
    const node = getNode(id);
    if (!(node instanceof Element)) return null;
    const rect = node.getBoundingClientRect();
    const x = rect.left + Math.min(1, Math.max(0, Number(nx))) * rect.width;
    const y = rect.top + Math.min(1, Math.max(0, Number(ny))) * rect.height;
    return { x, y, width: rect.width, height: rect.height };
  }

  function focus(id) {
    const node = getNode(id);
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
    try {
      node.focus?.({ preventScroll: true });
      return true;
    } catch {
      return false;
    }
  }

  async function fetchResource(url) {
    const response = await fetch(String(url), { credentials: 'include' });
    const buffer = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < buffer.length; i += chunk) {
      binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
    }
    return {
      ok: response.ok,
      status: response.status,
      mime: response.headers.get('content-type') || 'application/octet-stream',
      base64: btoa(binary)
    };
  }

  function installObserver() {
    observer?.disconnect();
    const root = document.documentElement;
    if (!root) return;
    observer = new MutationObserver(() => signalDirty('mutation'));
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    addEventListener('input', () => signalDirty('input'), true);
    addEventListener('change', () => signalDirty('change'), true);
    addEventListener('scroll', () => signalDirty('scroll'), true);
    addEventListener('resize', () => signalDirty('resize'), true);
  }

  globalThis.__WEB_BRIDGE__ = {
    version: 1,
    snapshot,
    point,
    focus,
    fetchResource,
    signalDirty
  };

  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', installObserver, { once: true });
  } else {
    installObserver();
  }
  signalDirty('install');
})();`;
