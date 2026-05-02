// Verification-polling regression tests for the setup wizard hook.
//
// The wizard previously detected "the new module" via a baseline diff:
// snapshot the module-id set before flashing, then poll for any id that
// wasn't in the snapshot. That heuristic silently failed for reflashed
// modules — they keep the same MAC, so the "new" module already lives in
// the baseline and never trips the predicate.
//
// The fix is to wait for the *specific* MAC the firmware advertises during
// the AP-mode form handshake. `sendConfigToEsp` now returns
// `{ moduleId }`; the hook stashes it and the polling loop waits for that
// id to appear with status === 'online'.
//
// These tests pin:
//   1. Reflash regression — the module is already in the list (offline) and
//      eventually flips to online. Detection still fires.
//   2. Fresh flash — the module isn't in the list at first, then appears.
//   3. Times out when only an unrelated module ever comes online.
//   4. Refuses to start without a captured expected id (defensive guard).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Module, ModuleId } from '@highfive/contracts';

// Mock the ESP form handshake so we don't try to talk to 192.168.4.1.
// `sendConfigToEsp` resolves with the canonical id of the device that
// would have been listed in the form's `esp_id` hidden field.
vi.mock('../components/setup/espConfig', () => ({
  sendConfigToEsp: vi.fn(),
}));

// Mock the backend client. Each test wires up `getAllModules` with its own
// poll-by-poll responses.
vi.mock('../services/api', () => ({
  api: {
    getAllModules: vi.fn(),
    getModuleById: vi.fn(),
    getModuleLogs: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue({ status: 'ok', timestamp: '' }),
  },
}));

import { sendConfigToEsp } from '../components/setup/espConfig';
import { api } from '../services/api';
import { useSetupWizard } from '../components/setup/useSetupWizard';

const sendConfigToEspMock = vi.mocked(sendConfigToEsp);
const getAllModulesMock = vi.mocked(api.getAllModules);

const EXPECTED_ID = 'aabbccddeeff' as ModuleId;
const OTHER_ID = '112233445566' as ModuleId;

// Match the `Module` interface from `@highfive/contracts`. A small builder
// keeps each test focused on the field it actually cares about (id +
// status); everything else just needs to exist with sane defaults so the
// type checker is happy.
function makeModule(overrides: Partial<Module> & Pick<Module, 'id'>): Module {
  return {
    name: 'Test Module',
    location: { lat: 0, lng: 0 },
    status: 'offline',
    lastApiCall: '2026-01-01T00:00:00Z',
    batteryLevel: 100,
    firstOnline: '2026-01-01T00:00:00Z',
    totalHatches: 0,
    imageCount: 0,
    ...overrides,
  };
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 24;

// Drive a single polling tick: advance the timer by exactly one interval
// AND flush the in-flight `api.getAllModules()` promise the tick kicks off.
// Both have to happen inside `act` to keep React's setState calls quiet.
async function tickOnce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
}

describe('useSetupWizard verification polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendConfigToEspMock.mockReset();
    getAllModulesMock.mockReset();
    sendConfigToEspMock.mockResolvedValue({ moduleId: EXPECTED_ID });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects a reflashed module (already in list, flips offline → online)', async () => {
    // The reflash regression: the same MAC was already known to the
    // backend (offline). The old "spot the new MAC" baseline diff would
    // never fire because the id is in the baseline; the new id-based
    // predicate must still detect the flip to online.
    const offline = makeModule({ id: EXPECTED_ID, status: 'offline' });
    const online = makeModule({ id: EXPECTED_ID, status: 'online' });
    getAllModulesMock
      .mockResolvedValueOnce([offline]) // poll 1: still offline
      .mockResolvedValueOnce([online]); // poll 2: online — should fire

    const { result } = renderHook(() => useSetupWizard());

    await act(async () => {
      await result.current.sendConfig();
    });
    await act(async () => {
      await result.current.startVerification();
    });

    await tickOnce();
    expect(result.current.state.detectedModule).toBeNull();

    await tickOnce();
    expect(result.current.state.detectedModule).not.toBeNull();
    expect(result.current.state.detectedModule?.id).toBe(EXPECTED_ID);
    expect(result.current.state.detectedModule?.status).toBe('online');
  });

  it('detects a fresh-flashed module (not in list at first, then appears online)', async () => {
    const online = makeModule({ id: EXPECTED_ID, status: 'online' });
    getAllModulesMock
      .mockResolvedValueOnce([]) // poll 1: nothing yet
      .mockResolvedValueOnce([online]); // poll 2: registered + online

    const { result } = renderHook(() => useSetupWizard());

    await act(async () => {
      await result.current.sendConfig();
    });
    await act(async () => {
      await result.current.startVerification();
    });

    await tickOnce();
    expect(result.current.state.detectedModule).toBeNull();

    await tickOnce();
    expect(result.current.state.detectedModule?.id).toBe(EXPECTED_ID);
  });

  it('times out when only an unrelated module ever comes online', async () => {
    // An unrelated module flips to online — the wizard must NOT latch onto
    // it. After MAX_POLLS the polling loop should set verificationTimedOut
    // and leave detectedModule null.
    const unrelated = makeModule({ id: OTHER_ID, status: 'online' });
    getAllModulesMock.mockResolvedValue([unrelated]);

    const { result } = renderHook(() => useSetupWizard());

    await act(async () => {
      await result.current.sendConfig();
    });
    await act(async () => {
      await result.current.startVerification();
    });

    // Drive past MAX_POLLS — the guard fires when pollCountRef > MAX_POLLS,
    // so we need MAX_POLLS + 1 ticks to trigger the timeout branch.
    for (let i = 0; i <= MAX_POLLS; i++) {
      await tickOnce();
    }

    expect(result.current.state.verificationTimedOut).toBe(true);
    expect(result.current.state.detectedModule).toBeNull();
  });

  it('refuses to start verification without a captured expected id', async () => {
    // Defensive guard: if sendConfig hasn't run, we have no MAC to wait
    // for. The hook should bail immediately with verificationTimedOut and
    // never schedule a polling interval.
    const { result } = renderHook(() => useSetupWizard());

    await act(async () => {
      await result.current.startVerification();
    });

    expect(result.current.state.verificationTimedOut).toBe(true);
    expect(result.current.state.detectedModule).toBeNull();
    expect(result.current.state.pollingActive).toBe(false);

    // Advance well past several poll intervals — no interval was scheduled,
    // so getAllModules must never be called.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    });
    expect(getAllModulesMock).not.toHaveBeenCalled();
  });
});
