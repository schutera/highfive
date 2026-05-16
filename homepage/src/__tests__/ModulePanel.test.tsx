import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ModuleDetail } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// Pins the firmware-pill rendering against the actual wire shape that
// duckdb-service emits and that backend/src/database.ts's fetchAndAssemble
// passes through to the homepage. The pill is the dashboard's only
// surface for fwVersion (admin telemetry has its own row, but operators
// don't see that), so a regression where latestHeartbeat.fwVersion stops
// rendering would make manual T2/T3 evidence invisible — exactly the
// PR-42 trap CLAUDE.md "Verifying UI claims" was written to catch.
//
// Three branches matter:
//   - latestHeartbeat null         → pill hidden (new / never-heartbeated module)
//   - fwVersion === 'dev-unset'    → pill hidden (Arduino-IDE escape hatch sentinel,
//                                    documented in esp_init.h's FIRMWARE_VERSION default)
//   - fwVersion === '<bee-name>'   → pill rendered with "Firmware <bee-name>"

// Per-test mutable mock — set before each render() call.
let nextModuleDetail: ModuleDetail | null = null;

// Note: `hasAdminKey` / `isAdminMode` are NOT exported from
// `../services/api` — they're file-local helpers inside
// `ModulePanel.tsx` itself. We don't mock them; they default to false
// in jsdom (empty sessionStorage, no `?admin` URL param), so the
// admin/non-admin branch the pill is in is the only branch exercised
// here. That's the right branch — operators don't see admin mode.
vi.mock('../services/api', () => ({
  api: {
    getModuleById: vi.fn(() => Promise.resolve(nextModuleDetail)),
    getModuleLogs: vi.fn().mockResolvedValue([]),
  },
}));

// Static import after the vi.mock above (vitest hoists vi.mock).
import ModulePanel from '../components/ModulePanel';

const baseModule: ModuleDetail = {
  id: parseModuleId('e89fa9f23a08'),
  name: 'fierce-apricot-specht',
  // displayName is null by default — modules register with no override,
  // and the dashboard falls back to `name`. The display-name override
  // tests below mutate this field to pin the coalesce behaviour.
  displayName: null,
  location: { lat: 48.2, lng: 11.77 },
  status: 'online',
  lastApiCall: '2026-05-14T16:00:00.000Z',
  batteryLevel: 90,
  firstOnline: '2026-05-14',
  totalHatches: 0,
  imageCount: 12,
  email: null,
  updatedAt: '2026-05-14T16:00:00.000Z',
  lastSeenAt: '2026-05-14T16:00:00.000Z',
  latestHeartbeat: {
    receivedAt: '2026-05-14T16:00:00.000Z',
    battery: 90,
    rssi: -75,
    uptimeMs: 9999,
    freeHeap: 210000,
    fwVersion: 'leafcutter',
  },
  nests: [],
};

const renderPanel = () =>
  render(
    <LanguageProvider>
      <ModulePanel
        module={{
          id: baseModule.id,
          name: baseModule.name,
          displayName: baseModule.displayName,
          status: baseModule.status,
        }}
        onClose={() => undefined}
        onError={() => undefined}
      />
    </LanguageProvider>,
  );

describe('ModulePanel firmware pill', () => {
  beforeEach(() => {
    nextModuleDetail = null;
  });

  it('renders "Firmware <bee-name>" when latestHeartbeat.fwVersion is a release name', async () => {
    nextModuleDetail = {
      ...baseModule,
      latestHeartbeat: { ...baseModule.latestHeartbeat!, fwVersion: 'leafcutter' },
    };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Firmware leafcutter/)).toBeInTheDocument();
    });
  });

  it('hides the firmware pill when latestHeartbeat is null (module never heartbeated)', async () => {
    nextModuleDetail = { ...baseModule, latestHeartbeat: null };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(baseModule.name)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Firmware /)).not.toBeInTheDocument();
  });

  it('hides the firmware pill when fwVersion is the "dev-unset" sentinel', async () => {
    nextModuleDetail = {
      ...baseModule,
      latestHeartbeat: { ...baseModule.latestHeartbeat!, fwVersion: 'dev-unset' },
    };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(baseModule.name)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Firmware /)).not.toBeInTheDocument();
  });
});

