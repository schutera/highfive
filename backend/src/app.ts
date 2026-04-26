import express from 'express';
import cors from 'cors';
import { tryParseModuleId } from '@highfive/contracts';
import { db } from './database';
import { apiKeyAuth, getApiKey } from './auth';

export const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check (public, no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Apply API key authentication to all other /api routes
app.use('/api', apiKeyAuth);

// API Routes (protected)

app.get('/api/modules', async (req, res) => {
  try {
    const modules = await db.listModules();
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

app.get('/api/modules/:id', async (req, res) => {
  const id = tryParseModuleId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid module id format' });
    return;
  }
  try {
    const module = await db.getModuleDetail(id);
    if (module) {
      res.json(module);
    } else {
      res.status(404).json({ error: 'Module not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch module details' });
  }
});

const IMAGE_SERVICE_URL = process.env.IMAGE_SERVICE_URL || 'http://image-service:4444';

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
    res.status(502).json({ error: 'image-service unreachable' });
  }
});
