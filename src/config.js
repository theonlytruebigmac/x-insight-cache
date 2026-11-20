/**
 * All runtime configuration, loaded once from the environment.
 *
 * API_KEY has no default and the server refuses to start without one (see
 * server.js) — this service is meant for a defined community, not the open
 * internet, and a missing key should never silently mean "open to anyone."
 *
 * Numeric settings are validated: a value that is set but malformed or out of
 * range is a startup error rather than a silent fallback to the default (a typo
 * like RETENTION_DAYS=6O should not quietly mean "60"), and nonsense such as
 * CLEANUP_INTERVAL_MS=0 can't turn the sweep into a busy loop.
 */

function int(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    console.error(`FATAL: ${name}="${raw}" is invalid. Expected an integer between ${min} and ${max}.`);
    process.exit(1);
  }
  return n;
}

export const config = {
  port: int('PORT', 8787, { min: 0, max: 65535 }),
  dbPath: process.env.DB_PATH || './data/cache.db',
  apiKey: process.env.API_KEY || null,
  adminUsername: process.env.ADMIN_USERNAME || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  adminSecureCookie: process.env.ADMIN_SECURE_COOKIE !== 'false',

  retentionDays: int('RETENTION_DAYS', 60),
  cleanupIntervalMs: int('CLEANUP_INTERVAL_MS', 60 * 60 * 1000, { min: 1000 }), // hourly
  notFoundTtlSeconds: int('NOT_FOUND_TTL_SECONDS', 24 * 60 * 60),

  maxLookupUsers: int('MAX_LOOKUP_USERS', 100),
  maxContributeEntries: int('MAX_CONTRIBUTE_ENTRIES', 200),
  maxFieldLength: int('MAX_FIELD_LENGTH', 100),

  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60 * 1000),
  lookupRateLimit: int('LOOKUP_RATE_LIMIT', 60),        // per window, per IP
  contributeRateLimit: int('CONTRIBUTE_RATE_LIMIT', 30), // per window, per IP
  statsRateLimit: int('STATS_RATE_LIMIT', 30)            // per window, per IP
};
