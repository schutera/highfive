import { Readable, pipeline } from 'node:stream';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { tryParseModuleId } from '@highfive/contracts';
import type {
  ServerLogsResponse,
  HeartbeatGap,
  NestSnip,
  NestSnipsResponse,
  NestSnipHistoryResponse,
} from '@highfive/contracts';
import { db } from './database';
import { verifyApiKey, getApiKey } from './auth';
import { accessLog } from './accessLog';
import { getRecentEntries } from './logRing';
import { streamBackendRing, writeSseHeaders } from './logStream';
import {
  SESSION_COOKIE,
  issueSessionToken,
  verifySessionToken,
  sessionCookieOptions,
  requireAdmin,
  isRateLimited,
  recordFailedAttempt,
  resetAttempts,
} from './session';
import { DUCKDB_URL } from './duckdbClient';
import { isProduction } from './env';
import { lookupUserLocation } from './userLocation';

const IMAGE_SERVICE_URL = process.env.IMAGE_SERVICE_URL ?? 'http://image-service:4444';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? '';

export const app = express();

// Honour X-Forwarded-For when the immediate connection is from a private
// network range (typical reverse-proxy topology). Without this, `req.ip`
// is always the reverse-proxy's address in prod, and ipapi.co looks up
// our datacenter instead of the visitor. The 'loopback, linklocal,
// uniquelocal' preset specifically does NOT trust public-IP clients to
// spoof X-F-F. See https://expressjs.com/en/guide/behind-proxies.html.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// Middleware - Configure CORS for production. The `exposedHeaders` field
// is load-bearing: production runs `highfive.schutera.com` ↔
// `api.highfive.schutera.com` (cross-origin), and dev is `:5173 → :3002`
// (also cross-origin), so the browser only lets `fetch().headers.get(...)`
// read response headers that are explicitly listed here. Without
// `X-Highfive-Data-Incomplete` exposed, the dashboard's
// "heartbeat data unavailable" banner (#31) never fires.
// `origin` cannot be the wildcard `*` once `credentials: true` is set — the
// browser rejects a credentialed response whose Access-Control-Allow-Origin
// is `*`. In dev we therefore reflect the request origin (`true`) instead of
// `*` so the session cookie can flow on `credentials: 'include'` fetches from
// the homepage dev server (localhost:5173 / CI :6173). Prod stays pinned to
// the one allowed origin. See ADR-019 and docs/08-.../auth.md.
const corsOptions = {
  origin: isProduction() ? 'https://highfive.schutera.com' : true,
  credentials: true,
  optionsSuccessStatus: 200,
  exposedHeaders: ['X-Highfive-Data-Incomplete'],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Access logging (#178): one structured entry per request into the admin log
// ring. Mounted here so it wraps every route below (health + public + admin).
// Logs method+path+status+duration only — never headers/body/query — so no
// secret can reach the ring. See accessLog.ts.
app.use(accessLog);

// Health check (public, no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve images without auth — <img> tags cannot send custom headers
app.get('/api/images/:filename', async (req, res) => {
  try {
    const response = await fetch(
      `${IMAGE_SERVICE_URL}/images/${encodeURIComponent(req.params.filename)}`,
    );
    if (!response.ok) {
      res.status(response.status).json({ error: 'Image not found' });
      return;
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error('[GET /api/images/:filename]', {
      filename: req.params.filename,
      error: String(error),
    });
    res.status(502).json({ error: 'Failed to fetch image from image service' });
  }
});

// Serve per-nest snips without auth (#165) — the crop removes all background
// (issue #154), and <img> tags cannot send custom headers. Mirrors the images
// proxy above, hitting image-service's dedicated /snips route.
app.get('/api/snips/:filename', async (req, res) => {
  try {
    const response = await fetch(
      `${IMAGE_SERVICE_URL}/snips/${encodeURIComponent(req.params.filename)}`,
    );
    if (!response.ok) {
      res.status(response.status).json({ error: 'Snip not found' });
      return;
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error('[GET /api/snips/:filename]', {
      filename: req.params.filename,
      error: String(error),
    });
    res.status(502).json({ error: 'Failed to fetch snip from image service' });
  }
});

// Public waitlist signup — forwards to Discord webhook
app.post('/api/waitlist', async (req, res) => {
  try {
    const { name, email } = req.body ?? {};
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim() : '';

    if (!cleanName || cleanName.length > 200) {
      res.status(400).json({ error: 'Invalid name' });
      return;
    }
    if (!cleanEmail || cleanEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Invalid email' });
      return;
    }

    if (!DISCORD_WEBHOOK_URL) {
      console.warn('Waitlist signup received but DISCORD_WEBHOOK_URL is not set');
      res.status(503).json({ error: 'Waitlist temporarily unavailable' });
      return;
    }

    const content = `🐝 **New Hive Module waitlist signup**\n**Name:** ${cleanName}\n**Email:** ${cleanEmail}`;
    const discordRes = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!discordRes.ok) {
      console.error('Discord webhook failed:', discordRes.status, await discordRes.text());
      res.status(502).json({ error: 'Failed to register signup' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Waitlist signup error:', err);
    res.status(500).json({ error: 'Failed to register signup' });
  }
});

// --- Admin session auth (public routes; issue #142 / ADR-019) ----------
//
// The homepage bundle holds no secret. An operator logs in here with the
// `HIGHFIVE_API_KEY` value; on success the server mints a signed, HttpOnly
// session cookie. Admin/write routes below are gated by `requireAdmin`,
// which accepts that cookie OR an `X-Admin-Key` header (machine credential).

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ authenticated: false, error: 'Too many attempts. Try again later.' });
    return;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !verifyApiKey(password)) {
    recordFailedAttempt(ip);
    res.status(401).json({ authenticated: false });
    return;
  }
  resetAttempts(ip);
  res.cookie(SESSION_COOKIE, issueSessionToken(), sessionCookieOptions());
  res.json({ authenticated: true });
});

app.post('/api/admin/logout', (req, res) => {
  // Match the mint-time attributes so the browser deletes the right cookie;
  // clearCookie overrides the expiry to the past.
  const { maxAge: _maxAge, ...clearOpts } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, clearOpts);
  res.json({ authenticated: false });
});

