import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildBootstrapExpression } from '../src/electron-cdp-bootstrap.mjs';

test('bootstrap expression replaces remote debugging switches before ready', () => {
  const switches = new Map([
    ['remote-debugging-address', 'old-host'],
    ['remote-debugging-port', '9222']
  ]);
  const calls = [];
  const app = {
    commandLine: {
      removeSwitch(name) {
        calls.push(['remove', name]);
        switches.delete(name);
      },
      appendSwitch(name, value) {
        calls.push(['append', name, value]);
        switches.set(name, value);
      },
      getSwitchValue(name) {
        return switches.get(name) || '';
      }
    }
  };

  const expression = buildBootstrapExpression({ cdpHost: '127.0.0.1', cdpPort: 41047 });
  const result = vm.runInNewContext(expression, {
    require(name) {
      assert.equal(name, 'electron');
      return { app };
    },
    process: {}
  });

  assert.deepEqual({ ...result }, { address: '127.0.0.1', port: '41047' });
  assert.deepEqual(calls, [
    ['remove', 'remote-debugging-address'],
    ['remove', 'remote-debugging-port'],
    ['append', 'remote-debugging-address', '127.0.0.1'],
    ['append', 'remote-debugging-port', '41047']
  ]);
});

test('bootstrap expression safely quotes host input', () => {
  const expression = buildBootstrapExpression({ cdpHost: "127.0.0.1'); throw new Error('boom", cdpPort: 43210 });
  assert.match(expression, /appendSwitch\('remote-debugging-address'/);
  assert.doesNotMatch(expression, /appendSwitch\('remote-debugging-address', '127\.0\.0\.1'/);
});
