import { Module, ModuleDetail, NestData, DailyProgress } from './types';
import { DUCKDB_URL } from './duckdbClient';

interface ApiModule {
  id: string;
  name: string;
  lat: string;
  lng: string;
  status: 'online' | 'offline';
  first_online: string;
  battery_level: number;
  image_count: number;
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

export class ModuleCache {
  private modules: Map<string, ModuleDetail>;

  constructor() {
    this.modules = new Map();
    this.initWithRetry();
  }

  private async initWithRetry(retries = 10, delayMs = 3000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.initializeData();
        console.log('📊 Data loaded from DuckDB service');
        return;
      } catch (err) {
        const remaining = retries - i - 1;
        if (remaining > 0) {
          console.warn(`⏳ DuckDB not ready, retrying in ${delayMs / 1000}s (${remaining} left)...`);
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          console.error('❌ Could not reach DuckDB service after all retries. Starting with empty data.');
        }
      }
    }
  }

  async initializeData(): Promise<void> {
    const [modulesResult, nestsResult, progressResult] = await Promise.allSettled([
      fetch(`${DUCKDB_URL}/modules`).then(r => r.json()),
      fetch(`${DUCKDB_URL}/nests`).then(r => r.json()),
      fetch(`${DUCKDB_URL}/progress`).then(r => r.json()),
    ]);

    if (modulesResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch modules:', modulesResult.reason);
    }
    if (nestsResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch nests:', nestsResult.reason);
    }
    if (progressResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch progress:', progressResult.reason);
    }

    const modulesData = (modulesResult.status === 'fulfilled' ? modulesResult.value : { modules: [] }) as ApiModuleResponse;
    const nestsData = (nestsResult.status === 'fulfilled' ? nestsResult.value : { nests: [] }) as ApiNestResponse;
    const progressData = (progressResult.status === 'fulfilled' ? progressResult.value : { progress: [] }) as ApiDailyProgressResponse;

    this.modules.clear();

    // ---- 1) Progress normalisieren ----
    const progressByNest = new Map<string, DailyProgress[]>();

    progressData.progress.forEach((p: any) => {
      const normalized: DailyProgress = {
        progress_id: p.progess_id, // Backend name!
        nest_id: p.nest_id,
        date: new Date(p.date).toISOString(),
        empty: p.empty,
        sealed: p.sealed,
        hatched: p.hateched, // Backend name!
      };

      let arr = progressByNest.get(p.nest_id);
      if (!arr) {
        arr = [];
        progressByNest.set(p.nest_id, arr);
      }
      arr.push(normalized);
    });

    // ---- 2) Nests bauen ----
    const nestsByModule = new Map<string, NestData[]>();

    nestsData.nests.forEach((n: any) => {
      const nest: NestData = {
        nest_id: n.nest_id,
        module_id: n.module_id,
        beeType: n.beeType,
        dailyProgress: progressByNest.get(n.nest_id) || [],
      };

      let arr = nestsByModule.get(n.module_id);
      if (!arr) {
        arr = [];
        nestsByModule.set(n.module_id, arr);
      }
      arr.push(nest);
    });

    // ---- 3) Module bauen ----
    modulesData.modules.forEach((m: any) => {
      const firstOnlineDate = new Date(m.first_online);
      const now = new Date();
      const isOnline =
        now.getTime() - firstOnlineDate.getTime() <= 24 * 60 * 60 * 1000;

      const module: ModuleDetail = {
        id: m.id,
        name: m.name,
        location: {
          lat: Number(m.lat),
          lng: Number(m.lng),
        },
        status: isOnline ? 'online' : 'offline',
        firstOnline: firstOnlineDate.toISOString(),
        lastApiCall: now.toISOString(),
        batteryLevel: m.battery_level ?? 0,
        totalHatches: 0,
        imageCount: m.image_count ?? 0,
        nests: nestsByModule.get(m.id) || [],
      };

      this.modules.set(module.id, module);
    });
  }

  async refresh() {
    await this.initializeData();
  }

  // ---- API Methods ----
  getAllModules(): Module[] {
    return Array.from(this.modules.values()).map((m) => {
      const totalHatches = m.nests.reduce((sum, nest) => {
        const latestProgress =
          nest.dailyProgress[nest.dailyProgress.length - 1];
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
        imageCount: m.imageCount,
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

export const db = new ModuleCache();