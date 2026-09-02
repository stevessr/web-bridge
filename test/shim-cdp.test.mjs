import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { CdpConnection, listTargets } from '../src/cdp.mjs';

function writeLine(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

test('CDP discovery falls back to Electron debugger shim transport', async () => {
  const previousToken = process.env.WEB_BRIDGE_QQ_SHIM_TOKEN;
  process.env.WEB_BRIDGE_QQ_SHIM_TOKEN = 'test-token';
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.startsWith('GET ') || buffer.startsWith('HEAD ')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        assert.equal(message.token, 'test-token');
        if (message.op === 'list') {
          writeLine(socket, { id: message.id, result: [{ id: '7', type: 'page', title: 'QQ', url: 'file:///qq/index.html' }] });
        } else if (message.op === 'attach') {
          assert.equal(message.targetId, '7');
          writeLine(socket, { id: message.id, result: { attached: true } });
        } else if (message.method === 'Runtime.enable') {
          writeLine(socket, { id: message.id, result: { enabled: true } });
          queueMicrotask(() => writeLine(socket, { method: 'Runtime.bindingCalled', params: { name: '__webBridgeDirty' } }));
        }
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const targets = await listTargets('127.0.0.1', port, 1000);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, '7');
    assert.match(targets[0].webSocketDebuggerUrl, /^shim:\/\//);

    const connection = new CdpConnection(targets[0].webSocketDebuggerUrl, { callTimeoutMs: 1000 });
    await connection.connect();
    const eventPromise = new Promise((resolve) => connection.on('Runtime.bindingCalled', resolve));
    assert.deepEqual(await connection.call('Runtime.enable'), { enabled: true });
    assert.deepEqual(await eventPromise, { name: '__webBridgeDirty' });
    connection.close();
  } finally {
    server.close();
    await once(server, 'close');
    if (previousToken == null) delete process.env.WEB_BRIDGE_QQ_SHIM_TOKEN;
    else process.env.WEB_BRIDGE_QQ_SHIM_TOKEN = previousToken;
  }
});
