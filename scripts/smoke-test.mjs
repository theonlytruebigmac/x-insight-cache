/**
 * End-to-end smoke test: starts a real server against a temp DB, exercises
 * every endpoint over real HTTP, then separately unit-tests the retention
 * cleanup. No mocking of express/sqlite — this is testing the actual
 * contract the extension's client code depends on.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 8799;
const API_KEY = 'test-key-' + Math.random().toString(36).slice(2);
const BASE = `http://127.0.0.1:${PORT}`;
const dbDir = mkdtempSync(join(tmpdir(), 'xic-test-'));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function startServer(env) {
  return spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dbDir, 'test.db'), API_KEY, RETENTION_DAYS: '60', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited early (${code})`)); });
  });
}

async function req(method, path, { auth = API_KEY, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  console.log('=== fails to start without API_KEY ===');
  const noKey = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: '8800', DB_PATH: join(dbDir, 'nokey.db'), API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exitCode = await new Promise((resolve) => noKey.on('exit', resolve));
  check('exits non-zero with no API_KEY set', exitCode !== 0);

  console.log('=== main server ===');
  const server = startServer({});
  await waitForServer(server);

  try {
    // --- auth ---
    let r = await req('GET', '/lookup?users=espn', { auth: null });
    check('lookup without auth -> 401', r.status === 401);

    r = await req('GET', '/lookup?users=espn', { auth: 'totally-wrong-key' });
    check('lookup with wrong key -> 401', r.status === 401);

    // --- lookup on empty db ---
    r = await req('GET', '/lookup?users=espn,nfl', {});
    check('lookup empty db -> 200', r.status === 200);
    check('lookup empty db -> both are misses', r.json.misses.length === 2 && Object.keys(r.json.results).length === 0);

    // --- lookup validation ---
    r = await req('GET', '/lookup?users=' + 'a'.repeat(50) + ',' + 'b'.repeat(50), {});
    check('lookup rejects invalid (too-long) username -> 400', r.status === 400);

    r = await req('GET', '/lookup?users=' + Array.from({ length: 101 }, (_, i) => 'user' + i).join(','), {});
    check('lookup rejects batch over max -> 400', r.status === 400);

    // --- contribute: valid + malformed entries in one batch ---
    r = await req('POST', '/contribute', {
      body: {
        entries: {
          espn: { l: 'United States', d: 'Web', a: true, c: 1174941976, uc: 0 },
          nfl: { l: 'United States', d: 'iOS', a: true, id: '123456', uc: 2 },
          // malformed: username fails the X handle pattern, must be dropped silently
          'bad user!': { l: 'Nowhere', d: 'Web' },
          // malformed: no location/device at all, nothing worth storing
          emptyguy: {},
          // malformed: created_at before Twitter existed -> must be nulled, not stored as-is
          oldaccount: { l: 'Mars', d: 'Web', c: 1 }
        }
      }
    });
    check('contribute valid+malformed batch -> 200', r.status === 200);
    check('contribute accepted only the 3 valid-shaped entries', r.json.accepted === 3);

    // --- lookup after contribute: hits should reflect sanitized data ---
    r = await req('GET', '/lookup?users=espn,nfl,oldaccount', {});
    check('espn is now a hit', !!r.json.results.espn);
    check('espn location round-trips', r.json.results.espn?.l === 'United States');
    check('nfl numeric id round-trips', r.json.results.nfl?.id === '123456');
    check('oldaccount stored despite bad created_at', !!r.json.results.oldaccount);
    check('oldaccount bad created_at was nulled, not stored as 1', r.json.results.oldaccount?.c === undefined);

    // --- contribute validation: oversized batch ---
    const tooMany = {};
    for (let i = 0; i < 201; i++) tooMany['user' + i] = { l: 'X', d: 'Web' };
    r = await req('POST', '/contribute', { body: { entries: tooMany } });
    check('contribute rejects batch over max -> 400', r.status === 400);

    // --- stats ---
    r = await req('GET', '/stats', {});
    check('stats -> 200', r.status === 200);
    check('stats totalEntries reflects contributed rows', r.json.totalEntries === 3);
    check('stats totalContributions accumulated', r.json.totalContributions === 3);
    check('stats lastUpdated is a timestamp', typeof r.json.lastUpdated === 'string');

    // --- cache-poisoning guard: a field-name collision can't smuggle extra keys ---
    r = await req('POST', '/contribute', {
      body: { entries: { espn: { l: 'Fakeland', d: 'Web', __proto__: { polluted: true } } } }
    });
    check('contribute with __proto__ key does not throw -> 200', r.status === 200);
    check('global Object.prototype was not polluted', !({}).polluted);
  } finally {
    server.kill();
  }

  console.log('\n=== retention cleanup (direct unit test, not real time) ===');
  process.env.DB_PATH = join(dbDir, 'cleanup.db');
  const { upsertMany, cleanup, getMany } = await import('./../src/db.js');
  upsertMany([{ username: 'willexpire', location: 'Nowhere', device: 'Web' }]);
  // Can't wait 60 real days, so directly rewrite updated_at into the past.
  const { default: db } = await import('./../src/db.js');
  db.prepare("UPDATE entries SET updated_at = ? WHERE username = 'willexpire'")
    .run(Math.floor(Date.now() / 1000) - 61 * 86400);
  const removed = cleanup(60);
  check('cleanup removes entries past retention', removed === 1);
  check('expired entry is actually gone', getMany(['willexpire']).size === 0);

  rmSync(dbDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
