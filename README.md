# x-insight-cache

Self-hosted, API-key-gated community cache server for the
[x-account-insight](../x-account-insight) browser extension. Not affiliated
with x-account-location-device or its author — this is independent
infrastructure built to replace that project's third-party Cloudflare Worker
with something the community actually controls.

## Why this exists

The extension's cloud-cache client (`cloud-cache.js`) talks to whatever
server `CLOUD_CACHE_CONFIG.API_URL` points at. Upstream pointed it at their
own Cloudflare Worker — meaning every install quietly became a sensor
feeding a database of X accounts' location/device metadata that upstream
operated, enabled by default for new installs. `x-account-insight` disabled
that entirely (`API_URL` is an unconfigured placeholder there). This project
is what you point it at instead, if you want the shared-cache feature back
but running on infrastructure you control, for a community you've actually
handed a key to — not the open internet.

## API contract

Reverse-engineered from the extension's actual client code, since upstream
never published their server. Implementing exactly this means the client
works against this server unmodified — just point `API_URL` at a deployment
of this and flip `host_permissions` back on in the extension's manifest.

| Endpoint | Request | Response |
|---|---|---|
| `GET /lookup?users=a,b,c` | comma-separated lowercase handles | `{"results": {"handle": {t,l,d,a,af,id,c,uc}}, "notFound": {"handle": {"t": 123}}, "misses": ["handle", ...]}` |
| `POST /contribute` | `{"entries": {"handle": {l,d,a,af,c,id,uc,t}}}`; confirmed X 404: `{"handle": {"nf": true, "t": 123}}` | `{"accepted": N}` |
| `GET /stats` | — | `{"totalEntries", "totalNotFoundEntries", "totalContributions", "lastUpdated"}` |

Field shorthand: `t`=last-updated (unix seconds), `l`=location, `d`=device,
`a`=location-accurate (bool), `af`=affiliation badge, `id`=numeric account
ID, `c`=account creation (unix seconds), `uc`=handle-change count.
An explicit `af: ""` means affiliation was checked and none was present; an
omitted `af` means unknown. A contribution with `nf: true` is a confirmed
not-found result and is shared for 24 hours by default
(`NOT_FOUND_TTL_SECONDS`).

On `/contribute`, `t` is optional and means *when the client observed* the
data (unix seconds; defaults to now, future values clamp to now, values past
`RETENTION_DAYS` are dropped). Merging is newer-observation-wins: an older
upload can't overwrite newer location/device data but still fills fields the
row lacks, and when two observations name different account `id`s (a
recycled handle) the newer one replaces the row outright. `accepted` counts
entries that passed validation, so it can be lower than the number sent; it also
counts a stale not-found observation that was validated but not stored because a
newer profile observation already exists. Entries past `RETENTION_DAYS` are never
returned by `/lookup`, even in the window before the next sweep deletes them.
An active negative result is returned separately from `misses`; it is counted
as a cache hit, but never as a profile entry. A newer profile observation
clears an older negative result, while a newer negative result temporarily
hides an older profile observation.

All three endpoints require `Authorization: Bearer <API_KEY>` (the `Bearer`
scheme is case-insensitive). A separate unauthenticated `GET /healthz` returns
`{"ok": true}` when the process is up and the database answers; the container
`HEALTHCHECK` uses it. Malformed JSON gets `400` and an oversized body `413`; bodies
are only read after rate limiting and authentication. Upstream's
own changelog documents a cache-poisoning bug from an unauthenticated
`/contribute` — this server requires a key for both reads and writes from
the start, and independently re-validates every field server-side rather
than trusting the client (see `src/validate.js`). Anyone holding a community
key can submit profile or not-found observations, so only distribute it to
trusted members; the 24-hour default bounds the effect of an incorrect
not-found contribution.

## Deploy

```bash
cp .env.example .env
# edit .env: set API_KEY to something you generate yourself, e.g.
node -e "console.log(require('crypto').randomUUID())"

docker compose up -d --build
```

