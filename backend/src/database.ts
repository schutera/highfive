import {
  Module,
  ModuleDetail,
  NestData,
  DailyProgress,
  HeartbeatSnapshot,
  ModuleId,
  parseModuleId,
} from '@highfive/contracts';
import { DUCKDB_URL } from './duckdbClient';

interface ApiHeartbeatSummaryEntry {
  last_seen: string | null;
  battery: number | null;
  rssi: number | null;
  uptime_ms: number | null;
  free_heap: number | null;
  fw_version: string | null;
}

interface ApiHeartbeatSummaryResponse {
  summary: Record<string, ApiHeartbeatSummaryEntry>;
}

interface ApiModule {
  id: string;
  name: string;
  lat: string;
  lng: string;
  status: 'online' | 'offline';
  first_online: string;
  battery_level: number;
  image_count: number;
  real_image_count: number;
  last_image_at: string | null;
  email: string | null;
  updated_at: string | null;
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
 * Owns no state. Each call fetches the four upstream endpoints and shapes
 * the response. The DTO normalisation (date ISOification, lat/lng stringly-
 * typed → numbers, status derivation, totalHatches roll-up, heartbeat fold-in)
 * is the actual value of this layer — the only place where the duckdb wire
 * shape is translated into the contracts package shape.
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
      email: detail.email,
      updatedAt: detail.updatedAt,
      lastSeenAt: detail.lastSeenAt,
      latestHeartbeat: detail.latestHeartbeat,
    }));
  }

  async getModuleDetail(id: ModuleId): Promise<ModuleDetail | null> {
    const all = await this.fetchAndAssemble();
    return all.find((x) => x.detail.id === id)?.detail ?? null;
  }

  private async fetchAndAssemble(): Promise<Array<{ detail: ModuleDetail; totalHatches: number }>> {
    const [modulesResult, nestsResult, progressResult, heartbeatsResult] = await Promise.allSettled(
      [
        fetch(`${DUCKDB_URL}/modules`).then((r) => r.json()),
        fetch(`${DUCKDB_URL}/nests`).then((r) => r.json()),
        fetch(`${DUCKDB_URL}/progress`).then((r) => r.json()),
        fetch(`${DUCKDB_URL}/heartbeats_summary`).then((r) => r.json()),
      ],
    );

    if (modulesResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch modules:', modulesResult.reason);
    }
    if (nestsResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch nests:', nestsResult.reason);
    }
    if (progressResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch progress:', progressResult.reason);
    }
    if (heartbeatsResult.status === 'rejected') {
      console.warn('⚠️ Failed to fetch heartbeats:', heartbeatsResult.reason);
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
    const heartbeatsData = (
      heartbeatsResult.status === 'fulfilled' ? heartbeatsResult.value : { summary: {} }
    ) as ApiHeartbeatSummaryResponse;

    // ---- 1) Normalize progress ----
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

    // ---- 2) Build nests ----
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

    // ---- 3) Build modules ----
    const heartbeatSummary = heartbeatsData.summary || {};
    const now = new Date();
    return modulesData.modules.map((m) => {
      const moduleId = parseModuleId(m.id);

      const hbEntry = heartbeatSummary[m.id];
      const latestHeartbeat: HeartbeatSnapshot | null = hbEntry?.last_seen
        ? {
            receivedAt: hbEntry.last_seen,
            battery: hbEntry.battery,
            rssi: hbEntry.rssi,
            uptimeMs: hbEntry.uptime_ms,
            freeHeap: hbEntry.free_heap,
            fwVersion: hbEntry.fw_version,
          }
        : null;

      // lastSeenAt = freshest of: image upload, registration, heartbeat
      const candidates: number[] = [];
      if (m.last_image_at) candidates.push(new Date(m.last_image_at).getTime());
      if (m.updated_at) candidates.push(new Date(m.updated_at).getTime());
      if (latestHeartbeat?.receivedAt)
        candidates.push(new Date(latestHeartbeat.receivedAt).getTime());
      const lastSeenAt =
        candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null;

      // A module is online if any liveness signal arrived in the last 2h
      const isOnline = lastSeenAt
        ? now.getTime() - new Date(lastSeenAt).getTime() <= 2 * 60 * 60 * 1000
        : false;

      // first_online is a DATE column (no time), pass the date portion only
      const firstOnlineStr = m.first_online
        ? new Date(m.first_online).toISOString().split('T')[0]
        : '';

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
        firstOnline: firstOnlineStr,
        lastApiCall: m.last_image_at ? new Date(m.last_image_at).toISOString() : '',
        batteryLevel: m.battery_level ?? 0,
        totalHatches,
        imageCount: m.real_image_count ?? m.image_count ?? 0,
        email: m.email ?? null,
        updatedAt: m.updated_at ?? undefined,
        lastSeenAt,
        latestHeartbeat,
        nests,
      };

      return { detail, totalHatches };
    });
  }
}

export const db = new ModuleReadModel();
