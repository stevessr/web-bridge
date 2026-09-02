import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMediaConfig } from '../src/media/config.mjs';

function baseConfig(overrides = {}) {
  return {
    youtubeAccounts: [{ id: 'yt', sourceUrls: [':ytsubs'], cookiesFile: 'yt.txt' }],
    asr: { backend: 'local-faster-whisper' },
    translation: { backend: 'none' },
    bilibiliAccount: 'bili',
    bilibili: { accounts: [{ id: 'bili', cookieFile: 'bili.json' }] },
    ...overrides
  };
}

test('normalizes multi-account media config', () => {
  const config = normalizeMediaConfig(baseConfig({
    youtubeAccounts: [
      { id: 'one', sourceUrls: [':ytsubs'], cookiesFile: 'one.txt', bilibiliAccount: 'bili' },
      { id: 'two', sourceUrls: ['https://www.youtube.com/@example/videos'], bilibiliAccount: 'second', ytDlpArgs: ['--sleep-requests', '1'] }
    ],
    bilibili: { accounts: [{ id: 'bili' }, { id: 'second' }] }
  }), { configDir: '/tmp/media-config' });

  assert.equal(config.youtubeAccounts.length, 2);
  assert.equal(config.youtubeAccounts[1].bilibiliAccount, 'second');
  assert.deepEqual(config.youtubeAccounts[1].ytDlpArgs, ['--sleep-requests', '1']);
  assert.equal(config.configDir, '/tmp/media-config');
});

test('blocks command-executing yt-dlp arguments by default', () => {
  assert.throws(() => normalizeMediaConfig(baseConfig({ ytDlpArgs: ['--exec', 'touch /tmp/pwned'] })), /allowUnsafeYtDlpArgs/);
});

test('allows explicitly trusted unsafe yt-dlp arguments', () => {
  const config = normalizeMediaConfig(baseConfig({ allowUnsafeYtDlpArgs: true, ytDlpArgs: ['--exec', 'echo ok'] }));
  assert.deepEqual(config.ytDlpArgs, ['--exec', 'echo ok']);
});

test('rejects a missing Bilibili route', () => {
  assert.throws(() => normalizeMediaConfig(baseConfig({ bilibiliAccount: 'missing' })), /unknown\/disabled Bilibili account/);
});
