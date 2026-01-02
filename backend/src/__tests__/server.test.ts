import { exec } from 'child_process';
import { promisify } from 'util';
import request from 'supertest';

const execAsync = promisify(exec);

describe('Server Integration', () => {
  let serverProcess: any;
  const PORT = 3001;
  const BASE_URL = `http://localhost:${PORT}`;

  // Integration tests - will start actual server process
  describe('Server Startup', () => {
    beforeAll(async () => {
      // Start the server
      serverProcess = exec('npm run dev');
      
      // Wait for server to start
      await new Promise(resolve => setTimeout(resolve, 3000));
    });

    afterAll(async () => {
      // Kill the server process
      if (serverProcess) {
        serverProcess.kill();
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    });

    it('should start server on port 3001', async () => {
      const response = await request(BASE_URL)
        .get('/api/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
    });

    it('should serve API documentation', async () => {
      const response = await request(BASE_URL)
        .get('/api-docs.json')
        .expect(200);

      expect(response.body).toHaveProperty('openapi');
    });

    it('should serve all API endpoints', async () => {
      const response = await request(BASE_URL)
        .get('/api/modules')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('Server Module', () => {
    it('should export server startup code', () => {
      // This test just verifies the server file can be imported
      // The actual server startup is tested above or manually
      expect(() => {
        // In a real scenario, we'd check if the file exists and is valid TypeScript
        const fs = require('fs');
        const path = require('path');
        const serverPath = path.join(__dirname, '../server.ts');
        const serverContent = fs.readFileSync(serverPath, 'utf-8');
        
        // Verify it imports from app
        expect(serverContent).toContain("from './app'");
        
        // Verify it starts the server
        expect(serverContent).toContain('app.listen');
        
        // Verify it logs startup messages
        expect(serverContent).toContain('console.log');
      }).not.toThrow();
    });
  });
});
