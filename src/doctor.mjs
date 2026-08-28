import process from 'node:process';
import { detectQQBinary } from './qq-detect.mjs';
import { isLoopbackHost } from './config.mjs';

const checks = [];
const add = (ok, name, detail) => checks.push({ ok, name, detail });

const major = Number(process.versions.node.split('.')[0]);
add(major >= 22, 'Node.js', process.version);
add(process.platform === 'linux', 'Platform', process.platform === 'linux' ? 'linux' : `${process.platform} (QQ launcher currently targets Linux)`);
add(Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY), 'Display session', process.env.WAYLAND_DISPLAY ? `Wayland ${process.env.WAYLAND_DISPLAY}` : process.env.DISPLAY ? `X11 ${process.env.DISPLAY}` : 'DISPLAY/WAYLAND_DISPLAY is missing');

try {
  const qq = await detectQQBinary();
  add(Boolean(qq), 'QQ NT executable', qq ? `${qq.path} (${qq.source})` : 'not found');
} catch (error) {
  add(false, 'QQ NT executable', error.message);
}

const webHost = process.env.WEB_BRIDGE_HOST || '127.0.0.1';
const hasAuth = Boolean(process.env.WEB_BRIDGE_AUTH_TOKEN);
add(isLoopbackHost(webHost) || hasAuth || process.env.WEB_BRIDGE_ALLOW_INSECURE === '1', 'Web exposure', isLoopbackHost(webHost) ? `${webHost} (loopback)` : hasAuth ? `${webHost} with authentication` : `${webHost} without authentication`);

const cdpHost = process.env.WEB_BRIDGE_CDP_HOST || '127.0.0.1';
add(isLoopbackHost(cdpHost) || process.env.WEB_BRIDGE_ALLOW_REMOTE_CDP === '1', 'CDP isolation', isLoopbackHost(cdpHost) ? `${cdpHost} (loopback)` : `${cdpHost} (remote override)`);

for (const check of checks) console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}: ${check.detail}`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
