/**
 * SQLite storage.
 *
 * One file, one process — intentional for "simple". No native TTL (unlike
 * Cloudflare KV, which upstream relied on), so retention is enforced by a
 * periodic sweep in server.js rather than per-key expiry.
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
// In WAL mode NORMAL cannot corrupt the database; it only risks losing the last
// few commits on power loss, which is fine for a re-fillable cache and avoids an
// fsync (blocking the event loop) on every lookup's activity-counter write.
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    username TEXT PRIMARY KEY,
    location TEXT,
    device TEXT,
    location_accurate INTEGER NOT NULL DEFAULT 1,
    affiliation TEXT,
    account_id TEXT,
    created_at INTEGER,
    username_changes INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_updated_at ON entries(updated_at);

  CREATE TABLE IF NOT EXISTS not_found_entries (
    username TEXT PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_not_found_expires_at ON not_found_entries(expires_at);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    bucket INTEGER PRIMARY KEY,
    lookup_requests INTEGER NOT NULL DEFAULT 0,
    lookup_hits INTEGER NOT NULL DEFAULT 0,
    lookup_misses INTEGER NOT NULL DEFAULT 0,
    lookup_not_found_hits INTEGER NOT NULL DEFAULT 0,
    lookup_rate_limited INTEGER NOT NULL DEFAULT 0,
    contribute_rate_limited INTEGER NOT NULL DEFAULT 0,
    contribution_entries INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_activity_bucket ON activity(bucket);

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
`);

const activityColumns = new Set(db.prepare('PRAGMA table_info(activity)').all().map((column) => column.name));
for (const [name, definition] of [
  ['lookup_not_found_hits', 'INTEGER NOT NULL DEFAULT 0'],
  ['lookup_rate_limited', 'INTEGER NOT NULL DEFAULT 0'],
  ['contribute_rate_limited', 'INTEGER NOT NULL DEFAULT 0']
]) {
  if (!activityColumns.has(name)) db.exec(`ALTER TABLE activity ADD COLUMN ${name} ${definition}`);
}

function getMeta(key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function incrMeta(key, by) {
  const next = (Number(getMeta(key, '0')) || 0) + by;
  setMeta(key, next);
  return next;
}

// Merge rules for a contribution against an existing row. Contributions carry their
// observation time, so arrival order no longer decides which data wins:
//  - the newer observation wins each field it actually has; the other fills gaps
//  - if both rows name different account ids, the handle was recycled: the newer
//    observation replaces the row wholesale (never mix two accounts' fields)
// SQLite evaluates every SET expression against the pre-update row.
const NEWER = 'excluded.updated_at >= entries.updated_at';
const SAME_ACCOUNT = '(excluded.account_id IS NULL OR entries.account_id IS NULL OR excluded.account_id = entries.account_id)';
const pickNewer = (column) => `CASE
        WHEN NOT ${SAME_ACCOUNT} THEN CASE WHEN ${NEWER} THEN excluded.${column} ELSE entries.${column} END
        WHEN ${NEWER} THEN COALESCE(excluded.${column}, entries.${column})
        ELSE COALESCE(entries.${column}, excluded.${column}) END`;

const stmts = {
  getMany: db.prepare(`
    SELECT username, location, device, location_accurate, affiliation, account_id, created_at, username_changes, updated_at
    FROM entries WHERE username IN (SELECT value FROM json_each(?)) AND updated_at >= ?
  `),
  getEntriesByUsername: db.prepare('SELECT * FROM entries WHERE username IN (SELECT value FROM json_each(?))'),
  getNotFoundMany: db.prepare(`
    SELECT n.username, n.observed_at
    FROM not_found_entries n
    LEFT JOIN entries e ON e.username = n.username
    WHERE n.username IN (SELECT value FROM json_each(?))
      AND n.expires_at > ?
      AND (e.username IS NULL OR n.observed_at > e.updated_at)
  `),
  upsertNotFound: db.prepare(`
    INSERT INTO not_found_entries (username, observed_at, expires_at)
    VALUES (@username, @observedAt, @expiresAt)
    ON CONFLICT(username) DO UPDATE SET
      observed_at = excluded.observed_at,
      expires_at = excluded.expires_at
    WHERE excluded.observed_at >= not_found_entries.observed_at
  `),
  entryUpdatedAt: db.prepare('SELECT updated_at FROM entries WHERE username = ?'),
  clearOlderNotFound: db.prepare(`
    DELETE FROM not_found_entries WHERE username = ? AND observed_at <= ?
  `),
  upsert: db.prepare(`
    INSERT INTO entries (username, location, device, location_accurate, affiliation, account_id, created_at, username_changes, updated_at)
    VALUES (@username, @location, @device, @locationAccurate, @affiliation, @accountId, @createdAt, @usernameChanges, @updatedAt)
    ON CONFLICT(username) DO UPDATE SET
      location = ${pickNewer('location')},
      device = ${pickNewer('device')},
      location_accurate = CASE
        WHEN NOT ${SAME_ACCOUNT} THEN CASE WHEN ${NEWER} THEN excluded.location_accurate ELSE entries.location_accurate END
        WHEN ${NEWER} AND excluded.location IS NOT NULL THEN excluded.location_accurate
        WHEN entries.location IS NULL AND excluded.location IS NOT NULL THEN excluded.location_accurate
        ELSE entries.location_accurate END,
      affiliation = ${pickNewer('affiliation')},
      account_id = ${pickNewer('account_id')},
      created_at = ${pickNewer('created_at')},
      username_changes = ${pickNewer('username_changes')},
      updated_at = MAX(excluded.updated_at, entries.updated_at)
  `),
  count: db.prepare('SELECT COUNT(*) AS n FROM entries'),
  deleteOlderThan: db.prepare('DELETE FROM entries WHERE updated_at < ?'),
  activityUpsert: db.prepare(`
    INSERT INTO activity (
      bucket, lookup_requests, lookup_hits, lookup_misses, lookup_not_found_hits,
      lookup_rate_limited, contribute_rate_limited, contribution_entries
    )
    VALUES (
      @bucket, @lookupRequests, @lookupHits, @lookupMisses, @lookupNotFoundHits,
      @lookupRateLimited, @contributeRateLimited, @contributionEntries
    )
    ON CONFLICT(bucket) DO UPDATE SET
      lookup_requests = lookup_requests + excluded.lookup_requests,
      lookup_hits = lookup_hits + excluded.lookup_hits,
      lookup_misses = lookup_misses + excluded.lookup_misses,
      lookup_not_found_hits = lookup_not_found_hits + excluded.lookup_not_found_hits,
      lookup_rate_limited = lookup_rate_limited + excluded.lookup_rate_limited,
      contribute_rate_limited = contribute_rate_limited + excluded.contribute_rate_limited,
      contribution_entries = contribution_entries + excluded.contribution_entries
  `)
};

function currentHour() {
  return Math.floor(Date.now() / 3600000) * 3600;
}

/** Store only hourly aggregate counts; no usernames or IP addresses. */
export function recordActivity({
  lookupRequests = 0, lookupHits = 0, lookupMisses = 0, lookupNotFoundHits = 0,
  lookupRateLimited = 0, contributeRateLimited = 0, contributionEntries = 0
}) {
  stmts.activityUpsert.run({
    bucket: currentHour(), lookupRequests, lookupHits, lookupMisses, lookupNotFoundHits,
    lookupRateLimited, contributeRateLimited, contributionEntries
  });
}

function hashApiKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createApiKey(name) {
  const token = `xic_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, hashApiKey(token), token.slice(0, 12), createdAt);
  return { id, name, keyPrefix: token.slice(0, 12), createdAt, token };
}

export function listApiKeys() {
  return db.prepare(`
    SELECT id, name, key_prefix AS keyPrefix, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM api_keys ORDER BY created_at DESC, name ASC
  `).all();
}

export function revokeApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
}

export function useApiKey(token) {
  const hash = hashApiKey(token);
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    UPDATE api_keys SET last_used_at = @now
    WHERE key_hash = @hash AND (last_used_at IS NULL OR last_used_at < @recent)
  `).run({ hash, now, recent: now - 60 }).changes > 0 ||
    !!db.prepare('SELECT 1 FROM api_keys WHERE key_hash = ?').get(hash);
}

/**
 * Entries past retention are not served even though the periodic sweep may not
 * have deleted them yet (same boundary the sweep uses: `updated_at < cutoff`).
 * @param {string[]} usernames already-lowercased
 */
export function getMany(usernames, retentionDays = config.retentionDays) {
  if (!usernames.length) return new Map();
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const rows = stmts.getMany.all(JSON.stringify(usernames), cutoff);
  return new Map(rows.map((r) => [r.username, r]));
}

/** @param {string[]} usernames already-lowercased */
export function getNotFoundMany(usernames) {
  if (!usernames.length) return new Map();
  const now = Math.floor(Date.now() / 1000);
  const rows = stmts.getNotFoundMany.all(JSON.stringify(usernames), now);
  return new Map(rows.map((row) => [row.username, row]));
}

