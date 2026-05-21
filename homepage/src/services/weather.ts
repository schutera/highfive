// Open-Meteo client for the dashboard activity-vs-weather chart.
//
// Hits the public Open-Meteo Forecast API directly from the browser
// (CORS open, no API key). The endpoint accepts `past_days=N` to
// return a back-window of hourly observations + the current day, which
// is exactly what the chart needs to overlay against image-upload
// activity. If/when call-volume becomes an issue we add a backend
// proxy with a short TTL — see ADR for the rationale on starting
// keyless and browser-direct.
//
// The shape returned here intentionally mirrors `ActivityBucket` from
// `@highfive/contracts` (a `timestamp` + a number) so the chart can
// merge series by timestamp with one lookup.

export interface WeatherBucket {
  timestamp: string; // ISO 8601, hour-precision (Open-Meteo emits "2026-05-13T14:00")
  temperatureC: number | null;
  precipitationMm: number | null;
}

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    precipitation?: Array<number | null>;
  };
}

/**
 * Fetch hourly temperature + precipitation for `lat`/`lng` covering
 * the last `pastDays` days (plus today). Returns an empty array on
 * any error — the chart is designed to degrade to activity-only
 * rendering when Open-Meteo is unreachable, so a network blip should
 * not surface a red banner.
 */
export async function fetchHourlyWeather(
  lat: number,
  lng: number,
  pastDays: number,
): Promise<WeatherBucket[]> {
  // Cap mirrors the backend's `days <= 90` validation in
  // `duckdb-service/routes/modules.py::activity_timeseries`. Keeping the
  // two in sync means a future operator-facing window-size bump only
  // needs one place edited; an asymmetric cap is the kind of drift the
  // PR-104 reviewer round flagged on other features.
  const clampedPast = Math.max(1, Math.min(90, Math.round(pastDays)));
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat.toFixed(4))}` +
    `&longitude=${encodeURIComponent(lng.toFixed(4))}` +
    `&hourly=temperature_2m,precipitation` +
    `&past_days=${clampedPast}` +
    `&forecast_days=1` +
    `&timezone=UTC`;
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = (await response.json()) as OpenMeteoResponse;
    const times = data.hourly?.time ?? [];
    const temps = data.hourly?.temperature_2m ?? [];
    const precip = data.hourly?.precipitation ?? [];
    // Open-Meteo emits "YYYY-MM-DDTHH:mm" (no seconds, no TZ). Pad to
    // ":00" so the timestamp aligns byte-for-byte with the duckdb-
    // service buckets (which include `:00:00`), letting the chart
    // merge series with a plain string key lookup.
    return times.map((t, i) => ({
      timestamp: t.length === 16 ? `${t}:00` : t,
      temperatureC: temps[i] ?? null,
      precipitationMm: precip[i] ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Collapse hourly Open-Meteo samples into one bucket per UTC day so a
 * daily-interval activity chart can overlay them without painting a
 * single hour's value as if it were the day. Aggregation rules:
 *
 *   - `temperatureC`  → arithmetic mean of non-null hourly values
 *   - `precipitationMm` → sum of non-null hourly values (mm/h × hours = mm/day)
 *
 * Bucket key is `${YYYY-MM-DD}T00:00:00`, byte-for-byte aligned to the
 * duckdb-service daily aggregate timestamps so the chart's `Map.get`
 * lookup hits without further normalisation. Days where every hourly
 * sample was null collapse to `null` (not 0) so the line breaks
 * visibly instead of dragging through fake-zero.
 */
export function aggregateHourlyToDaily(hourly: WeatherBucket[]): WeatherBucket[] {
  const byDay = new Map<
    string,
    { tempSum: number; tempCount: number; precipSum: number; precipSawValue: boolean }
  >();
  for (const h of hourly) {
    // Open-Meteo's contract guarantees `YYYY-MM-DDTHH:mm` (16 chars)
    // — we pad to 19 above. Any shorter value is malformed and would
    // produce a truncated day key; drop it rather than poison the
    // aggregate.
    if (h.timestamp.length < 10) continue;
    const dayKey = h.timestamp.slice(0, 10); // "YYYY-MM-DD"
    let agg = byDay.get(dayKey);
    if (!agg) {
      agg = { tempSum: 0, tempCount: 0, precipSum: 0, precipSawValue: false };
      byDay.set(dayKey, agg);
    }
    if (h.temperatureC != null) {
      agg.tempSum += h.temperatureC;
      agg.tempCount += 1;
    }
    if (h.precipitationMm != null) {
      agg.precipSum += h.precipitationMm;
      agg.precipSawValue = true;
    }
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dayKey, agg]) => ({
      timestamp: `${dayKey}T00:00:00`,
      temperatureC: agg.tempCount > 0 ? agg.tempSum / agg.tempCount : null,
      precipitationMm: agg.precipSawValue ? agg.precipSum : null,
    }));
}
