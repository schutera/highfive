import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TelemetryEntry } from '@highfive/contracts';

import { TelemetryRow } from '../components/ModulePanel';
import { api } from '../services/api';

// Pins the envelope-aware rendering of TelemetryRow against the actual
// wire shape that image-service/services/sidecar.py emits. Before this
// pin, the component read flat top-level fields (entry.last_reset_reason,
// entry._received_at, …) while image-service was emitting nested
// envelopes — every field rendered as `—` since the envelope refactor
// because the optional-typed fields silently fell through. See the
// PR-42 senior-reviewer round-2 finding for the full incident.

const baseEnvelope: TelemetryEntry = {
  mac: 'aabbccddeeff',
  received_at: '2026-05-07T12:00:00',
  image: 'esp_capture_20260507_120000.jpg',
  payload: {
    fw: '1.0.0',
    uptime_s: 3661,
    last_reset_reason: 'TASK_WDT',
    free_heap: 124352,
    min_free_heap: 98211,
    rssi: -67,
    wifi_reconnects: 2,
    last_http_codes: [200, 200, 500],
    log: '[BOOT] fw=1.0.0 reset_reason=7 boot_count=3\n',
  },
};

describe('TelemetryRow envelope rendering', () => {
  it('reads telemetry fields off the nested payload, not flat top-level', () => {
    render(<TelemetryRow entry={baseEnvelope} />);
    // Top-level metadata
    expect(screen.getByText('2026-05-07T12:00:00')).toBeInTheDocument();
    expect(screen.getByText(/fw 1\.0\.0/)).toBeInTheDocument();
    // Nested payload — the actual fix this test pins
    expect(screen.getByText(/TASK_WDT/)).toBeInTheDocument();
    expect(screen.getByText(/-67 dBm/)).toBeInTheDocument();
    // Heap formatted as KB
    expect(screen.getByText(/121 KB/)).toBeInTheDocument();
    // Uptime formatted (3661 s = 1h1m)
    expect(screen.getByText(/1h 1m/)).toBeInTheDocument();
    // HTTP-codes ring rendered comma-separated
    expect(screen.getByText(/200, 200, 500/)).toBeInTheDocument();
  });

  it('renders "stage at previous reboot" only when last_stage_before_reboot is set (#42)', () => {
    const { rerender } = render(<TelemetryRow entry={baseEnvelope} />);
    // Empty case — field omitted by firmware on clean boots
    expect(screen.queryByText(/stage at previous reboot/i)).not.toBeInTheDocument();

    // Present case
    const withCrumb: TelemetryEntry = {
      ...baseEnvelope,
      payload: { ...baseEnvelope.payload, last_stage_before_reboot: 'setup:getGeolocation' },
    };
    rerender(<TelemetryRow entry={withCrumb} />);
    expect(screen.getByText(/stage at previous reboot/i)).toBeInTheDocument();
    expect(screen.getByText(/setup:getGeolocation/)).toBeInTheDocument();
  });

  it('renders dashes when payload telemetry fields are absent', () => {
    const sparse: TelemetryEntry = {
      mac: 'aabbccddeeff',
      received_at: '2026-05-07T12:00:00',
      image: 'esp_capture.jpg',
      payload: {},
    };
    render(<TelemetryRow entry={sparse} />);
    // Pin the specific cells that fall back, not just the count, so a
    // future regression where one cell starts rendering "undefined"
    // (or one of the four cells stops rendering) shows up as a test
    // failure rather than an unchanged dash count.
    const labelToCell = (label: string) =>
      screen.getByText(label).parentElement?.textContent?.trim();
    expect(labelToCell('uptime')).toBe('uptime —');
    expect(labelToCell('heap')).toBe('heap —');
    expect(labelToCell('rssi')).toBe('rssi —');
    expect(labelToCell('reset')).toBe('reset —');
  });

  it('tolerates a missing payload object (defensive — bad sidecar)', () => {
    const broken = {
      mac: 'aabbccddeeff',
      received_at: '2026-05-07T12:00:00',
      image: 'esp_capture.jpg',
    } as unknown as TelemetryEntry;
    expect(() => render(<TelemetryRow entry={broken} />)).not.toThrow();
  });
});

// Wire-shape round-trip: mocks `fetch` with the exact JSON shape that
// image-service/app.py's `get_module_logs` returns (the result of
// `LogSidecarEnvelope.model_dump()`), feeds it through the production
// code path `api.getModuleLogs(id, limit)`, and renders the result via
// TelemetryRow. This is the contract test the chapter-11 lesson named:
// it catches a future flatten-the-envelope-in-getModuleLogs refactor
// that the structural-only TelemetryEntry type would miss (every field
// is `string | undefined`, so a level-mismatch is not a TS compile
// error — see `docs/11-risks-and-technical-debt/README.md` "Telemetry
// sidecar envelope drift").
describe('TelemetryRow wire-shape round-trip via api.getModuleLogs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders correctly when fed the actual image-service response shape', async () => {
    const wireShape = [
      {
        mac: 'aabbccddeeff',
        received_at: '2026-05-07T12:00:00',
        image: 'esp_capture_20260507_120000.jpg',
        payload: {
          fw: '1.0.0',
          uptime_s: 60,
          last_reset_reason: 'TASK_WDT',
          last_stage_before_reboot: 'setup:getGeolocation',
          free_heap: 100000,
          rssi: -55,
          last_http_codes: [200, 200],
          log: '[BOOT] reset_reason=7\n',
        },
      },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wireShape), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const logs = await api.getModuleLogs('aabbccddeeff', 1);
    expect(logs).toHaveLength(1);
    render(<TelemetryRow entry={logs[0]} />);
    // Top-level metadata renders.
    expect(screen.getByText('2026-05-07T12:00:00')).toBeInTheDocument();
    // Nested payload fields render — the level the round-1 fix got wrong.
    expect(screen.getByText(/TASK_WDT/)).toBeInTheDocument();
    expect(screen.getByText(/setup:getGeolocation/)).toBeInTheDocument();
    expect(screen.getByText(/-55 dBm/)).toBeInTheDocument();
  });
});
