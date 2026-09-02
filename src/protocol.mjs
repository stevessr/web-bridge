export class TokenBucket {
  constructor(rate, burst, now = () => Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.updated = now();
    this.now = now;
  }

  take(cost = 1) {
    const current = this.now();
    const elapsed = Math.max(0, current - this.updated) / 1000;
    this.updated = current;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

function number(value, fallback = 0, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function nodeId(value) {
  const parsed = Math.trunc(number(value, -1));
  return parsed > 0 ? parsed : null;
}

function screenId(value) {
  if (value == null || value === '') return null;
  const parsed = String(value);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(parsed) ? parsed : null;
}

function modifiers(value = {}) {
  return {
    alt: Boolean(value.alt),
    ctrl: Boolean(value.ctrl),
    meta: Boolean(value.meta),
    shift: Boolean(value.shift)
  };
}

function scoped(message, result) {
  if (message.screenId == null || message.screenId === '') return result;
  const id = screenId(message.screenId);
  return id ? { ...result, screenId: id } : null;
}

export function parseClientMessage(raw, { maxTextBytes = 64 * 1024 } = {}) {
  let message;
  try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return null; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;

  switch (message.type) {
    case 'selectScreen': {
      const id = screenId(message.screenId);
      return id ? { type: 'selectScreen', screenId: id } : null;
    }
    case 'resync':
      return scoped(message, { type: 'resync' });
    case 'takeControl':
      return scoped(message, { type: 'takeControl' });
    case 'releaseControl':
      return scoped(message, { type: 'releaseControl' });
    case 'resizeWindow': {
      const width = Math.trunc(number(message.width, 0));
      const height = Math.trunc(number(message.height, 0));
      if (width < 320 || width > 7680 || height < 240 || height > 4320) return null;
      return scoped(message, { type: 'resizeWindow', width, height });
    }
    case 'getWindowState':
      return scoped(message, { type: 'getWindowState' });
    case 'setWindowState': {
      const state = String(message.state || '');
      return ['normal', 'maximized', 'minimized', 'fullscreen'].includes(state)
        ? scoped(message, { type: 'setWindowState', state })
        : null;
    }
    case 'fileCommit': {
      const id = nodeId(message.nodeId);
      const tokens = Array.isArray(message.uploadTokens) ? message.uploadTokens.filter((token) => /^[A-Za-z0-9_-]{16,128}$/.test(String(token))).slice(0, 32).map(String) : [];
      return id && tokens.length ? scoped(message, { type: 'fileCommit', nodeId: id, uploadTokens: tokens }) : null;
    }
    case 'focus': {
      const id = nodeId(message.nodeId);
      return id ? scoped(message, { type: 'focus', nodeId: id }) : null;
    }
    case 'select': {
      const id = nodeId(message.nodeId);
      const index = Math.trunc(number(message.index, -1, 0, 100000));
      return id && index >= 0 ? scoped(message, { type: 'select', nodeId: id, index }) : null;
    }
    case 'pointer':
    case 'click':
    case 'wheel': {
      const id = nodeId(message.nodeId);
      if (!id) return null;
      const base = {
        type: message.type,
        nodeId: id,
        nx: number(message.nx, 0.5, 0, 1),
        ny: number(message.ny, 0.5, 0, 1),
        modifiers: modifiers(message.modifiers)
      };
      if (message.type === 'click') base.button = [0, 1, 2].includes(message.button) ? message.button : 0;
      if (message.type === 'wheel') {
        base.deltaX = number(message.deltaX, 0, -5000, 5000);
        base.deltaY = number(message.deltaY, 0, -5000, 5000);
      }
      return scoped(message, base);
    }
    case 'key': {
      const id = message.nodeId == null ? null : nodeId(message.nodeId);
      const key = String(message.key || '').slice(0, 64);
      const code = String(message.code || '').slice(0, 64);
      if (!key && !code) return null;
      return scoped(message, {
        type: 'key', nodeId: id, key, code,
        text: typeof message.text === 'string' ? message.text.slice(0, 16) : '',
        repeat: Boolean(message.repeat), modifiers: modifiers(message.modifiers)
      });
    }
    case 'text': {
      const id = message.nodeId == null ? null : nodeId(message.nodeId);
      const text = String(message.text || '');
      if (!text || Buffer.byteLength(text) > maxTextBytes) return null;
      return scoped(message, { type: 'text', nodeId: id, text });
    }
    default:
      return null;
  }
}