The image is built on Node 22 (`better-sqlite3` ships prebuilt binaries for it, so
nothing is compiled), the container runs under `init: true`, and the server handles
`SIGTERM`/`SIGINT` by finishing the shutdown cleanly and closing the database
(a stuck request is cut off after 8 seconds, inside Docker's 10-second grace).

Data persists in the `cache-data` volume. Retention defaults to 60 days
(matching upstream) and is enforced by an hourly sweep, not a database-level
TTL — SQLite doesn't have one, unlike the Cloudflare KV store upstream used.

### Dashboard

Visit `/` or `/admin/` on your server to open the read-only dashboard. Enable
login by setting both of these in `.env`, then recreate the container with
`docker compose up -d --build`:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
ADMIN_SECURE_COOKIE=true
```

Generate a password using the command in the deployment section; do not reuse
the extension's `API_KEY`. The existing Compose `env_file` passes these settings
to the server. No frontend build or additional service is needed.

The dashboard shows cached account counts, lifetime accepted contributions
(including updates), retention, last contribution time and server uptime.
Browse all stored fields in a paginated table, or search by handle, location,
device, affiliation or account ID. Cache data is read-only; the dashboard
does not record who looked up whom.

The dashboard also includes filters, sort, CSV/JSON export, API-key management,
freshness counts, device/location breakdowns, aggregate lookup hit/miss and
not-found trends, and HTTP 429 counts for lookup and contribution requests.
Activity is hourly and aggregate-only; it does not retain handles or client IPs.
Charts use local time for hourly buckets and UTC for daily buckets; the current
bucket is incomplete. Hover over a plotted point to see its count.
Activity history begins when this server version is deployed; older lookup and
contribution events cannot be reconstructed from the cache database.
Managed extension keys have the same read/write permissions as `API_KEY`.
Only the key hash is stored; the complete key appears only once at creation.
Use individual labels to track key ownership, and revoke a key immediately if
it is lost or no longer needed. Removing a key does not revoke the configured
shared `API_KEY`.

Dashboard credentials are separate from the shared extension API key.
Login creates an HttpOnly, SameSite=Strict cookie valid for eight hours.
Sessions are held in memory: logout invalidates that session, and restarting
the server invalidates all sessions (including when rotating credentials).
Failed login attempts are limited to 10 per client IP per 15 minutes (successful
logins are not counted). Behind the documented single Traefik hop, `trust proxy`
uses the forwarded client IP for rate limiting. This trusts the *last*
`X-Forwarded-For` entry, which is only correct because Traefik sets it: a client that
reaches the Node port directly can send its own `X-Forwarded-For` and choose its own
rate-limit identity. Keep the port reachable only from the proxy/host, and don't
configure Traefik to trust client-supplied forwarded headers.

**Use HTTPS in production.** Session cookies have `Secure` enabled by default,
including behind Traefik. For local HTTP testing only, set
`ADMIN_SECURE_COOKIE=false`; otherwise a browser may not retain the cookie.
Leave both admin credentials unset to disable dashboard access to data.
Setting only one is a startup error. The extension API and its bearer-token
authentication are unchanged; dashboard cookies cannot authenticate API calls,
and API keys cannot authenticate dashboard calls.

### Behind Traefik

`docker-compose.yml` matches the `-rtr`/`-service` label convention and
`t3_proxy` network already used elsewhere in this deployment, routing
`feed.syschimp.com` (set `CACHE_FQDN` in `.env` to override). No TLS/
certresolver labels are set here — this setup's `websecure` entrypoint
already has a default resolver configured in Traefik's own static config,
same as the other services on `t3_proxy`.

**No `chain-oauth@file` middleware on this one, unlike some other services
behind the same Traefik.** This is a JSON API that the extension's
background script calls directly with `Authorization: Bearer <key>` — an
OAuth redirect chain is built for a human signing in through a browser, and
would break every request from the extension rather than add protection.
The API key is this service's actual auth; adding the OAuth chain here
wouldn't secure it further, it would just make it stop working.

The direct port is bound to `127.0.0.1:8787` for access from the Docker
host only. Use the HTTPS Traefik URL from other machines; publishing the
HTTP port on all interfaces would expose dashboard passwords and bearer
tokens in transit. Firewall the port as well: older Docker releases may
allow hosts on the same network segment to reach localhost-published ports.

### Without Traefik

Delete the `labels:` and `networks:` blocks. Keep the loopback-only port:
```yaml
    ports:
      - "127.0.0.1:8787:8787"
```
Put your own HTTPS reverse proxy in front for access from other machines.

## Security model

- **Extension credentials.** The configured `API_KEY` remains a shared key.
  The admin API can also issue individually revocable keys; each
  key has the same read/write permissions as `API_KEY`. Rotating the shared
  key does not revoke separately issued keys. Key-management controls in the
  dashboard require an authenticated admin session.
- **Separate admin login.** Optional dashboard credentials do not grant
  extension API access. Cached account data is read-only in the dashboard,
  but the admin API can create and revoke extension keys. Dashboard access
  requires an expiring session; cross-site login/logout requests are rejected
  and login is rate-limited.
- **Server-side validation independent of the client.** Username format,
  batch-size caps, field-length caps, and account-ID/creation-date sanity
  checks are all re-checked here (`src/validate.js`), not trusted from the
  request. A malformed entry inside an otherwise-valid batch is dropped
  individually rather than failing the whole request.
- **Per-IP rate limiting** on `/lookup`, `/contribute` and `/stats`
  (`express-rate-limit`), configurable via `LOOKUP_RATE_LIMIT` /
  `CONTRIBUTE_RATE_LIMIT` / `STATS_RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS`. The
  limiters run before authentication, so guessing keys is throttled too. IPv6
  clients are limited per /56 subnet, so rotating addresses inside one allocation
  doesn't earn a fresh budget.
- **No prototype-pollution path.** Entry keys go through `Object.keys()` and
  explicit field extraction, never a pattern that could let a `__proto__`
  key reach `Object.prototype` (covered in `scripts/smoke-test.mjs`).
- **Refuses to start without `API_KEY` set.** No accidental "open to the
  internet" default.

## What's actually stored

The cache contains the fields in the table above, keyed by handle — the same
subset upstream's cache carried, already public on the account's profile.
The database also stores hourly aggregate lookup and contribution counts and,
for managed API keys, an administrator-supplied label, key prefix, key hash,
creation time and last-use time. It does not record who looked up whom or
individual lookup history; your reverse proxy may keep its own access logs.
The retention sweep does not delete managed keys; hourly aggregate counts are
deleted after 90 days.

## Testing

```bash
npm test
```

Starts a real server against a temp SQLite file and exercises every endpoint
over actual HTTP: auth rejection, server-side validation limits, malformed
entries inside a valid batch, stats accumulation, prototype-pollution safety,
and a direct unit test of the retention sweep. Also covers dashboard sessions,
login rate limiting, cookie flags, cross-site rejection, read-only access,
search and pagination. Regression tests also cover malformed/oversized request
bodies, the `/stats` limiter, `/healthz`, graceful shutdown, config validation, and a
stalled or abandoned dashboard export not disturbing other requests. Tests use an
OS-assigned port and temporary databases. Requires Node 22 or newer.

## Environment variables

Numeric settings must be integers in range; a malformed or out-of-range value is a
startup error rather than a silent fallback to the default.

| Variable | Default | Meaning |
|---|---|---|
| `API_KEY` | *(required)* | Shared bearer token. Server refuses to start without it. |
| `ADMIN_USERNAME` | *(unset)* | Dashboard username. Set with `ADMIN_PASSWORD` to enable dashboard data access. |
| `ADMIN_PASSWORD` | *(unset)* | Dashboard password, separate from `API_KEY`. |
| `ADMIN_SECURE_COOKIE` | `true` | Require HTTPS for dashboard cookies. Set to `false` only for local HTTP. |
| `PORT` | `8787` | Listen port. |
| `DB_PATH` | `./data/cache.db` | SQLite file path. |
| `RETENTION_DAYS` | `60` | Entries older than this are swept hourly. |
| `CLEANUP_INTERVAL_MS` | `3600000` | How often the retention sweep runs (minimum `1000`). |
| `MAX_LOOKUP_USERS` | `100` | Max handles per `/lookup` call. |
| `MAX_CONTRIBUTE_ENTRIES` | `200` | Max entries per `/contribute` call. |
| `MAX_FIELD_LENGTH` | `100` | Max chars for location/device/affiliation strings. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `LOOKUP_RATE_LIMIT` | `60` | Max `/lookup` requests per window, per IP. |
| `CONTRIBUTE_RATE_LIMIT` | `30` | Max `/contribute` requests per window, per IP. |
| `STATS_RATE_LIMIT` | `30` | Max `/stats` requests per window, per IP. |
| `CACHE_FQDN` | `feed.syschimp.com` | Only used by the Traefik label in `docker-compose.yml`. |
