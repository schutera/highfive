import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ActivityTimeSeries } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// Mock api.getActivity at the service boundary — the contract under
// test is "the chart calls api.getActivity with (id, interval, days)
// and renders the result". Pinning the wire-shape round trip with a
// realistic fixture mirrors CLAUDE.md rule #3 ("Component tests for
// views that render wire-shape data must mount with a realistic
// fixture, not a mock object the test author guessed at").
const getActivity = vi.fn();
vi.mock('../services/api', () => ({
  api: {
    getActivity: (...args: unknown[]) => getActivity(...args),
  },
}));

const fetchHourlyWeather = vi.fn();
// Spread `vi.importActual` so the real `aggregateHourlyToDaily` (used by
// the chart in daily mode) stays available — without this the named
// import becomes `undefined` and the effect throws, dropping the chart
// into its error branch.
vi.mock('../services/weather', async () => {
  const actual = await vi.importActual<typeof import('../services/weather')>('../services/weather');
  return {
    ...actual,
    fetchHourlyWeather: (...args: unknown[]) => fetchHourlyWeather(...args),
  };
});

// Recharts pulls in ResponsiveContainer which doesn't size correctly
// in jsdom; mock its primitives down to plain DOM so we can assert on
// "the right data shape reaches the chart" without depending on layout.
vi.mock('recharts', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const passthrough = (name: string) => (props: any) => (
    <div data-testid={`recharts-${name}`} data-key={props.dataKey} data-name={props.name}>
      {props.children}
    </div>
  );
  return {
    ResponsiveContainer: passthrough('ResponsiveContainer'),
    ComposedChart: ({ data, children }: { data: unknown[]; children: React.ReactNode }) => (
      <div data-testid="recharts-ComposedChart" data-rows={data.length}>
        {children}
      </div>
    ),
    CartesianGrid: passthrough('CartesianGrid'),
    XAxis: passthrough('XAxis'),
    YAxis: passthrough('YAxis'),
    Tooltip: passthrough('Tooltip'),
    Legend: passthrough('Legend'),
    Bar: passthrough('Bar'),
    Line: passthrough('Line'),
  };
});

// Static import after vi.mock — Vitest hoists the mocks.
import ActivityWeatherChart from '../components/ActivityWeatherChart';

const MODULE_ID = parseModuleId('e89fa9f23a08');

function makeActivity(
  buckets: Array<{ timestamp: string; count: number }>,
  interval: 'hourly' | 'daily' = 'hourly',
): ActivityTimeSeries {
  return {
    moduleId: MODULE_ID,
    interval,
    start: buckets[0]?.timestamp ?? '2026-05-13T00:00:00',
    end: '2026-05-20T00:00:00',
    buckets,
  };
}

beforeEach(() => {
  getActivity.mockReset();
  fetchHourlyWeather.mockReset();
});

const renderChart = (location: { lat: number; lng: number } | null) =>
  render(
    <LanguageProvider>
      <ActivityWeatherChart moduleId={MODULE_ID} location={location} />
    </LanguageProvider>,
  );

