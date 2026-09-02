import { randomBytes } from 'node:crypto';

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

export function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig() {
  const host = process.env.WEB_BRIDGE_HOST || '127.0.0.1';
  const cdpHost = process.env.WEB_BRIDGE_CDP_HOST || '127.0.0.1';
  const allowRemoteCdp = boolEnv('WEB_BRIDGE_ALLOW_REMOTE_CDP', false);
  if (!isLoopbackHost(cdpHost) && !allowRemoteCdp) throw new Error('Refusing remote CDP host. Keep WEB_BRIDGE_CDP_HOST on loopback or explicitly set WEB_BRIDGE_ALLOW_REMOTE_CDP=1.');
  const authToken = process.env.WEB_BRIDGE_AUTH_TOKEN || '';
  const allowInsecure = boolEnv('WEB_BRIDGE_ALLOW_INSECURE', false);
  if (!isLoopbackHost(host) && !authToken && !allowInsecure) {
    throw new Error('Refusing non-loopback bind without WEB_BRIDGE_AUTH_TOKEN. Set a token or explicitly set WEB_BRIDGE_ALLOW_INSECURE=1.');
  }

  return Object.freeze({
    host,
    port: intEnv('WEB_BRIDGE_PORT', 8080, { min: 1, max: 65535 }),
    cdpHost,
    cdpPort: intEnv('WEB_BRIDGE_CDP_PORT', 9222, { min: 1, max: 65535 }),
    attachTimeoutMs: intEnv('WEB_BRIDGE_ATTACH_TIMEOUT_MS', 60_000, { min: 1000, max: 600_000 }),
    reconnectMinMs: intEnv('WEB_BRIDGE_RECONNECT_MIN_MS', 500, { min: 100, max: 60_000 }),
    reconnectMaxMs: intEnv('WEB_BRIDGE_RECONNECT_MAX_MS', 10_000, { min: 500, max: 120_000 }),
    patchThrottleMs: intEnv('WEB_BRIDGE_PATCH_THROTTLE_MS', 16, { min: 8, max: 5000 }),
    shimPollMs: intEnv('WEB_BRIDGE_SHIM_POLL_MS', 33, { min: 16, max: 5000 }),
    fullSnapshotIntervalMs: intEnv('WEB_BRIDGE_FULL_SNAPSHOT_INTERVAL_MS', 60_000, { min: 5000, max: 3_600_000 }),
    callTimeoutMs: intEnv('WEB_BRIDGE_CDP_CALL_TIMEOUT_MS', 15_000, { min: 1000, max: 120_000 }),
    maxClients: intEnv('WEB_BRIDGE_MAX_CLIENTS', 4, { min: 1, max: 128 }),
    maxWsPayloadBytes: intEnv('WEB_BRIDGE_MAX_WS_PAYLOAD_BYTES', 2 * 1024 * 1024, { min: 4096, max: 64 * 1024 * 1024 }),
    maxInputEventsPerSecond: intEnv('WEB_BRIDGE_INPUT_EVENTS_PER_SECOND', 180, { min: 10, max: 2000 }),
    maxInputBurst: intEnv('WEB_BRIDGE_INPUT_BURST', 240, { min: 10, max: 5000 }),
    maxTextBytes: intEnv('WEB_BRIDGE_MAX_TEXT_BYTES', 64 * 1024, { min: 256, max: 4 * 1024 * 1024 }),
    maxResourceBytes: intEnv('WEB_BRIDGE_MAX_RESOURCE_BYTES', 64 * 1024 * 1024, { min: 64 * 1024, max: 512 * 1024 * 1024 }),
    maxUploadBytes: intEnv('WEB_BRIDGE_MAX_UPLOAD_BYTES', 256 * 1024 * 1024, { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 }),
    uploadTtlMs: intEnv('WEB_BRIDGE_UPLOAD_TTL_MS', 10 * 60_000, { min: 60_000, max: 60 * 60_000 }),
    resourceCacheBytes: intEnv('WEB_BRIDGE_RESOURCE_CACHE_BYTES', 192 * 1024 * 1024, { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 }),
    resourceTokenTtlMs: intEnv('WEB_BRIDGE_RESOURCE_TOKEN_TTL_MS', 30 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 }),
    heartbeatMs: intEnv('WEB_BRIDGE_HEARTBEAT_MS', 30_000, { min: 5000, max: 120_000 }),
    controlLeaseMs: intEnv('WEB_BRIDGE_CONTROL_LEASE_MS', 30_000, { min: 1000, max: 600_000 }),
    maxBufferedBytes: intEnv('WEB_BRIDGE_MAX_BUFFERED_BYTES', 8 * 1024 * 1024, { min: 256 * 1024, max: 128 * 1024 * 1024 }),
    authToken,
    authRealm: process.env.WEB_BRIDGE_AUTH_REALM || 'web-bridge',
    allowedOrigins: listEnv('WEB_BRIDGE_ALLOWED_ORIGINS'),
    allowInsecure,
    allowRemoteCdp,
    allowMultipleControllers: boolEnv('WEB_BRIDGE_MULTI_CONTROL', false),
    metricsPublic: boolEnv('WEB_BRIDGE_METRICS_PUBLIC', false),
    targetMatch: process.env.WEB_BRIDGE_TARGET_MATCH || '',
    instanceId: process.env.WEB_BRIDGE_INSTANCE_ID || randomBytes(8).toString('hex')
  });
}
