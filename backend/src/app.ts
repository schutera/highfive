import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { db } from './database';
import { swaggerSpec } from './swagger';

export const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Swagger documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'HighFive API Docs',
}));

// Swagger JSON
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Routes

/**
 * @openapi
 * /api/modules:
 *   get:
 *     summary: Get all modules
 *     description: Retrieve a list of all bee hive modules with basic information
 *     tags:
 *       - Modules
 *     responses:
 *       200:
 *         description: List of modules
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Module'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/api/modules', (req, res) => {
  try {
    const modules = db.getAllModules();
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

/**
 * @openapi
 * /api/modules/{id}:
 *   get:
 *     summary: Get module details
 *     description: Retrieve detailed information for a specific module including all nest data
 *     tags:
 *       - Modules
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Module ID
 *         example: hive-001
 *     responses:
 *       200:
 *         description: Module details with nest data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ModuleDetail'
 *       404:
 *         description: Module not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

/**
 * @openapi
 * /api/modules/{id}/status:
 *   patch:
 *     summary: Update module status
 *     description: Change the online/offline status of a module
 *     tags:
 *       - Modules
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Module ID
 *         example: hive-001
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateStatusRequest'
 *     responses:
 *       200:
 *         description: Status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessage'
 *       400:
 *         description: Invalid status value
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Module not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

/**
 * @openapi
 * /api/health:
 *   get:
 *     summary: Health check
 *     description: Check if the API server is running
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthCheck'
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
