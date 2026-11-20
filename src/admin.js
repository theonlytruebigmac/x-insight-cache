import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { safeEqual } from './auth.js';
import {
  createApiKey,
  getBreakdowns,
  getHistory,
  getStats,
  iterateEntries,
  listApiKeys,
  listEntries,
  revokeApiKey
} from './db.js';

const router = express.Router();
const sessions = new Map();
const sessionLifetime = 8 * 60 * 60 * 1000;
const cookieName = 'xic_admin';
const configured = !!(config.adminUsername && config.adminPassword);

function sessionToken(req) {
  const cookie = (req.get('cookie') || '').split(';')
    .map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  return cookie?.slice(cookieName.length + 1);
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, expires] of sessions) {
    if (expires <= now) sessions.delete(token);
  }
}

const cookieOptions = {
  httpOnly: true,
  secure: config.adminSecureCookie,
  sameSite: 'strict',
  path: '/admin'
};

router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    let foreignOrigin = false;
    if (origin) {
      try {
        const url = new URL(origin);
        foreignOrigin = !['http:', 'https:'].includes(url.protocol) || url.host !== req.get('host');
      } catch {
        foreignOrigin = true;
      }
    }
    if (foreignOrigin || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'cross-site requests are not allowed' });
    }
  }
  next();
});

router.use('/api', (req, res, next) => {
  if (!configured) {
    return res.status(503).json({ error: 'Dashboard disabled. Set ADMIN_USERNAME and ADMIN_PASSWORD, then restart the server.' });
  }
  next();
});

router.post('/api/session', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  // Only failed attempts count: a legitimate admin signing in repeatedly must
  // not be locked out, and the limit exists to stop password guessing.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
}), (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  // Evaluate both comparisons unconditionally so timing doesn't reveal whether
  // the username alone was correct.
  const usernameOk = safeEqual(username, config.adminUsername);
  const passwordOk = safeEqual(password, config.adminPassword);
  if (!(usernameOk && passwordOk)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  pruneSessions();
  if (sessions.size >= 1000) {
    return res.status(503).json({ error: 'Too many active dashboard sessions. Try again later.' });
  }
  sessions.delete(sessionToken(req));
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + sessionLifetime);
  res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
  res.json({ username: config.adminUsername });
});

router.use('/api', (req, res, next) => {
  pruneSessions();
  if (!sessions.has(sessionToken(req))) {
    return res.status(401).json({ error: 'Please log in to the dashboard.' });
  }
  next();
});

router.get('/api/session', (req, res) => {
  res.json({ username: config.adminUsername });
});

router.delete('/api/session', (req, res) => {
  sessions.delete(sessionToken(req));
  res.clearCookie(cookieName, cookieOptions);
  res.json({ ok: true });
});

router.get('/api/keys', (req, res) => {
  res.json({ keys: listApiKeys() });
});

router.post('/api/keys', (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Enter a key label between 1 and 60 characters.' });
  }
  if (listApiKeys().length >= 500) {
    return res.status(409).json({ error: 'The maximum of 500 active API keys has been reached.' });
  }
  res.status(201).json(createApiKey(name.trim()));
});

router.delete('/api/keys/:id', (req, res) => {
  if (!/^[\da-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid API key ID.' });
  }
  if (!revokeApiKey(req.params.id)) {
    return res.status(404).json({ error: 'API key not found.' });
  }
  res.json({ ok: true });
});

router.get('/api/stats', (req, res) => {
  res.json({
    ...getStats(),
    retentionDays: config.retentionDays,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

router.get('/api/breakdowns', (req, res) => {
  res.json(getBreakdowns(config.retentionDays));
});

router.get('/api/history', (req, res) => {
  const period = req.query.period || '24h';
  if (typeof period !== 'string' || !['24h', '7d', '30d'].includes(period)) {
    return res.status(400).json({ error: 'Period must be 24h, 7d, or 30d.' });
  }
  res.json(getHistory(period));
});

function parseEntryFilters(query) {
  const { search = '', page = '1', pageSize = '25', device = '', accurate = '', freshness = '', sort = 'updated', direction = 'desc' } = query;
  if (typeof search !== 'string' || search.length > 100 ||
      typeof device !== 'string' || device.length > 100 ||
      typeof page !== 'string' || !/^[1-9]\d{0,6}$/.test(page) ||
      typeof pageSize !== 'string' || !/^[1-9]\d{0,2}$/.test(pageSize) || Number(pageSize) > 100 ||
      typeof accurate !== 'string' || !['', 'yes', 'no'].includes(accurate) ||
      typeof freshness !== 'string' || !['', 'fresh', 'expiring', 'expired'].includes(freshness) ||
      typeof sort !== 'string' || !['updated', 'username', 'location', 'device', 'created'].includes(sort) ||
      typeof direction !== 'string' || !['asc', 'desc'].includes(direction)) {
    return null;
  }
  return {
    filters: { search: search.trim(), device, accurate, freshness, sort, direction },
    page: Number(page),
    pageSize: Number(pageSize)
  };
}

router.get('/api/entries', (req, res) => {
  const options = parseEntryFilters(req.query);
  if (!options) {
    return res.status(400).json({ error: 'Invalid search, filter, sort or pagination options.' });
  }
  res.json(listEntries(options.filters, options.page, options.pageSize, config.retentionDays));
});

router.get('/api/export', async (req, res, next) => {
  const options = parseEntryFilters({ ...req.query, page: '1', pageSize: '1' });
  if (!options) return res.status(400).json({ error: 'Invalid search, filter, sort or export options.' });
  const format = req.query.format || 'csv';
  if (typeof format !== 'string' || !['csv', 'json'].includes(format)) {
    return res.status(400).json({ error: 'Export format must be csv or json.' });
  }
  const columns = ['username', 'location', 'device', 'location_accurate', 'affiliation', 'account_id', 'created_at', 'username_changes', 'updated_at'];
  const csvValue = (value) => {
    let text = value == null ? '' : String(value);
    if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  res.setHeader('Content-Disposition', `attachment; filename="x-insight-cache-${new Date().toISOString().slice(0, 10)}.${format}"`);
  res.type(format === 'csv' ? 'text/csv' : 'application/json');
  if (format === 'csv') res.write(columns.join(',') + '\r\n');
  else res.write('[');
  // If the client goes away while we're waiting on backpressure, 'drain' never
  // fires; wake on 'close' too so the loop ends instead of hanging forever.
  const drainOrClose = () => new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
  try {
    let first = true;
    for (const entry of iterateEntries(options.filters, config.retentionDays)) {
      if (res.destroyed) return;
      const row = format === 'csv'
        ? columns.map((column) => csvValue(entry[column])).join(',') + '\r\n'
        : `${first ? '' : ','}${JSON.stringify(entry)}`;
      if (!res.write(row)) await drainOrClose();
      first = false;
    }
    if (!res.destroyed) res.end(format === 'json' ? ']' : undefined);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    next(error);
  }
});

router.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
router.use(express.static(fileURLToPath(new URL('./public/', import.meta.url)), {
  etag: false,
  lastModified: false
}));

export default router;
