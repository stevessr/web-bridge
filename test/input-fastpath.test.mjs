import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fastPathUrl = new URL('../public/input-fastpath.js', import.meta.url);
const indexUrl = new URL('../public/index.html', import.meta.url);

test('input fast path is valid JavaScript and loads before the module client', async () => {
  const [source, html] = await Promise.all([
    readFile(fastPathUrl, 'utf8'),
    readFile(indexUrl, 'utf8')
  ]);
  assert.doesNotThrow(() => new Function(source));
  const fastPathAt = html.indexOf('/input-fastpath.js');
  const clientAt = html.indexOf('/client.js');
  assert.ok(fastPathAt >= 0);
  assert.ok(clientAt > fastPathAt);
});

test('wheel forwarding normalizes non-pixel deltas and coalesces work per frame', async () => {
  const source = await readFile(fastPathUrl, 'utf8');
  assert.match(source, /WheelEvent\.DOM_DELTA_LINE/);
  assert.match(source, /WheelEvent\.DOM_DELTA_PAGE/);
  assert.match(source, /requestAnimationFrame\(flushWheel\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /type: 'wheel'/);
});

test('typing fast path supports contenteditable, IME, paste and printable text', async () => {
  const source = await readFile(fastPathUrl, 'utf8');
  assert.match(source, /element\.isContentEditable/);
  assert.match(source, /compositionend/);
  assert.match(source, /insertCompositionText/);
  assert.match(source, /clipboardData\?\.getData\('text\/plain'\)/);
  assert.match(source, /type: 'text'/);
  assert.match(source, /type: 'key'/);
});

test('pointer forwarding uses frame pacing instead of the legacy 40ms gate', async () => {
  const source = await readFile(fastPathUrl, 'utf8');
  assert.match(source, /requestAnimationFrame\(flushPointer\)/);
  assert.doesNotMatch(source, /lastPointerSent/);
});
