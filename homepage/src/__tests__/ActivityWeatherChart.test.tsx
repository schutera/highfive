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
vi.mock('../services/weather', () => ({
  fetchHourlyWeather: (...args: unknown[]) => fetchHourlyWeather(...args),
}));

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
    });
    // Weather fetch is intentionally NOT triggered for daily mode — see
    // the dedicated daily-mode test below for the rationale.
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
    expect(screen.getByTestId('recharts-ComposedChart')).toBeInTheDocument();
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

  it('does NOT fetch Open-Meteo in daily (30d) mode and does not render the weather-unavailable hint', async () => {
    // Reviewer P1: a stale comment claimed "daily mode skips the
    // weather merge" while the code merged anyway, painting "midnight
    // UTC temperature" as if it were the daily value. The fix gates the
    // fetch on `interval === 'hourly'`. Pinned here so a regression
    // re-enabling the call shows up at test time.
    //
    // The mount-time render is in the default 7d/hourly window — that
    // call DOES legitimately hit fetchHourlyWeather. We clear the spy
    // after that initial load so the "did the daily click trigger a
    // fetch?" assertion below isn't contaminated by the mount call.
    getActivity.mockResolvedValue(
      makeActivity([{ timestamp: '2026-05-19T00:00:00', count: 4 }], 'daily'),
    );
    fetchHourlyWeather.mockResolvedValue([]);

    renderChart({ lat: 48.2, lng: 11.77 });

    await waitFor(() => {
      expect(getActivity).toHaveBeenCalledTimes(1);
    });
    fetchHourlyWeather.mockClear();

    const range30 = screen.getByRole('radio', { name: /30/i });
    fireEvent.click(range30);

    await waitFor(() => {
      expect(getActivity).toHaveBeenLastCalledWith(MODULE_ID, 'daily', 30);
    });
    expect(fetchHourlyWeather).not.toHaveBeenCalled();
    // The "weather unavailable" notice is reserved for "asked, got
    // nothing" — silent daily mode is by design, not a failure.
    expect(
      screen.queryByText(/Weather data unavailable|Wetterdaten nicht verfügbar/i),
    ).not.toBeInTheDocument();
  });
});
