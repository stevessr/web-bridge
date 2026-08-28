import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage, TokenBucket } from '../src/protocol.mjs';

test('normalizes pointer input', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'pointer', nodeId: 4, nx: 2, ny: -1, modifiers: { ctrl: 1 } })), {
    type: 'pointer', nodeId: 4, nx: 1, ny: 0,
    modifiers: { alt: false, ctrl: true, meta: false, shift: false }
  });
});

test('rejects invalid and oversized text', () => {
  assert.equal(parseClientMessage('{'), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'text', nodeId: 1, text: 'abcd' }), { maxTextBytes: 3 }), null);
});

test('accepts file commit only with opaque tokens', () => {
  const good = 'abcdefghijklmnopQRSTUV_123';
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'fileCommit', nodeId: 7, uploadTokens: [good] })), {
    type: 'fileCommit', nodeId: 7, uploadTokens: [good]
  });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'fileCommit', nodeId: 7, uploadTokens: ['../bad'] })), null);
});

test('token bucket refills over time', () => {
  let now = 0;
  const bucket = new TokenBucket(2, 2, () => now);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  now = 500;
  assert.equal(bucket.take(), true);
});
