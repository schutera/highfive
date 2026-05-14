import express from 'express';
import cors from 'cors';
import { tryParseModuleId } from '@highfive/contracts';
import { db } from './database';
import { apiKeyAuth, getApiKey } from './auth';
import { DUCKDB_URL } from './duckdbClient';
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
  origin: process.env.NODE_ENV === 'production' ? 'https://highfive.schutera.com' : '*',
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

// Admin-only: telemetry sidecar logs. Layered on top of the existing X-API-Key
// middleware. Requires an additional X-Admin-Key header matching HIGHFIVE_API_KEY.
app.get('/api/modules/:id/logs', async (req, res) => {
  const provided = req.header('X-Admin-Key');
  if (!provided || provided !== getApiKey()) {
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
