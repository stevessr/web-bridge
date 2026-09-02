import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseClientMessage } from '../src/protocol.mjs';

test('window state protocol validates commands', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'getWindowState', screenId: '12' })), { type: 'getWindowState', screenId: '12' });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'setWindowState', state: 'maximized' })), { type: 'setWindowState', state: 'maximized' });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'setWindowState', state: 'floating' })), null);
});

test('host and Web UI expose state synchronization', async () => {
  const host = await readFile(new URL('../src/host-multi.mjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const fast = await readFile(new URL('../public/input-fastpath.js', import.meta.url), 'utf8');
  assert.match(host, /getWindowState/);
  assert.match(host, /setHostWindowState/);
  assert.match(html, /data-window-state=\"maximized\"/);
  assert.match(html, /window-state-refresh/);
  assert.match(fast, /windowBounds/);
  assert.match(fast, /requestWindowState/);
});
