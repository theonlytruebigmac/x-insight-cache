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

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    bucket INTEGER PRIMARY KEY,
    lookup_requests INTEGER NOT NULL DEFAULT 0,
    lookup_hits INTEGER NOT NULL DEFAULT 0,
    lookup_misses INTEGER NOT NULL DEFAULT 0,
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

function getMeta(key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function incrMeta(key, by) {
  const current = Number(getMeta(key, '0')) || 0;
  const next = current + by;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(next));
  return next;
}

const stmts = {
  getMany: db.prepare(`
    SELECT username, location, device, location_accurate, affiliation, account_id, created_at, username_changes, updated_at
    FROM entries WHERE username IN (SELECT value FROM json_each(?))
  `),
  upsert: db.prepare(`
    INSERT INTO entries (username, location, device, location_accurate, affiliation, account_id, created_at, username_changes, updated_at)
    VALUES (@username, @location, @device, @locationAccurate, @affiliation, @accountId, @createdAt, @usernameChanges, @updatedAt)
    ON CONFLICT(username) DO UPDATE SET
      location = excluded.location,
      device = excluded.device,
      location_accurate = excluded.location_accurate,
      affiliation = COALESCE(excluded.affiliation, entries.affiliation),
      account_id = COALESCE(excluded.account_id, entries.account_id),
      created_at = COALESCE(excluded.created_at, entries.created_at),
      username_changes = COALESCE(excluded.username_changes, entries.username_changes),
      updated_at = excluded.updated_at
  `),
  count: db.prepare('SELECT COUNT(*) AS n FROM entries'),
  deleteOlderThan: db.prepare('DELETE FROM entries WHERE updated_at < ?'),
  activityUpsert: db.prepare(`
    INSERT INTO activity (bucket, lookup_requests, lookup_hits, lookup_misses, contribution_entries)
    VALUES (@bucket, @lookupRequests, @lookupHits, @lookupMisses, @contributionEntries)
    ON CONFLICT(bucket) DO UPDATE SET
      lookup_requests = lookup_requests + excluded.lookup_requests,
      lookup_hits = lookup_hits + excluded.lookup_hits,
      lookup_misses = lookup_misses + excluded.lookup_misses,
      contribution_entries = contribution_entries + excluded.contribution_entries
  `)
};

function currentHour() {
  return Math.floor(Date.now() / 3600000) * 3600;
}

/** Store only hourly aggregate counts; no usernames or IP addresses. */
export function recordActivity({ lookupRequests = 0, lookupHits = 0, lookupMisses = 0, contributionEntries = 0 }) {
  stmts.activityUpsert.run({
    bucket: currentHour(), lookupRequests, lookupHits, lookupMisses, contributionEntries
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

/** @param {string[]} usernames already-lowercased */
export function getMany(usernames) {
  if (!usernames.length) return new Map();
  const rows = stmts.getMany.all(JSON.stringify(usernames));
  return new Map(rows.map((r) => [r.username, r]));
}

/** @param {Array<{username:string, location?, device?, locationAccurate?, affiliation?, accountId?, createdAt?, usernameChanges?}>} entries */
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
        updatedAt: now
      });
    }
  });
  tx(entries);
  incrMeta('total_contributions', entries.length);
  if (entries.length) recordActivity({ contributionEntries: entries.length });
  incrMeta('last_updated', 0); // touch below via setMeta for a real timestamp
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('last_updated', String(now));
  return entries.length;
}

export function getStats() {
  return {
    totalEntries: stmts.count.get().n,
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

export function* iterateEntries(filters, retentionDays = config.retentionDays) {
  const { where, params, order, orderDirection } = entryQuery(filters, retentionDays);
  yield* db.prepare(`
    SELECT * FROM entries ${where}
    ORDER BY ${order} ${orderDirection}, username ASC
  `).iterate(params);
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
        lookup_misses AS misses, contribution_entries AS contributions
      FROM activity WHERE bucket >= ? ORDER BY bucket ASC
    `).all(start)
    : db.prepare(`
      SELECT (bucket / ?) * ? AS bucket,
        SUM(lookup_requests) AS requests, SUM(lookup_hits) AS hits,
        SUM(lookup_misses) AS misses, SUM(contribution_entries) AS contributions
      FROM activity WHERE bucket >= ? GROUP BY (bucket / ?) * ? ORDER BY bucket ASC
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
  db.prepare('DELETE FROM activity WHERE bucket < ?').run(Math.floor(Date.now() / 1000) - 90 * 86400);
  return removed;
}

export default db;
