import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ServerLogsResponse } from '@highfive/contracts';

import ServerLogsPanel from '../components/ServerLogsPanel';
import { api } from '../services/api';

// Pins the #171/#178 admin server-logs view against the real ServerLogsResponse
// wire shape (CLAUDE.md rule 3 — realistic fixture, not a guessed object).
// api.getServerLogs is the single boundary, spied so no real fetch fires.

const backendLogs: ServerLogsResponse = {
  service: 'backend',
  entries: [
    {
      ts: '2026-06-18T20:42:55.000Z',
      level: 'info',
      msg: '🐝 HighFive Backend API listening on port 3002 (all interfaces)',
    },
    { ts: '2026-06-18T20:42:56.000Z', level: 'info', msg: 'GET /api/modules 200 4ms' },
  ],
  truncated: false,
};

const duckdbLogs: ServerLogsResponse = {
  service: 'duckdb-service',
  entries: [
    { ts: '2026-06-18T20:43:00.000Z', level: 'info', msg: '[heartbeat] mac=aabbccddeeff battery=None' },
    { ts: '2026-06-18T20:43:01.000Z', level: 'error', msg: 'GET /health 500 12ms' },
  ],
  truncated: true,
};

beforeEach(() => {
  vi.spyOn(api, 'getServerLogs').mockResolvedValue(backendLogs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ServerLogsPanel (#171/#178)', () => {
  it('loads the backend ring on mount and renders structured entries', async () => {
    render(<ServerLogsPanel />);
    await waitFor(() => expect(api.getServerLogs).toHaveBeenCalledWith('backend', 200));
    const out = await screen.findByTestId('server-logs-output');
    expect(out.textContent).toContain('HighFive Backend API listening on port 3002');
    expect(out.textContent).toContain('GET /api/modules 200 4ms');
    // Each entry renders its ISO timestamp and level badge.
    expect(out.textContent).toContain('2026-06-18T20:42:55.000Z');
    const rows = screen.getAllByTestId('server-log-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-level')).toBe('info');
  });

  it('color-codes by level (error entries carry data-level=error)', async () => {
    (api.getServerLogs as ReturnType<typeof vi.fn>).mockResolvedValue(duckdbLogs);
    render(<ServerLogsPanel />);
    const out = await screen.findByTestId('server-logs-output');
    expect(out.textContent).toContain('GET /health 500 12ms');
    const errorRow = screen
      .getAllByTestId('server-log-entry')
      .find((r) => r.getAttribute('data-level') === 'error');
    expect(errorRow).toBeTruthy();
  });

  it('refetches the selected service when the dropdown changes', async () => {
    (api.getServerLogs as ReturnType<typeof vi.fn>).mockImplementation(async (service: string) =>
      service === 'duckdb-service' ? duckdbLogs : backendLogs,
    );
    render(<ServerLogsPanel />);
    await screen.findByText(/HighFive Backend API listening/);

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
