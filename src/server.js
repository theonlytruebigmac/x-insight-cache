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
import { getMany, getNotFoundMany, upsertMany, upsertNotFoundMany, getStats, cleanup, recordActivity } from './db.js';
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
// Trust exactly one hop of X-Forwarded-For. The only paths to this process
// are Traefik (one real proxy hop, on the t3_proxy network) or 127.0.0.1 on
// the Docker host itself -- there's no untrusted multi-hop chain in front of
// it. Without this, express-rate-limit refuses to use X-Forwarded-For at all
// (see ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) and every client behind Traefik
// collapses into one shared rate-limit bucket, same bug for admin.js's login
// limiter. `1` -- not `true` -- deliberately: trusting only one hop means a
// request straight to the loopback port can't spoof X-Forwarded-For to fake
// a different rate-limit identity, since no real proxy added one there.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.get('/', (req, res) => res.redirect('/admin/'));
app.use('/admin', admin);

app.use(
  '/lookup',
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.lookupRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      recordActivity({ lookupRateLimited: 1 });
      res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
  })
);
app.use(
  '/contribute',
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.contributeRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      recordActivity({ contributeRateLimited: 1 });
      res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
  })
);

app.get('/lookup', requireApiKey, (req, res) => {
  const parsed = parseUsersParam(req.query.users);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const rows = getMany(parsed.usernames);
  const notFoundRows = getNotFoundMany(parsed.usernames);
  const notFound = {};
  const misses = [];
  const results = {};
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

app.post('/contribute', requireApiKey, (req, res) => {
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
  if (req.path.startsWith('/admin/') && (err.status === 400 || err.status === 413)) {
    console.warn('Rejected dashboard JSON request:', err.status);
    res.status(err.status).json({ error: err.status === 413 ? 'Request body too large.' : 'Invalid JSON body.' });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

const removed = cleanup(config.retentionDays);
if (removed) console.log(`Startup cleanup: removed ${removed} entries older than ${config.retentionDays} days`);
setInterval(() => {
  const n = cleanup(config.retentionDays);
  if (n) console.log(`Cleanup: removed ${n} entries older than ${config.retentionDays} days`);
}, config.cleanupIntervalMs);

const server = app.listen(config.port, () => {
  console.log(`x-insight-cache listening on :${server.address().port} (retention: ${config.retentionDays}d)`);
});
