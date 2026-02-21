import { Module, ModuleDetail, NestData, DailyProgress } from './types';

interface ApiModule {
  id: string;
  name: string;
  lat: string;
  lng: string;
  status: 'online' | 'offline';
  first_online: string;
  battery_level: number;
}

interface ApiNestResponse {
  nests: NestData[];
}

interface ApiDailyProgressResponse {
  progress: DailyProgress[];
}

interface ApiModuleResponse {
  modules: ApiModule[];
}

export class MockDatabase {
  private modules: Map<string, ModuleDetail>;

  constructor() {
    this.modules = new Map();
    this.initializeData().catch((err) => {
      console.error('Failed to initialize database:', err);
    });
  }

async initializeData(): Promise<void> {
  const [modulesRes, nestsRes, progressRes] = await Promise.all([
    fetch('http://duckdb-service:8000/modules'),
    fetch('http://duckdb-service:8000/nests'),
    fetch('http://duckdb-service:8000/progress'),
  ]);

  const modulesData = await modulesRes.json() as ApiModuleResponse;
  const nestsData = await nestsRes.json() as ApiNestResponse;
  const progressData = await progressRes.json() as ApiDailyProgressResponse;

  this.modules.clear();

  // ---- 1️⃣ Progress normalisieren ----
  const progressByNest = new Map<string, DailyProgress[]>();

  progressData.progress.forEach((p: any) => {
    const normalized: DailyProgress = {
      progress_id: p.progess_id,     // Backend name!
      nest_id: p.nest_id,
      date: new Date(p.date).toISOString(),
      empty: p.empty,
      sealed: p.sealed,
      hatched: p.hateched,           // Backend name!
    };

    if (!progressByNest.has(p.nest_id)) {
      progressByNest.set(p.nest_id, []);
    }

    progressByNest.get(p.nest_id)!.push(normalized);
  });

  // ---- 2️⃣ Nests bauen ----
  const nestsByModule = new Map<string, NestData[]>();

  nestsData.nests.forEach((n: any) => {
    const nest: NestData = {
      nest_id: n.nest_id,
      module_id: n.module_id,
      beeType: n.beeType,
      dailyProgress: progressByNest.get(n.nest_id) || [],
    };

    if (!nestsByModule.has(n.module_id)) {
      nestsByModule.set(n.module_id, []);
    }

    nestsByModule.get(n.module_id)!.push(nest);
  });

  // ---- 3️⃣ Module bauen ----
  modulesData.modules.forEach((m: any) => {
    const module: ModuleDetail = {
      id: m.id,
      name: m.name,
      location: {
        lat: Number(m.lat),
        lng: Number(m.lng),
      },
      status: m.status,
      firstOnline: new Date(m.first_online).toISOString(),
      lastApiCall: new Date().toISOString(),
      batteryLevel: m.battery_level,
      totalHatches: 0,
      nests: nestsByModule.get(m.id) || [],
    };

    this.modules.set(module.id, module);
  });
}

  async refresh() {
  await this.initializeData();
  }


  // API Methods
  getAllModules(): Module[] {
    return Array.from(this.modules.values()).map(m => {
      const totalHatches = m.nests.reduce((sum, nest) => {
        const latestProgress = nest.dailyProgress[nest.dailyProgress.length - 1];
        return sum + (latestProgress?.hatched || 0);
      }, 0);

      return {
        id: m.id,
        name: m.name,
        location: m.location,
        status: m.status,
        lastApiCall: m.lastApiCall,
        batteryLevel: m.batteryLevel,
        firstOnline: m.firstOnline,
        totalHatches,
      };
    });
  }

  getModuleById(id: string): ModuleDetail | null {
    return this.modules.get(id) || null;
  }

  updateModuleStatus(id: string, status: 'online' | 'offline'): boolean {
    const module = this.modules.get(id);
    if (!module) return false;

    module.status = status;
    module.lastApiCall = new Date().toISOString();
    return true;
  }
}

export const db = new MockDatabase();
