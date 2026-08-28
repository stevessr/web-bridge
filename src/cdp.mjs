import WebSocket from 'ws';

export async function listTargets(host = '127.0.0.1', port = 9222) {
  const response = await fetch(`http://${host}:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP target discovery failed: ${response.status}`);
  return response.json();
}

export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    if (this.ws) return;
    this.ws = new WebSocket(this.url, { maxPayload: 128 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.ws.off('open', onOpen);
        this.ws.off('error', onError);
      };
      this.ws.on('open', onOpen);
      this.ws.on('error', onError);
    });

    this.ws.on('message', (raw) => this.#onMessage(raw));
    this.ws.on('close', () => {
      const error = new Error('CDP connection closed');
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.emit('disconnect', {});
    });
  }

  call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP is not connected'));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
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
      try {
        handler(params);
      } catch (error) {
        console.error(`[cdp] event handler failed for ${method}`, error);
      }
    }
  }

  close() {
    this.ws?.close();
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

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
