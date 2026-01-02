import { db } from '../database';

describe('Database', () => {
  describe('getAllModules', () => {
    it('should return an array of modules', () => {
      const modules = db.getAllModules();
      
      expect(Array.isArray(modules)).toBe(true);
      expect(modules.length).toBeGreaterThan(0);
    });

    it('should return modules with required properties', () => {
      const modules = db.getAllModules();
      
      modules.forEach(module => {
        expect(module).toHaveProperty('id');
        expect(module).toHaveProperty('name');
        expect(module).toHaveProperty('location');
        expect(module).toHaveProperty('status');
        expect(module).toHaveProperty('batteryLevel');
        expect(module).toHaveProperty('lastApiCall');
        expect(module).toHaveProperty('firstOnline');
        
        expect(typeof module.id).toBe('string');
        expect(typeof module.name).toBe('string');
        expect(typeof module.location).toBe('object');
        expect(['online', 'offline']).toContain(module.status);
        expect(typeof module.batteryLevel).toBe('number');
        expect(typeof module.lastApiCall).toBe('string');
        expect(typeof module.firstOnline).toBe('string');
      });
    });

    it('should return modules with valid battery levels', () => {
      const modules = db.getAllModules();
      
      modules.forEach(module => {
        expect(module.batteryLevel).toBeGreaterThanOrEqual(0);
        expect(module.batteryLevel).toBeLessThanOrEqual(100);
      });
    });

    it('should return modules with German names', () => {
      const modules = db.getAllModules();
      const germanNames = ['Klostergarten', 'Wiesengrund', 'Waldrand', 'Schussental', 'Bergblick'];
      
      modules.forEach(module => {
        expect(germanNames).toContain(module.name);
      });
    });

    it('should return modules with Weingarten/Ravensburg coordinates', () => {
      const modules = db.getAllModules();
      
      // Coordinates should be around Weingarten/Ravensburg area
      // Lat: ~47.78-47.81, Lng: ~9.61-9.65
      modules.forEach(module => {
        expect(module.location.lat).toBeGreaterThan(47.7);
        expect(module.location.lat).toBeLessThan(47.9);
        expect(module.location.lng).toBeGreaterThan(9.5);
        expect(module.location.lng).toBeLessThan(9.7);
      });
    });
  });

  describe('getModuleById', () => {
    it('should return module details for valid id', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      
      expect(module).toBeDefined();
      expect(module?.id).toBe(testId);
      expect(module).toHaveProperty('nests');
      expect(Array.isArray(module?.nests)).toBe(true);
    });

    it('should return null for non-existent id', () => {
      const module = db.getModuleById('non-existent-id');
      
      expect(module).toBeNull();
    });

    it('should return module with 12 nests', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      
      expect(module?.nests.length).toBe(12);
    });

    it('should return nests with correct structure', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      
      module?.nests.forEach(nest => {
        expect(nest).toHaveProperty('nestId');
        expect(nest).toHaveProperty('beeType');
        expect(nest).toHaveProperty('dailyProgress');
        
        expect(['blackmasked', 'resin', 'leafcutter', 'orchard']).toContain(nest.beeType);
        expect(Array.isArray(nest.dailyProgress)).toBe(true);
      });
    });

    it('should return nests for all 4 bee types', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      const beeTypes = module?.nests.map(nest => nest.beeType) || [];
      
      expect(beeTypes).toContain('blackmasked');
      expect(beeTypes).toContain('resin');
      expect(beeTypes).toContain('leafcutter');
      expect(beeTypes).toContain('orchard');
    });

    it('should have 3 nests per bee type', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      const beeTypeCounts = module?.nests.reduce((acc, nest) => {
        acc[nest.beeType] = (acc[nest.beeType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      expect(beeTypeCounts?.['blackmasked']).toBe(3);
      expect(beeTypeCounts?.['resin']).toBe(3);
      expect(beeTypeCounts?.['leafcutter']).toBe(3);
      expect(beeTypeCounts?.['orchard']).toBe(3);
    });

    it('should return daily progress data for each nest', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      
      module?.nests.forEach(nest => {
        expect(Array.isArray(nest.dailyProgress)).toBe(true);
        expect(nest.dailyProgress.length).toBeGreaterThan(0);
        
        nest.dailyProgress.forEach(day => {
          expect(day).toHaveProperty('date');
          expect(day).toHaveProperty('empty');
          expect(day).toHaveProperty('sealed');
          expect(day).toHaveProperty('hatched');
          expect(typeof day.date).toBe('string');
          expect(typeof day.empty).toBe('number');
          expect(typeof day.sealed).toBe('number');
          expect(typeof day.hatched).toBe('number');
          expect(day.empty).toBeGreaterThanOrEqual(0);
          expect(day.sealed).toBeGreaterThanOrEqual(0);
          expect(day.hatched).toBeGreaterThanOrEqual(0);
        });
      });
    });

    it('should have valid ISO date strings in dailyProgress', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const module = db.getModuleById(testId);
      
      module?.nests.forEach(nest => {
        nest.dailyProgress.forEach(day => {
          const date = new Date(day.date);
          expect(date).toBeInstanceOf(Date);
          expect(isNaN(date.getTime())).toBe(false);
        });
      });
    });
  });

  describe('updateModuleStatus', () => {
    it('should update module status to online', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const result = db.updateModuleStatus(testId, 'online');
      
      expect(result).toBe(true);
      
      const updatedModule = db.getAllModules().find(m => m.id === testId);
      expect(updatedModule?.status).toBe('online');
    });

    it('should update module status to offline', () => {
      const modules = db.getAllModules();
      const testId = modules[1].id;
      
      const result = db.updateModuleStatus(testId, 'offline');
      
      expect(result).toBe(true);
      
      const updatedModule = db.getAllModules().find(m => m.id === testId);
      expect(updatedModule?.status).toBe('offline');
    });

    it('should return false for non-existent module', () => {
      const result = db.updateModuleStatus('non-existent-id', 'online');
      
      expect(result).toBe(false);
    });

    it('should update lastApiCall timestamp', () => {
      const modules = db.getAllModules();
      const testId = modules[0].id;
      
      const beforeUpdate = new Date(modules[0].lastApiCall);
      
      // Wait a tiny bit to ensure timestamp changes
      setTimeout(() => {
        db.updateModuleStatus(testId, 'online');
        
        const updatedModule = db.getAllModules().find(m => m.id === testId);
        const afterUpdate = new Date(updatedModule!.lastApiCall);
        
        expect(afterUpdate.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
      }, 10);
    });

    it('should maintain other module properties when updating status', () => {
      const modules = db.getAllModules();
      const testModule = modules[0];
      const originalName = testModule.name;
      const originalBattery = testModule.batteryLevel;
      
      db.updateModuleStatus(testModule.id, 'offline');
      
      const updatedModule = db.getAllModules().find(m => m.id === testModule.id);
      expect(updatedModule?.name).toBe(originalName);
      expect(updatedModule?.batteryLevel).toBe(originalBattery);
    });
  });

  describe('Data Consistency', () => {
    it('should have unique module IDs', () => {
      const modules = db.getAllModules();
      const ids = modules.map(m => m.id);
      const uniqueIds = new Set(ids);
      
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have unique nest IDs within each module', () => {
      const modules = db.getAllModules();
      
      modules.forEach(module => {
        const detail = db.getModuleById(module.id);
        const nestIds = detail?.nests.map(n => n.nestId) || [];
        const uniqueNestIds = new Set(nestIds);
        
        expect(uniqueNestIds.size).toBe(nestIds.length);
      });
    });

    it('should have firstOnline dates in the past', () => {
      const modules = db.getAllModules();
      const now = new Date();
      
      modules.forEach(module => {
        const firstOnline = new Date(module.firstOnline);
        expect(firstOnline.getTime()).toBeLessThanOrEqual(now.getTime());
      });
    });
  });
});
