import process from 'node:process';
import { WebSocket } from 'ws';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const equal = token.indexOf('=');
    if (equal > 2) {
      result[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      result[name] = next;
      i += 1;
    } else {
      result[name] = '1';
    }
  }
  return result;
}

function positiveInt(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be a valid TCP port`);
  return parsed;
}

function timeoutInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) throw new Error('timeout must be between 100 and 120000 milliseconds');
  return parsed;
}

function errorText(error) {
  const cause = error?.cause;
  const suffix = cause?.code ? ` (${cause.code}${cause.message ? `: ${cause.message}` : ''})` : '';
  return `${error?.message || String(error)}${suffix}`;
}

export function buildBootstrapExpression({ cdpHost, cdpPort }) {
  return `(() => {
    const load = typeof require === 'function' ? require : process?.mainModule?.require?.bind(process.mainModule);
    if (!load) throw new Error('require() is unavailable in Electron main process');
    const { app } = load('electron');
    if (!app?.commandLine) throw new Error('electron.app.commandLine is unavailable');
    app.commandLine.removeSwitch('remote-debugging-address');
    app.commandLine.removeSwitch('remote-debugging-port');
    app.commandLine.appendSwitch('remote-debugging-address', ${JSON.stringify(String(cdpHost))});
    app.commandLine.appendSwitch('remote-debugging-port', ${JSON.stringify(String(cdpPort))});
    return {
      address: app.commandLine.getSwitchValue('remote-debugging-address'),
      port: app.commandLine.getSwitchValue('remote-debugging-port')
    };
  })()`;
}

class InspectorConnection {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const ws = new WebSocket(this.url, {
      handshakeTimeout: Math.min(this.timeoutMs, 5000),
      perMessageDeflate: false,
      maxPayload: 4 * 1024 * 1024
    });
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron inspector websocket connect timeout')), Math.min(this.timeoutMs, 5000));
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('close', () => this.#rejectPending(new Error('Electron inspector disconnected')));
    ws.on('error', () => {});
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Electron inspector is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Electron inspector call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(error);
      });
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }

  #rejectPending(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message.id) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else waiter.resolve(message.result ?? {});
  }
}

async function discoverInspectorTarget(host, port, deadline) {
  const endpoint = `http://${host}:${port}/json/list`;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(100, deadline - Date.now());
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(Math.min(1000, remaining)) });
      if (!response.ok) throw new Error(`inspector discovery returned HTTP ${response.status}`);
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.webSocketDebuggerUrl) || targets[0];
      if (target?.webSocketDebuggerUrl) return target;
      lastError = new Error('inspector target list is empty');
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Electron main-process inspector did not become ready at ${endpoint}: ${errorText(lastError)}`);
}

async function bootstrap({ inspectorHost, inspectorPort, cdpHost, cdpPort, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const target = await discoverInspectorTarget(inspectorHost, inspectorPort, deadline);
  const connection = new InspectorConnection(target.webSocketDebuggerUrl, Math.max(1000, deadline - Date.now()));
  let resumed = false;
  await connection.connect();
  try {
    await connection.call('Runtime.enable');
    const evaluated = await connection.call('Runtime.evaluate', {
      expression: buildBootstrapExpression({ cdpHost, cdpPort }),
      returnByValue: true,
      awaitPromise: true
    });
    if (evaluated.exceptionDetails) {
      const detail = evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'unknown evaluation error';
      throw new Error(`failed to configure Electron command line: ${detail}`);
    }
    const configured = evaluated.result?.value;
    if (String(configured?.port) !== String(cdpPort)) throw new Error(`Electron reported unexpected remote-debugging-port: ${configured?.port ?? '<empty>'}`);

    // The inspector is only a bootstrap transport. Close it shortly after the
    // paused main process resumes so the long-lived privileged surface is CDP only.
    await connection.call('Runtime.evaluate', {
      expression: `setTimeout(() => { try { require('node:inspector').close(); } catch {} }, 1500); true`,
      returnByValue: true
    });
    await connection.call('Runtime.runIfWaitingForDebugger');
    resumed = true;
    return configured;
  } finally {
    if (!resumed) {
      try { await connection.call('Runtime.runIfWaitingForDebugger', {}, 1000); } catch {}
    }
    connection.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inspectorHost = args['inspector-host'] || '127.0.0.1';
  const inspectorPort = positiveInt(args['inspector-port'], null, 'inspector-port');
  const cdpHost = args['cdp-host'] || '127.0.0.1';
  const cdpPort = positiveInt(args['cdp-port'], null, 'cdp-port');
  const timeoutMs = timeoutInt(args.timeout, 15_000);
  if (!inspectorPort) throw new Error('--inspector-port is required');
  if (!cdpPort) throw new Error('--cdp-port is required');

  const configured = await bootstrap({ inspectorHost, inspectorPort, cdpHost, cdpPort, timeoutMs });
  process.stderr.write(`[web-bridge] injected Electron CDP switches before app startup: ${configured.address || cdpHost}:${configured.port}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`[web-bridge] Electron CDP bootstrap failed: ${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
