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
| `GET /lookup?users=a,b,c` | comma-separated lowercase handles | `{"results": {"handle": {t,l,d,a,af,id,c,uc}}, "misses": ["handle", ...]}` |
| `POST /contribute` | `{"entries": {"handle": {l,d,a,af,c,id,uc}}}` | `{"accepted": N}` |
| `GET /stats` | — | `{"totalEntries", "totalContributions", "lastUpdated"}` |

Field shorthand: `t`=last-updated (unix seconds), `l`=location, `d`=device,
`a`=location-accurate (bool), `af`=affiliation badge, `id`=numeric account
ID, `c`=account creation (unix seconds), `uc`=handle-change count.

All three endpoints require `Authorization: Bearer <API_KEY>`. Upstream's
own changelog documents a cache-poisoning bug from an unauthenticated
`/contribute` — this server requires a key for both reads and writes from
the start, and independently re-validates every field server-side rather
than trusting the client (see `src/validate.js`).

## Deploy

```bash
cp .env.example .env
# edit .env: set API_KEY to something you generate yourself, e.g.
node -e "console.log(require('crypto').randomUUID())"

docker compose up -d --build
```

Data persists in the `cache-data` volume. Retention defaults to 60 days
(matching upstream) and is enforced by an hourly sweep, not a database-level
TTL — SQLite doesn't have one, unlike the Cloudflare KV store upstream used.

### Behind Traefik

`docker-compose.yml` ships with Traefik labels already, routing
`feed.syschimp.com` (set `CACHE_FQDN` in `.env` to override) with TLS via a
cert resolver. Two things to set before it'll actually work:

1. **The external network.** The compose file expects a Docker network
   named `traefik` that your Traefik container is already attached to.
   Create it once if it doesn't exist: `docker network create traefik`.
   If your Traefik setup uses a different network name, change the
   `networks:` block at the bottom of `docker-compose.yml` to match.
2. **The cert resolver name.** `tls.certresolver=letsencrypt` is a
   placeholder — set it to whatever resolver name is actually defined in
   your Traefik static config, or no certificate will be issued.

There's deliberately no `ports:` mapping — Traefik is meant to be the only
entrypoint. The app's own API-key check still applies regardless, but
there's no reason to also expose the raw port on the host.

### Without Traefik

Delete the `labels:` and `networks:` blocks and add back:
```yaml
    ports:
      - "8787:8787"
```
Put your own reverse proxy (or none, on a private network) in front for TLS.

## Security model

- **One shared key, not per-user accounts.** Simple by design — good for
  "a defined group I've handed a key to," not meant to scale past that.
  Rotate it by changing `API_KEY` and restarting; every client needs the
  new value.
- **Server-side validation independent of the client.** Username format,
  batch-size caps, field-length caps, and account-ID/creation-date sanity
  checks are all re-checked here (`src/validate.js`), not trusted from the
  request. A malformed entry inside an otherwise-valid batch is dropped
  individually rather than failing the whole request.
- **Per-IP rate limiting** on `/lookup` and `/contribute` (`express-rate-limit`),
  configurable via `LOOKUP_RATE_LIMIT` / `CONTRIBUTE_RATE_LIMIT` /
  `RATE_LIMIT_WINDOW_MS`.
- **No prototype-pollution path.** Entry keys go through `Object.keys()` and
  explicit field extraction, never a pattern that could let a `__proto__`
  key reach `Object.prototype` (covered in `scripts/smoke-test.mjs`).
- **Refuses to start without `API_KEY` set.** No accidental "open to the
  internet" default.

## What's actually stored

Exactly the fields in the table above, keyed by handle — the same subset
upstream's cache carried, already public on the account's own profile.
Nothing about *you* (the person running or using the extension) is sent:
no identity, no browsing history, no record of who looked up whom, beyond
whatever your reverse proxy's own access logs capture.

## Testing

```bash
npm test
```

Starts a real server against a temp SQLite file and exercises every endpoint
over actual HTTP: auth rejection, server-side validation limits, malformed
entries inside a valid batch, stats accumulation, prototype-pollution safety,
and a direct unit test of the retention sweep. 23 checks, all passing as of
the last run.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `API_KEY` | *(required)* | Shared bearer token. Server refuses to start without it. |
| `PORT` | `8787` | Listen port. |
| `DB_PATH` | `./data/cache.db` | SQLite file path. |
| `RETENTION_DAYS` | `60` | Entries older than this are swept hourly. |
| `CLEANUP_INTERVAL_MS` | `3600000` | How often the retention sweep runs. |
| `MAX_LOOKUP_USERS` | `100` | Max handles per `/lookup` call. |
| `MAX_CONTRIBUTE_ENTRIES` | `200` | Max entries per `/contribute` call. |
| `MAX_FIELD_LENGTH` | `100` | Max chars for location/device/affiliation strings. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `LOOKUP_RATE_LIMIT` | `60` | Max `/lookup` requests per window, per IP. |
| `CONTRIBUTE_RATE_LIMIT` | `30` | Max `/contribute` requests per window, per IP. |
| `CACHE_FQDN` | `feed.syschimp.com` | Only used by the Traefik label in `docker-compose.yml`. |