// Pin the post-PR-I label/MAC behaviour (ADR-011 / issues #91, #92, #93,
// #94). The dashboard renders `displayName ?? name`, and the last 4 hex
// chars of the MAC ride along as a subtitle so two modules sharing a
// label remain visually distinct.
describe('ModulePanel display-name override', () => {
  beforeEach(() => {
    nextModuleDetail = null;
  });

  it('renders displayName when set, not the firmware name', async () => {
    nextModuleDetail = { ...baseModule, displayName: 'Garden Bee' };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('Garden Bee')).toBeInTheDocument();
    });
    // The firmware name must NOT appear in the header — it's superseded
    // by the override. The admin page is where both are visible side
    // by side; the dashboard shows only the chosen label.
    expect(screen.queryByText('fierce-apricot-specht')).not.toBeInTheDocument();
  });

  it('falls back to firmware name when displayName is null', async () => {
    nextModuleDetail = { ...baseModule, displayName: null };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('fierce-apricot-specht')).toBeInTheDocument();
    });
  });

  it('renders the MAC-prefix subtitle in uppercase hex', async () => {
    // baseModule.id = 'e89fa9f23a08' → leading 4 = 'e89f' → 'E89F'.
    // Leading rather than trailing so same-batch hardware (which shares
    // its trailing MAC octets) remains visually distinct — see ADR-011
    // and the field incident in issue #92.
    nextModuleDetail = { ...baseModule };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('E89F')).toBeInTheDocument();
    });
  });

  it('renders MAC prefix even when displayName is set (always-visible disambiguator)', async () => {
    nextModuleDetail = { ...baseModule, displayName: 'Garden Bee' };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('Garden Bee')).toBeInTheDocument();
    });
    // MAC prefix is also present so two modules with the same custom
    // label remain distinguishable on the dashboard.
    expect(screen.getByText('E89F')).toBeInTheDocument();
  });
});

// Pin the exact field-incident disambiguation: the two MACs from issue
// #92 (b0:69:6e:f2:3a:08 and e8:9f:a9:f2:3a:08) share their trailing
// three octets. A trailing-4 disambiguator would render `3A08` on both
// and defeat the entire point. The leading 4 (`B069` / `E89F`) actually
// differ. This test pins the right side of that choice.
describe('ModulePanel MAC disambiguation for same-batch hardware', () => {
  it('renders distinct prefixes for the issue-#92 field-collision MAC pair', async () => {
    // Render module A and assert its prefix.
    nextModuleDetail = {
      ...baseModule,
      id: parseModuleId('b0696ef23a08'),
    };
    const { unmount } = render(
      <LanguageProvider>
        <ModulePanel
          module={{
            id: parseModuleId('b0696ef23a08'),
            name: baseModule.name,
            displayName: baseModule.displayName,
            status: baseModule.status,
          }}
          onClose={() => undefined}
          onError={() => undefined}
        />
      </LanguageProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('B069')).toBeInTheDocument();
    });
    // Trailing-4 (the broken-disambiguator choice) would have been
    // 3A08 — if it appears here, the prefix swap regressed.
    expect(screen.queryByText('3A08')).not.toBeInTheDocument();
    unmount();

    // Now module B from the same batch — its trailing octets are
    // identical (f2:3a:08), so only the prefix saves us.
    nextModuleDetail = {
      ...baseModule,
      id: parseModuleId('e89fa9f23a08'),
    };
    render(
      <LanguageProvider>
        <ModulePanel
          module={{
            id: parseModuleId('e89fa9f23a08'),
            name: baseModule.name,
            displayName: baseModule.displayName,
            status: baseModule.status,
          }}
          onClose={() => undefined}
          onError={() => undefined}
        />
      </LanguageProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('E89F')).toBeInTheDocument();
    });
    expect(screen.queryByText('B069')).not.toBeInTheDocument();
    // Same broken-disambiguator check as the first render — the
    // trailing-4 value (`3A08`) is identical for both same-batch
    // MACs, so its absence is what proves we're using leading-4.
    expect(screen.queryByText('3A08')).not.toBeInTheDocument();
  });
});
