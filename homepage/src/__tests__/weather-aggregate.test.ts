import { describe, it, expect } from 'vitest';
import { aggregateHourlyToDaily, type WeatherBucket } from '../services/weather';

describe('aggregateHourlyToDaily', () => {
  it('collapses hourly samples to one bucket per UTC day, key aligned to T00:00:00', () => {
    const hourly: WeatherBucket[] = [
      { timestamp: '2026-05-18T08:00:00', temperatureC: 10, precipitationMm: 0.2 },
      { timestamp: '2026-05-18T15:00:00', temperatureC: 20, precipitationMm: 0.4 },
      { timestamp: '2026-05-19T09:00:00', temperatureC: 14, precipitationMm: 0 },
    ];
    const daily = aggregateHourlyToDaily(hourly);
    expect(daily).toHaveLength(2);
    expect(daily[0].timestamp).toBe('2026-05-18T00:00:00');
    expect(daily[0].temperatureC).toBe(15); // (10 + 20) / 2
    expect(daily[0].precipitationMm).toBeCloseTo(0.6, 9); // 0.2 + 0.4
    expect(daily[1]).toEqual({
      timestamp: '2026-05-19T00:00:00',
      temperatureC: 14,
      precipitationMm: 0,
    });
  });

  it('collapses an all-null-temperature day to a null mean (so the line breaks visibly)', () => {
    const daily = aggregateHourlyToDaily([
      { timestamp: '2026-05-18T08:00:00', temperatureC: null, precipitationMm: 0.1 },
      { timestamp: '2026-05-18T09:00:00', temperatureC: null, precipitationMm: 0.0 },
    ]);
    expect(daily).toEqual([
      { timestamp: '2026-05-18T00:00:00', temperatureC: null, precipitationMm: 0.1 },
    ]);
  });

  it('collapses an all-null-precip day to a null sum (not 0)', () => {
    // Distinguishing "no observation" from "0 mm fell" matters for the
    // faint precipitation bar: 0 mm should still draw a zero-height
    // bar, but a null sample day should not draw anything.
    const daily = aggregateHourlyToDaily([
      { timestamp: '2026-05-18T08:00:00', temperatureC: 12, precipitationMm: null },
    ]);
    expect(daily[0].precipitationMm).toBeNull();
  });

  it('returns an empty array for an empty input', () => {
    expect(aggregateHourlyToDaily([])).toEqual([]);
  });

  it('emits days in ascending order regardless of input ordering', () => {
    const daily = aggregateHourlyToDaily([
      { timestamp: '2026-05-19T08:00:00', temperatureC: 14, precipitationMm: 0 },
      { timestamp: '2026-05-17T08:00:00', temperatureC: 9, precipitationMm: 0 },
      { timestamp: '2026-05-18T08:00:00', temperatureC: 12, precipitationMm: 0 },
    ]);
    expect(daily.map((d) => d.timestamp)).toEqual([
      '2026-05-17T00:00:00',
      '2026-05-18T00:00:00',
      '2026-05-19T00:00:00',
    ]);
  });
});
