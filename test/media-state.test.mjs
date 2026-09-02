import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MediaState } from '../src/media/state.mjs';

test('global dedupe prevents a completed video from another account', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'web-bridge-media-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const config = { workDir, dedupeScope: 'global', maxAttempts: 3, retryBackoffSeconds: 1 };
  const state = await new MediaState(config).load();
  const entry = { id: 'video123', title: 'test', webpageUrl: 'https://www.youtube.com/watch?v=video123' };

  await state.discovered('one', entry);
  await state.markRunning('one', entry);
  await state.markCompleted('one', entry.id, { bvid: 'BV1example' });

  assert.equal(state.canRun('two', entry.id), false);
  assert.equal(state.get('two', entry.id).bvid, 'BV1example');
});

test('failed jobs get a retry time and eventually become dead', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'web-bridge-media-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const config = { workDir, dedupeScope: 'account', maxAttempts: 2, retryBackoffSeconds: 1 };
  const state = await new MediaState(config).load();
  const entry = { id: 'video456', title: 'test', webpageUrl: 'https://www.youtube.com/watch?v=video456' };

  await state.markRunning('one', entry);
  const failed = await state.markFailed('one', entry.id, new Error('first'));
  assert.equal(failed.status, 'failed');
  assert.ok(failed.nextRetryAt);

  failed.nextRetryAt = new Date(0).toISOString();
  await state.save();
  await state.markRunning('one', entry);
  const dead = await state.markFailed('one', entry.id, new Error('second'));
  assert.equal(dead.status, 'dead');
  assert.equal(dead.nextRetryAt, null);
});
