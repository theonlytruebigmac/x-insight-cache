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
import Database from 'better-sqlite3';

const API_KEY = 'test-key-' + Math.random().toString(36).slice(2);
const ADMIN_PASSWORD = 'admin-test-' + Math.random().toString(36).slice(2);
let BASE;
const dbDir = mkdtempSync(join(tmpdir(), 'xic-test-'));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function startServer(env) {
  return spawn('node', ['src/server.js'], {
    env: {
      ...process.env, PORT: '0', DB_PATH: join(dbDir, 'test.db'), API_KEY, RETENTION_DAYS: '60',
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD, ADMIN_SECURE_COOKIE: 'false', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        BASE = `http://127.0.0.1:${chunk.toString().match(/listening on :(\d+)/)[1]}`;
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
    env: { ...process.env, PORT: '0', DB_PATH: join(dbDir, 'nokey.db'), API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exitCode = await new Promise((resolve) => noKey.on('exit', resolve));
  check('exits non-zero with no API_KEY set', exitCode !== 0);

  const partialAdmin = startServer({ ADMIN_PASSWORD: '' });
  const partialExit = await new Promise((resolve) => partialAdmin.on('exit', resolve));
  check('exits non-zero with incomplete admin configuration', partialExit !== 0);

  console.log('=== main server ===');
  const server = startServer({});

  try {
    await waitForServer(server);
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

    const observedAt = Math.floor(Date.now() / 1000);
    r = await req('POST', '/contribute', {
      body: { entries: { goneuser: { nf: true, t: observedAt } } }
    });
    check('confirmed not-found contribution is accepted', r.status === 200 && r.json.accepted === 1);
    r = await req('GET', '/lookup?users=goneuser,unknownspecimen', {});
    check('active not-found entry is returned separately from misses',
      r.json.notFound?.goneuser?.t === observedAt &&
      r.json.misses.includes('unknownspecimen') &&
      !r.json.misses.includes('goneuser'));

    r = await req('POST', '/contribute', {
      body: { entries: { espn: { l: 'United States', d: 'Web', af: '' } } }
    });
    check('explicit no-affiliation contribution is accepted', r.status === 200 && r.json.accepted === 1);
    r = await req('GET', '/lookup?users=espn', {});
    check('checked-with-no-affiliation round-trips as an explicit empty af', r.json.results.espn?.af === '');

    // --- contribute validation: oversized batch ---
    const tooMany = {};
    for (let i = 0; i < 201; i++) tooMany['user' + i] = { l: 'X', d: 'Web' };
    r = await req('POST', '/contribute', { body: { entries: tooMany } });
    check('contribute rejects batch over max -> 400', r.status === 400);

    // --- stats ---
    r = await req('GET', '/stats', {});
    check('stats -> 200', r.status === 200);
    check('stats totalEntries reflects contributed rows', r.json.totalEntries === 3);
    check('stats totalContributions accumulated', r.json.totalContributions === 5);
    check('stats reports active not-found entries', r.json.totalNotFoundEntries === 1);
    check('stats lastUpdated is a timestamp', typeof r.json.lastUpdated === 'string');

    // --- cache-poisoning guard: a field-name collision can't smuggle extra keys ---
    r = await req('POST', '/contribute', {
      body: { entries: { espn: { l: 'Fakeland', d: 'Web', __proto__: { polluted: true } } } }
    });
    check('contribute with __proto__ key does not throw -> 200', r.status === 200);
    check('global Object.prototype was not polluted', !({}).polluted);

    console.log('=== dashboard ===');
    let response = await fetch(BASE + '/');
    check('root opens the dashboard', response.ok && response.url.endsWith('/admin/'));
    const html = await response.text();
    check('dashboard loads module script and has no embedded credentials',
      html.includes('type="module"') && !html.includes(API_KEY) && !html.includes(ADMIN_PASSWORD));
    check('dashboard has no-store and CSP headers',
      response.headers.get('cache-control') === 'no-store' &&
      response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    response = await fetch(BASE + '/admin/app.js');
    check('dashboard JavaScript is served', response.ok && response.headers.get('content-type').includes('javascript'));
    response = await fetch(BASE + '/admin/style.css');
    check('dashboard stylesheet is served', response.ok && response.headers.get('content-type').includes('css'));
    response = await fetch(BASE + '/admin/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
    });
    check('malformed dashboard JSON returns an explicit client error',
      response.status === 400 && (await response.json()).error === 'Invalid JSON body.');

    for (const path of ['session', 'stats', 'entries', 'export']) {
      r = await req('GET', '/admin/api/' + path);
      check(`API key cannot access dashboard ${path}`, r.status === 401);
    }

    const login = (body, headers = {}) => fetch(BASE + '/admin/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    response = await login({ username: 'admin', password: 'wrong' });
    check('wrong admin password rejected', response.status === 401 && !response.headers.get('set-cookie'));
    response = await login({ username: 'admin', password: ADMIN_PASSWORD }, { origin: 'https://other.invalid' });
    check('cross-origin login rejected', response.status === 403);
    response = await login({ username: 'admin', password: ADMIN_PASSWORD }, { origin: BASE });
    const setCookie = response.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    check('admin can log in with a scoped HttpOnly SameSite cookie',
      response.ok && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes('Path=/admin'));
    const adminReq = (path, options = {}) => fetch(BASE + '/admin/api/' + path, {
      ...options, headers: { cookie, 'content-type': 'application/json', ...options.headers }
    });
    response = await adminReq('session');
    check('session authenticates admin', response.ok && (await response.json()).username === 'admin');
    response = await fetch(BASE + '/stats', { headers: { cookie } });
    check('admin session cannot replace extension API key', response.status === 401);
    response = await adminReq('stats');
    const stats = await response.json();
    check('dashboard stats include storage, contributions, retention and uptime',
      response.ok && stats.totalEntries === 3 && stats.totalContributions === 6 &&
      stats.retentionDays === 60 && Number.isInteger(stats.uptimeSeconds));
    response = await adminReq('breakdowns');
    const breakdowns = await response.json();
    check('breakdowns report populated devices and locations',
      response.ok && breakdowns.devices.some((item) => item.name === 'Web') &&
      breakdowns.locations.some((item) => item.name === 'Fakeland'));
    response = await adminReq('history?period=24h');
    const history = await response.json();
    check('lookup history contains aggregate requests, hits and misses',
      response.ok && history.period === '24h' &&
      history.buckets.reduce((sum, item) => sum + item.requests, 0) > 0 &&
      history.buckets.reduce((sum, item) => sum + item.hits, 0) > 0 &&
      history.buckets.reduce((sum, item) => sum + item.misses, 0) > 0);
    for (const period of ['7d', '30d']) {
      response = await adminReq('history?period=' + period);
      const daily = await response.json();
      check(`${period} history has daily buckets`, response.ok && daily.bucketSeconds === 86400);
    }
    response = await adminReq('history?period=year');
    check('invalid history period rejected', response.status === 400);
    response = await adminReq('entries?pageSize=2');
    const first = await response.json();
    response = await adminReq('entries?pageSize=2&page=2');
    const second = await response.json();
    check('entries paginate with stable ordering and totals',
      first.total === 3 && first.entries.length === 2 && second.entries.length === 1 &&
      !first.entries.some((entry) => entry.username === second.entries[0].username));
    const espn = [...first.entries, ...second.entries].find((entry) => entry.username === 'espn');
    check('dashboard exposes full cached fields without changing values',
      espn.location === 'Fakeland' && espn.created_at === 1174941976 &&
      espn.username_changes === 0 && typeof espn.updated_at === 'number');
    response = await adminReq('entries?device=iOS&accurate=yes&sort=username&direction=asc');
    const filtered = await response.json();
    check('device, accuracy and sorting filters apply',
      response.ok && filtered.total === 1 && filtered.entries[0].username === 'nfl');
    for (const term of ['ESPN', 'Fakeland', 'iOS', '123456']) {
      response = await adminReq('entries?search=' + encodeURIComponent(term));
      const data = await response.json();
      check(`search matches ${term}`, response.ok && data.total === 1);
    }
    for (const term of ['%', '_', "' OR 1=1 --", 'doesnotexist']) {
      response = await adminReq('entries?search=' + encodeURIComponent(term));
      check(`search treats ${term} literally`, response.ok && (await response.json()).total === 0);
    }
    for (const query of ['page=0', 'page=1.5', 'pageSize=101', 'search[]=x', 'search=' + 'a'.repeat(101)]) {
      response = await adminReq('entries?' + query);
      check(`invalid pagination/search rejected: ${query.slice(0, 25)}`, response.status === 400);
    }
    response = await adminReq('entries', { method: 'DELETE' });
    check('dashboard cannot delete cache entries', response.status === 404);
    response = await adminReq('keys', { method: 'POST', body: JSON.stringify({ name: 'Test extension' }) });
    const generatedKey = await response.json();
    check('admin can create a high-entropy individually labeled key',
      response.status === 201 && generatedKey.name === 'Test extension' &&
      generatedKey.token.startsWith('xic_') && generatedKey.token.length > 40);
    response = await adminReq('keys');
    let keyList = await response.json();
    check('key listing exposes prefix but never full token',
      response.ok && keyList.keys.length === 1 && !JSON.stringify(keyList).includes(generatedKey.token));
    response = await fetch(BASE + '/lookup?users=espn', {
      headers: { authorization: `Bearer ${generatedKey.token}` }
    });
    check('generated key works with the extension API', response.status === 200);
    response = await adminReq('keys');
    keyList = await response.json();
    check('managed key records last-use time', typeof keyList.keys[0].lastUsedAt === 'number');
    response = await adminReq('keys/' + encodeURIComponent(generatedKey.id), { method: 'DELETE' });
    check('admin can revoke managed key', response.ok);
    response = await fetch(BASE + '/lookup?users=espn', {
      headers: { authorization: `Bearer ${generatedKey.token}` }
    });
    check('revoked key no longer authenticates requests', response.status === 401);
    response = await adminReq('keys', { method: 'POST', body: JSON.stringify({ name: '' }) });
    check('invalid managed-key label rejected', response.status === 400);

    r = await req('POST', '/contribute', {
      body: { entries: { formula: { l: '=1+2', d: 'Web' } } }
    });
    check('formula-like cache field can be contributed for CSV escaping test', r.status === 200);
    response = await adminReq('export?format=csv');
    const csv = await response.text();
    check('CSV export neutralizes formula-leading fields',
      response.ok && csv.includes("'=1+2") && response.headers.get('content-disposition').includes('.csv'));
    response = await adminReq('export?format=json');
    const exportedEntries = await response.json();
    check('JSON export contains cached fields', response.ok && exportedEntries.some((entry) => entry.username === 'formula'));
    response = await adminReq('export?format=xml');
    check('unsupported export format rejected', response.status === 400);
    response = await adminReq('session', { method: 'DELETE', headers: { origin: 'https://other.invalid' } });
    check('cross-origin logout rejected', response.status === 403);
    response = await adminReq('session', { method: 'DELETE' });
    check('logout clears cookie', response.ok && response.headers.get('set-cookie').includes('Expires=Thu, 01 Jan 1970'));
    response = await adminReq('entries');
    check('logged-out session cannot be reused', response.status === 401);
    for (let attempt = 0; attempt < 10; attempt++) {
      response = await login({ username: 'admin', password: 'wrong' });
    }
    check('dashboard login is rate limited', response.status === 429 && (await response.json()).error.includes('Too many'));
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('close', resolve));
  }

  const disabled = startServer({ ADMIN_USERNAME: '', ADMIN_PASSWORD: '' });
  try {
    await waitForServer(disabled);
    const response = await fetch(BASE + '/admin/api/session');
    check('dashboard stays disabled without admin credentials', response.status === 503);
    const r = await req('GET', '/stats');
    check('extension API still works with dashboard disabled', r.status === 200);
  } finally {
    disabled.kill();
    await new Promise((resolve) => disabled.once('close', resolve));
  }

  const secure = startServer({ ADMIN_SECURE_COOKIE: 'true' });
  try {
    await waitForServer(secure);
    const response = await fetch(BASE + '/admin/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    });
    check('production session cookie has Secure flag', response.headers.get('set-cookie')?.includes('; Secure;'));
  } finally {
    secure.kill();
    await new Promise((resolve) => secure.once('close', resolve));
  }

  console.log('=== trust proxy / X-Forwarded-For (regression: ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) ===');
  let xffStderr = '';
  const xffServer = startServer({ LOOKUP_RATE_LIMIT: '2' });
  xffServer.stderr.on('data', (chunk) => { xffStderr += chunk.toString(); });
  try {
    await waitForServer(xffServer);
    const xffReq = (ip) => fetch(BASE + '/lookup?users=espn', {
      headers: { authorization: `Bearer ${API_KEY}`, 'x-forwarded-for': ip }
    });

    // Exhaust client A's deliberately tiny budget (2/window).
    await xffReq('203.0.113.10');
    let rA = await xffReq('203.0.113.10');
    check('client A can use its own budget', rA.status === 200);
    rA = await xffReq('203.0.113.10');
    check('client A is rate-limited after exhausting its own budget', rA.status === 429);

    // A different forwarded IP must get its own, un-exhausted budget. Before
    // app.set('trust proxy', 1), express-rate-limit refused to use
    // X-Forwarded-For at all behind a proxy, collapsing every client into
    // one shared bucket -- this is the actual bug, not just a log line.
    const rB = await xffReq('203.0.113.20');
    check('a different X-Forwarded-For client has its own separate budget', rB.status === 200);

    const login = await fetch(BASE + '/admin/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    const historyResponse = await fetch(BASE + '/admin/api/history?period=24h', {
      headers: { cookie }
    });
    const history = await historyResponse.json();
    check('dashboard activity reports lookup 429s',
      historyResponse.status === 200 &&
      history.buckets.reduce((sum, bucket) => sum + bucket.lookupRateLimited, 0) >= 1);

    check('no express-rate-limit X-Forwarded-For validation error was logged',
      !xffStderr.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR') && !xffStderr.includes('ValidationError'));
  } finally {
    xffServer.kill();
    await new Promise((resolve) => xffServer.once('close', resolve));
  }

  console.log('\n=== retention cleanup (direct unit test, not real time) ===');
  process.env.DB_PATH = join(dbDir, 'cleanup.db');
  const legacyDb = new Database(process.env.DB_PATH);
  legacyDb.exec(`
    CREATE TABLE activity (
      bucket INTEGER PRIMARY KEY,
      lookup_requests INTEGER NOT NULL DEFAULT 0,
      lookup_hits INTEGER NOT NULL DEFAULT 0,
      lookup_misses INTEGER NOT NULL DEFAULT 0,
      contribution_entries INTEGER NOT NULL DEFAULT 0
    )
  `);
  legacyDb.close();
  const {
    default: db, upsertMany, upsertNotFoundMany, cleanup, getMany, getNotFoundMany,
    getStats, recordActivity, getHistory
  } = await import('./../src/db.js');
  check('existing activity tables gain the new counters on startup',
    new Set(db.prepare('PRAGMA table_info(activity)').all().map((column) => column.name))
      .has('lookup_rate_limited'));
  upsertMany([{ username: 'willexpire', location: 'Nowhere', device: 'Web' }]);
  // Can't wait 60 real days, so directly rewrite updated_at into the past.
  db.prepare("UPDATE entries SET updated_at = ? WHERE username = 'willexpire'")
    .run(Math.floor(Date.now() / 1000) - 61 * 86400);
  const removed = cleanup(60);
  check('cleanup removes entries past retention', removed === 1);
  check('expired entry is actually gone', getMany(['willexpire']).size === 0);

  const negativeNow = Math.floor(Date.now() / 1000);
  upsertNotFoundMany([{ username: 'negative', observedAt: negativeNow }]);
  check('a newer negative observation is returned', getNotFoundMany(['negative']).has('negative'));
  upsertMany([{ username: 'negative', location: 'France', observedAt: negativeNow + 1 }]);
  check('a newer profile observation clears a negative result', !getNotFoundMany(['negative']).has('negative'));
  upsertNotFoundMany([{ username: 'negative', observedAt: negativeNow }]);
  check('an older negative observation cannot hide a newer profile', !getNotFoundMany(['negative']).has('negative'));
  check('an older negative observation is not retained as active', getStats().totalNotFoundEntries === 0);

  recordActivity({ lookupRateLimited: 2, contributeRateLimited: 3, lookupNotFoundHits: 4 });
  const activity = getHistory('24h').buckets.at(-1);
  check('rate-limit and negative-hit activity is retained as aggregate counters',
    activity.lookupRateLimited === 2 && activity.contributeRateLimited === 3 && activity.notFoundHits === 4);

  console.log('\n=== observation time (t) and newer-wins merge (direct unit test) ===');
  const { parseContributeBody } = await import('./../src/validate.js');
  const nowS = Math.floor(Date.now() / 1000);
  const parsed = parseContributeBody({ entries: {
    dated: { l: 'Germany', t: nowS - 3600 },
    future: { l: 'Germany', t: nowS + 3600 },
    expired: { l: 'Germany', t: nowS - 61 * 86400 },
    oldnegative: { nf: true, t: nowS - 2 * 86400 },
    badt: { l: 'Germany', t: 'yesterday' },
    undated: { l: 'Germany' }
  } });
  const byName = Object.fromEntries(parsed.entries.map((e) => [e.username, e]));
  check('t is kept as the observation time', byName.dated?.observedAt === nowS - 3600);
  check('a future t clamps to now', byName.future && byName.future.observedAt <= nowS + 1);
  check('a t past retention is dropped', !byName.expired);
  check('an already-expired not-found observation is dropped', !parsed.notFound.some((e) => e.username === 'oldnegative'));
  check('a malformed t is dropped', !byName.badt);
  check('no t defaults to now (older clients)', byName.undated && Math.abs(byName.undated.observedAt - nowS) <= 1);

  upsertMany([{ username: 'merge', location: 'France', device: 'iOS', accountId: '1', observedAt: nowS - 100 }]);
  upsertMany([{ username: 'merge', location: 'Spain', device: 'Android', affiliation: 'Acme', observedAt: nowS - 5000 }]);
  let row = getMany(['merge']).get('merge');
  check('an older observation does not overwrite newer core fields', row.location === 'France' && row.device === 'iOS');
  check('an older observation still fills missing optional fields', row.affiliation === 'Acme' && row.account_id === '1');
  check('updated_at keeps the newest observation', row.updated_at === nowS - 100);

  upsertMany([{ username: 'merge', location: 'Italy', observedAt: nowS - 10 }]);
  row = getMany(['merge']).get('merge');
  check('a newer observation wins core fields', row.location === 'Italy' && row.updated_at === nowS - 10);
  check('a newer partial observation keeps fields it lacks', row.device === 'iOS' && row.affiliation === 'Acme');

  upsertMany([{ username: 'merge', location: 'Japan', accountId: '2', observedAt: nowS }]);
  row = getMany(['merge']).get('merge');
  check('a recycled handle (new account id) replaces the row wholesale',
    row.location === 'Japan' && row.account_id === '2' && row.affiliation === null && row.device === null);
  upsertMany([{ username: 'merge', location: 'France', accountId: '1', affiliation: 'Old', observedAt: nowS - 50 }]);
  row = getMany(['merge']).get('merge');
  check('an older observation of the previous account is ignored', row.location === 'Japan' && row.affiliation === null);

  rmSync(dbDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
