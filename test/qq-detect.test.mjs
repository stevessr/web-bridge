import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectQQBinary, extractExecutableFromDesktopExec, tokenizeDesktopExec } from '../src/qq-detect.mjs';

test('tokenizeDesktopExec preserves quoted paths', () => {
  assert.deepEqual(
    tokenizeDesktopExec('"/opt/Tencent QQ/qq" --no-sandbox %U'),
    ['/opt/Tencent QQ/qq', '--no-sandbox', '%U']
  );
});

test('extractExecutableFromDesktopExec handles env prefixes', () => {
  assert.equal(
    extractExecutableFromDesktopExec('env ELECTRON_OZONE_PLATFORM_HINT=x11 DESKTOPINTEGRATION=false /usr/bin/linuxqq --no-sandbox %U'),
    '/usr/bin/linuxqq'
  );
});

test('extractExecutableFromDesktopExec handles direct Exec values', () => {
  assert.equal(extractExecutableFromDesktopExec('/opt/QQ/qq %U'), '/opt/QQ/qq');
});

test('QQ_BIN override wins and is validated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-bridge-qq-'));
  try {
    const executable = join(dir, 'qq');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    const result = await detectQQBinary({ env: { ...process.env, QQ_BIN: executable } });
    assert.equal(result.path, executable);
    assert.equal(result.source, 'env:QQ_BIN');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
