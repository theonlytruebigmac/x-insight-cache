/**
 * SQLite storage.
 *
 * One file, one process — intentional for "simple". No native TTL (unlike
 * Cloudflare KV, which upstream relied on), so retention is enforced by a
 * periodic sweep in server.js rather than per-key expiry.
 */
import Database from 'better-sqlite3';
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
  deleteOlderThan: db.prepare('DELETE FROM entries WHERE updated_at < ?')
};

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

/** Enforce retention. Returns the number of rows removed. */
export function cleanup(retentionDays) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  return stmts.deleteOlderThan.run(cutoff).changes;
}

export default db;