/**
 * Counters and the "last contribution" time move in the same transaction as the
 * rows they describe, and only when something was actually submitted: a batch
 * that validated down to nothing must not look like a contribution.
 */
function recordContribution(count, now) {
  if (!count) return;
  incrMeta('total_contributions', count);
  recordActivity({ contributionEntries: count });
  setMeta('last_updated', now);
}

/** @param {Array<{username:string, location?, device?, locationAccurate?, affiliation?, accountId?, createdAt?, usernameChanges?, observedAt?}>} entries */
export function upsertMany(entries) {
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      stmts.upsert.run({
        username: e.username,
        location: e.location ?? null,
        device: e.device ?? null,
        locationAccurate: e.locationAccurate === false ? 0 : 1,
        affiliation: e.affiliation ?? null,
        accountId: e.accountId ?? null,
        createdAt: e.createdAt ?? null,
        usernameChanges: e.usernameChanges ?? null,
        updatedAt: Number.isInteger(e.observedAt) ? Math.min(e.observedAt, now) : now
      });
      stmts.clearOlderNotFound.run(e.username, Number.isInteger(e.observedAt) ? Math.min(e.observedAt, now) : now);
    }
    recordContribution(rows.length, now);
  });
  tx(entries);
  return entries.length;
}

/** @param {Array<{username:string, observedAt:number}>} entries */
export function upsertNotFoundMany(entries) {
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((rows) => {
    for (const entry of rows) {
      const observedAt = Math.min(entry.observedAt, now);
      const profile = stmts.entryUpdatedAt.get(entry.username);
      if (profile && profile.updated_at >= observedAt) continue;
      stmts.upsertNotFound.run({
        username: entry.username,
        observedAt,
        expiresAt: observedAt + config.notFoundTtlSeconds
      });
    }
    recordContribution(rows.length, now);
  });
  tx(entries);
  return entries.length;
}

export function getStats() {
  return {
    totalEntries: stmts.count.get().n,
    totalNotFoundEntries: db.prepare('SELECT COUNT(*) AS n FROM not_found_entries WHERE expires_at > ?')
      .get(Math.floor(Date.now() / 1000)).n,
    totalContributions: Number(getMeta('total_contributions', '0')) || 0,
    lastUpdated: (() => {
      const v = getMeta('last_updated', null);
      return v ? new Date(Number(v) * 1000).toISOString() : null;
    })()
  };
}

