// The canonical Module / ModuleDetail / NestData / DailyProgress types
// live in @highfive/contracts. A previous local Module declaration here
// had the wrong shape (location as a tuple, no ModuleId brand) — deleted
// in 2026-04 to remove the drift hazard.

// Nest size configuration with consistent colors across the application
export const BEE_TYPES = [
  { key: 'blackmasked', size: '2 mm', color: '#f59e0b', lightColor: '#fef3c7' },
  { key: 'resin', size: '3 mm', color: '#eab308', lightColor: '#fef9c3' },
  { key: 'leafcutter', size: '6 mm', color: '#84cc16', lightColor: '#ecfccb' },
  { key: 'orchard', size: '9 mm', color: '#22c55e', lightColor: '#dcfce7' },
] as const;

export type BeeTypeKey = (typeof BEE_TYPES)[number]['key'];
