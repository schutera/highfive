import request from 'supertest';
import { app } from '../app';
import { db } from '../database';

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('GET /api/modules', () => {
    it('should return all modules', async () => {
      const response = await request(app)
        .get('/api/modules')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      
      // Verify module structure
      const module = response.body[0];
      expect(module).toHaveProperty('id');
      expect(module).toHaveProperty('name');
      expect(module).toHaveProperty('location');
      expect(module).toHaveProperty('status');
      expect(module).toHaveProperty('batteryLevel');
      expect(module).toHaveProperty('lastApiCall');
      expect(module).toHaveProperty('firstOnline');
    });

    it('should return modules with valid coordinates', async () => {
      const response = await request(app)
        .get('/api/modules')
        .expect(200);

      response.body.forEach((module: any) => {
        expect(module.location).toHaveProperty('lat');
        expect(module.location).toHaveProperty('lng');
        expect(typeof module.location.lat).toBe('number');
        expect(typeof module.location.lng).toBe('number');
        expect(module.location.lat).toBeGreaterThan(-90);
        expect(module.location.lat).toBeLessThan(90);
        expect(module.location.lng).toBeGreaterThan(-180);
        expect(module.location.lng).toBeLessThan(180);
      });
    });

    it('should return modules with valid status', async () => {
      const response = await request(app)
        .get('/api/modules')
        .expect(200);

      response.body.forEach((module: any) => {
        expect(['online', 'offline']).toContain(module.status);
      });
    });
  });

  describe('GET /api/modules/:id', () => {
    it('should return module details for valid id', async () => {
      const modules = db.getAllModules();
      const testModule = modules[0];

      const response = await request(app)
        .get(`/api/modules/${testModule.id}`)
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('id', testModule.id);
      expect(response.body).toHaveProperty('name');
      expect(response.body).toHaveProperty('nests');
      expect(Array.isArray(response.body.nests)).toBe(true);
      expect(response.body.nests.length).toBeGreaterThan(0);
    });

    it('should return nest data with correct structure', async () => {
      const modules = db.getAllModules();
      const testModule = modules[0];

      const response = await request(app)
        .get(`/api/modules/${testModule.id}`)
        .expect(200);

      const nest = response.body.nests[0];
      expect(nest).toHaveProperty('nestId');
      expect(nest).toHaveProperty('beeType');
      expect(nest).toHaveProperty('dailyProgress');
      expect(Array.isArray(nest.dailyProgress)).toBe(true);
    });

    it('should return 404 for non-existent module', async () => {
      const response = await request(app)
        .get('/api/modules/non-existent-id')
        .expect(404)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('error', 'Module not found');
    });

    it('should return daily progress data for each nest', async () => {
      const modules = db.getAllModules();
      const testModule = modules[0];

      const response = await request(app)
        .get(`/api/modules/${testModule.id}`)
        .expect(200);

      response.body.nests.forEach((nest: any) => {
        expect(nest.dailyProgress.length).toBeGreaterThan(0);
        
        const progress = nest.dailyProgress[0];
        expect(progress).toHaveProperty('date');
        expect(progress).toHaveProperty('empty');
        expect(progress).toHaveProperty('sealed');
        expect(progress).toHaveProperty('hatched');
        expect(typeof progress.hatched).toBe('number');
        expect(progress.hatched).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('PATCH /api/modules/:id/status', () => {
    it('should update module status to online', async () => {
      const modules = db.getAllModules();
      const testModule = modules[0];

      const response = await request(app)
        .patch(`/api/modules/${testModule.id}/status`)
        .send({ status: 'online' })
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('message', 'Status updated successfully');

      // Verify the status was actually updated
      const updatedModule = db.getModuleById(testModule.id);
      expect(updatedModule?.status).toBe('online');
    });

    it('should update module status to offline', async () => {
      const modules = db.getAllModules();
      const testModule = modules[1];

      const response = await request(app)
        .patch(`/api/modules/${testModule.id}/status`)
        .send({ status: 'offline' })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Status updated successfully');

      // Verify the status was actually updated
      const updatedModule = db.getModuleById(testModule.id);
      expect(updatedModule?.status).toBe('offline');
    });

    it('should return 400 for invalid status', async () => {
      const modules = db.getAllModules();
      const testModule = modules[0];

      const response = await request(app)
        .patch(`/api/modules/${testModule.id}/status`)
        .send({ status: 'invalid-status' })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Invalid status. Must be "online" or "offline"');
    });

    it('should return 404 for non-existent module', async () => {
      const response = await request(app)
        .patch('/api/modules/non-existent-id/status')
        .send({ status: 'online' })
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Module not found');
    });

    it('should handle missing status in request body', async () => {
      const modules = db.getAllModules();
      const testModule = modules[0];

      const response = await request(app)
        .patch(`/api/modules/${testModule.id}/status`)
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Swagger Documentation', () => {
    it('should serve Swagger JSON spec', async () => {
      const response = await request(app)
        .get('/api-docs.json')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('openapi');
      expect(response.body).toHaveProperty('info');
      expect(response.body).toHaveProperty('paths');
      expect(response.body.paths).toHaveProperty('/api/modules');
      expect(response.body.paths).toHaveProperty('/api/modules/{id}');
      expect(response.body.paths).toHaveProperty('/api/modules/{id}/status');
      expect(response.body.paths).toHaveProperty('/api/health');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for undefined routes', async () => {
      await request(app)
        .get('/api/undefined-route')
        .expect(404);
    });

    it('should handle database errors when getting all modules', async () => {
      // Mock the database to throw an error
      const originalGetAllModules = db.getAllModules;
      db.getAllModules = jest.fn().mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const response = await request(app)
        .get('/api/modules')
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to fetch modules');

      // Restore original function
      db.getAllModules = originalGetAllModules;
    });

    it('should handle database errors when getting module by id', async () => {
      // Mock the database to throw an error
      const originalGetModuleById = db.getModuleById;
      db.getModuleById = jest.fn().mockImplementation(() => {
        throw new Error('Database query failed');
      });

      const response = await request(app)
        .get('/api/modules/hive-001')
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to fetch module details');

      // Restore original function
      db.getModuleById = originalGetModuleById;
    });

    it('should handle database errors when updating module status', async () => {
      // Mock the database to throw an error
      const originalUpdateModuleStatus = db.updateModuleStatus;
      db.updateModuleStatus = jest.fn().mockImplementation(() => {
        throw new Error('Database update failed');
      });

      const response = await request(app)
        .patch('/api/modules/hive-001/status')
        .send({ status: 'online' })
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to update module status');

      // Restore original function
      db.updateModuleStatus = originalUpdateModuleStatus;
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const response = await request(app)
        .get('/api/modules')
        .expect(200);

      expect(response.headers).toHaveProperty('access-control-allow-origin');
    });
  });
});
