import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBilibiliQrLoginService, saveBilibiliCredential, signBilibiliTvParams } from '../src/media/bilibili-login.mjs';
import { createMediaWebApp } from '../src/media/web.mjs';
import { writeJsonAtomic } from '../src/media/utils.mjs';

function credential(secret = 'secret') {
  return {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: secret }] },
    sso: ['bilibili.com'],
    token_info: { access_token: `${secret}-access`, expires_in: 3600, mid: 42, refresh_token: `${secret}-refresh` }
  };
}

function mediaConfig() {
  return {
    workDir: './work',
    youtubeAccounts: [{ id: 'youtube-main', sourceUrls: ['https://www.youtube.com/@example/videos'], bilibiliAccount: 'default' }],
    asr: { backend: 'openai-compatible', apiKeyEnv: 'TEST_ASR_KEY' },
    translation: { backend: 'none' },
    bilibiliAccount: 'default',
    bilibili: { accounts: [{ id: 'default', cookieFile: './bilibili.cookies.json' }] }
  };
}

test('BiliTV signing matches biliup-compatible request examples', () => {
  assert.equal(signBilibiliTvParams([
    ['appkey', '4409e2ce8ffd12b8'], ['local_id', '0'], ['ts', '0']
  ]), 'e134154ed6add881d28fbdf68653cd9c');
  assert.equal(signBilibiliTvParams([
    ['appkey', '4409e2ce8ffd12b8'], ['auth_code', '6214464b3025541abf6f654cf7569a01'], ['local_id', '0'], ['ts', '0']
  ]), '87de3d0fee7c3f4facd244537238914e');
});

test('QR service creates a QR and maps waiting/success without exposing protocol details', async () => {
  const responses = [
    { code: 0, data: { url: 'https://passport.bilibili.com/example', auth_code: 'auth-secret' } },
    { code: 86039, message: 'waiting' },
    { code: 0, data: credential('login-secret') }
  ];
  const requests = [];
  const service = createBilibiliQrLoginService({
    now: () => 1_000,
    qrToDataURL: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body.toString() });
      const payload = responses.shift();
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  const started = await service.start();
  assert.equal(started.authCode, 'auth-secret');
  assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
  assert.match(requests[0].body, /sign=/);
  assert.deepEqual(await service.poll(started), { status: 'waiting' });
  const done = await service.poll(started);
  assert.equal(done.status, 'success');
  assert.equal(done.mid, 42);
  assert.equal(done.credential.platform, 'BiliTV');
});

test('credential writer stores biliup LoginInfo with owner-only permissions on Unix', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'web-bridge-bili-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'account.json');
  await saveBilibiliCredential(file, credential('disk-secret'));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.platform, 'BiliTV');
  assert.equal(saved.token_info.mid, 42);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('WebUI QR login saves the credential for the selected Bilibili account', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'web-bridge-bili-web-'));
  const configFile = path.join(dir, 'media.json');
  await writeJsonAtomic(configFile, mediaConfig());
  const fakeLogin = {
    async start() {
      return { authCode: 'server-only-auth', pollTs: 1, qrDataUrl: 'data:image/png;base64,AAAA', expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    async poll() {
      return { status: 'success', credential: credential('web-secret'), mid: 42 };
    }
  };
  const app = createMediaWebApp({ configFile, bilibiliLogin: fakeLogin });
  const server = createServer(app.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await once(server, 'close').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const startResponse = await fetch(`${baseUrl}/api/bilibili/qr/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'default' })
  });
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  assert.ok(started.sessionId);
  assert.equal(JSON.stringify(started).includes('server-only-auth'), false);

  const pollResponse = await fetch(`${baseUrl}/api/bilibili/qr/status?sessionId=${encodeURIComponent(started.sessionId)}`);
  assert.equal(pollResponse.status, 200);
  const result = await pollResponse.json();
  assert.deepEqual(result, { status: 'success', accountId: 'default', credentialSaved: true, mid: 42 });
  assert.equal(JSON.stringify(result).includes('web-secret'), false);

  const saved = JSON.parse(await readFile(path.join(dir, 'bilibili.cookies.json'), 'utf8'));
  assert.equal(saved.cookie_info.cookies[0].value, 'web-secret');

  const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
  assert.equal(snapshot.config.bilibiliAccounts[0].credentialConfigured, true);
  assert.equal(snapshot.config.bilibiliAccounts[0].credentialPresent, true);
});
