import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, originAllowed } from '../src/auth.mjs';

const config = { authToken: 'secret-value', allowedOrigins: [] };

test('basic and bearer authentication', () => {
  const basic = Buffer.from('web:secret-value').toString('base64');
  assert.equal(isAuthorized({ headers: { authorization: `Basic ${basic}` } }, config), true);
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer secret-value' } }, config), true);
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer nope' } }, config), false);
});

test('same-origin websocket check', () => {
  assert.equal(originAllowed({ headers: { origin: 'https://bridge.example', host: 'bridge.example' } }, config), true);
  assert.equal(originAllowed({ headers: { origin: 'https://evil.example', host: 'bridge.example' } }, config), false);
});
