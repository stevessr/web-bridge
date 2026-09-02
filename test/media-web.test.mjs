import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMediaWebApp } from '../src/media/web.mjs';
import { writeJsonAtomic } from '../src/media/utils.mjs';

function exampleConfig() {
  return {
    workDir: './work',
    maxAttempts: 3,
    youtubeAccounts: [
      {
        id: 'youtube-main',
        sourceUrls: ['https://www.youtube.com/@example/videos'],
        bilibiliAccount: 'default'
      }
    ],
    asr: {
      backend: 'openai-compatible',
      apiKeyEnv: 'TEST_ASR_KEY'
    },
    translation: {
      backend: 'none'
    },
    bilibiliAccount: 'default',
    bilibili: {
      accounts: [
        { id: 'default', cookieFile: './bilibili.cookies' }
      ]
    }
  };
}

async function startApp(t, { token = '' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'web-bridge-media-web-'));
  const configFile = path.join(dir, 'media.json');
  await writeJsonAtomic(configFile, exampleConfig());
  const app = createMediaWebApp({ configFile, token });
  const server = createServer(app.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.close();
    await once(server, 'close').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { baseUrl, configFile, dir };
}

test('media WebUI serves the dashboard and snapshot API', async (t) => {
  const { baseUrl } = await startApp(t);
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /自动烤肉控制台/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

  const response = await fetch(`${baseUrl}/api/snapshot`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.config.youtubeAccounts[0].id, 'youtube-main');
  assert.equal(snapshot.stats.total, 0);
  assert.equal(snapshot.runtime.mode, 'idle');
});

test('media WebUI API requires bearer token when configured', async (t) => {
  const { baseUrl } = await startApp(t, { token: 'secret-token' });
  assert.equal((await fetch(`${baseUrl}/api/snapshot`)).status, 401);
  const response = await fetch(`${baseUrl}/api/snapshot`, {
    headers: { authorization: 'Bearer secret-token' }
  });
  assert.equal(response.status, 200);
});

test('media WebUI validates configuration before replacing media.json', async (t) => {
  const { baseUrl, configFile } = await startApp(t);
  const before = await readFile(configFile, 'utf8');
  const response = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ youtubeAccounts: [] })
  });
  assert.equal(response.status, 500);
  assert.equal(await readFile(configFile, 'utf8'), before);

  const next = exampleConfig();
  next.pollIntervalSeconds = 42;
  const ok = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next)
  });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(saved.pollIntervalSeconds, 42);
});