function entryQuery({ search = '', device = '', accurate = '', freshness = '', sort = 'updated', direction = 'desc' } = {}, retentionDays = config.retentionDays) {
  // Treat LIKE metacharacters as literal search text.
  const clauses = [];
  const params = {};
  if (search) {
    params.pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(`(username LIKE @pattern ESCAPE '\\'
    OR location LIKE @pattern ESCAPE '\\'
    OR device LIKE @pattern ESCAPE '\\'
    OR affiliation LIKE @pattern ESCAPE '\\'
    OR account_id LIKE @pattern ESCAPE '\\')`);
  }
  if (device) {
    clauses.push('device = @device');
    params.device = device;
  }
  if (accurate) {
    clauses.push('location_accurate = @accurate');
    params.accurate = accurate === 'yes' ? 1 : 0;
  }
  if (freshness) {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - retentionDays * 86400;
    const warning = Math.min(7, Math.max(1, Math.ceil(retentionDays * 0.2)));
    const warningAt = cutoff + warning * 86400;
    if (freshness === 'expired') {
      clauses.push('updated_at <= @cutoff');
      params.cutoff = cutoff;
    } else if (freshness === 'expiring') {
      clauses.push('updated_at > @cutoff AND updated_at <= @warningAt');
      params.cutoff = cutoff;
      params.warningAt = warningAt;
    } else {
      clauses.push('updated_at > @warningAt');
      params.warningAt = warningAt;
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sortColumns = {
    updated: 'updated_at',
    username: 'username',
    location: 'location',
    device: 'device',
    created: 'created_at'
  };
  const order = sortColumns[sort] || sortColumns.updated;
  const orderDirection = direction === 'asc' ? 'ASC' : 'DESC';
  return { where, params, order, orderDirection };
}

export function listEntries(filters, page, pageSize, retentionDays = config.retentionDays) {
  const { where, params, order, orderDirection } = entryQuery(filters, retentionDays);
  return db.transaction(() => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM entries ${where}`).get(params).n;
    const entries = db.prepare(`
      SELECT * FROM entries ${where}
      ORDER BY ${order} ${orderDirection}, username ASC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
    return { entries, total, page, pageSize };
  })();
}

/**
 * Stream every entry matching the filters, in dashboard order.
 *
 * Never holds a statement cursor (`.iterate()`) open across a yield. The caller
 * awaits between rows (socket backpressure), and while a cursor is open
 * better-sqlite3 rejects every other statement on the shared connection with
 * "This database connection is busy executing a query" -- a slow or abandoned
 * export would 500 every /lookup and /contribute, indefinitely. Instead, snapshot
 * just the ordered handles up front, then read rows in short chunks; each chunk
 * is fully read before anything is yielded.
 */
export function* iterateEntries(filters, retentionDays = config.retentionDays, chunkSize = 500) {
  const { where, params, order, orderDirection } = entryQuery(filters, retentionDays);
  const usernames = db.prepare(`
    SELECT username FROM entries ${where}
    ORDER BY ${order} ${orderDirection}, username ASC
  `).pluck().all(params);
  for (let i = 0; i < usernames.length; i += chunkSize) {
    const chunk = usernames.slice(i, i + chunkSize);
    const rows = new Map(stmts.getEntriesByUsername.all(JSON.stringify(chunk)).map((row) => [row.username, row]));
    for (const username of chunk) {
      const row = rows.get(username); // absent if the retention sweep removed it meanwhile
      if (row) yield row;
    }
  }
}

export function getBreakdowns(retentionDays = config.retentionDays) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - retentionDays * 86400;
  const warningDays = Math.min(7, Math.max(1, Math.ceil(retentionDays * 0.2)));
  const warningAt = cutoff + warningDays * 86400;
  return {
    devices: db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(device), ''), 'Unknown') AS name, COUNT(*) AS count
      FROM entries GROUP BY COALESCE(NULLIF(TRIM(device), ''), 'Unknown')
      ORDER BY count DESC, name ASC LIMIT 12
    `).all(),
    locations: db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(location), ''), 'Unknown') AS name, COUNT(*) AS count
      FROM entries GROUP BY COALESCE(NULLIF(TRIM(location), ''), 'Unknown')
      ORDER BY count DESC, name ASC LIMIT 12
    `).all(),
    // Every distinct device for the filter dropdown (the display list above is top-12 only).
    deviceOptions: db.prepare(`
      SELECT device AS name, COUNT(*) AS count FROM entries
      WHERE device IS NOT NULL AND TRIM(device) <> ''
      GROUP BY device ORDER BY count DESC, name ASC LIMIT 200
    `).all(),
    expiringEntries: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE updated_at > ? AND updated_at <= ?')
      .get(cutoff, warningAt).n,
    expiredEntries: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE updated_at <= ?')
      .get(cutoff).n,
    warningDays,
    totalKeys: db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n
  };
}

export function getHistory(period = '24h') {
  const now = Math.floor(Date.now() / 1000);
  const hours = period === '7d' ? 24 * 7 : period === '30d' ? 24 * 30 : 24;
  const bucketSeconds = period === '24h' ? 3600 : 86400;
  const start = Math.floor(now / bucketSeconds) * bucketSeconds - (hours / (bucketSeconds / 3600) - 1) * bucketSeconds;
  const buckets = period === '24h'
    ? db.prepare(`
      SELECT bucket, lookup_requests AS requests, lookup_hits AS hits,
        lookup_misses AS misses, lookup_not_found_hits AS notFoundHits,
        lookup_rate_limited AS lookupRateLimited, contribute_rate_limited AS contributeRateLimited,
        contribution_entries AS contributions
      FROM activity WHERE bucket >= ? ORDER BY bucket ASC
    `).all(start)
    : db.prepare(`
      SELECT (bucket / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket,
        SUM(lookup_requests) AS requests, SUM(lookup_hits) AS hits,
        SUM(lookup_misses) AS misses, SUM(lookup_not_found_hits) AS notFoundHits,
        SUM(lookup_rate_limited) AS lookupRateLimited,
        SUM(contribute_rate_limited) AS contributeRateLimited,
        SUM(contribution_entries) AS contributions
      FROM activity WHERE bucket >= ?
      GROUP BY (bucket / CAST(? AS INTEGER)) * CAST(? AS INTEGER) ORDER BY bucket ASC
    `).all(bucketSeconds, bucketSeconds, start, bucketSeconds, bucketSeconds);
  return {
    period,
    bucketSeconds,
    buckets
  };
}

/** Enforce retention. Returns the number of rows removed. */
export function cleanup(retentionDays) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const removed = stmts.deleteOlderThan.run(cutoff).changes;
  db.prepare('DELETE FROM not_found_entries WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
  db.prepare('DELETE FROM activity WHERE bucket < ?').run(Math.floor(Date.now() / 1000) - 90 * 86400);
  return removed;
}

export default db;
