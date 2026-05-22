import express from 'express';
import cors from 'cors';
import { tryParseModuleId } from '@highfive/contracts';
import { db } from './database';
import { apiKeyAuth, verifyApiKey } from './auth';
import { DUCKDB_URL } from './duckdbClient';
import { isProduction } from './env';
import { lookupUserLocation } from './userLocation';

const IMAGE_SERVICE_URL = process.env.IMAGE_SERVICE_URL ?? 'http://image-service:4444';

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
const corsOptions = {
  origin: isProduction() ? 'https://highfive.schutera.com' : '*',
  credentials: true,
  optionsSuccessStatus: 200,
  exposedHeaders: ['X-Highfive-Data-Incomplete'],
};

app.use(cors(corsOptions));
app.use(express.json());

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

// Apply API key authentication to all other /api routes
app.use('/api', apiKeyAuth);

// API Routes (protected)

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

// Image listing (proxied to image-service)
app.get('/api/images', async (req, res) => {
  try {
    const moduleId = req.query.module_id;
    const url = moduleId
      ? `${IMAGE_SERVICE_URL}/images?module_id=${encodeURIComponent(String(moduleId))}`
      : `${IMAGE_SERVICE_URL}/images`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image service error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[GET /api/images]', {
      moduleId: req.query.module_id,
      error: String(error),
    });
    res.status(502).json({ error: 'Failed to fetch images from image service' });
  }
});

app.delete('/api/images/:filename', async (req, res) => {
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

app.delete('/api/modules/:id', async (req, res) => {
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
// for a module. Layered on top of the existing X-API-Key middleware;
// requires an additional X-Admin-Key matching HIGHFIVE_API_KEY (mirrors
// the /logs gate below). Proxies to duckdb-service's PATCH endpoint
// which enforces the UNIQUE constraint and surfaces 409 on collision —
// we forward both status and body so the homepage can render the
// inline error with the conflicting MAC. See ADR-011 and issue #93.
app.patch('/api/modules/:id/name', async (req, res) => {
  const provided = req.header('X-Admin-Key');
  if (!provided || !verifyApiKey(provided)) {
    res.status(403).json({ error: 'Forbidden: admin key required' });
    return;
  }
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
// No admin gate — the dashboard chart is part of the regular view, so
// only the standard X-API-Key middleware (applied at /api above) runs.
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

// Bucketed per-module measurements time series (issue #110). Mirrors
// the activity-timeseries proxy above: pre-checks `upstream.ok`, maps
// snake_case → camelCase, and gates on the standard X-API-Key
// middleware (this is dashboard data, not admin data — production
// /api/modules/:id is publicly readable with the API key).
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
// X-Admin-Key gate mirrors the `/logs` and `/name` admin routes
// below — the standard /api X-API-Key middleware is necessary but
// not sufficient.
app.post('/api/modules/:id/measurements', async (req, res) => {
  const provided = req.header('X-Admin-Key');
  if (!provided || !verifyApiKey(provided)) {
    res.status(403).json({ error: 'Forbidden: admin key required' });
    return;
  }
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
// #111, ADR-017). Layered on top of the standard X-API-Key middleware
// — needs an additional X-Admin-Key matching HIGHFIVE_API_KEY, like
// the other /api admin endpoints in this file.
//
// Forwards `days` (optional integer) to the duckdb-service handler,
// which itself owns the range validation (>= 1, <= 36500) and the
// per-module fetch logic. Response shape is the partial-success
// envelope `{modules_touched, rows_written, errors[]}` — see
// `docs/api-reference.md` §1.8.
app.post('/api/admin/weather/backfill', async (req, res) => {
  const provided = req.header('X-Admin-Key');
  if (!provided || !verifyApiKey(provided)) {
    res.status(403).json({ error: 'Forbidden: admin key required' });
    return;
  }
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

// Admin-only: telemetry sidecar logs. Layered on top of the existing X-API-Key
// middleware. Requires an additional X-Admin-Key header matching HIGHFIVE_API_KEY.
app.get('/api/modules/:id/logs', async (req, res) => {
  const provided = req.header('X-Admin-Key');
  if (!provided || !verifyApiKey(provided)) {
    res.status(403).json({ error: 'Forbidden: admin key required' });
    return;
  }
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
