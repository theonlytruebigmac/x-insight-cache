/**
 * Bearer-token auth via `Authorization: Bearer <key>`.
 *
 * Two kinds of credential are accepted: the shared API_KEY from the
 * environment, and individually issued/revocable keys stored (hashed) in the
 * database by the admin dashboard.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { useApiKey } from './db.js';

/**
 * Constant-time string comparison. Both inputs are hashed first so the
 * comparison always runs over equal-length buffers: no early return on a length
 * mismatch, so neither the content nor the length of the secret leaks via timing.
 */
export function safeEqual(a, b) {
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// RFC 7235: the auth scheme is case-insensitive.
const BEARER_RE = /^Bearer +(\S+)$/i;

export function requireApiKey(req, res, next) {
  const token = BEARER_RE.exec(req.get('authorization') || '')?.[1];
  if (!token || (!safeEqual(token, config.apiKey) && !useApiKey(token))) {
    res.status(401).json({ error: 'missing or invalid API key' });
    return;
  }
  next();
}
