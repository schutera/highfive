import {
  Module,
  ModuleDetail,
  NestData,
  DailyProgress,
  ModuleId,
  parseModuleId,
} from '@highfive/contracts';
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

/**
 * Read-only projection of duckdb-service for the homepage.
 *
 * Owns no state. Each call fetches the three upstream endpoints and shapes
 * the response. The DTO normalisation (date ISOification, lat/lng stringly-
 * typed → numbers, status derivation, totalHatches roll-up) is the actual
 * value of this layer — the only place where the duckdb wire shape is
 * translated into the contracts package shape.
 */
export class ModuleReadModel {
  async listModules(): Promise<Module[]> {
    const all = await this.fetchAndAssemble();
    return all.map(({ detail, totalHatches }) => ({
      id: detail.id,
      name: detail.name,
      location: detail.location,
      status: detail.status,
      lastApiCall: detail.lastApiCall,
      batteryLevel: detail.batteryLevel,
      firstOnline: detail.firstOnline,
      totalHatches,
      imageCount: detail.imageCount,
    }));
  }

  async getModuleDetail(id: ModuleId): Promise<ModuleDetail | null> {
    const all = await this.fetchAndAssemble();
    return all.find((x) => x.detail.id === id)?.detail ?? null;
  }

  private async fetchAndAssemble(): Promise<Array<{ detail: ModuleDetail; totalHatches: number }>> {
    const [modulesResult, nestsResult, progressResult] = await Promise.allSettled([
      fetch(`${DUCKDB_URL}/modules`).then((r) => r.json()),
      fetch(`${DUCKDB_URL}/nests`).then((r) => r.json()),
      fetch(`${DUCKDB_URL}/progress`).then((r) => r.json()),
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

    const modulesData = (
      modulesResult.status === 'fulfilled' ? modulesResult.value : { modules: [] }
    ) as ApiModuleResponse;
    const nestsData = (
      nestsResult.status === 'fulfilled' ? nestsResult.value : { nests: [] }
    ) as ApiNestResponse;
    const progressData = (
      progressResult.status === 'fulfilled' ? progressResult.value : { progress: [] }
    ) as ApiDailyProgressResponse;

    // ---- 1) Progress normalisieren ----
    const progressByNest = new Map<string, DailyProgress[]>();
    progressData.progress.forEach((p: any) => {
      const normalized: DailyProgress = {
        progress_id: p.progress_id,
        nest_id: p.nest_id,
        date: new Date(p.date).toISOString(),
        empty: p.empty,
        sealed: p.sealed,
        hatched: p.hatched,
      };
      const arr = progressByNest.get(p.nest_id) ?? [];
      arr.push(normalized);
      progressByNest.set(p.nest_id, arr);
    });

    // ---- 2) Nests bauen ----
    // Brand `module_id` at the boundary: parseModuleId throws on a malformed
    // upstream value, which is the right signal — duckdb-service drift should
    // surface, not be silently swallowed. Mirrors homepage `services/api.ts`.
    const nestsByModule = new Map<ModuleId, NestData[]>();
    nestsData.nests.forEach((n: any) => {
      const moduleId = parseModuleId(n.module_id);
      const nest: NestData = {
        nest_id: n.nest_id,
        module_id: moduleId,
        beeType: n.beeType,
        dailyProgress: progressByNest.get(n.nest_id) ?? [],
      };
      const arr = nestsByModule.get(moduleId) ?? [];
      arr.push(nest);
      nestsByModule.set(moduleId, arr);
    });

    // ---- 3) Module bauen ----
    const now = new Date();
    return modulesData.modules.map((m) => {
      const moduleId = parseModuleId(m.id);
      const firstOnlineDate = new Date(m.first_online);
      const isOnline = now.getTime() - firstOnlineDate.getTime() <= 24 * 60 * 60 * 1000;
      const nests = nestsByModule.get(moduleId) ?? [];
      const totalHatches = nests.reduce((sum, nest) => {
        const latest = nest.dailyProgress[nest.dailyProgress.length - 1];
        return sum + (latest?.hatched || 0);
      }, 0);

      const detail: ModuleDetail = {
        id: moduleId,
        name: m.name,
        location: { lat: Number(m.lat), lng: Number(m.lng) },
        status: isOnline ? 'online' : 'offline',
        firstOnline: firstOnlineDate.toISOString(),
        lastApiCall: now.toISOString(),
        batteryLevel: m.battery_level ?? 0,
        totalHatches,
        imageCount: m.image_count ?? 0,
        nests,
      };

      return { detail, totalHatches };
    });
  }
}

export const db = new ModuleReadModel();
