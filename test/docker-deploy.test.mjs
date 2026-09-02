import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Dockerfile installs official Linux QQ and runs it headlessly without disabling sandbox', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /download-linuxqq/);
  assert.match(dockerfile, /TARGETARCH/);
  assert.match(dockerfile, /xvfb/);
  assert.match(dockerfile, /USER webbridge/);
  assert.match(dockerfile, /VOLUME \["\/home\/webbridge\/\.config\/QQ"\]/);
  assert.match(dockerfile, /chrome-sandbox/);
  assert.doesNotMatch(dockerfile, /--no-sandbox/);
});

test('Docker entrypoint uses a private virtual display and requires auth for published UI', async () => {
  const entrypoint = await read('deploy/docker-entrypoint.sh');
  assert.match(entrypoint, /dbus-run-session -- xvfb-run/);
  assert.match(entrypoint, /-nolisten tcp/);
  assert.match(entrypoint, /WEB_BRIDGE_AUTH_TOKEN/);
  assert.doesNotMatch(entrypoint, /owner\.focus|target\.focus/);
});

test('Compose persists QQ state and allocates enough Chromium shared memory', async () => {
  const compose = await read('docker-compose.yml');
  assert.match(compose, /shm_size: 512m/);
  assert.match(compose, /qq-data:\/home\/webbridge\/\.config\/QQ/);
  assert.match(compose, /WEB_BRIDGE_AUTH_TOKEN/);
  assert.match(compose, /WEB_BRIDGE_QQ_MAIN_SHIM/);
});

test('QQ downloader discovers only architecture-matching Tencent packages by default', async () => {
  const downloader = await read('deploy/download-linuxqq.sh');
  assert.match(downloader, /linuxConfig\.js/);
  assert.match(downloader, /amd64\|x86_64/);
  assert.match(downloader, /arm64\|aarch64/);
  assert.match(downloader, /refusing non-Tencent QQ download URL/);
  assert.match(downloader, /dpkg-deb --info/);
});
