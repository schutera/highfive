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
  // Admin-settable label override from duckdb-service. Null when not
  // set. Wire-shape pinned by `duckdb-service/db/schema.py` and the
  // `Module` contract's `displayName` field; see ADR-011.
  display_name: string | null;
  lat: string;
  lng: string;
  first_online: string;
  battery_level: number;
  image_count: number;
  real_image_count: number;
  last_image_at: string | null;
  email: string | null;
  updated_at: string | null;
  // Device-liveness signal — bumped only on `add_module` per-boot
  // registration in duckdb-service (issue #97 / PR B split).
  // `fetchAndAssemble` reads this for the 2 h status window via the
  // `lastSeenAt` derivation; the older `updated_at` is row-metadata
  // only post-split.
  last_seen_at: string | null;
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
/**
 * Wrapper returned by ModuleReadModel methods so callers can surface
 * upstream-fetch failures to the wire (currently as the
 * ``X-Highfive-Data-Incomplete`` response header). The body itself stays
 * shape-compatible with old clients — only the meta moves out-of-band.
 */
export interface ModulesWithMeta {
  modules: Module[];
  heartbeatsFailed: boolean;
}

export interface ModuleDetailWithMeta {
  detail: ModuleDetail | null;
  heartbeatsFailed: boolean;
}

/**
 * Result of one full fan-out + assembly pass, shared by `listModules`
 * and `getModuleDetail` via the short-TTL cache below.
 */
interface AssembleResult {
  items: Array<{ detail: ModuleDetail; totalHatches: number }>;
  heartbeatsFailed: boolean;
  // True when ANY of the four upstream fetches rejected (modules, nests,
  // progress, or heartbeats). The fan-out uses `Promise.allSettled` and
  // degrades gracefully rather than throwing, so this flag is the only
  // signal that the snapshot is partial. `assemble()` refuses to cache a
  // degraded snapshot — otherwise a transient duckdb outage would pin an
  // empty/partial fleet (or a stuck `heartbeatsFailed`) for a full TTL
  // after upstream recovered. Not part of the public method return shape.
  degraded: boolean;
}

// How long an assembled fleet snapshot is reused before the next
// caller triggers a fresh upstream fan-out. Tuned for the dominant
// access pattern: the dashboard fetches `/api/modules`, then the
// operator clicks a module and `/api/modules/:id` fires moments later.
// Pre-cache, the detail route re-fetched all four duckdb endpoints just
// to find one module by id (the dashboard had already loaded the exact
// same data). At 5 s, that second call — and any rapid re-selection —
// is served from memory. The cost is staleness: a brand-new heartbeat
// or freshly onboarded module can lag by up to one TTL. The dashboard
// does not poll, so this is only ever observed across deliberate
// re-navigations, where 5 s is imperceptible.
const ASSEMBLE_CACHE_TTL_MS = 5000;

export class ModuleReadModel {
  // Last successful assembly + the time it completed. `null` until the
  // first fetch resolves.
  private cache: { at: number; value: AssembleResult } | null = null;
  // In-flight fan-out, if one is running. Concurrent callers (e.g. the
  // dashboard list and an immediate detail open) await the same promise
  // instead of each launching a duplicate four-endpoint fan-out.
  private inflight: Promise<AssembleResult> | null = null;

