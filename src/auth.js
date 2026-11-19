/**
 * Single shared-secret auth via `Authorization: Bearer <key>`.
 *
 * Deliberately simple — one key for the whole community, not per-user
 * accounts. Good enough for "a defined group I've shared a key with",
 * not meant to scale past that without real per-client credentials.
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { useApiKey } from './db.js';

export function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch rather than returning false,
  // so pad to equal length first — the length check itself leaks via timing
  // either way, but that's far less sensitive than the key content.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireApiKey(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token ||
      (!safeEqual(token, config.apiKey) && !useApiKey(token))) {
    res.status(401).json({ error: 'missing or invalid API key' });
    return;
  }
  next();
}
