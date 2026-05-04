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

  it('logs failed attempts with console.warn (one per failure, none on success)', async () => {
    healthCheck
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'ok', timestamp: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderWizardStep();

    // Drain the 2 s retry delay so the success path also runs. The
    // failure→success sequence is what proves we don't double-warn on
    // recovery, and that warn fires exactly once per actual failure.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[Step5] backend healthcheck 1/8 failed'),
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
