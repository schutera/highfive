import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TelemetryEntry } from '@highfive/contracts';

import { TelemetryRow } from '../components/ModulePanel';

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
    // The reset row falls back to "—"; before the envelope fix this
    // was happening for every entry, silently.
    const resetCells = screen.getAllByText('—');
    expect(resetCells.length).toBeGreaterThanOrEqual(3);
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
