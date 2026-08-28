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

function modifiers(value = {}) {
  return {
    alt: Boolean(value.alt),
    ctrl: Boolean(value.ctrl),
    meta: Boolean(value.meta),
    shift: Boolean(value.shift)
  };
}

export function parseClientMessage(raw, { maxTextBytes = 64 * 1024 } = {}) {
  let message;
  try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return null; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;

  switch (message.type) {
    case 'resync':
      return { type: 'resync' };
    case 'takeControl':
      return { type: 'takeControl' };
    case 'releaseControl':
      return { type: 'releaseControl' };
    case 'fileCommit': {
      const id = nodeId(message.nodeId);
      const tokens = Array.isArray(message.uploadTokens) ? message.uploadTokens.filter((token) => /^[A-Za-z0-9_-]{16,128}$/.test(String(token))).slice(0, 32).map(String) : [];
      return id && tokens.length ? { type: 'fileCommit', nodeId: id, uploadTokens: tokens } : null;
    }
    case 'focus': {
      const id = nodeId(message.nodeId);
      return id ? { type: 'focus', nodeId: id } : null;
    }
    case 'select': {
      const id = nodeId(message.nodeId);
      const index = Math.trunc(number(message.index, -1, 0, 100000));
      return id && index >= 0 ? { type: 'select', nodeId: id, index } : null;
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
      return base;
    }
    case 'key': {
      const id = message.nodeId == null ? null : nodeId(message.nodeId);
      const key = String(message.key || '').slice(0, 64);
      const code = String(message.code || '').slice(0, 64);
      if (!key && !code) return null;
      return {
        type: 'key', nodeId: id, key, code,
        text: typeof message.text === 'string' ? message.text.slice(0, 16) : '',
        repeat: Boolean(message.repeat), modifiers: modifiers(message.modifiers)
      };
    }
    case 'text': {
      const id = message.nodeId == null ? null : nodeId(message.nodeId);
      const text = String(message.text || '');
      if (!text || Buffer.byteLength(text) > maxTextBytes) return null;
      return { type: 'text', nodeId: id, text };
    }
    default:
      return null;
  }
}