  async listModules(): Promise<ModulesWithMeta> {
    const { items, heartbeatsFailed } = await this.assemble();
    const modules = items.map(({ detail, totalHatches }) => ({
      id: detail.id,
      name: detail.name,
      displayName: detail.displayName,
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
    return { modules, heartbeatsFailed };
  }

  async getModuleDetail(id: ModuleId): Promise<ModuleDetailWithMeta> {
    const { items, heartbeatsFailed } = await this.assemble();
    const detail = items.find((x) => x.detail.id === id)?.detail ?? null;
    return { detail, heartbeatsFailed };
  }

  /**
   * Cached wrapper around `fetchAndAssemble`. Serves a snapshot younger
   * than `ASSEMBLE_CACHE_TTL_MS` from memory; otherwise dedupes
   * concurrent callers onto a single in-flight fan-out.
   *
   * Two things are deliberately NOT cached, so a transient upstream
   * outage can't pin stale-bad state for a full TTL:
   *   - a rejected promise. The `Promise.allSettled` fan-out itself
   *     never rejects; the only throw path is *during assembly, after
   *     the fan-out* — e.g. `parseModuleId` on a malformed upstream id.
   *     Caching is wired through `.then` (success only); `.finally`
   *     clears the in-flight slot so the next caller retries.
   *   - a *degraded* fan-out (`value.degraded` — any of the four
   *     upstream fetches failed). The result is still returned to the
   *     current caller (graceful degradation), but it is not stored, so
   *     the next call re-fetches against a possibly-recovered upstream.
   * Only a fully-successful snapshot is cached.
   */
  private async assemble(): Promise<AssembleResult> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < ASSEMBLE_CACHE_TTL_MS) {
      return this.cache.value;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.fetchAndAssemble()
      .then((value) => {
        if (!value.degraded) {
          this.cache = { at: Date.now(), value };
        }
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchAndAssemble(): Promise<AssembleResult> {
    // Reject on non-2xx so the existing `.status === 'rejected'` branches
    // fire on a duckdb HTTP 500 (or any other non-2xx). Without this,
    // `r.json()` happily parses the JSON error body, the promise resolves
    // 'fulfilled', and an upstream 500 on /modules silently renders an
    // empty fleet (#31 review P0). The body is captured (capped at 200
    // chars so a misbehaving upstream can't fill the log) because
    // duckdb-service's error handlers put a useful `error` field there
    // and we lose it otherwise.
    const fetchJsonOk = async (url: string): Promise<unknown> => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`upstream ${url} responded ${r.status}: ${body.slice(0, 200)}`);
      }
      return r.json();
    };
    const [modulesResult, nestsResult, progressResult, heartbeatsResult] = await Promise.allSettled(
      [
        fetchJsonOk(`${DUCKDB_URL}/modules`),
        fetchJsonOk(`${DUCKDB_URL}/nests`),
        fetchJsonOk(`${DUCKDB_URL}/progress`),
        fetchJsonOk(`${DUCKDB_URL}/heartbeats_summary`),
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
    const heartbeatsFailed = heartbeatsResult.status === 'rejected';
    if (heartbeatsFailed) {
      console.warn('⚠️ Failed to fetch heartbeats:', heartbeatsResult.reason);
    }

    // Any rejected fetch makes the assembled snapshot partial — see the
    // `degraded` field on AssembleResult for why `assemble()` won't cache it.
    const degraded =
      modulesResult.status === 'rejected' ||
      nestsResult.status === 'rejected' ||
      progressResult.status === 'rejected' ||
      heartbeatsFailed;

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
    const items = modulesData.modules.map((m) => {
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

      // lastSeenAt = freshest of: image upload, registration, heartbeat.
      // Reads `m.last_seen_at` (bumped only on `add_module`'s per-boot
      // registration UPSERT). Pre-#97 split this read `m.updated_at`,
      // but that column is now row-metadata only — see chapter 11
      // "updated_at semantic overload" for why the rename matters.
      const candidates: number[] = [];
      if (m.last_image_at) candidates.push(new Date(m.last_image_at).getTime());
      if (m.last_seen_at) candidates.push(new Date(m.last_seen_at).getTime());
      if (latestHeartbeat?.receivedAt)
        candidates.push(new Date(latestHeartbeat.receivedAt).getTime());
      const lastSeenAt =
        candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null;

      // A module is online if any liveness signal arrived in the last 2h
      const isOnline = lastSeenAt
        ? now.getTime() - new Date(lastSeenAt).getTime() <= 2 * 60 * 60 * 1000
        : false;

      // Status classification (#31). When the heartbeat fetch failed we
      // can't compute liveness from the freshest signal — most modules
      // heartbeat every 60 s but only image on motion, so a missing
      // heartbeats summary deletes their dominant freshness signal. Any
      // module that would have been 'offline' might actually be online
      // — we just couldn't ask. Surface 'unknown' (gray) rather than
      // misleading the user with red 'offline'.
      //
      // Note: an earlier draft gated this on `!m.last_seen_at`, but
      // `last_seen_at` refreshes on every module-registration call via
      // the `ON CONFLICT (id) DO UPDATE SET ... last_seen_at = NOW()`
      // branch in `duckdb-service/routes/modules.py`'s `add_module`,
      // which firmware fires unconditionally in setup() on every
      // boot. So a `!m.last_seen_at` guard was unreachable for the
      // exact population the fix was for. Switched to gating on the
      // would-be-offline outcome itself. (The first draft of this
      // comment said `updated_at` "never refreshes" — corrected by
      // the #15 fix's senior-review against the DDL; the column was
      // later renamed to `last_seen_at` in PR B / issue #97. See
      // chapter-11 "Post-reflash dashboard latency" and "updated_at
      // semantic overload" for full incident context.)
      let status: 'online' | 'offline' | 'unknown';
      if (isOnline) {
        status = 'online';
      } else if (heartbeatsFailed) {
        status = 'unknown';
      } else {
        status = 'offline';
      }

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
        // `?? null` because old duckdb-service builds (pre-PR-I) won't
        // include the field at all — keep the contract's `string | null`
        // shape honest in skew scenarios. The homepage resolves the
        // operator-visible label via `homepage/src/lib/displayLabel.ts`
        // (falls back to `name` on null / empty / whitespace-only), so a
        // null here lands on the firmware-reported name — the right
        // behaviour for modules that have never been renamed.
        displayName: m.display_name ?? null,
        location: { lat: Number(m.lat), lng: Number(m.lng) },
        status,
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
    return { items, heartbeatsFailed, degraded };
  }
}

export const db = new ModuleReadModel();
