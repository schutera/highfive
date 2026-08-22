import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ModuleReadModel } from '../src/database';
import { parseModuleId } from '@highfive/contracts';

/**
 * Contract test for the duckdb-service -> backend progress/nest wire shape.
 *
 * Chapter 11 "Backend `database.ts` reading typo'd field names" records an
 * incident where `p.progess_id` / `p.hateched` read undefined for months, and
 * prescribes: "Add a contract test that reads a known row and checks the field
 * values". This is that test.
 *
 * It asserts *values*, not just shape. A misspelled read yields `undefined`,
 * which a shape-only assertion would happily accept.
 */

const MODULE_ID = 'aabbccddeeff';
const NEST_ID = 'nest-0001';

const MODULES = {
  modules: [
    {
      id: MODULE_ID,
      name: 'hive-alpha',
      display_name: 'Hive Alpha',
      location: null,
      battery_level: 80,
      image_count: 3,
      real_image_count: 3,
      email: null,
      last_image_at: null,
      first_online: null,
      updated_at: null,
      last_seen_at: null,
    },
  ],
};

const NESTS = {
  nests: [{ nest_id: NEST_ID, module_id: MODULE_ID, beeType: 'resin' }],
};

/** Date-ascending, as duckdb-service returns them. */
const PROGRESS = {
  progress: [
    {
      progress_id: 'progress-0001',
      nest_id: NEST_ID,
      date: '2026-08-01T00:00:00.000Z',
      empty: 5,
      sealed: 2,
      hatched: 1,
    },
    {
      progress_id: 'progress-0002',
      nest_id: NEST_ID,
      date: '2026-08-02T00:00:00.000Z',
      empty: 3,
      sealed: 4,
      hatched: 7,
    },
  ],
};

const HEARTBEATS = { summary: {} };

function stubDuckdb(overrides: Record<string, unknown> = {}) {
  const payloads: Record<string, unknown> = {
    '/modules': MODULES,
    '/nests': NESTS,
    '/progress': PROGRESS,
    '/heartbeats_summary': HEARTBEATS,
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = Object.keys(payloads).find((k) => url.includes(k));
      return {
        ok: true,
        status: 200,
        json: async () => payloads[key ?? '/modules'],
        text: async () => '',
      };
    }),
  );
}

beforeEach(() => {
  stubDuckdb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('progress rows survive assembly with their declared field names', () => {
  it('carries every DailyProgress field through by value', async () => {
    const { detail } = await new ModuleReadModel().getModuleDetail(parseModuleId(MODULE_ID));

    expect(detail).not.toBeNull();
    const progress = detail!.nests[0].dailyProgress;
    expect(progress).toHaveLength(2);

    // Every field read by name. A typo'd read is `undefined`, so these
    // assertions are what the incident needed and did not have.
    expect(progress[0].progress_id).toBe('progress-0001');
    expect(progress[0].nest_id).toBe(NEST_ID);
    expect(progress[0].empty).toBe(5);
    expect(progress[0].sealed).toBe(2);
    expect(progress[0].hatched).toBe(1);
    expect(progress[0].date).toBe('2026-08-01T00:00:00.000Z');

    expect(progress[1].progress_id).toBe('progress-0002');
    expect(progress[1].hatched).toBe(7);
  });

  it('defines no progress field as undefined', async () => {
    const { detail } = await new ModuleReadModel().getModuleDetail(parseModuleId(MODULE_ID));
    for (const row of detail!.nests[0].dailyProgress) {
      for (const [field, value] of Object.entries(row)) {
        expect(value, `${field} read as undefined`).toBeDefined();
      }
    }
  });

  it('rolls totalHatches up from the latest row, not the first', async () => {
    // The dailyProgress[length-1]-is-latest invariant. Reading the wrong end
    // would give 1 here instead of 7.
    const modules = await new ModuleReadModel().listModules();
    expect(modules.modules[0].totalHatches).toBe(7);
  });

  it('carries nest fields through by value', async () => {
    const { detail } = await new ModuleReadModel().getModuleDetail(parseModuleId(MODULE_ID));
    const nest = detail!.nests[0];

    expect(nest.nest_id).toBe(NEST_ID);
    expect(nest.module_id).toBe(MODULE_ID);
    expect(nest.beeType).toBe('resin');
  });

  it('groups progress under the nest it belongs to', async () => {
    const otherNest = 'nest-0002';
    stubDuckdb({
      '/nests': {
        nests: [
          { nest_id: NEST_ID, module_id: MODULE_ID, beeType: 'resin' },
          { nest_id: otherNest, module_id: MODULE_ID, beeType: 'orchard' },
        ],
      },
    });

    const { detail } = await new ModuleReadModel().getModuleDetail(parseModuleId(MODULE_ID));
    const byId = Object.fromEntries(detail!.nests.map((n) => [n.nest_id, n]));

    expect(byId[NEST_ID].dailyProgress).toHaveLength(2);
    expect(byId[otherNest].dailyProgress).toHaveLength(0);
  });

  it('leaves dailyProgress empty rather than undefined when a nest has no rows', async () => {
    stubDuckdb({ '/progress': { progress: [] } });

    const { detail } = await new ModuleReadModel().getModuleDetail(parseModuleId(MODULE_ID));
    expect(detail!.nests[0].dailyProgress).toEqual([]);
  });
});
