import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';

function withoutEnv(names, fn) {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('push sync uses frame-paced patch coalescing and only slow safety polling', () => {
  const config = withoutEnv(['WEB_BRIDGE_PATCH_THROTTLE_MS', 'WEB_BRIDGE_SHIM_POLL_MS'], () => loadConfig());
  assert.equal(config.patchThrottleMs, 16);
  assert.equal(config.shimPollMs, 1000);
});

test('QQ launcher keeps fallback polling slow while preserving user overrides', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['dev:qq'], /WEB_BRIDGE_SHIM_POLL_MS=\$\{WEB_BRIDGE_SHIM_POLL_MS:-1000\}/);
});
