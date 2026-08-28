import WebSocket from 'ws';

export async function listTargets(host = '127.0.0.1', port = 9222, timeoutMs = 3000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`http://${host}:${port}/json/list`, { signal });
  if (!response.ok) throw new Error(`CDP target discovery failed: ${response.status}`);
  return response.json();
}

export class CdpConnection {
  constructor(url, { callTimeoutMs = 15_000 } = {}) {
    this.url = url;
    this.callTimeoutMs = callTimeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
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
