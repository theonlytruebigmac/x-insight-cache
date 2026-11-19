/**
 * Server-side validation. The extension's own client (cloud-cache.js)
 * already sanitizes before sending, but this server has to assume nothing —
 * anyone with the API key can point any HTTP client at it, and upstream's
 * own changelog documents a cache-poisoning bug from trusting the client
 * too much. Every field here is independently re-validated.
 */
import { config } from './config.js';

// X's actual handle format.
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const ACCOUNT_ID_RE = /^[0-9]{1,20}$/;

// Twitter launched 2006-01-01. Anything earlier (or in the future) is bad
// data, not an old account — mirrors the client's own MIN_CREATED_AT_SECONDS.
const MIN_CREATED_AT_SECONDS = 1136073600;

export function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

export function parseUsersParam(raw) {
  if (typeof raw !== 'string' || !raw) return { ok: false, error: 'missing users parameter' };
  const usernames = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!usernames.length) return { ok: false, error: 'no usernames provided' };
  if (usernames.length > config.maxLookupUsers) {
    return { ok: false, error: `too many usernames (max ${config.maxLookupUsers})` };
  }
  if (!usernames.every(isValidUsername)) return { ok: false, error: 'invalid username in list' };
  return { ok: true, usernames };
}

function clampString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, config.maxFieldLength);
}

/**
 * Validate and normalize one contribute() entry. Returns null to drop a
 * malformed entry rather than failing the whole batch — one bad client
 * shouldn't block everyone else's valid contributions in the same request.
 */
function sanitizeEntry(username, raw) {
  if (!isValidUsername(username) || !raw || typeof raw !== 'object') return null;

  const location = clampString(raw.l);
  const device = clampString(raw.d);
  if (!location && !device) return null; // nothing worth storing

  const affiliation = clampString(raw.af);

  const accountId = typeof raw.id === 'string' && ACCOUNT_ID_RE.test(raw.id) ? raw.id : null;

  let createdAt = null;
  if (Number.isInteger(raw.c)) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (raw.c >= MIN_CREATED_AT_SECONDS && raw.c <= nowSeconds) createdAt = raw.c;
  }

  let usernameChanges = null;
  if (Number.isInteger(raw.uc) && raw.uc >= 0 && raw.uc <= 10000) usernameChanges = raw.uc;

  return {
    username: username.toLowerCase(),
    location,
    device,
    locationAccurate: raw.a !== false,
    affiliation,
    accountId,
    createdAt,
    usernameChanges
  };
}

export function parseContributeBody(body) {
  if (!body || typeof body !== 'object' || !body.entries || typeof body.entries !== 'object') {
    return { ok: false, error: 'missing entries object' };
  }
  const keys = Object.keys(body.entries);
  if (!keys.length) return { ok: false, error: 'no entries provided' };
  if (keys.length > config.maxContributeEntries) {
    return { ok: false, error: `too many entries (max ${config.maxContributeEntries})` };
  }

  const entries = [];
  for (const key of keys) {
    const sanitized = sanitizeEntry(key, body.entries[key]);
    if (sanitized) entries.push(sanitized);
  }
  return { ok: true, entries };
}
