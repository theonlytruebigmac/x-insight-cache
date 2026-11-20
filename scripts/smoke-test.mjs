/**
 * End-to-end smoke test: starts a real server against a temp DB, exercises
 * every endpoint over real HTTP, then separately unit-tests the retention
 * cleanup. No mocking of express/sqlite — this is testing the actual
 * contract the extension's client code depends on.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
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

    r = await req('GET', '/lookup?users=dupe,dupe,Dupe', {});
    check('lookup de-duplicates repeated handles', r.json.misses.length === 1 && r.json.misses[0] === 'dupe');
    let lower = await fetch(BASE + '/stats', { headers: { authorization: `bearer ${API_KEY}` } });
    check('auth scheme is case-insensitive', lower.status === 200);

    // --- malformed bodies are client errors, and are only parsed for authenticated callers ---
    const rawContribute = (body, headers = {}) => fetch(BASE + '/contribute', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body
    });
    const authed = { authorization: `Bearer ${API_KEY}` };
    let bad = await rawContribute('{bad', authed);
    check('malformed JSON to /contribute -> 400, not 500', bad.status === 400);
    bad = await rawContribute(JSON.stringify({ entries: {}, pad: 'x'.repeat(300000) }), authed);
    check('oversized body to /contribute -> 413, not 500', bad.status === 413);
    bad = await rawContribute('{bad');
    check('unauthenticated request is rejected before its body is parsed', bad.status === 401);

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
    check('breakdowns list every device for the filter dropdown',
      response.ok && breakdowns.deviceOptions.some((item) => item.name === 'iOS') &&
      breakdowns.deviceOptions.every((item) => item.name !== 'Unknown'));
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
    const sampleDay = Math.floor(Date.now() / 86400000) * 86400 - 2 * 86400;
    const activityDb = new Database(join(dbDir, 'test.db'));
    const insertActivity = activityDb.prepare('INSERT INTO activity (bucket, lookup_requests) VALUES (?, ?)');
    insertActivity.run(sampleDay + 3600, 2);
    insertActivity.run(sampleDay + 7200, 3);
    activityDb.close();
    for (const period of ['7d', '30d']) {
      response = await adminReq('history?period=' + period);
      const daily = await response.json();
      check(`${period} history combines hourly activity into UTC daily buckets`,
        response.ok && daily.bucketSeconds === 86400 &&
        daily.buckets.every((bucket) => bucket.bucket % 86400 === 0) &&
        daily.buckets.filter((bucket) => bucket.bucket === sampleDay).length === 1 &&
        daily.buckets.find((bucket) => bucket.bucket === sampleDay).requests === 5);
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
    const successes = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      successes.push((await login({ username: 'admin', password: ADMIN_PASSWORD })).status);
    }
    check('successful logins do not count against the login limit', successes.every((status) => status === 200));
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

    // IPv6 clients control a whole /64; rotating addresses inside it must not
    // yield a fresh budget each time.
    const v6 = [];
    for (let i = 1; i <= 4; i++) v6.push((await xffReq(`2001:db8:1:2::${i}`)).status);
    check('addresses within one IPv6 subnet share a rate-limit budget', v6.join() === '200,200,429,429');

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

  console.log('=== /stats rate limit, /healthz, graceful shutdown, config validation ===');
  const misc = startServer({ STATS_RATE_LIMIT: '2', DB_PATH: join(dbDir, 'misc.db') });
  try {
    await waitForServer(misc);
    // "__proto__" is a valid handle; it must come back as a normal entry, not vanish.
    const rawPost = (body) => fetch(BASE + '/contribute', {
      method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body
    });
    let proto = await rawPost('{"entries":{"__proto__":{"l":"Peru","d":"iOS"},"constructor":{"l":"Chile","d":"Web"}}}');
    check('handles that collide with Object.prototype names are accepted', (await proto.json()).accepted === 2);
    const protoLookup = (await req('GET', '/lookup?users=__proto__,constructor,toString')).json;
    check('a "__proto__" handle is returned as an ordinary entry, not dropped',
      Object.hasOwn(protoLookup.results, '__proto__') && protoLookup.results['__proto__'].l === 'Peru' &&
      protoLookup.results.constructor?.l === 'Chile' && protoLookup.misses.join() === 'tostring');
    proto = await rawPost('{"entries":[{"l":"US","d":"iOS"}]}');
    check('entries sent as an array are rejected rather than stored under "0", "1", ...', proto.status === 400);

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await req('GET', '/stats')).status);
    check('/stats is rate limited per client', statuses.join() === '200,200,429,429');
    const health = await fetch(BASE + '/healthz');
    check('/healthz is unauthenticated and reports ok', health.status === 200 && (await health.json()).ok === true);
    const closed = new Promise((resolve) => misc.once('close', (code, signal) => resolve({ code, signal })));
    misc.kill('SIGTERM');
    const { code, signal } = await closed;
    check('SIGTERM shuts the server down cleanly (exit 0, not killed)', code === 0 && signal === null);
  } finally {
    if (misc.exitCode === null && misc.signalCode === null) misc.kill('SIGKILL');
  }
  for (const bad of [{ RETENTION_DAYS: '6O' }, { CLEANUP_INTERVAL_MS: '0' }, { LOOKUP_RATE_LIMIT: '-5' }, { PORT: '99999' }]) {
    const proc = startServer(bad);
    const exit = await new Promise((resolve) => proc.on('exit', resolve));
    check(`invalid ${Object.keys(bad)[0]}=${Object.values(bad)[0]} is a startup error`, exit !== 0);
  }

  console.log('=== export under backpressure (regression: an open cursor wedged the database) ===');
  const exportDbPath = join(dbDir, 'export.db');
  const exporter = startServer({ DB_PATH: exportDbPath });
  try {
    await waitForServer(exporter);
    const seedDb = new Database(exportDbPath);
    const seedInsert = seedDb.prepare('INSERT INTO entries (username, location, device, updated_at) VALUES (?, ?, ?, ?)');
    const seedNow = Math.floor(Date.now() / 1000);
    seedDb.transaction(() => {
      for (let i = 0; i < 40000; i++) seedInsert.run('seed' + i, 'L'.repeat(60), 'D'.repeat(60), seedNow - i);
    })();
    seedDb.close();
    const loginRes = await fetch(BASE + '/admin/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    });
    const exportCookie = loginRes.headers.get('set-cookie').split(';')[0];
    const contribute = (name) => req('POST', '/contribute', { body: { entries: { [name]: { l: 'US', d: 'iOS' } } } });

    // A client that stops reading leaves the export blocked on socket backpressure.
    await new Promise((resolve, reject) => {
      const clientReq = http.get(`${BASE}/admin/api/export?format=json`, { headers: { cookie: exportCookie } }, (res) => {
        res.pause();
        setTimeout(async () => {
          try {
            const during = [
              (await contribute('during')).status,
              (await req('GET', '/lookup?users=during')).status,
              (await fetch(BASE + '/admin/api/entries', { headers: { cookie: exportCookie } })).status
            ];
            check('contribute, lookup and dashboard keep working while an export is stalled', during.join() === '200,200,200');
            res.destroy();
            clientReq.destroy();
            resolve();
          } catch (error) { reject(error); }
        }, 500);
      });
      clientReq.on('error', () => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    check('server still accepts writes after a client abandons an export', (await contribute('after')).status === 200);

    const full = await fetch(BASE + '/admin/api/export?format=json&sort=username&direction=asc', { headers: { cookie: exportCookie } });
    const rows = await full.json();
    check('a complete export contains every row exactly once',
      full.ok && rows.length === 40002 && new Set(rows.map((row) => row.username)).size === 40002);
    check('export honors the requested sort order', rows.every((row, i) => i === 0 || rows[i - 1].username < row.username));
  } finally {
    exporter.kill();
    await new Promise((resolve) => exporter.once('close', resolve));
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

  const unitNow = Math.floor(Date.now() / 1000);
  const insertRaw = db.prepare('INSERT INTO entries (username, location, device, updated_at) VALUES (?, ?, ?, ?)');
  insertRaw.run('stale', 'X', 'Y', unitNow - 61 * 86400);
  insertRaw.run('almoststale', 'X', 'Y', unitNow - 59 * 86400);
  check('an entry past retention is not served even before the sweep removes it', !getMany(['stale'], 60).has('stale'));
  check('an entry still inside retention is served', getMany(['almoststale'], 60).has('almoststale'));
  db.prepare("DELETE FROM entries WHERE username IN ('stale', 'almoststale')").run();

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_updated', '1000'), ('total_contributions', '7')").run();
  upsertMany([]);
  upsertNotFoundMany([]);
  check('batches that validated down to nothing do not bump last_updated or the counters',
    getStats().lastUpdated === new Date(1000 * 1000).toISOString() && getStats().totalContributions === 7);
  upsertMany([{ username: 'counted', location: 'Peru', device: 'Web' }]);
  check('a real contribution updates last_updated and the counters',
    getStats().lastUpdated !== new Date(1000 * 1000).toISOString() && getStats().totalContributions === 8);

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
    undated: { l: 'Germany' },
    nullt: { l: 'Germany', t: null }
  } });
  const byName = Object.fromEntries(parsed.entries.map((e) => [e.username, e]));
  check('t is kept as the observation time', byName.dated?.observedAt === nowS - 3600);
  check('a future t clamps to now', byName.future && byName.future.observedAt <= nowS + 1);
  check('a t past retention is dropped', !byName.expired);
  check('an already-expired not-found observation is dropped', !parsed.notFound.some((e) => e.username === 'oldnegative'));
  check('a malformed t is dropped', !byName.badt);
  const cleaned = parseContributeBody({ entries: {
    emoji: { l: 'a'.repeat(99) + '\u{1F600}', d: 'Web' },
    ctrl: { l: 'Line1\nLine2\u0000\u001b[31mx', d: '\tWeb\r' },
    lone: { l: 'ok\ud800end', d: 'Web' },
    onlyctrl: { l: '\u0000\n', d: '\t' }
  } }).entries;
  const cleanedBy = Object.fromEntries(cleaned.map((e) => [e.username, e]));
  check('truncating at the field limit never leaves half of a surrogate pair',
    cleanedBy.emoji.location.isWellFormed() && cleanedBy.emoji.location.length <= 100);
  check('control characters are stripped from stored fields',
    !/[\u0000-\u001f\u007f-\u009f]/.test(cleanedBy.ctrl.location + cleanedBy.ctrl.device) && cleanedBy.ctrl.device === 'Web');
  check('lone surrogates in input are replaced, not stored', cleanedBy.lone.location.isWellFormed());
  check('a field made only of control characters counts as empty', !cleanedBy.onlyctrl);
  check('no t defaults to now (older clients)', byName.undated && Math.abs(byName.undated.observedAt - nowS) <= 1);
  check('t: null is treated like no t', byName.nullt && Math.abs(byName.nullt.observedAt - nowS) <= 1);

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
