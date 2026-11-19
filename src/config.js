/**
 * All runtime configuration, loaded once from the environment.
 *
 * API_KEY has no default and the server refuses to start without one (see
 * server.js) — this service is meant for a defined community, not the open
 * internet, and a missing key should never silently mean "open to anyone."
 */
import { randomUUID } from 'node:crypto';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int('PORT', 8787),
  dbPath: process.env.DB_PATH || './data/cache.db',
  apiKey: process.env.API_KEY || null,

  retentionDays: int('RETENTION_DAYS', 60),
  cleanupIntervalMs: int('CLEANUP_INTERVAL_MS', 60 * 60 * 1000), // hourly

  maxLookupUsers: int('MAX_LOOKUP_USERS', 100),
  maxContributeEntries: int('MAX_CONTRIBUTE_ENTRIES', 200),
  maxFieldLength: int('MAX_FIELD_LENGTH', 100),

  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60 * 1000),
  lookupRateLimit: int('LOOKUP_RATE_LIMIT', 60),      // per window, per IP
  contributeRateLimit: int('CONTRIBUTE_RATE_LIMIT', 30) // per window, per IP
};

/** Only used by `npm run dev` convenience output — never a real credential. */
export const SAMPLE_KEY = randomUUID();