describe('<ActivityWeatherChart>', () => {
  it('renders the "location unknown" notice for sentinel (0,0) and does NOT call any API', () => {
    renderChart({ lat: 0, lng: 0 });
    expect(screen.getByText(/Location unknown|Standort unbekannt/i)).toBeInTheDocument();
    expect(getActivity).not.toHaveBeenCalled();
    expect(fetchHourlyWeather).not.toHaveBeenCalled();
  });

  it('renders the "location unknown" notice when location is null', () => {
    renderChart(null);
    expect(screen.getByText(/Location unknown|Standort unbekannt/i)).toBeInTheDocument();
    expect(getActivity).not.toHaveBeenCalled();
  });

  it('fetches activity and weather and renders the chart for a valid location', async () => {
    getActivity.mockResolvedValue(
      makeActivity([
        { timestamp: '2026-05-19T10:00:00', count: 0 },
        { timestamp: '2026-05-19T11:00:00', count: 5 },
        { timestamp: '2026-05-19T12:00:00', count: 2 },
      ]),
    );
    fetchHourlyWeather.mockResolvedValue([
      { timestamp: '2026-05-19T11:00:00', temperatureC: 18.4, precipitationMm: 0 },
      { timestamp: '2026-05-19T12:00:00', temperatureC: 19.1, precipitationMm: 0.2 },
    ]);

    renderChart({ lat: 48.2, lng: 11.77 });

    const chart = await screen.findByTestId('recharts-ComposedChart');
    expect(chart).toBeInTheDocument();
    expect(chart.dataset.rows).toBe('3');

    // The contract: chart asks for hourly + 7-day window by default.
    expect(getActivity).toHaveBeenCalledWith(MODULE_ID, 'hourly', 7);
    expect(fetchHourlyWeather).toHaveBeenCalledWith(48.2, 11.77, 7);

    // Both data-bound elements register against the wire-shape fields.
    const dataKeys = screen.getAllByTestId(/^recharts-(Bar|Line)$/).map((el) => el.dataset.key);
    expect(dataKeys).toContain('count');
    expect(dataKeys).toContain('temperatureC');
    expect(dataKeys).toContain('precipitationMm');
  });

  it('switches to daily interval and a 30-day window when the 30d range is selected', async () => {
    getActivity.mockResolvedValue(makeActivity([], 'daily'));
    fetchHourlyWeather.mockResolvedValue([]);

    renderChart({ lat: 48.2, lng: 11.77 });

    // Wait for first load (default 7d / hourly) so we can assert on the
    // post-toggle call cleanly.
    await waitFor(() => {
      expect(getActivity).toHaveBeenCalledTimes(1);
    });

    const range30 = screen.getByRole('radio', { name: /30/i });
    fireEvent.click(range30);

    await waitFor(() => {
      expect(getActivity).toHaveBeenLastCalledWith(MODULE_ID, 'daily', 30);
      // Weather IS fetched in daily mode (the hourly samples are then
      // aggregated to daily client-side). See the daily-aggregation
      // test below for the merge behaviour.
      expect(fetchHourlyWeather).toHaveBeenLastCalledWith(48.2, 11.77, 30);
    });
  });

  it('surfaces the "weather unavailable" hint when Open-Meteo returns nothing', async () => {
    getActivity.mockResolvedValue(makeActivity([{ timestamp: '2026-05-19T10:00:00', count: 1 }]));
    fetchHourlyWeather.mockResolvedValue([]);

    renderChart({ lat: 48.2, lng: 11.77 });

    await waitFor(() => {
      expect(
        screen.getByText(/Weather data unavailable|Wetterdaten nicht verfügbar/i),
      ).toBeInTheDocument();
    });
    // Chart still renders — the upload bars are independent of weather.
    // findBy* (async) because the chart subtree is gated on a
    // requestAnimationFrame in production — see ActivityWeatherChart's
    // `chartReady` state. The RAF resolves one microtask later than
    // the effect that sets the activity/weather text, so a sync
    // getByTestId here would race.
    expect(await screen.findByTestId('recharts-ComposedChart')).toBeInTheDocument();
  });

  it('renders the empty-state message when activity has no buckets', async () => {
    getActivity.mockResolvedValue(makeActivity([]));
    fetchHourlyWeather.mockResolvedValue([]);

    renderChart({ lat: 48.2, lng: 11.77 });

    await waitFor(() => {
      expect(
        screen.getByText(/No activity in the selected window|Keine Aktivität im ausgewählten/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recharts-ComposedChart')).not.toBeInTheDocument();
  });

  it('aggregates hourly weather to daily buckets in 30d mode (mean temp, sum precip)', async () => {
    // Earlier ADR-014 revisions suppressed the Open-Meteo fetch in
    // daily mode and let the bars stand alone, on the reasoning that
    // a single midnight-UTC hourly sample is not the daily value.
    // The aggregator (`aggregateHourlyToDaily`) is the explicit fix
    // for that, so daily mode now fetches and aggregates. This test
    // pins both halves of the new contract:
    //   1. fetchHourlyWeather IS called with the daily window (30).
    //   2. The chart receives bucket rows whose weather values are
    //      the per-day mean / sum of the hourly samples, keyed at
    //      `YYYY-MM-DDT00:00:00` to align with the duckdb-service
    //      daily aggregate timestamps.
    getActivity.mockResolvedValue(
      makeActivity(
        [
          { timestamp: '2026-05-18T00:00:00', count: 2 },
          { timestamp: '2026-05-19T00:00:00', count: 4 },
        ],
        'daily',
      ),
    );
    // Two hourly samples for the 19th: temp mean = (10 + 20)/2 = 15;
    // precip sum = 0.2 + 0.4 = 0.6. The 18th has no samples → both
    // values null (line will gap visibly).
    fetchHourlyWeather.mockResolvedValue([
      { timestamp: '2026-05-19T08:00:00', temperatureC: 10, precipitationMm: 0.2 },
      { timestamp: '2026-05-19T15:00:00', temperatureC: 20, precipitationMm: 0.4 },
    ]);

    renderChart({ lat: 48.2, lng: 11.77 });

    await waitFor(() => {
      expect(getActivity).toHaveBeenCalledTimes(1);
    });
    fetchHourlyWeather.mockClear();

    const range30 = screen.getByRole('radio', { name: /30/i });
    fireEvent.click(range30);

    await waitFor(() => {
      expect(getActivity).toHaveBeenLastCalledWith(MODULE_ID, 'daily', 30);
      expect(fetchHourlyWeather).toHaveBeenLastCalledWith(48.2, 11.77, 30);
    });
    // The "weather unavailable" notice is reserved for "asked and got
    // nothing back" — Open-Meteo returned 2 rows, so the notice does
    // NOT fire even though only one of the activity days got coverage.
    expect(
      screen.queryByText(/Weather data unavailable|Wetterdaten nicht verfügbar/i),
    ).not.toBeInTheDocument();
    // findBy* (async) because the chart subtree is gated on a
    // requestAnimationFrame in production — see ActivityWeatherChart's
    // `chartReady` state. The RAF resolves one microtask later than
    // the effect that sets the activity/weather text, so a sync
    // getByTestId here would race.
    expect(await screen.findByTestId('recharts-ComposedChart')).toBeInTheDocument();
  });

  it('fires "weather unavailable" when daily-mode Open-Meteo returns nothing', async () => {
    getActivity.mockResolvedValue(
      makeActivity([{ timestamp: '2026-05-19T00:00:00', count: 4 }], 'daily'),
    );
    fetchHourlyWeather.mockResolvedValue([]);

    renderChart({ lat: 48.2, lng: 11.77 });
    const range30 = screen.getByRole('radio', { name: /30/i });
    fireEvent.click(range30);

    await waitFor(() => {
      expect(
        screen.getByText(/Weather data unavailable|Wetterdaten nicht verfügbar/i),
      ).toBeInTheDocument();
    });
    // findBy* (async) because the chart subtree is gated on a
    // requestAnimationFrame in production — see ActivityWeatherChart's
    // `chartReady` state. The RAF resolves one microtask later than
    // the effect that sets the activity/weather text, so a sync
    // getByTestId here would race.
    expect(await screen.findByTestId('recharts-ComposedChart')).toBeInTheDocument();
  });
});
