import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MeasurementTimeSeries } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// NOTE(perf/data): <BatteryHistoryChart> is currently shelved — its only
// consumer (ModulePanel.tsx) has the import commented out because there
// is no real battery telemetry — `carpenter`+ firmware omits battery, so
// the production series is empty (the dev seed is a synthetic cosine, see
// db/schema.py; older firmware sent `random(1,100)`). These
// tests still pass but exercise a component not mounted in production
// today; keep them as re-enable scaffolding. Green here does NOT mean
// the feature is live (its Playwright gate is skipped for the same
// reason — see tests/ui/tests/module-battery-history.spec.ts).

// Mock api.getMeasurements at the service boundary — the contract under
// test is "the chart calls api.getMeasurements with (id, 'battery_pct',
// 'hourly', 7) and renders the buckets honestly". CLAUDE.md rule 3:
// mount with a realistic wire-shape fixture, not a guess.
const getMeasurements = vi.fn();
vi.mock('../services/api', () => ({
  api: {
    getMeasurements: (...args: unknown[]) => getMeasurements(...args),
  },
}));

// Recharts in jsdom does not size; mock it to plain DOM so the test
// asserts the data shape that reaches the chart rather than depending
// on a real layout pass. Same idiom as ActivityWeatherChart.test.tsx.
vi.mock('recharts', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const passthrough = (name: string) => (props: any) => (
    <div
      data-testid={`recharts-${name}`}
      data-key={props.dataKey}
      data-name={props.name}
      data-connect-nulls={String(props.connectNulls ?? '')}
    >
      {props.children}
    </div>
  );
  return {
    LineChart: ({ data, children }: { data: unknown[]; children: React.ReactNode }) => (
      <div data-testid="recharts-LineChart" data-rows={data.length}>
        {/* Stash the data as a JSON string so the test can inspect bucket
            values directly, not via post-hoc DOM scraping. */}
        <script type="application/json" data-testid="recharts-LineChart-data">
          {JSON.stringify(data)}
        </script>
        {children}
      </div>
    ),
    CartesianGrid: passthrough('CartesianGrid'),
    XAxis: passthrough('XAxis'),
    YAxis: passthrough('YAxis'),
    Tooltip: passthrough('Tooltip'),
    Line: passthrough('Line'),
  };
});

import BatteryHistoryChart from '../components/BatteryHistoryChart';

const MODULE_ID = parseModuleId('e89fa9f23a08');

/**
 * Realistic fixture matching the EXACT shape emitted by `backend
 * GET /api/modules/:id/measurements` (camelCase, sample_count → sampleCount,
 * `value: null` for gap buckets). Round-trips the wire-shape contract
 * under test — a refactor that drifts this shape away from what the
 * backend emits should fail this fixture's parsing.
 */
const wireFixture: MeasurementTimeSeries = {
  moduleId: MODULE_ID,
  metric: 'battery_pct',
  interval: 'hourly',
  start: '2026-05-13T00:00:00',
  end: '2026-05-20T00:00:00',
  buckets: [
    { timestamp: '2026-05-13T00:00:00', value: 87.5, sampleCount: 2 },
    { timestamp: '2026-05-13T01:00:00', value: null, sampleCount: 0 }, // gap
    { timestamp: '2026-05-13T02:00:00', value: 86.0, sampleCount: 1 },
  ],
};

beforeEach(() => {
  getMeasurements.mockReset();
});

const renderChart = () =>
  render(
    <LanguageProvider>
      <BatteryHistoryChart moduleId={MODULE_ID} />
    </LanguageProvider>,
  );

describe('<BatteryHistoryChart>', () => {
  it('calls api.getMeasurements with (id, "battery_pct", "hourly", 7)', async () => {
    getMeasurements.mockResolvedValue(wireFixture);
    renderChart();
    await waitFor(() => expect(getMeasurements).toHaveBeenCalled());
    expect(getMeasurements).toHaveBeenCalledWith(MODULE_ID, 'battery_pct', 'hourly', 7);
  });

  it('renders the chart with the bucket values when samples are present', async () => {
    getMeasurements.mockResolvedValue(wireFixture);
    renderChart();
    const chart = await screen.findByTestId('recharts-LineChart');
    expect(chart).toHaveAttribute('data-rows', '3');

    // Inspect the data shape that reached the chart — the wire-shape
    // round trip is the contract under test. A future refactor that
    // collapsed `null` to 0 would silently render the gap as a flat
    // line; assert the null carries through.
    const dataNode = screen.getByTestId('recharts-LineChart-data');
    const rows = JSON.parse(dataNode.textContent ?? '[]') as Array<{
      timestamp: string;
      value: number | null;
    }>;
    expect(rows.map((r) => r.value)).toEqual([87.5, null, 86.0]);
  });

  it('passes connectNulls=false to the Line so gaps render as breaks, not zero', async () => {
    getMeasurements.mockResolvedValue(wireFixture);
    renderChart();
    const line = await screen.findByTestId('recharts-Line');
    // Recharts default would bridge nulls; that would mis-render a
    // missing sensor reading as "battery dropped to zero and recovered".
    // The whole point of `value: number | null` in the contract is to
    // let the Line break visibly at the gap.
    expect(line).toHaveAttribute('data-connect-nulls', 'false');
  });

  it('shows the empty-state message when every bucket is null', async () => {
    getMeasurements.mockResolvedValue({
      ...wireFixture,
      buckets: [
        { timestamp: '2026-05-13T00:00:00', value: null, sampleCount: 0 },
        { timestamp: '2026-05-13T01:00:00', value: null, sampleCount: 0 },
      ],
    });
    renderChart();
    await waitFor(() =>
      expect(screen.getByText(/No battery readings|Keine Akkudaten/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('recharts-LineChart')).not.toBeInTheDocument();
  });

  it('renders the error state when the fetch rejects', async () => {
    getMeasurements.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => expect(screen.getByText(/error|fehler/i)).toBeInTheDocument());
  });
});