app.get('/api/admin/session', (req, res) => {
  const cookie = (req as typeof req & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];
  res.json({ authenticated: verifySessionToken(cookie) });
});

// API Routes
//
// Read routes below are PUBLIC by design: the dashboard and map are linked
// from the marketing site and must render for anonymous visitors. The blanket
// X-API-Key gate that used to sit here was removed in #142 — a single-page app
// cannot hold the secret that gate required, so it protected nothing the public
// dashboard didn't already expose. Write/admin routes are individually gated by
// `requireAdmin` (see ADR-019).

app.get('/api/modules', async (req, res) => {
  try {
    const { modules, heartbeatsFailed } = await db.listModules();
    if (heartbeatsFailed) {
      res.setHeader('X-Highfive-Data-Incomplete', 'heartbeats');
    }
    res.json(modules);
  } catch (error) {
    console.error('[GET /api/modules]', { error: String(error) });
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

// Coarse IP-based user-location hint for the dashboard map (issue #14).
// Permissionless, ~city accuracy. 204 for private/loopback IPs (dev), 503
// when ipapi.co is unreachable. The frontend treats both as "no hint" and
// falls back to the default centre — see userLocation.ts for the rationale.
app.get('/api/user-location', async (req, res) => {
  // `req.ip` honours the trust-proxy setting above. Fall back to the raw
  // socket address only if Express somehow couldn't determine one.
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (!ip) {
    res.status(204).end();
    return;
  }
  try {
    const result = await lookupUserLocation(ip);
    // Exhaustive switch — adding a fifth `source` to UserLocationLookup
    // becomes a TypeScript compile error in the default branch rather
    // than silently falling through to a 503.
    switch (result.source) {
      case 'hit':
      case 'miss':
        res.json(result.data);
        return;
      case 'private':
        res.status(204).end();
        return;
      case 'unavailable':
        console.error('[GET /api/user-location]', { ip, source: result.source });
        res.status(503).json({ error: 'user-location unavailable' });
        return;
      default: {
        const _exhaustive: never = result.source;
        throw new Error(`unhandled user-location source: ${String(_exhaustive)}`);
      }
    }
  } catch (error) {
    // lookupUserLocation is written to never throw, but a future refactor
    // could; we'd rather emit a clean 503 than a 500 traceback.
    console.error('[GET /api/user-location]', { ip, error: String(error) });
    res.status(503).json({ error: 'user-location unavailable' });
  }
});

app.get('/api/modules/:id', async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    // The detail route deliberately does NOT emit
    // X-Highfive-Data-Incomplete — the dashboard banner is rendered by
    // the listing call (DashboardPage.tsx), and the detail panel is
    // always opened from the listing, so the user has already seen the
    // degradation signal. Avoids API/UI drift where one route surfaces
    // the header but the consumer doesn't read it.
    const { detail } = await db.getModuleDetail(id);
    if (detail) {
      res.json(detail);
    } else {
      res.status(404).json({ error: 'Module not found' });
    }
  } catch (error) {
    console.error('[GET /api/modules/:id]', { id, error: String(error) });
    res.status(500).json({ error: 'Failed to fetch module details' });
  }
});

// Image listing (proxied to image-service). Forwards module_id/limit/
// offset for newest-first pagination; response is the ImageUploadsPage
// envelope ({ images, total }) from the contracts package.
app.get('/api/images', async (req, res) => {
  try {
    const params = new URLSearchParams();
    for (const key of ['module_id', 'limit', 'offset']) {
      const value = req.query[key];
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    const url = `${IMAGE_SERVICE_URL}/images${qs ? `?${qs}` : ''}`;
    // 15s ceiling so a hung image-service can't hang this hop
    // indefinitely — matches image-service's own read timeout, keeping
    // the proxy chain free of any unbounded fetch.
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    // Masks any upstream non-2xx (incl. a duckdb 400 on a bad module_id)
    // as 502 by design — these routes are only ever called with the
    // admin dropdown's canonical ids and integer paging, so an upstream
    // 4xx is unreachable in practice.
    if (!response.ok) throw new Error(`Image service error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[GET /api/images]', {
      query: req.query,
      error: String(error),
    });
    res.status(502).json({ error: 'Failed to fetch images from image service' });
  }
});

app.delete('/api/images/:filename', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(
      `${IMAGE_SERVICE_URL}/images/${encodeURIComponent(req.params.filename)}`,
      {
        method: 'DELETE',
      },
    );
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('[DELETE /api/images/:filename]', {
      filename: req.params.filename,
      error: String(error),
    });
    res.status(502).json({ error: 'Failed to delete image' });
  }
});

app.delete('/api/modules/:id', requireAdmin, async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    const response = await fetch(`${DUCKDB_URL}/modules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('[DELETE /api/modules/:id]', { id, error: String(error) });
    res.status(502).json({ error: 'Failed to delete module' });
  }
});

// Admin-only: set or clear the operator-settable display-name override
// for a module. Gated by `requireAdmin` (session cookie OR X-Admin-Key
// machine credential — see session.ts / ADR-019). Proxies to duckdb-service's
// PATCH endpoint
// which enforces the UNIQUE constraint and surfaces 409 on collision —
// we forward both status and body so the homepage can render the
// inline error with the conflicting MAC. See ADR-011 and issue #93.
app.patch('/api/modules/:id/name', requireAdmin, async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'display_name')) {
    res.status(400).json({ error: "body must include 'display_name' (string or null)" });
    return;
  }
  // Type-check at the proxy too — duckdb-service rejects non-string/
  // non-null with its own 400, but catching here saves an upstream
  // round trip and gives a uniformly-shaped error body. Defence-in-
  // depth, not a hard requirement.
  const dn: unknown = req.body.display_name;
  if (dn !== null && typeof dn !== 'string') {
    res.status(400).json({ error: "'display_name' must be a string or null" });
    return;
  }
  try {
    const upstream = await fetch(`${DUCKDB_URL}/modules/${encodeURIComponent(id)}/display_name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: req.body.display_name }),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[PATCH /api/modules/:id/name]', { id, error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Bucketed image-upload activity for the homepage weather-correlation
// chart. Proxies duckdb-service `/modules/:id/activity_timeseries`
// (snake_case wire) and maps to the camelCase `ActivityTimeSeries`
// shape pinned in `@highfive/contracts`. Forwards `interval` and `days`
// verbatim; upstream owns validation so we surface 400/404 unchanged.
//
// No admin gate — the dashboard chart is part of the regular view, and
// reads are public (#142). No credential required.
app.get('/api/modules/:id/activity', async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  const params = new URLSearchParams();
  if (typeof req.query.interval === 'string') params.set('interval', req.query.interval);
  if (typeof req.query.days === 'string') params.set('days', req.query.days);
  const qs = params.toString();
  const url = `${DUCKDB_URL}/modules/${encodeURIComponent(id)}/activity_timeseries${
    qs ? `?${qs}` : ''
  }`;
  try {
    const upstream = await fetch(url);
    // Check `upstream.ok` BEFORE parsing JSON. duckdb-service wraps its
    // errors as JSON today (and the activity_timeseries route does so
    // explicitly), but other Flask routes can serve the default HTML
    // 500 page on uncaught exceptions — see `routes/modules.py`'s
    // `get_modules` wrapper comment. Trying to `.json()` an HTML body
    // throws and we'd return 502 instead of bubbling the real upstream
    // status. Defence-in-depth, not a hard requirement today.
    if (!upstream.ok) {
      const errBody = (await upstream.json().catch(() => ({
        error: `upstream returned ${upstream.status}`,
      }))) as Record<string, unknown>;
      res.status(upstream.status).json(errBody);
      return;
    }
    const body = (await upstream.json()) as Record<string, unknown>;
    // snake_case → camelCase mapping. Only `module_id` differs from
    // the wire JSON; `buckets` entries (`timestamp`, `count`) and the
    // ISO `start` / `end` strings carry through unchanged.
    res.json({
      moduleId: body.module_id,
      interval: body.interval,
      start: body.start,
      end: body.end,
      buckets: body.buckets,
    });
  } catch (error) {
    console.error('[GET /api/modules/:id/activity]', { id, error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Per-nest hole-detection snips for the public dashboard grid (#165).
// Proxies duckdb-service `GET /detections?module_id=` and maps the snake_case
// rows to the camelCase `NestSnip` contract. No admin gate — snips are public
// by design (the crop removes all background; reads are public per #142).
const SNIP_BEE_TYPES = ['blackmasked', 'resin', 'leafcutter', 'orchard'] as const;
type SnipBeeType = (typeof SNIP_BEE_TYPES)[number];
// `undetermined` is the localize-only state the learned detector emits (ADR-027);
// `empty`/`sealed` remain for a future classifier. Mirror duckdb-service
// `routes/detections.py::_VALID_STATES` and the `NestSnip.state` contract union.
const SNIP_STATES = ['empty', 'sealed', 'undetermined'] as const;
type SnipState = (typeof SNIP_STATES)[number];

interface ApiDetection {
  bee_type: string;
  nest_index: number;
  state: string;
  confidence: number;
  bbox: [number, number, number, number];
  snip_filename: string;
  filename: string;
  detected_at: string;
}

// Validate each row's shape AND the bee-type/state enums, dropping anything
// malformed rather than forwarding a drifted shape typed as valid (CLAUDE.md
// wire-shape rule). A bad row becomes "no snip", never a `{beeType: undefined}`
// reaching the UI. Shared by the grid (`/snips`) and time-lapse
// (`/snips/history`) reads so both folds map the duckdb shape identically.
const isValidDetection = (d: ApiDetection): boolean =>
  d != null &&
  (SNIP_BEE_TYPES as readonly string[]).includes(d.bee_type) &&
  (SNIP_STATES as readonly string[]).includes(d.state) &&
  typeof d.snip_filename === 'string' &&
  typeof d.nest_index === 'number' &&
  typeof d.confidence === 'number' &&
  Array.isArray(d.bbox) &&
  d.bbox.length === 4;

// Annotate against the contract so the camelCase mapping is checked at compile
// time on the producer side too (ADR-004), not just the consumer's.
const toNestSnips = (raw: ApiDetection[]): NestSnip[] =>
  raw.filter(isValidDetection).map((d) => ({
    beeType: d.bee_type as SnipBeeType,
    nestIndex: d.nest_index,
    state: d.state as SnipState,
    confidence: d.confidence,
    snipFilename: d.snip_filename,
    bbox: d.bbox,
    sourceFilename: d.filename,
    detectedAt: d.detected_at,
  }));

app.get('/api/modules/:id/snips', async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    const upstream = await fetch(`${DUCKDB_URL}/detections?module_id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      const errBody = (await upstream.json().catch(() => ({
        error: `upstream returned ${upstream.status}`,
      }))) as Record<string, unknown>;
      res.status(upstream.status).json(errBody);
      return;
    }
    const body = (await upstream.json()) as { detections?: unknown };
    const raw = Array.isArray(body.detections) ? (body.detections as ApiDetection[]) : [];
    const payload: NestSnipsResponse = { snips: toNestSnips(raw) };
    res.json(payload);
  } catch (error) {
    console.error('[GET /api/modules/:id/snips]', { id, error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Global per-module time-lapse: every nest of every capture (#166 phase 3).
// Proxies duckdb-service `GET /detections/history` and maps to `NestSnip[]`
// (oldest first) so the UI can group by capture and scrub all holes across days
// with one slider. Public like `/snips`.
app.get('/api/modules/:id/snips/history', async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    const qs = new URLSearchParams({ module_id: id });
    const upstream = await fetch(`${DUCKDB_URL}/detections/history?${qs.toString()}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      const errBody = (await upstream.json().catch(() => ({
        error: `upstream returned ${upstream.status}`,
      }))) as Record<string, unknown>;
      res.status(upstream.status).json(errBody);
      return;
    }
    const body = (await upstream.json()) as { detections?: unknown };
    const raw = Array.isArray(body.detections) ? (body.detections as ApiDetection[]) : [];
    const payload: NestSnipHistoryResponse = { snips: toNestSnips(raw) };
    res.json(payload);
  } catch (error) {
    console.error('[GET /api/modules/:id/snips/history]', {
      id,
      error: String(error),
    });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Bucketed per-module measurements time series (issue #110). Mirrors
// the activity-timeseries proxy above: pre-checks `upstream.ok`, maps
// snake_case → camelCase. No credential required — this is dashboard
// data and reads are public (#142).
//
// Pass-through query params: `metric` (required upstream),
// `interval`, `days`. Upstream owns the actual validation; we
// forward 400 / 404 verbatim so the user-facing error reflects the
// real reason rather than a generic 502.
app.get('/api/modules/:id/measurements', async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  const params = new URLSearchParams();
  if (typeof req.query.metric === 'string') params.set('metric', req.query.metric);
  if (typeof req.query.interval === 'string') params.set('interval', req.query.interval);
  if (typeof req.query.days === 'string') params.set('days', req.query.days);
  const qs = params.toString();
  const url = `${DUCKDB_URL}/modules/${encodeURIComponent(id)}/measurements${qs ? `?${qs}` : ''}`;
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      const errBody = (await upstream.json().catch(() => ({
        error: `upstream returned ${upstream.status}`,
      }))) as Record<string, unknown>;
      res.status(upstream.status).json(errBody);
      return;
    }
    const body = (await upstream.json()) as Record<string, unknown>;
    // snake_case → camelCase mapping. The only key that differs from
    // the wire JSON is `module_id`; `metric`, `interval`, `start`,
    // `end`, and the `buckets` entries (`timestamp`, `value`,
    // `sample_count`) carry through unchanged in name… except for
    // `sample_count`, which we rename to `sampleCount` so the
    // `MeasurementBucket` contract in `@highfive/contracts` matches.
    const rawBuckets = Array.isArray(body.buckets)
      ? (body.buckets as Array<Record<string, unknown>>)
      : [];
    res.json({
      moduleId: body.module_id,
      metric: body.metric,
      interval: body.interval,
      start: body.start,
      end: body.end,
      buckets: rawBuckets.map((b) => ({
        timestamp: b.timestamp,
        value: b.value,
        sampleCount: b.sample_count,
      })),
    });
  } catch (error) {
    console.error('[GET /api/modules/:id/measurements]', { id, error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Admin-only: append one or more measurements. Used by external
// producers (the future weather worker for #111, the classifier for
// #114) to push samples into the canonical store. The heartbeat dual-
// write at `duckdb-service/routes/heartbeats.py` writes directly to
// the DB without going through this proxy because it's in-cluster.
//
// Gated by `requireAdmin` (session cookie OR X-Admin-Key machine
// credential), like the `/logs`, `/name`, and `/weather/backfill` routes.
app.post('/api/modules/:id/measurements', requireAdmin, async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'body must be a JSON object' });
    return;
  }
  // Force the path id onto each item before forwarding — the path is
  // the authority, not the body. This mirrors REST conventions and
  // means a typo in the body can't smuggle a sample onto a different
  // module.
  const body = req.body as Record<string, unknown>;
  let forward: unknown;
  if (Array.isArray(body.measurements)) {
    forward = {
      measurements: body.measurements.map((m) =>
        typeof m === 'object' && m !== null
          ? { ...(m as Record<string, unknown>), module_mac: id }
          : m,
      ),
    };
  } else {
    forward = { ...body, module_mac: id };
  }
  try {
    const upstream = await fetch(`${DUCKDB_URL}/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forward),
    });
    const data = await upstream.json().catch(() => ({
      error: `upstream returned ${upstream.status}`,
    }));
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[POST /api/modules/:id/measurements]', { id, error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Admin-only: trigger the one-shot historical weather backfill (issue
// #111, ADR-017). Gated by `requireAdmin` (session cookie OR X-Admin-Key
// machine credential), like the other admin endpoints in this file.
//
// Forwards `days` (optional integer) to the duckdb-service handler,
// which itself owns the range validation (>= 1, <= 36500) and the
// per-module fetch logic. Response shape is the partial-success
// envelope `{modules_touched, rows_written, errors[]}` — see
// `docs/api-reference.md` §1.8.
app.post('/api/admin/weather/backfill', requireAdmin, async (req, res) => {
  const params = new URLSearchParams();
  if (typeof req.query.days === 'string') params.set('days', req.query.days);
  const qs = params.toString();
  const url = `${DUCKDB_URL}/admin/weather/backfill${qs ? `?${qs}` : ''}`;
  try {
    const upstream = await fetch(url, { method: 'POST' });
    const data = await upstream.json().catch(() => ({
      error: `upstream returned ${upstream.status}`,
    }));
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[POST /api/admin/weather/backfill]', { error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Admin-only: telemetry sidecar logs. Gated by `requireAdmin` (session
// cookie OR X-Admin-Key machine credential — see session.ts / ADR-019).
app.get('/api/modules/:id/logs', requireAdmin, async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    const limit = req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : '';
    const url = `${IMAGE_SERVICE_URL}/modules/${encodeURIComponent(id)}/logs${limit}`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Failed to fetch module logs' });
      return;
    }
    const payload = await upstream.json();
    res.json(payload);
  } catch (error) {
    console.error('[GET /api/modules/:id/logs]', { id, error: String(error) });
    res.status(502).json({ error: 'image-service unreachable' });
  }
});

// snake_case wire shape from duckdb-service `GET /heartbeats/:id/gaps`,
// camelCased into the `HeartbeatGap` contract by the route below.
interface ApiHeartbeatGap {
  gap_start: string;
  gap_end: string;
  gap_seconds: number;
}

// Admin-only: derived heartbeat-gap timeline for a module (#172, option 3).
// Gated by `requireAdmin` (session cookie OR X-Admin-Key — like the sibling
// /logs route). Proxies duckdb-service `GET /heartbeats/:id/gaps`, forwarding
// the machine credential. Read-only; the upstream derives gaps from the
// existing heartbeat timeline (no schema/writer — see ADR-005).
app.get('/api/modules/:id/heartbeat-gaps', requireAdmin, async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    const limit = req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : '';
    const url = `${DUCKDB_URL}/heartbeats/${encodeURIComponent(id)}/gaps${limit}`;
    const upstream = await fetch(url, { headers: { 'X-Admin-Key': getApiKey() } });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Failed to fetch heartbeat gaps' });
      return;
    }
    const payload = (await upstream.json()) as { module_id?: string; gaps?: unknown };
    // Map the snake_case upstream shape to the camelCase HeartbeatGap contract.
    // Don't forward a drifted shape typed as valid (CLAUDE.md wire-shape rule):
    // validate the array AND each element's fields, so a `[{}]` from upstream
    // surfaces as a 502 rather than reaching the UI as `{gapStart: undefined}`.
    const isGap = (g: unknown): g is ApiHeartbeatGap =>
      typeof g === 'object' &&
      g !== null &&
      typeof (g as ApiHeartbeatGap).gap_start === 'string' &&
      typeof (g as ApiHeartbeatGap).gap_end === 'string' &&
      typeof (g as ApiHeartbeatGap).gap_seconds === 'number';
    if (!payload || !Array.isArray(payload.gaps) || !payload.gaps.every(isGap)) {
      res.status(502).json({ error: 'malformed heartbeat-gaps response' });
      return;
    }
    const gaps: HeartbeatGap[] = (payload.gaps as ApiHeartbeatGap[]).map((g) => ({
      gapStart: g.gap_start,
      gapEnd: g.gap_end,
      gapSeconds: g.gap_seconds,
    }));
    res.json({ gaps });
  } catch (error) {
    console.error('[GET /api/modules/:id/heartbeat-gaps]', { id, error: String(error) });
    res.status(502).json({ error: 'duckdb-service unreachable' });
  }
});

// Admin-only: tail of a server process's own recent stdout/stderr (#171).
// Gated by `requireAdmin` (session cookie OR X-Admin-Key — like
// /api/admin/weather/backfill). The backend serves its own in-memory ring
// directly (logRing.ts); the two Flask services expose an internal `/logs`
// we proxy to, forwarding the machine credential so their published dev ports
// (duckdb :8002, image :8000) can't leak logs. `nginx` is not a valid service
// here — it has no app ring (host/file concern, out of scope). See ADR-021.
const LOG_SERVICES = ['backend', 'duckdb-service', 'image-service'] as const;
const LOG_LINES_CAP = 1000;
const LOG_LINES_DEFAULT = 200;

app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  const service = String(req.query.service ?? '');
  if (!(LOG_SERVICES as readonly string[]).includes(service)) {
    res.status(400).json({
      error: `invalid service; expected one of: ${LOG_SERVICES.join(', ')}`,
    });
    return;
  }

  // Clamp lines to [1, cap]; a missing/non-numeric value takes the default.
  const rawLines = Number(req.query.lines);
  const lines = Number.isFinite(rawLines)
    ? Math.max(1, Math.min(Math.floor(rawLines), LOG_LINES_CAP))
    : LOG_LINES_DEFAULT;

  if (service === 'backend') {
    const { entries, truncated } = getRecentEntries(lines);
    const payload: ServerLogsResponse = { service: 'backend', entries, truncated };
    res.json(payload);
    return;
  }

  // Proxy to the named Flask service's internal /logs, forwarding the machine
  // credential. DUCKDB_URL / IMAGE_SERVICE_URL are the same internal bases the
  // other proxy routes use.
  const base = service === 'duckdb-service' ? DUCKDB_URL : IMAGE_SERVICE_URL;
  try {
    const upstream = await fetch(`${base}/logs?lines=${lines}`, {
      headers: { 'X-Admin-Key': getApiKey() },
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Failed to fetch ${service} logs` });
      return;
    }
    const payload = (await upstream.json()) as ServerLogsResponse;
    // Don't forward a drifted wire shape typed as valid: a service that
    // changed its /logs envelope should surface as a clear 502, not as
    // `undefined` fields reaching the UI.
    if (
      !payload ||
      typeof payload.service !== 'string' ||
      !Array.isArray(payload.entries) ||
      typeof payload.truncated !== 'boolean'
    ) {
      res.status(502).json({ error: `malformed logs response from ${service}` });
      return;
    }
    res.json(payload);
  } catch (error) {
    console.error('[GET /api/admin/logs]', { service, error: String(error) });
    res.status(502).json({ error: `${service} unreachable` });
  }
});

// SSE live tail (#178 Phase 4). One `LogEntry` JSON per `data:` event. The panel
// fetches GET /api/admin/logs once for backfill, then opens this for live tail.
// `backend` streams its own ring; the two Flask services are piped from their
// internal `/logs/stream` (X-Admin-Key forwarded). See ADR-023 / logStream.ts.
app.get('/api/admin/logs/stream', requireAdmin, async (req, res) => {
  const service = String(req.query.service ?? '');
  if (!(LOG_SERVICES as readonly string[]).includes(service)) {
    res.status(400).json({
      error: `invalid service; expected one of: ${LOG_SERVICES.join(', ')}`,
    });
    return;
  }

  if (service === 'backend') {
    writeSseHeaders(res);
    const cleanup = streamBackendRing(res);
    req.on('close', cleanup);
    return;
  }

  // Proxy the Flask service's SSE stream. Connect FIRST so a failure still
  // surfaces as 502 before we commit to a 200 event-stream response.
  const base = service === 'duckdb-service' ? DUCKDB_URL : IMAGE_SERVICE_URL;
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  try {
    const upstream = await fetch(`${base}/logs/stream`, {
      headers: { 'X-Admin-Key': getApiKey() },
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `Failed to open ${service} log stream` });
      return;
    }
    writeSseHeaders(res);
    // Pipe the upstream SSE bytes straight through (Flask emits the same
    // `data:`/keepalive framing and its own keepalives). Use `pipeline`, not a
    // bare `.pipe()`: on client disconnect `controller.abort()` makes the
    // source emit an AbortError, and an unhandled stream 'error' would crash
    // the process — pipeline routes it to the callback and destroys both ends.
    pipeline(
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]),
      res,
      (err) => {
        // Abort on client disconnect is the normal teardown path, not an error.
        if (err && !controller.signal.aborted) {
          console.error('[GET /api/admin/logs/stream] pipe', { service, error: String(err) });
        }
      },
    );
  } catch (error) {
    if (controller.signal.aborted) return; // client went away mid-connect
    console.error('[GET /api/admin/logs/stream]', { service, error: String(error) });
    if (!res.headersSent) res.status(502).json({ error: `${service} unreachable` });
    else res.end();
  }
});
