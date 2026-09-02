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

test('default sync cadence stays within a roughly 50ms mutation-to-patch budget', () => {
  const config = withoutEnv(['WEB_BRIDGE_PATCH_THROTTLE_MS', 'WEB_BRIDGE_SHIM_POLL_MS'], () => loadConfig());
  assert.equal(config.patchThrottleMs, 16);
  assert.equal(config.shimPollMs, 33);
  assert.ok(config.patchThrottleMs + config.shimPollMs <= 50);
});

test('QQ launcher forwards the low-latency shim poll default while preserving overrides', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['dev:qq'], /WEB_BRIDGE_SHIM_POLL_MS=\$\{WEB_BRIDGE_SHIM_POLL_MS:-33\}/);
});
