import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ActivityTimeSeries } from '@highfive/contracts';
import { api } from '../services/api';
import { fetchHourlyWeather, type WeatherBucket } from '../services/weather';
import { hasPlausibleLocation } from '../lib/location';
import { useTranslation } from '../i18n/LanguageContext';

type Range = 1 | 7 | 30;

interface ActivityWeatherChartProps {
  moduleId: string;
  location: { lat: number; lng: number } | null | undefined;
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

  const locationOk = hasPlausibleLocation(location ?? null);

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
    const weatherPromise = fetchHourlyWeather(location!.lat, location!.lng, range);
    Promise.all([activityPromise, weatherPromise.catch(() => [] as WeatherBucket[])])
      .then(([act, wx]) => {
        if (cancelled) return;
        setActivity(act);
        setWeather(wx);
        // If the location is known but Open-Meteo returned nothing,
        // surface a soft notice so the operator knows the overlay is
        // missing rather than thinking the weather was perfectly flat.
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

  // Merge series by bucket-start timestamp. Daily activity buckets
  // skip the weather merge (Open-Meteo is hourly) — the chart still
  // renders the bar series alone in that mode.
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
          <div className="h-48 md:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
            </ResponsiveContainer>
          </div>
        </>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="text-hf-sm text-hf-fg-mute">{t('activityChart.empty')}</p>
      )}
    </section>
  );
}
