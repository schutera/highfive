import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HeartbeatSnapshot } from '@highfive/contracts';

import { HeartbeatDiagnostics } from '../components/ModulePanel';

// Pins the #148 heartbeat-diagnostics card against the actual
// HeartbeatSnapshot wire shape that backend/src/database.ts assembles
// from duckdb-service's /heartbeats_summary. This is the freshest
// "why did it reset / is it boot-looping" surface — the per-upload
// TelemetryRow only lands ~daily, so a hung module shows nothing there.
//
// The fixture is a realistic snapshot (the contract under test, per
// CLAUDE.md "Component tests ... must mount with a realistic fixture"),
// not a hand-guessed object: every field is one duckdb-service emits.

// A healthy, long-running module: high uptime, low boot count.
const healthy: HeartbeatSnapshot = {
  receivedAt: '2026-06-06T15:01:00.000Z',
  battery: null,
  rssi: -72,
  uptimeMs: 3_660_000, // ~1h — survived a full heartbeat interval
  freeHeap: 167_888,
  fwVersion: 'carpenter',
  resetReason: 'POWERON',
  minFreeHeap: 69_916,
  bootCount: 12,
};

describe('HeartbeatDiagnostics', () => {
  it('renders nothing when there is no heartbeat (never phoned home)', () => {
    const { container } = render(<HeartbeatDiagnostics heartbeat={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the freshest heartbeat diagnostic fields', () => {
    render(<HeartbeatDiagnostics heartbeat={healthy} />);
    // reset reason — the single highest-leverage field (#148): why it reset.
    expect(screen.getByText('POWERON')).toBeInTheDocument();
    // boot count and rssi surface for the boot-loop / link-quality read.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('-72 dBm')).toBeInTheDocument();
    // heap low-water mark (min heap) is rendered in KB.
    expect(screen.getByText('68 KB')).toBeInTheDocument(); // round(69916/1024)
    // firmware version rides along.
    expect(screen.getByText('carpenter')).toBeInTheDocument();
  });

  it('does NOT flag a healthy module (high uptime) as faulted', () => {
    render(<HeartbeatDiagnostics heartbeat={healthy} />);
    expect(screen.queryByText(/fault reset/)).not.toBeInTheDocument();
  });

  it('flags a recent fault reset (watchdog/panic/brownout) at low uptime', () => {
    // The ready-peach signature from #148: only boot heartbeats (~16 s
    // uptime) following a watchdog reset — the dashboard's binary
    // online/offline keeps this green, so the card must call it out.
    const faulted: HeartbeatSnapshot = {
      ...healthy,
      uptimeMs: 16_462, // ~16 s — has not sustained uptime since the fault
      bootCount: 3169, // (displayed, not part of the single-sample flag)
      resetReason: 'TASK_WDT',
    };
    render(<HeartbeatDiagnostics heartbeat={faulted} />);
    expect(screen.getByText(/recent fault reset \(TASK_WDT\)/)).toBeInTheDocument();
  });

  it('does NOT flag a healthy daily reboot (clean SW reset at low uptime, high boot count)', () => {
    // The false-positive a naive boot_count>1 && low-uptime heuristic would
    // hit: EVERY healthy module restarts itself every 24h
    // (esp-reliability.md "Daily reboot") via ESP.restart() → reset_reason
    // SW, landing at seconds-low uptime with a boot_count well past 1. A
    // clean SW reset is not a fault, so the card must stay quiet.
    const dailyReboot: HeartbeatSnapshot = {
      ...healthy,
      uptimeMs: 10_000, // 10 s — just rebooted
      bootCount: 5, // well past its first boot
      resetReason: 'SW',
    };
    render(<HeartbeatDiagnostics heartbeat={dailyReboot} />);
    expect(screen.queryByText(/fault reset/)).not.toBeInTheDocument();
  });

  it('does NOT flag a fault reset once uptime has recovered', () => {
    // A single watchdog reset that the module recovered from: the next
    // heartbeat shows uptime climbing past the threshold, so the warning
    // clears. We surface fresh faults, not historical ones.
    const recovered: HeartbeatSnapshot = {
      ...healthy,
      uptimeMs: 3_600_000, // ~1 h — recovered
      resetReason: 'TASK_WDT',
    };
    render(<HeartbeatDiagnostics heartbeat={recovered} />);
    expect(screen.queryByText(/fault reset/)).not.toBeInTheDocument();
  });

  it('does not flag a fresh power-on (POWERON) even at low uptime', () => {
    const freshBoot: HeartbeatSnapshot = {
      ...healthy,
      uptimeMs: 16_000,
      bootCount: 1,
      resetReason: 'POWERON',
    };
    render(<HeartbeatDiagnostics heartbeat={freshBoot} />);
    expect(screen.queryByText(/fault reset/)).not.toBeInTheDocument();
  });
});
