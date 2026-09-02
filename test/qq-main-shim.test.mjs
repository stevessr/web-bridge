import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildLoaderSource, buildShimPackage } from '../src/qq-main-shim.mjs';

test('shim package preserves QQ metadata and replaces only main entry', () => {
  const original = { name: 'QQ', version: '3.2.33', main: './application/app_launcher/index.js', sideEffects: true };
  const result = buildShimPackage(original, '/tmp/web-bridge/qq-main-shim.cjs');
  assert.deepEqual(result, {
    name: 'QQ', version: '3.2.33', main: '/tmp/web-bridge/qq-main-shim.cjs', sideEffects: true
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
      resourcesPath: '/opt/QQ/resources',
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
