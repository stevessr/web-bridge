import { createHash, timingSafeEqual } from 'node:crypto';

function equalSecret(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

export function isAuthorized(req, config) {
  if (!config.authToken) return true;
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return equalSecret(header.slice(7), config.authToken);
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const password = separator >= 0 ? decoded.slice(separator + 1) : '';
      return equalSecret(password, config.authToken);
    } catch {
      return false;
    }
  }
  return false;
}

export function challenge(res, config) {
  res.writeHead(401, {
    'www-authenticate': `Basic realm="${String(config.authRealm).replace(/["\\]/g, '')}", charset="UTF-8"`,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end('Authentication required');
}

export function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  try {
    const parsed = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    return parsed.host === host;
  } catch {
    return false;
  }
}
