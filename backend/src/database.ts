import { Module, ModuleDetail, NestData, DailyProgress } from './types';

// Mock database
export class MockDatabase {
  private modules: Map<string, ModuleDetail>;

  constructor() {
    this.modules = new Map();
    this.initializeData();
  }

  private initializeData() {
    // Create 5 mock modules around Weingarten (88250) and Ravensburg
    const moduleConfigs = [
      { id: 'hive-001', name: 'Klostergarten', lat: 47.8086, lng: 9.6433, status: 'online' as const, firstOnline: '2023-04-15' },
      { id: 'hive-002', name: 'Wiesengrund', lat: 47.8100, lng: 9.6450, status: 'offline' as const, firstOnline: '2023-05-20' },
      { id: 'hive-003', name: 'Waldrand', lat: 47.7819, lng: 9.6107, status: 'online' as const, firstOnline: '2024-03-10' },
      { id: 'hive-004', name: 'Schussental', lat: 47.7850, lng: 9.6200, status: 'online' as const, firstOnline: '2024-06-01' },
      { id: 'hive-005', name: 'Bergblick', lat: 47.8050, lng: 9.6350, status: 'online' as const, firstOnline: '2025-02-14' }
    ];

    moduleConfigs.forEach(config => {
      const isOnline = config.status === 'online';
      const module: ModuleDetail = {
        id: config.id,
        name: config.name,
        location: {
          lat: config.lat,
          lng: config.lng
        },
        status: config.status,
        lastApiCall: isOnline 
          ? new Date(Date.now() - Math.random() * 300000).toISOString() // Last 5 min
          : new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)).toISOString(), // 10 days ago
        batteryLevel: isOnline 
          ? 60 + Math.random() * 40 // 60-100%
          : 10 + Math.random() * 30, // 10-40%
        firstOnline: new Date(config.firstOnline).toISOString(),
        nests: this.generateNestData(config.id)
      };
      this.modules.set(config.id, module);
    });
  }

  private generateNestData(moduleId: string): NestData[] {
    const beeTypes: ('blackmasked' | 'resin' | 'leafcutter' | 'orchard')[] = 
      ['blackmasked', 'resin', 'leafcutter', 'orchard'];
    
    const nests: NestData[] = [];
    let nestId = 1;

    // 3 nests per bee type (12 total)
    beeTypes.forEach(beeType => {
      for (let i = 0; i < 3; i++) {
        nests.push({
          nestId: nestId++,
          beeType,
          dailyProgress: this.generateYearData(moduleId, nestId)
        });
      }
    });

    return nests;
  }

  private generateYearData(moduleId: string, nestId: number): DailyProgress[] {
    const progress: DailyProgress[] = [];
    const startDate = new Date('2025-01-01');
    const endDate = new Date('2026-01-02');
    
    // Seeded random based on moduleId and nestId
    const seed = this.hashCode(moduleId + nestId);
    let random = this.seededRandom(seed);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const month = d.getMonth();
      
      // Simulate annual cycle: activity peaks in spring/summer (Mar-Aug)
      const isActiveSeason = month >= 2 && month <= 7;
      
      if (isActiveSeason) {
        // Active season: gradual progression
        const dayOfSeason = Math.floor((d.getTime() - new Date(d.getFullYear(), 2, 1).getTime()) / (1000 * 60 * 60 * 24));
        const maxDays = 180; // ~6 months
        
        const baseProgress = Math.min(100, (dayOfSeason / maxDays) * 100);
        const sealed = Math.min(100, baseProgress + (random() * 10 - 5));
        const hatched = Math.min(sealed, baseProgress * 0.8 + (random() * 10 - 5));
        const empty = Math.max(0, 100 - sealed);
        
        progress.push({
          date: dateStr,
          empty: Math.round(Math.max(0, empty)),
          sealed: Math.round(Math.max(0, Math.min(100, sealed))),
          hatched: Math.round(Math.max(0, Math.min(sealed, hatched)))
        });
      } else {
        // Dormant season: minimal activity
        progress.push({
          date: dateStr,
          empty: 95 + Math.floor(random() * 5),
          sealed: Math.floor(random() * 5),
          hatched: 0
        });
      }
    }

    return progress;
  }

  // Simple hash function for seeding
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // Seeded random number generator
  private seededRandom(seed: number) {
    let value = seed;
    return function() {
      value = (value * 9301 + 49297) % 233280;
      return value / 233280;
    };
  }

  // API Methods
  getAllModules(): Module[] {
    return Array.from(this.modules.values()).map(m => ({
      id: m.id,
      name: m.name,
      location: m.location,
      status: m.status,
      lastApiCall: m.lastApiCall,
      batteryLevel: m.batteryLevel,
      firstOnline: m.firstOnline
    }));
  }

  getModuleById(id: string): ModuleDetail | null {
    return this.modules.get(id) || null;
  }

  updateModuleStatus(id: string, status: 'online' | 'offline'): boolean {
    const module = this.modules.get(id);
    if (module) {
      module.status = status;
      module.lastApiCall = new Date().toISOString();
      return true;
    }
    return false;
  }
}

export const db = new MockDatabase();
