import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';

const host = await readFile(new URL('../src/host-multi.mjs', import.meta.url), 'utf8');

function withoutEnv(names, fn) {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try { return fn(); }
  finally {
    for (const [name, value] of saved) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('multi-screen defaults keep discovery responsive and bounded', () => {
  const config = withoutEnv(['WEB_BRIDGE_SCREEN_DISCOVERY_MS', 'WEB_BRIDGE_MAX_SCREENS'], () => loadConfig());
  assert.equal(config.screenDiscoveryMs, 1000);
  assert.equal(config.maxScreens, 8);
});

test('host keeps independent sessions, revisions and patch queues per screen', () => {
  assert.match(host, /const screens = new Map\(\)/);
  assert.match(host, /function createSession\(target\)/);
  assert.match(host, /patchTimer: null/);
  assert.match(host, /syncChain: Promise\.resolve\(\)/);
  assert.match(host, /broadcastToScreen/);
  assert.match(host, /screenId: session\.id/);
  assert.match(host, /hasSubscribers\(session\.id\)/);
});

test('host discovers multiple renderer windows and scopes resources and controls', () => {
  assert.match(host, /listTargets\(config\.cdpHost/);
  assert.match(host, /slice\(0, config\.maxScreens\)/);
  assert.match(host, /controllerByScreen/);
  assert.match(host, /registerResource\(url, screenId\)/);
  assert.match(host, /upload\.screenId !== session\.id/);
  assert.match(host, /type: 'screenUnavailable'/);
  assert.match(host, /web_bridge_screens/);
});
