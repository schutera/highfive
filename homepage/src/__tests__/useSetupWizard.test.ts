import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Hoisted mocks — declared before the hook import so vi rewrites
// the module graph.
const getAllModules = vi.fn();
const healthCheck = vi.fn();
vi.mock('../services/api', () => ({
  api: {
    getAllModules: (...args: unknown[]) => getAllModules(...args),
    healthCheck: (...args: unknown[]) => healthCheck(...args),
  },
}));

import { useSetupWizard } from '../components/setup/useSetupWizard';

// Issue #44: when the poll loop times out, the wizard previously set a
// single verificationTimedOut=true regardless of why. The orange "check
// the module" troubleshooting screen pointed users at completely the
// wrong remediation when the actual failure was a backend outage during
// the 2-minute poll window. The hook now distinguishes the two cases via
// a trailing-error counter.

describe('useSetupWizard.startVerification — mid-poll classification (#44)', () => {
  beforeEach(() => {
    getAllModules.mockReset();
    healthCheck.mockReset();
    healthCheck.mockResolvedValue({ status: 'ok', timestamp: '' });
    vi.useFakeTimers();
    // The hook's mount effects also fetch /firmware.json and
    // /__dev-api/lan-ip — stub those so the test isn't coupled to
    // their implementations.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 })) as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive the poll-loop interval forward by `n` ticks (POLL_INTERVAL=5s). */
  async function tick(n: number) {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }
  }

  it('classifies as backend-unreachable when all 24 polls fail', async () => {
    // Mount snapshot fetch: empty success.
    getAllModules.mockResolvedValueOnce([]);
    // Poll loop: every fetch rejects.
    getAllModules.mockRejectedValue(new Error('fetch failed'));

    const { result } = renderHook(() => useSetupWizard());
    // Drain the mount-effect promises (loadFirmware, detectLanIp,
    // snapshotModules) so subsequent assertions see the post-mount state.
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.startVerification();
    });

    // 24 ticks fire the per-poll fetch; the 25th increments
    // pollCountRef past MAX_POLLS and runs the classification.
    await tick(25);

    expect(result.current.state.verificationBackendUnreachable).toBe(true);
    expect(result.current.state.verificationTimedOut).toBe(false);
    expect(result.current.state.pollingActive).toBe(false);
  });

  it('classifies as timeout when a late poll succeeds (resetting the trailing-error counter)', async () => {
    getAllModules.mockResolvedValueOnce([]); // mount snapshot
    // First 23 poll attempts fail.
    for (let i = 0; i < 23; i++) {
      getAllModules.mockRejectedValueOnce(new Error('fetch failed'));
    }
    // 24th poll succeeds with empty array — backend is alive, but no
    // matching module appeared. Counter resets to 0; classification
    // should be the orange timeout, not the red unreachable.
    getAllModules.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useSetupWizard());
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.startVerification();
    });

    await tick(25);

    expect(result.current.state.verificationTimedOut).toBe(true);
    expect(result.current.state.verificationBackendUnreachable).toBe(false);
  });

  it('still classifies as backend-unreachable when an early poll succeeded but the trailing run is long enough', async () => {
    // Mount with a non-empty snapshot so startVerification skips its
    // fallback fetch — keeps the call accounting honest.
    getAllModules.mockResolvedValueOnce([
      { id: 'pre-existing-aabbccddeeff', name: 'Pre-existing', updatedAt: '2024-01-01' },
    ]);
    // First poll succeeds (resets counter to 0)…
    getAllModules.mockResolvedValueOnce([]);
    // …then the next 23 polls all fail. Trailing run = 23 ≥ 5.
    for (let i = 0; i < 23; i++) {
      getAllModules.mockRejectedValueOnce(new Error('fetch failed'));
    }
    // Belt-and-braces: if the loop somehow runs past the planned mocks,
    // any extra call rejects too (default returning undefined would hit
    // the success branch and silently reset the counter).
    getAllModules.mockRejectedValue(new Error('fetch failed (default)'));

    const { result } = renderHook(() => useSetupWizard());
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.startVerification();
    });

    await tick(25);

    expect(result.current.state.verificationBackendUnreachable).toBe(true);
    expect(result.current.state.verificationTimedOut).toBe(false);
  });
});
