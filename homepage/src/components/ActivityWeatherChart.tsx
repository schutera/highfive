import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from 'recharts';
import type { ActivityTimeSeries, Module, ModuleId } from '@highfive/contracts';
import { api } from '../services/api';
import {
  aggregateHourlyToDaily,
  fetchHourlyWeather,
  type WeatherBucket,
} from '../services/weather';
import { hasPlausibleLocation } from '../lib/location';
import { useTranslation } from '../i18n/LanguageContext';

type Range = 1 | 7 | 30;

// Bound to the contracts shape (mirrors `lib/location.ts::hasPlausibleLocation`)
// so a future `location.lat → location.latitude` rename in `@highfive/contracts`
// becomes a compile error here instead of a silent `undefined`-pluck. ADR-004
// "wire-shape drift becomes a compile error" depends on consumers actually
// taking the branded/derived types.
interface ActivityWeatherChartProps {
  moduleId: ModuleId;
  location: Pick<Module['location'], 'lat' | 'lng'> | null | undefined;
}

interface ChartRow {
  timestamp: string;
  count: number;
  temperatureC: number | null;
  precipitationMm: number | null;
  label: string;
}

export default function ActivityWeatherChart({ moduleId, location }: ActivityWeatherChartProps) {
  const { t, lang } = useTranslation();
  const [range, setRange] = useState<Range>(7);
  const [activity, setActivity] = useState<ActivityTimeSeries | null>(null);
  const [weather, setWeather] = useState<WeatherBucket[]>([]);
  const [weatherFailed, setWeatherFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Recharts' ResponsiveContainer measures its wrapper synchronously
  // on mount, sees 0×0 before the first browser paint, and logs a
  // noisy "width(-1) of chart should be greater than 0" — once per
  // child component, per render pass, so ~7 console entries every
  // time a module panel opens. `minWidth/minHeight=0` only soften
  // the warning text; gating on `requestAnimationFrame` doesn't help
  // either because Recharts' measure loop runs at mount. We bypass
  // the container entirely: a ResizeObserver attached to our own
  // wrapper feeds explicit numeric `width`/`height` to ComposedChart,
  // which then skips the measurement path that emits the warning.
  const observerRef = useRef<ResizeObserver | null>(null);
  const [chartSize, setChartSize] = useState<{ w: number; h: number } | null>(null);

  const locationOk = hasPlausibleLocation(location ?? null);

  // Callback ref so the ResizeObserver attaches the moment the chart
  // wrapper div mounts — which is only AFTER activity data loads,
  // since the wrapper sits inside the `rows.length > 0` branch. A
  // plain `useRef` + effect would have measured `null` on first
  // commit and never re-run.
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    // ResizeObserver fires once for the initial size as soon as
    // `observe()` is called (per spec), so we don't need a separate
    // `getBoundingClientRect` pass — the observer's first delivery
    // is the synchronous-on-modern-browsers measurement we'd get
    // from the rect anyway, just routed through the same code path
    // that subsequent resize updates take.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        if (cr.width > 0 && cr.height > 0) {
          setChartSize((prev) =>
            prev && prev.w === cr.width && prev.h === cr.height
              ? prev
              : { w: cr.width, h: cr.height },
          );
        }
      }
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    // Guard the effect, not just the JSX — fetching activity for a
    // chart we never render is wasted bandwidth, and the matching
    // `useEffect`-side test pin keeps a future refactor from
    // silently restoring the load.
    if (!locationOk) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setWeatherFailed(false);
    const interval: 'hourly' | 'daily' = range === 30 ? 'daily' : 'hourly';
    const activityPromise = api.getActivity(moduleId, interval, range);
    // Open-Meteo only emits hourly samples. In daily-interval mode we
    // still fetch the hourly series for the full window and aggregate
    // client-side (mean temperature, summed precipitation) into one
    // bucket per UTC day — see `aggregateHourlyToDaily` in
    // `services/weather.ts`. Earlier revisions skipped the call to
    // avoid painting a single midnight-UTC sample as the daily value;
    // the aggregator is the explicit fix for that, so the call is
    // always made when location is plausible.
    const weatherPromise: Promise<WeatherBucket[]> = fetchHourlyWeather(
      location!.lat,
      location!.lng,
      range,
    );
    Promise.all([activityPromise, weatherPromise.catch(() => [] as WeatherBucket[])])
      .then(([act, wx]) => {
        if (cancelled) return;
        setActivity(act);
        const finalWeather = interval === 'daily' ? aggregateHourlyToDaily(wx) : wx;
        setWeather(finalWeather);
        // "Weather unavailable" fires whenever we asked for weather and
        // got nothing back — true for hourly AND daily, since both
        // depend on Open-Meteo reachability.
        setWeatherFailed(wx.length === 0);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, range, location?.lat, location?.lng, locationOk]);

  // Merge series by bucket-start timestamp. In daily mode the weather
  // array is the result of `aggregateHourlyToDaily` and its keys are
  // `${YYYY-MM-DD}T00:00:00` — byte-aligned with the duckdb-service
  // daily activity buckets. In hourly mode it is the raw Open-Meteo
  // hourly series. Either way `weatherByTs.get(timestamp)` returns the
  // matching weather sample for the activity bucket; missing samples
  // collapse to `null` so the Line breaks visibly instead of
  // interpolating through zero.
  const rows = useMemo<ChartRow[]>(() => {
    if (!activity) return [];
    const weatherByTs = new Map(weather.map((w) => [w.timestamp, w]));
    const locale = lang === 'de' ? 'de-DE' : 'en-US';
    const formatter =
      activity.interval === 'hourly'
        ? new Intl.DateTimeFormat(locale, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
          })
        : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    return activity.buckets.map((b) => {
      const wx = weatherByTs.get(b.timestamp);
      return {
        timestamp: b.timestamp,
        count: b.count,
        temperatureC: wx?.temperatureC ?? null,
        precipitationMm: wx?.precipitationMm ?? null,
        // The X-axis renders this short label; the tooltip uses the
        // full ISO timestamp via Recharts' `labelFormatter` below.
        label: formatter.format(new Date(`${b.timestamp}Z`)),
      };
    });
  }, [activity, weather, lang]);

  if (!locationOk) {
    return (
      <section className="px-4 md:px-5 py-4 border-t border-hf-fg-mute/20">
        <h3 className="font-semibold text-hf-md mb-1">{t('activityChart.title')}</h3>
        <p className="text-hf-sm text-hf-fg-mute">{t('activityChart.locationUnknown')}</p>
      </section>
    );
  }

  return (
    <section className="px-4 md:px-5 py-4 border-t border-hf-fg-mute/20">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <h3 className="font-semibold text-hf-md">{t('activityChart.title')}</h3>
          <p className="text-hf-xs text-hf-fg-mute">{t('activityChart.subtitle')}</p>
        </div>
        <div role="radiogroup" aria-label={t('activityChart.title')} className="flex gap-1">
          {([1, 7, 30] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              onClick={() => setRange(r)}
              className={`px-2 py-1 text-hf-xs rounded ${
                range === r
                  ? 'bg-hf-honey-500 text-white'
                  : 'bg-hf-fg-mute/10 hover:bg-hf-fg-mute/20'
              }`}
            >
              {r === 1
                ? t('activityChart.rangeDay')
                : r === 7
                  ? t('activityChart.rangeWeek')
                  : t('activityChart.rangeMonth')}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="hf-skeleton h-48 rounded-hf-lg" role="status" aria-live="polite">
          <span className="sr-only">{t('activityChart.loading')}</span>
        </div>
      )}

      {!loading && error && <p className="text-hf-sm text-hf-danger">{t('common.error')}</p>}

      {!loading && !error && rows.length > 0 && (
        <>
          {weatherFailed && (
            <p className="text-hf-xs text-hf-fg-mute mb-2">
              {t('activityChart.weatherUnavailable')}
            </p>
          )}
          <div ref={setContainerRef} className="h-48 md:h-64 w-full">
            {chartSize && (
              <ComposedChart
                width={chartSize.w}
                height={chartSize.h}
                data={rows}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hf-fg-mute)" opacity={0.2} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis
                  yAxisId="uploads"
                  tick={{ fontSize: 10 }}
                  allowDecimals={false}
                  label={{
                    value: t('activityChart.uploadsAxis'),
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 10, textAnchor: 'middle' },
                  }}
                />
                <YAxis
                  yAxisId="weather"
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  label={{
                    value: t('activityChart.temperatureAxis'),
                    angle: 90,
                    position: 'insideRight',
                    style: { fontSize: 10, textAnchor: 'middle' },
                  }}
                />
                <Tooltip
                  // Recharts' default tooltip is a hardcoded white box that
                  // ignores the theme tokens and, on the narrow ModulePanel
                  // chart, covers half the plot area. Pin compact dims + HF
                  // tokens so it sits as a small overlay readable in both
                  // light and dark themes. `offset` nudges it off the cursor
                  // so the underlying bar/line stays visible while hovered.
                  cursor={{
                    stroke: 'var(--hf-fg-mute)',
                    strokeOpacity: 0.4,
                    strokeDasharray: '3 3',
                  }}
                  offset={16}
                  wrapperStyle={{ outline: 'none', zIndex: 10 }}
                  contentStyle={{
                    background: 'color-mix(in oklch, var(--hf-bg-elev) 94%, transparent)',
                    border: '1px solid var(--hf-border)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-2)',
                    padding: '6px 8px',
                    fontSize: 10,
                    lineHeight: 1.35,
                    color: 'var(--hf-fg)',
                  }}
                  labelStyle={{
                    color: 'var(--hf-fg-mute)',
                    fontSize: 9,
                    marginBottom: 2,
                  }}
                  itemStyle={{ padding: 0, color: 'var(--hf-fg)' }}
                  labelFormatter={(_label, payload) => {
                    const ts = payload?.[0]?.payload?.timestamp as string | undefined;
                    if (!ts) return '';
                    const locale = lang === 'de' ? 'de-DE' : 'en-US';
                    return new Date(`${ts}Z`).toLocaleString(locale);
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  yAxisId="uploads"
                  dataKey="count"
                  name={t('activityChart.uploadsLabel')}
                  fill="var(--hf-honey-500)"
                />
                <Bar
                  yAxisId="weather"
                  dataKey="precipitationMm"
                  name={t('activityChart.precipitationLabel')}
                  fill="var(--hf-honey-200)"
                  opacity={0.6}
                />
                <Line
                  yAxisId="weather"
                  type="monotone"
                  dataKey="temperatureC"
                  name={t('activityChart.temperatureAxis')}
                  stroke="var(--hf-success)"
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                />
              </ComposedChart>
            )}
          </div>
        </>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="text-hf-sm text-hf-fg-mute">{t('activityChart.empty')}</p>
      )}
    </section>
  );
}
