import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const client = await readFile(new URL('../public/client.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

test('web UI exposes remote viewer controls and connection state panel', () => {
  for (const id of [
    'status', 'meta', 'take-control', 'resync', 'zoom-out', 'fit-view', 'zoom-in',
    'fullscreen', 'viewport', 'scaler', 'stage', 'connection-panel', 'retry'
  ]) {
    assert.match(index, new RegExp(`id=["']${id}["']`));
  }
});

test('web UI client handles responsive scaling and reconnect states', () => {
  assert.match(client, /function fitStage\(\)/);
  assert.match(client, /ResizeObserver/);
  assert.match(client, /requestFullscreen/);
  assert.match(client, /data(?:set)?\.status|dataset\.status/);
  assert.match(client, /setManualScale/);
  assert.match(client, /正在重新发现并同步 QQ NT/);
});

test('web UI keeps mirror styles scoped to the stage', () => {
  assert.match(style, /#stage\s*\{/);
  assert.match(style, /#connection-panel\s*\{/);
  assert.match(style, /prefers-reduced-motion/);
  assert.match(style, /safe-area-inset/);
});
