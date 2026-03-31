import express from 'express';
import cors from 'cors';
import { db } from './database';
import { setupSwagger } from './swagger';
import { apiKeyAuth } from './auth';
import { DUCKDB_URL } from './duckdbClient';

const IMAGE_SERVICE_URL = process.env.IMAGE_SERVICE_URL ?? 'http://127.0.0.1:4444';

export const app = express();

// Middleware - Configure CORS for production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? 'https://highfive.schutera.com'
    : '*',
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Setup Swagger documentation (public, no auth required)
setupSwagger(app);

// Health check (public, no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve images without auth — <img> tags cannot send custom headers
app.get('/api/images/:filename', async (req, res) => {
  try {
    const response = await fetch(`${IMAGE_SERVICE_URL}/images/${encodeURIComponent(req.params.filename)}`);
    if (!response.ok) {
      res.status(response.status).json({ error: 'Image not found' });
      return;
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch image from image service' });
  }
});

// Apply API key authentication to all other /api routes
app.use('/api', apiKeyAuth);

// API Routes (protected)

app.get('/api/modules', async (req, res) => {
  try {
    await db.refresh();
    const modules = db.getAllModules();
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

app.get('/api/modules/:id', async (req, res) => {
  try {
    await db.refresh();
    const module = db.getModuleById(req.params.id);
    if (module) {
      res.json(module);
    } else {
      res.status(404).json({ error: 'Module not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch module details' });
  }
});

// Image routes (proxied to image-service)

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
    res.status(502).json({ error: 'Failed to fetch images from image service' });
  }
});

app.delete('/api/images/:filename', async (req, res) => {
  try {
    const response = await fetch(`${IMAGE_SERVICE_URL}/images/${encodeURIComponent(req.params.filename)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to delete image' });
  }
});

app.delete('/api/modules/:id', async (req, res) => {
  try {
    const response = await fetch(`${DUCKDB_URL}/modules/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (response.ok) await db.refresh();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to delete module' });
  }
});

app.patch('/api/modules/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 'online' && status !== 'offline') {
      res.status(400).json({ error: 'Invalid status. Must be "online" or "offline"' });
      return;
    }
    const success = db.updateModuleStatus(req.params.id, status);
    await db.refresh();
    if (success) {
      res.json({ message: 'Status updated successfully' });
    } else {
      res.status(404).json({ error: 'Module not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to update module status' });
  }
});
