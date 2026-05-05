import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';

// Hoisted mock — must be declared before the component import below so vi
// rewrites the module graph.
const healthCheck = vi.fn();
vi.mock('../services/api', () => ({
  api: {
    healthCheck: (...args: unknown[]) => healthCheck(...args),
  },
}));

import Step5Verify from '../components/setup/Step5Verify';

function renderWizardStep(startVerification: () => void = () => {}) {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <Step5Verify
          pollingActive={true}
          detectedModule={null}
          verificationTimedOut={false}
          startVerification={startVerification}
          onBack={() => {}}
        />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

describe('Step5Verify retry visibility', () => {
  beforeEach(() => {
    healthCheck.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces the attempt counter through successive retries', async () => {
    healthCheck
      .mockRejectedValueOnce(new Error('handover-gap'))
      .mockRejectedValueOnce(new Error('handover-gap'))
      .mockResolvedValueOnce({ status: 'ok', timestamp: '' });
    const startVerification = vi.fn();

    renderWizardStep(startVerification);

    // First attempt fires synchronously inside the mount effect; flush
    // microtasks so the rejection lands in the catch block and the
    // component re-renders with healthAttempt = {1, 8}.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/1\/8/)).toBeInTheDocument();

    // Drain the 2 s retry delay → second attempt fires → rejects → "2/8".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText(/2\/8/)).toBeInTheDocument();

    // Third attempt resolves. The counter clears and verification kicks
    // off — that's the user-visible "we made it through the WiFi
    // handover" signal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(startVerification).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/\d\/8/)).not.toBeInTheDocument();
  });

  it('logs exactly one console.warn per failed attempt (and none on the eventual success)', async () => {
    // Three failures then success — three warns expected, in order. Mocking
    // a sequence longer than one rejection is what lets the test detect a
    // "two warns per single failure" regression.
    healthCheck
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockRejectedValueOnce(new Error('boom-3'))
      .mockResolvedValueOnce({ status: 'ok', timestamp: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderWizardStep();

    // Drain three 2 s retry delays so all three rejections + the success
    // resolution fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('[Step5] backend healthcheck 1/8 failed'),
      expect.any(Error),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('[Step5] backend healthcheck 2/8 failed'),
      expect.any(Error),
    );
    expect(warn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('[Step5] backend healthcheck 3/8 failed'),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('renders the unreachable-screen alert when all 8 attempts fail', async () => {
    // The branch the silent-retry feature exists for. Eight rejections,
    // no success: the spinner gives way to the red unreachable screen
    // (role=alert) and verification is NOT started.
    for (let i = 0; i < 8; i++) {
      healthCheck.mockRejectedValueOnce(new Error(`fail-${i + 1}`));
    }
    const startVerification = vi.fn();

    renderWizardStep(startVerification);

    // Drain all eight attempts × 2 s retry delay (~14 s). Add a small
    // buffer to flush any trailing microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8 * 2000 + 100);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Backend Server Not Reachable/i)).toBeInTheDocument();
    expect(startVerification).not.toHaveBeenCalled();
    // Two-sided: pin the attempt count too. If anyone bumps MAX_ATTEMPTS
    // past 8 without updating this test, the 9th call would see the
    // vitest auto-mock (returns undefined → component treats as success)
    // and the unreachable branch would silently stop being exercised.
    expect(healthCheck).toHaveBeenCalledTimes(8);
  });
});
