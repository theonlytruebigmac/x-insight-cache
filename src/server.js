/**
 * x-insight-cache — self-hosted community cache server.
 *
 * Implements exactly the three endpoints x-account-insight's cloud-cache.js
 * client expects (reverse-engineered from that client, since upstream never
 * published their server): GET /lookup, POST /contribute, GET /stats. Point
 * that extension's CLOUD_CACHE_CONFIG.API_URL at a deployment of this and
 * the client works unmodified.
 *
 * Gated behind a single shared API key (see auth.js) — this is for a
 * defined community you've handed a key to, not the open internet. The
 * server refuses to start without one rather than defaulting to open.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { requireApiKey } from './auth.js';
import { parseUsersParam, parseContributeBody } from './validate.js';
import db, { getMany, getNotFoundMany, upsertMany, upsertNotFoundMany, getStats, cleanup, recordActivity } from './db.js';
import admin from './admin.js';

if (!config.apiKey) {
  console.error(
    'FATAL: API_KEY is not set. This server refuses to start open to the\n' +
    'internet by default. Set API_KEY in your environment (see .env.example)\n' +
    'and give that value only to people you want in this community cache.'
  );
  process.exit(1);
}

const app = express();
if (!!config.adminUsername !== !!config.adminPassword) {
  console.error('FATAL: Set both ADMIN_USERNAME and ADMIN_PASSWORD to enable the dashboard, or leave both unset.');
  process.exit(1);
}
app.disable('x-powered-by');
// Trust exactly one hop of X-Forwarded-For. The expected deployment has one real
// proxy hop in front of this process (Traefik on the t3_proxy network). Without
// this, express-rate-limit refuses to use X-Forwarded-For at all (see
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) and every client behind Traefik collapses
// into one shared rate-limit bucket -- same for admin.js's login limiter.
//
// Know what this does and doesn't protect: with `1`, the TCP peer is treated as
// the trusted proxy and the *last* X-Forwarded-For entry is taken as the client.
// That is only correct if the proxy overwrites or appends to the header. A
// client that connects to this port directly (the 127.0.0.1 published port on
// the Docker host) can send any X-Forwarded-For and pick its own rate-limit
// identity, so keep the port unreachable except from the proxy/host, and make
// sure Traefik does not pass through client-supplied forwarded headers
// (entrypoint forwardedHeaders.trustedIPs unset, or limited to your own CDN).
app.set('trust proxy', 1);

const perIp = (limit, onLimit) => rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    onLimit?.();
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
});

// Body parsing is wired per route, *after* rate limiting and auth, so an
// unauthenticated or throttled client can't make the server buffer and parse
// request bodies. Dashboard bodies are tiny (login, key label).
app.get('/', (req, res) => res.redirect('/admin/'));
app.use('/admin', express.json({ limit: '16kb' }), admin);

// Liveness probe for the container HEALTHCHECK. Unauthenticated, reveals nothing,
// and only proves the process is up and the database answers.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/lookup', perIp(config.lookupRateLimit, () => recordActivity({ lookupRateLimited: 1 })));
app.use('/contribute', perIp(config.contributeRateLimit, () => recordActivity({ contributeRateLimited: 1 })));
// /stats is key-gated like the rest, but unthrottled it would be an open
// oracle for guessing the shared API_KEY.
app.use('/stats', perIp(config.statsRateLimit));

app.get('/lookup', requireApiKey, (req, res) => {
  const parsed = parseUsersParam(req.query.users);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const rows = getMany(parsed.usernames, config.retentionDays);
  const notFoundRows = getNotFoundMany(parsed.usernames);
  // Null-prototype objects: "__proto__" is a valid X handle, and assigning
  // results["__proto__"] on a plain object would set its prototype instead of
  // adding the entry, silently dropping that account from the response.
  const notFound = Object.create(null);
  const misses = [];
  const results = Object.create(null);
  let hits = 0;
  let notFoundHits = 0;
  for (const username of parsed.usernames) {
    const row = rows.get(username);
    const negative = notFoundRows.get(username);
    if (negative && (!row || negative.observed_at > row.updated_at)) {
      notFound[username] = { t: negative.observed_at };
      notFoundHits++;
    } else if (row) {
      results[username] = {
        t: row.updated_at,
        l: row.location,
        d: row.device,
        a: !!row.location_accurate,
        ...(row.affiliation !== null ? { af: row.affiliation } : {}),
        ...(row.account_id ? { id: row.account_id } : {}),
        ...(row.created_at ? { c: row.created_at } : {}),
        ...(row.username_changes !== null ? { uc: row.username_changes } : {})
      };
      hits++;
    } else {
      misses.push(username);
    }
  }
  recordActivity({
    lookupRequests: 1,
    lookupHits: hits,
    lookupMisses: misses.length,
    lookupNotFoundHits: notFoundHits
  });

  res.json({ results, notFound, misses });
});

app.post('/contribute', requireApiKey, express.json({ limit: '256kb' }), (req, res) => {
  const parsed = parseContributeBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const accepted = upsertMany(parsed.entries) + upsertNotFoundMany(parsed.notFound);
  res.json({ accepted });
});

app.get('/stats', requireApiKey, (req, res) => {
  res.json(getStats());
});

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Client errors raised by middleware (malformed JSON, oversized body, ...) are
  // the client's fault: answer 4xx, don't log a stack trace or report a 500.
  const status = err.status ?? err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    console.warn(`Rejected ${req.method} ${req.path}: ${status} ${err.type || err.message}`);
    res.status(status).json({
      error: status === 413 ? 'Request body too large.' : status === 400 ? 'Invalid JSON body.' : 'Bad request.'
    });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

const removed = cleanup(config.retentionDays);
if (removed) console.log(`Startup cleanup: removed ${removed} entries older than ${config.retentionDays} days`);
const sweepTimer = setInterval(() => {
  const n = cleanup(config.retentionDays);
  if (n) console.log(`Cleanup: removed ${n} entries older than ${config.retentionDays} days`);
}, config.cleanupIntervalMs);

const server = app.listen(config.port, () => {
  console.log(`x-insight-cache listening on :${server.address().port} (retention: ${config.retentionDays}d)`);
});

// Graceful shutdown. Containers run node as the main process, where an
// unhandled SIGTERM is ignored: `docker stop` would wait out its grace period
// and SIGKILL us without ever closing the database.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  clearInterval(sweepTimer);
  // Don't let a stuck request (e.g. a stalled export) outlast Docker's 10s grace.
  setTimeout(() => {
    console.error('Shutdown timed out; forcing exit');
    process.exit(1);
  }, 8000).unref();
  server.close(() => {
    try { db.close(); } catch (error) { console.error('Error closing database:', error); }
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
