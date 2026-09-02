import test from 'node:test';
import assert from 'node:assert/strict';
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

test('loader exposes Electron webContents.debugger and falls back across renderer targets', () => {
  const source = buildLoaderSource('./application/app_launcher/index.js');
  assert.match(source, /webContents\.getAllWebContents\(\)/);
  assert.match(source, /webContents\.fromId|debuggerCandidates/);
  assert.match(source, /wc\.debugger\.attach\('1\.3'\)/);
  assert.match(source, /wc\.debugger\.attach\(\)/);
  assert.match(source, /sendCommand\('Runtime\.enable'\)/);
  assert.match(source, /sendCommand\('Page\.enable'\)/);
  assert.match(source, /no usable renderer debugger target/);
  assert.match(source, /QQ webContents\.debugger bridge listening/);
  assert.match(source, /require\(entry\)/);
  assert.doesNotMatch(source, /appendSwitch\('remote-debugging-port'/);
  assert.doesNotMatch(source, /--no-sandbox/);
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
