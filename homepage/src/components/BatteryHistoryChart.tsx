import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { MeasurementTimeSeries, ModuleId } from '@highfive/contracts';
import { api } from '../services/api';
import { useTranslation } from '../i18n/LanguageContext';

interface BatteryHistoryChartProps {
  moduleId: ModuleId;
}

interface ChartRow {
  timestamp: string;
  // `null` is a real value here — recharts' `connectNulls={false}` reads
  // it to break the line at the gap, which is what we want for missing
  // sensor readings (see MeasurementBucket docstring in
  // `@highfive/contracts`).
  value: number | null;
  label: string;
}

/**
 * Stub UI panel for the per-module measurements store (issue #110).
 *
 * Renders a 7-day hourly battery percentage trace fetched from
 * `GET /api/modules/:id/measurements?metric=battery_pct`. Gaps in the
 * series render as broken line segments rather than dipping to 0 —
 * missing sensor readings are unknown, not zero (the contract uses
 * `null`, recharts honours it with `connectNulls={false}`).
 *
 * Visually intentional minimal sibling to `ActivityWeatherChart`: same
 * `<section>` wrapper, same loading skeleton, same compact tooltip
 * style — so adding more metric panels in the future (temperature,
 * activity score) means cloning this file and changing one prop. ADR-
 * 016 records the rationale; the chart deliberately exposes one
 * metric only, the broader "many-metric drawer" stays future work.
 *
 * The value semantics caveat: there is no battery ADC yet, so
 * `carpenter`+ firmware OMITS battery from the heartbeat (the
 * dual-write source). This chart therefore renders honest null gaps for
 * current firmware; only older `random(1,100)` rows show a (fake) line.
 * Real sensing is issue #8a/#8b; the glossary "Measurement" carries the note.
 */
export default function BatteryHistoryChart({ moduleId }: BatteryHistoryChartProps) {
  const { t, lang } = useTranslation();
  const [series, setSeries] = useState<MeasurementTimeSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Mirror ActivityWeatherChart's ResizeObserver pattern: avoid the
  // "width(-1)" warning recharts emits when ResponsiveContainer
  // measures 0×0 on first mount. ADR-014 + chapter 11 carry the
  // history.
  const observerRef = useRef<ResizeObserver | null>(null);
  const [chartSize, setChartSize] = useState<{ w: number; h: number } | null>(null);

  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
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
    let cancelled = false;
    setLoading(true);
    setError(false);
    api
      .getMeasurements(moduleId, 'battery_pct', 'hourly', 7)
      .then((data) => {
        if (cancelled) return;
        setSeries(data);
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
  }, [moduleId]);

  const rows = useMemo<ChartRow[]>(() => {
    if (!series) return [];
    const locale = lang === 'de' ? 'de-DE' : 'en-US';
    const formatter = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
    });
    return series.buckets.map((b) => ({
      timestamp: b.timestamp,
      value: b.value,
      label: formatter.format(new Date(`${b.timestamp}Z`)),
    }));
  }, [series, lang]);

  const hasSamples = rows.some((r) => r.value !== null);

  return (
    <section
      className="px-4 md:px-5 py-4 border-t border-hf-fg-mute/20"
      data-testid="battery-history-chart"
    >
      <div className="mb-2">
        <h3 className="font-semibold text-hf-md">{t('batteryChart.title')}</h3>
        <p className="text-hf-xs text-hf-fg-mute">{t('batteryChart.subtitle')}</p>
      </div>

      {loading && (
        <div className="hf-skeleton h-40 rounded-hf-lg" role="status" aria-live="polite">
          <span className="sr-only">{t('batteryChart.loading')}</span>
        </div>
      )}

      {!loading && error && <p className="text-hf-sm text-hf-danger">{t('common.error')}</p>}

      {!loading && !error && !hasSamples && (
        <p className="text-hf-sm text-hf-fg-mute">{t('batteryChart.empty')}</p>
      )}

      {!loading && !error && hasSamples && (
        <div
          ref={setContainerRef}
          className="h-40 md:h-48 w-full"
          data-testid="battery-history-chart-canvas"
        >
          {chartSize && (
            <LineChart
              width={chartSize.w}
              height={chartSize.h}
              data={rows}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--hf-fg-mute)" opacity={0.2} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis
                tick={{ fontSize: 10 }}
                domain={[0, 100]}
                allowDecimals={false}
                label={{
                  value: t('batteryChart.axisLabel'),
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 10, textAnchor: 'middle' },
                }}
              />
              <Tooltip
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
                labelStyle={{ color: 'var(--hf-fg-mute)', fontSize: 9, marginBottom: 2 }}
                itemStyle={{ padding: 0, color: 'var(--hf-fg)' }}
                labelFormatter={(_label, payload) => {
                  const ts = payload?.[0]?.payload?.timestamp as string | undefined;
                  if (!ts) return '';
                  const locale = lang === 'de' ? 'de-DE' : 'en-US';
                  return new Date(`${ts}Z`).toLocaleString(locale);
                }}
                formatter={(value) =>
                  value === null || value === undefined || typeof value !== 'number'
                    ? '—'
                    : `${Math.round(value)} %`
                }
              />
              <Line
                type="monotone"
                dataKey="value"
                name={t('batteryChart.seriesLabel')}
                stroke="var(--hf-honey-500)"
                strokeWidth={2}
                dot={false}
                // Critical: null values must break the line, not get
                // bridged. A missing sensor reading is unknown, not
                // zero — see the component docstring and the
                // `MeasurementBucket` shape in `@highfive/contracts`.
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          )}
        </div>
      )}
    </section>
  );
}
