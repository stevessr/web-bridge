import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

const BILITV_APP_KEY = '4409e2ce8ffd12b8';
const BILITV_APP_SECRET = '59b43e04ad6965f34319062b478f83dd';
const QR_CREATE_URL = 'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-tv-login/qrcode/poll';
const DEFAULT_QR_TTL_MS = 180_000;

function unixSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}

export function signBilibiliTvParams(entries, appSecret = BILITV_APP_SECRET) {
  const params = entries instanceof URLSearchParams ? new URLSearchParams(entries) : new URLSearchParams(entries);
  return createHash('md5').update(`${params.toString()}${appSecret}`).digest('hex');
}

function signedForm(entries) {
  const params = new URLSearchParams(entries);
  params.set('sign', signBilibiliTvParams(params));
  return params;
}

async function postSigned(fetchImpl, url, entries, { signal } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'web-bridge/0.2 BilibiliQR'
    },
    body: signedForm(entries),
    signal
  });
  if (!response.ok) throw new Error(`Bilibili QR API HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('Bilibili QR API returned an invalid response');
  return payload;
}

function apiError(payload, fallback) {
  const message = payload?.message || payload?.msg || fallback;
  return new Error(`Bilibili QR API: ${message} (code ${payload?.code ?? 'unknown'})`);
}

function validateCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bilibili QR login returned an invalid credential');
  if (!value.cookie_info || !value.token_info) throw new Error('Bilibili QR login credential is missing cookie_info/token_info');
  return { ...value, platform: 'BiliTV' };
}

export function createBilibiliQrLoginService({ fetchImpl = globalThis.fetch, qrToDataURL = QRCode.toDataURL, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (typeof qrToDataURL !== 'function') throw new Error('QR renderer is required');

  return Object.freeze({
    async start({ signal } = {}) {
      const createdAtMs = now();
      const payload = await postSigned(fetchImpl, QR_CREATE_URL, [
        ['appkey', BILITV_APP_KEY],
        ['local_id', '0'],
        ['ts', String(unixSeconds(createdAtMs))]
      ], { signal });
      if (payload.code !== 0) throw apiError(payload, 'failed to create QR code');
      const authCode = payload.data?.auth_code;
      const loginUrl = payload.data?.url;
      if (typeof authCode !== 'string' || !authCode || typeof loginUrl !== 'string' || !loginUrl) {
        throw new Error('Bilibili QR API response is missing auth_code/url');
      }
      const qrDataUrl = await qrToDataURL(loginUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 288,
        type: 'image/png'
      });
      return {
        authCode,
        pollTs: unixSeconds(now()),
        qrDataUrl,
        expiresAt: new Date(createdAtMs + DEFAULT_QR_TTL_MS).toISOString()
      };
    },

    async poll(session, { signal } = {}) {
      if (!session?.authCode) throw new Error('QR login session is missing auth code');
      if (session.expiresAt && Date.parse(session.expiresAt) <= now()) return { status: 'expired' };
      const payload = await postSigned(fetchImpl, QR_POLL_URL, [
        ['appkey', BILITV_APP_KEY],
        ['auth_code', session.authCode],
        ['local_id', '0'],
        ['ts', String(session.pollTs || unixSeconds(now()))]
      ], { signal });

      if (payload.code === 0) {
        const credential = validateCredential(payload.data);
        return {
          status: 'success',
          credential,
          mid: credential.token_info?.mid ?? null
        };
      }
      if (payload.code === 86038) return { status: 'expired' };
      if (payload.code === 86090) return { status: 'scanned' };
      if (payload.code === 86039 || payload.code === 86101) return { status: 'waiting' };
      throw apiError(payload, 'QR login polling failed');
    }
  });
}

export async function saveBilibiliCredential(file, credential) {
  const absolute = path.resolve(file);
  const dir = path.dirname(absolute);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(validateCredential(credential), null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, absolute);
    if (process.platform !== 'win32') await chmod(absolute, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return absolute;
}
