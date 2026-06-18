import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import type { LogEntry, LogLevel, ServerLogService } from '../services/api';

// Admin-only server-log viewer (#171, #178). Tails a service's own recent
// structured log entries via GET /api/admin/logs (the app-level ring in each
// service). English-only, like the rest of AdminPage (operator-facing, no i18n
// consumer in this page — see AdminPage's existing note). See ADR-021/ADR-022.
const SERVICES: ServerLogService[] = ['backend', 'duckdb-service', 'image-service'];
const DEFAULT_LINES = 200;
const MAX_LINES = 1000;

// Tailwind classes per level. Info is muted; warn amber; error red — matches
// the access-log middleware's status→level mapping.
const LEVEL_STYLES: Record<LogLevel, { badge: string; text: string }> = {
  info: { badge: 'bg-gray-700 text-gray-200', text: 'text-gray-100' },
  warn: { badge: 'bg-amber-500 text-gray-900', text: 'text-amber-300' },
  error: { badge: 'bg-red-600 text-white', text: 'text-red-300' },
};

export default function ServerLogsPanel() {
  const [service, setService] = useState<ServerLogService>('backend');
  const [lines, setLines] = useState(DEFAULT_LINES);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getServerLogs(service, lines);
      setEntries(res.entries);
      setTruncated(res.truncated);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'unauthorized'
          ? 'Session expired — reload and log in again.'
          : `Failed to fetch ${service} logs. Is the service running?`,
      );
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [service, lines]);

  // Reload whenever the selected service changes (and on mount).
  useEffect(() => {
    load();
  }, [service]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-8 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3 justify-between">
        <h2 className="text-lg font-semibold text-gray-800">Server Logs</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="log-service" className="text-sm text-gray-600">
            Service
          </label>
          <select
            id="log-service"
            data-testid="log-service-select"
            value={service}
            onChange={(e) => setService(e.target.value as ServerLogService)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
          >
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={MAX_LINES}
            value={lines}
            onChange={(e) =>
              setLines(Math.max(1, Math.min(MAX_LINES, Number(e.target.value) || DEFAULT_LINES)))
            }
            className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
            aria-label="Number of lines"
          />
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="p-4">
        {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
        {truncated && !error && (
          <p className="text-xs text-gray-400 mb-2">
            Showing the most recent {entries.length} entries.
          </p>
        )}
        {!error && entries.length === 0 && !loading ? (
          <p className="text-sm text-gray-400">No log entries captured yet.</p>
        ) : (
          <div
            data-testid="server-logs-output"
            className="bg-gray-900 text-xs font-mono rounded-lg p-3 overflow-auto max-h-[28rem]"
          >
            {entries.map((entry, i) => {
              const style = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.info;
              return (
                <div
                  key={`${entry.ts}-${i}`}
                  data-testid="server-log-entry"
                  data-level={entry.level}
                  className="flex items-start gap-2 py-0.5 whitespace-pre-wrap break-words"
                >
                  <span className="text-gray-500 shrink-0">{entry.ts}</span>
                  <span
                    className={`shrink-0 px-1.5 rounded uppercase font-semibold ${style.badge}`}
                  >
                    {entry.level}
                  </span>
                  <span className={style.text}>{entry.msg}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
