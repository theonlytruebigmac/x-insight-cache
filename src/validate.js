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
  // De-duplicate so a repeated handle isn't double-counted in hits/misses.
  const usernames = [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!usernames.length) return { ok: false, error: 'no usernames provided' };
  if (usernames.length > config.maxLookupUsers) {
    return { ok: false, error: `too many usernames (max ${config.maxLookupUsers})` };
  }
  if (!usernames.every(isValidUsername)) return { ok: false, error: 'invalid username in list' };
  return { ok: true, usernames };
}

// C0/C1 control characters (NUL, newlines, escape sequences, ...) have no place in
// a location, device or affiliation label.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function clampString(value) {
  if (typeof value !== 'string') return null;
  // toWellFormed() replaces any lone surrogate in the input with U+FFFD.
  let text = value.replace(CONTROL_CHARS_RE, ' ').toWellFormed().trim();
  if (!text) return null;
  text = text.slice(0, config.maxFieldLength);
  // The cut can land between the halves of a surrogate pair (an emoji); drop the
  // orphaned half rather than storing a malformed string.
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text.trim() || null;
}

function observationTime(raw) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Absent or null means "no observation time supplied" (older clients): use now.
  if (raw.t === undefined || raw.t === null) return nowSeconds;
  if (!Number.isInteger(raw.t) || raw.t < nowSeconds - config.retentionDays * 86400) return null;
  return Math.min(raw.t, nowSeconds);
}

/**
 * Validate and normalize one contribute() entry. Returns null to drop a
 * malformed entry rather than failing the whole batch — one bad client
 * shouldn't block everyone else's valid contributions in the same request.
 */
function sanitizeEntry(username, raw) {
  if (!isValidUsername(username) || !raw || typeof raw !== 'object') return null;

  const observedAt = observationTime(raw);
  if (observedAt === null) return null;

  if (raw.nf === true) {
    if (observedAt < Math.floor(Date.now() / 1000) - config.notFoundTtlSeconds) return null;
    return { username: username.toLowerCase(), notFound: true, observedAt };
  }

  const location = clampString(raw.l);
  const device = clampString(raw.d);
  if (!location && !device) return null; // nothing worth storing

  // An explicit empty string means the client checked affiliation and found none.
  // Missing/null remains unknown and must not overwrite a known affiliation.
  const affiliation = raw.af === '' ? '' : clampString(raw.af);

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
    usernameChanges,
    observedAt
  };
}

export function parseContributeBody(body) {
  // An array would be accepted by Object.keys() and store entries under the
  // handles "0", "1", ... -- the contract is an object keyed by handle.
  if (!body || typeof body !== 'object' || !body.entries || typeof body.entries !== 'object' ||
      Array.isArray(body.entries)) {
    return { ok: false, error: 'missing entries object' };
  }
  const keys = Object.keys(body.entries);
  if (!keys.length) return { ok: false, error: 'no entries provided' };
  if (keys.length > config.maxContributeEntries) {
    return { ok: false, error: `too many entries (max ${config.maxContributeEntries})` };
  }

  const entries = [];
  const notFound = [];
  for (const key of keys) {
    const sanitized = sanitizeEntry(key, body.entries[key]);
    if (sanitized?.notFound) notFound.push(sanitized);
    else if (sanitized) entries.push(sanitized);
  }
  return { ok: true, entries, notFound };
}
