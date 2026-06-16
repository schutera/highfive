import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ServerLogsResponse } from '@highfive/contracts';

import ServerLogsPanel from '../components/ServerLogsPanel';
import { api } from '../services/api';

// Pins the #171 admin server-logs view against the real ServerLogsResponse
// wire shape (CLAUDE.md rule 3 — realistic fixture, not a guessed object).
// api.getServerLogs is the single boundary, spied so no real fetch fires.

const backendLogs: ServerLogsResponse = {
  service: 'backend',
  lines: ['🐝 HighFive Backend API running on http://localhost:3002', '[GET /api/modules] 200'],
  truncated: false,
};

const duckdbLogs: ServerLogsResponse = {
  service: 'duckdb-service',
  lines: ['[heartbeat] mac=aabbccddeeff battery=None', '127.0.0.1 - "GET /health" 200'],
  truncated: true,
};

beforeEach(() => {
  vi.spyOn(api, 'getServerLogs').mockResolvedValue(backendLogs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ServerLogsPanel (#171)', () => {
  it('loads the backend ring on mount and renders its lines', async () => {
    render(<ServerLogsPanel />);
    await waitFor(() => expect(api.getServerLogs).toHaveBeenCalledWith('backend', 200));
    const out = await screen.findByTestId('server-logs-output');
    expect(out.textContent).toContain('HighFive Backend API running');
    expect(out.textContent).toContain('[GET /api/modules] 200');
  });

  it('refetches the selected service when the dropdown changes', async () => {
    (api.getServerLogs as ReturnType<typeof vi.fn>).mockImplementation(async (service: string) =>
      service === 'duckdb-service' ? duckdbLogs : backendLogs,
    );
    render(<ServerLogsPanel />);
    await screen.findByText(/HighFive Backend API running/);

    fireEvent.change(screen.getByTestId('log-service-select'), {
      target: { value: 'duckdb-service' },
    });

    await waitFor(() => expect(api.getServerLogs).toHaveBeenCalledWith('duckdb-service', 200));
    const out = await screen.findByTestId('server-logs-output');
    expect(out.textContent).toContain('[heartbeat] mac=aabbccddeeff');
    // truncated → the "showing most recent N" hint renders.
    expect(screen.getByText(/Showing the most recent/)).toBeTruthy();
  });

  it('shows an error message when the fetch fails', async () => {
    (api.getServerLogs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    render(<ServerLogsPanel />);
    expect(await screen.findByText(/Failed to fetch backend logs/)).toBeTruthy();
  });
});
