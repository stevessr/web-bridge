import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseClientMessage } from '../src/protocol.mjs';
import { buildLoaderSource } from '../src/qq-main-shim.mjs';

test('resizeWindow protocol is screen-scoped and validates sane bounds', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'resizeWindow', screenId: '12', width: 1024, height: 768 })), {
    type: 'resizeWindow', screenId: '12', width: 1024, height: 768
  });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resizeWindow', width: 120, height: 80 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resizeWindow', width: 99999, height: 768 })), null);
});

test('host exposes fastpath and resizes the real target window through CDP Browser bounds', async () => {
  const host = await readFile(new URL('../src/host-multi.mjs', import.meta.url), 'utf8');
  assert.match(host, /'\/input-fastpath\.js': 'input-fastpath\.js'/);
  assert.match(host, /Browser\.getWindowForTarget/);
  assert.match(host, /Browser\.setWindowBounds/);
  assert.match(host, /message\.type === 'resizeWindow'/);
});

test('Electron hybrid CDP shim implements Browser window bounds', () => {
  const loader = buildLoaderSource('/opt/QQ/resources/app/app_launcher/index.js');
  assert.match(loader, /Browser\.getWindowForTarget/);
  assert.match(loader, /Browser\.setWindowBounds/);
  assert.match(loader, /getOwnerBrowserWindow/);
  assert.match(loader, /owner\.setBounds/);
});

test('web UI offers real remote window size controls', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const fastpath = await readFile(new URL('../public/input-fastpath.js', import.meta.url), 'utf8');
  assert.match(index, /id="window-size"/);
  assert.match(index, /id="window-width"/);
  assert.match(index, /id="window-height"/);
  assert.match(fastpath, /type: 'resizeWindow'/);
  assert.match(fastpath, /data-window-size/);
});
