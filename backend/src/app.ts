import express from 'express';
import cors from 'cors';
import { db } from './database';

export const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes

app.get('/api/modules', (req, res) => {
  try {
    const modules = db.getAllModules();
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

app.get('/api/modules/:id', (req, res) => {
  try {
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

app.patch('/api/modules/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 'online' && status !== 'offline') {
      res.status(400).json({ error: 'Invalid status. Must be "online" or "offline"' });
      return;
    }
    
    const success = db.updateModuleStatus(req.params.id, status);
    if (success) {
      res.json({ message: 'Status updated successfully' });
    } else {
      res.status(404).json({ error: 'Module not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to update module status' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
