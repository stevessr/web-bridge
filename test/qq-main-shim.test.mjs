import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLoaderSource, buildShimPackage, prepareShadowQQ } from '../src/qq-main-shim.mjs';

test('shim package preserves QQ metadata and replaces only main entry', () => {
  const original = { name: 'QQ', version: '3.2.33', main: './application/app_launcher/index.js', sideEffects: true };
  const result = buildShimPackage(original, './.web-bridge-main-shim.cjs');
  assert.deepEqual(result, {
    name: 'QQ', version: '3.2.33', main: './.web-bridge-main-shim.cjs', sideEffects: true
  });
  assert.equal(original.main, './application/app_launcher/index.js');
});

test('loader injects remote debugging switches before loading original QQ main', () => {
  const calls = [];
  const required = [];
  const app = {
    commandLine: {
      removeSwitch(name) { calls.push(['remove', name]); },
      appendSwitch(name, value) { calls.push(['append', name, value]); }
    }
  };
  const source = buildLoaderSource('./application/app_launcher/index.js');
  const context = {
    process: {
      env: { WEB_BRIDGE_CDP_HOST: '127.0.0.1', WEB_BRIDGE_CDP_PORT: '33677' },
      resourcesPath: '/tmp/qq-shadow/resources',
      stderr: { write() {} }
    },
    require(name) {
      if (name === 'node:path') return { join: (...parts) => parts.join('/').replaceAll('//', '/'), isAbsolute: (p) => p.startsWith('/'), resolve: (...parts) => parts.join('/').replaceAll('//', '/') };
      if (name === 'electron') return { app };
      required.push(name);
      return {};
    },
    setTimeout(fn) { fn(); },
    global: {}
  };
  vm.runInNewContext(source, context);
  assert.deepEqual(calls, [
    ['remove', 'remote-debugging-address'],
    ['remove', 'remote-debugging-port'],
    ['append', 'remote-debugging-address', '127.0.0.1'],
    ['append', 'remote-debugging-port', '33677']
  ]);
  assert.equal(required.length, 1);
  assert.match(required[0], /application\/app_launcher\/index\.js$/);
});

test('shadow distribution keeps Chromium outside a nested user namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-bridge-shadow-test-'));
  try {
    const qqRoot = join(root, 'QQ');
    const appRoot = join(qqRoot, 'resources', 'app');
    await mkdir(appRoot, { recursive: true });
    const qqBin = join(qqRoot, 'qq');
    await writeFile(qqBin, '#!/bin/sh\nexit 0\n');
    await chmod(qqBin, 0o755);
    await writeFile(join(qqRoot, 'libffmpeg.so'), 'fake-lib');
    await writeFile(join(qqRoot, 'resources', 'resources.pak'), 'fake-resource');
    await writeFile(join(appRoot, 'main.js'), 'module.exports = true;\n');
    await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'QQ', version: '3.2.33', main: './main.js' }));

    const shadowRoot = join(root, 'shadow');
    const result = await prepareShadowQQ({ qqBin, outputDir: shadowRoot });

    assert.equal(result.shadowBin, join(shadowRoot, 'qq'));
    assert.equal((await lstat(result.shadowBin)).isSymbolicLink(), false);
    assert.equal((await lstat(join(shadowRoot, 'libffmpeg.so'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(shadowRoot, 'libffmpeg.so')), join(qqRoot, 'libffmpeg.so'));
    assert.equal((await lstat(join(shadowRoot, 'resources', 'resources.pak'))).isSymbolicLink(), true);
    assert.equal((await lstat(join(shadowRoot, 'resources', 'app', 'main.js'))).isSymbolicLink(), true);
    assert.equal((await lstat(join(shadowRoot, 'resources', 'app', 'package.json'))).isSymbolicLink(), false);

    const shadowPackage = JSON.parse(await readFile(join(shadowRoot, 'resources', 'app', 'package.json'), 'utf8'));
    assert.equal(shadowPackage.main, './.web-bridge-main-shim.cjs');
    assert.equal((await lstat(join(shadowRoot, 'resources', 'app', '.web-bridge-main-shim.cjs'))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
