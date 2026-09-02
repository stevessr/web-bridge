import { createConnection } from 'node:net';
import WebSocket from 'ws';

const MAX_SHIM_BUFFER_BYTES = 128 * 1024 * 1024;

function describeFetchError(error) {
  const cause = error?.cause;
  if (!cause) return error?.message || String(error);
  const parts = [];
  if (cause.code) parts.push(cause.code);
  if (cause.message) parts.push(cause.message);
  return parts.length ? `${error?.message || 'fetch failed'} (${parts.join(': ')})` : (error?.message || String(error));
}

function shimToken() {
  return process.env.WEB_BRIDGE_QQ_SHIM_TOKEN || '';
}

function shimAuthority(host, port) {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function shimRequest(host, port, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: Number(port) });
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error(`shim bridge request timed out at ${host}:${port}`)), timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ ...payload, token: shimToken() })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_SHIM_BUFFER_BYTES) return finish(reject, new Error('shim bridge response is too large'));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== payload.id) continue;
        if (message.error) return finish(reject, new Error(`${message.error.code ?? -32000}: ${message.error.message || 'shim bridge error'}`));
        return finish(resolve, message.result ?? {});
      }
    });
    socket.on('error', (error) => finish(reject, error));
    socket.on('close', () => {
      if (!settled) finish(reject, new Error(`shim bridge connection closed at ${host}:${port}`));
    });
  });
}

export async function listShimTargets(host = '127.0.0.1', port = 9222, timeoutMs = 3000) {
  let result;
  try {
    result = await shimRequest(host, port, { id: 1, op: 'list' }, timeoutMs);
  } catch (error) {
    throw new Error(`Electron shim discovery failed at ${host}:${port}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(result)) throw new Error(`Electron shim discovery returned an invalid target list at ${host}:${port}`);
  const authority = shimAuthority(host, port);
  return result.map((candidate) => ({
    ...candidate,
    id: String(candidate.id),
    type: candidate.type || 'page',
    webSocketDebuggerUrl: `shim://${authority}/${encodeURIComponent(String(candidate.id))}`
  }));
}

export async function listTargets(host = '127.0.0.1', port = 9222, timeoutMs = 3000) {
  const endpoint = `http://${host}:${port}/json/list`;
  const signal = AbortSignal.timeout(timeoutMs);
  let httpError = null;
  try {
    const response = await fetch(endpoint, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`invalid JSON: ${error.message}`, { cause: error });
    }
  } catch (error) {
    httpError = new Error(`CDP target discovery failed at ${endpoint}: ${describeFetchError(error)}`, { cause: error });
  }

  try {
    return await listShimTargets(host, port, timeoutMs);
  } catch (shimError) {
    throw new Error(`${httpError.message}; ${shimError.message}`, { cause: shimError });
  }
}

class ListenerSet {
  constructor() { this.listeners = new Map(); }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }
  emit(method, params) {
    for (const handler of this.listeners.get(method) ?? []) {
      try { handler(params); } catch (error) { console.error(`[cdp] handler failed for ${method}`, error); }
    }
  }
}

export class CdpConnection extends ListenerSet {
  constructor(url, options = {}) {
    if (String(url).startsWith('shim://')) return new ShimCdpConnection(url, options);
    super();
    const { callTimeoutMs = 15_000 } = options;
    this.url = url;
    this.callTimeoutMs = callTimeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.closed = false;
    const ws = new WebSocket(this.url, { maxPayload: 128 * 1024 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false });
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket connect timeout')), 10_000);
      const done = (fn) => (value) => { clearTimeout(timer); cleanup(); fn(value); };
      const onOpen = done(resolve);
      const onError = done(reject);
      const cleanup = () => { ws.off('open', onOpen); ws.off('error', onError); };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('error', (error) => this.emit('error', { error }));
    ws.on('close', () => this.#onClose());
  }

  call(method, params = {}, timeoutMs = this.callTimeoutMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(payload, (error) => {
        if (!error) return;
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(error);
      });
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }

  #onClose() {
    const error = new Error('CDP connection closed');
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.ws = null;
    this.emit('disconnect', {});
  }

  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.emit(message.method, message.params ?? {});
  }
}

export class ShimCdpConnection extends ListenerSet {
  constructor(url, { callTimeoutMs = 15_000 } = {}) {
    super();
    const parsed = new URL(url);
    if (parsed.protocol !== 'shim:') throw new Error(`unsupported shim bridge URL: ${url}`);
    this.url = url;
    this.host = parsed.hostname;
    this.port = Number(parsed.port);
    this.targetId = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    this.callTimeoutMs = callTimeoutMs;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.closed = false;
    const socket = createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron shim connect timeout')), 10_000);
      const cleanup = () => { clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError); };
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.emit('error', { error }));
    socket.on('close', () => this.#onClose());
    await this.#request({ op: 'attach', targetId: this.targetId }, 10_000);
  }

  call(method, params = {}, timeoutMs = this.callTimeoutMs) {
    return this.#request({ method, params }, timeoutMs);
  }

  close() {
    this.closed = true;
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
  }

  #request(payload, timeoutMs) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Electron shim is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.socket?.destroy(); } catch {}
        reject(new Error(`Electron shim call timed out: ${payload.method || payload.op}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.write(`${JSON.stringify({ id, ...payload, token: shimToken() })}\n`, (error) => {
        if (!error) return;
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(error);
      });
    });
  }

  #onClose() {
    const error = new Error('Electron shim connection closed');
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.socket = null;
    this.emit('disconnect', {});
  }

  #onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_SHIM_BUFFER_BYTES) {
      this.emit('error', { error: new Error('Electron shim message buffer exceeded limit') });
      this.socket?.destroy();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.code ?? -32000}: ${message.error.message || 'shim bridge error'}`));
        else waiter.resolve(message.result ?? {});
        continue;
      }
      if (message.method) this.emit(message.method, message.params ?? {});
    }
  }
}

export function createCdpConnection(url, options) {
  return String(url).startsWith('shim://') ? new ShimCdpConnection(url, options) : new CdpConnection(url, options);
}
