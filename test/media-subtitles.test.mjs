import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSegments, segmentsToAss, segmentsToSrt } from '../src/media/subtitles.mjs';

test('normalizes verbose ASR segments', () => {
  const segments = normalizeSegments({ segments: [
    { start: 0, end: 1.25, text: ' hello   world ' },
    { start: 1.25, end: 2.5, text: ' second line ' }
  ] });
  assert.deepEqual(segments, [
    { index: 0, start: 0, end: 1.25, text: 'hello world' },
    { index: 1, start: 1.25, end: 2.5, text: 'second line' }
  ]);
});

test('renders SRT timestamps', () => {
  const srt = segmentsToSrt([{ start: 1.234, end: 65.678, text: '字幕' }]);
  assert.match(srt, /00:00:01,234 --> 00:01:05,678/);
  assert.match(srt, /字幕/);
});

test('renders ASS events', () => {
  const ass = segmentsToAss([{ start: 0, end: 2, text: 'hello {world}' }]);
  assert.match(ass, /\[Events\]/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:02\.00/);
  assert.match(ass, /hello \\{world\\\}/);
});
