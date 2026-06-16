import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import type { ServerLogService } from '../services/api';

// Admin-only server-log viewer (#171). Tails a service's own recent
// stdout/stderr via GET /api/admin/logs (the app-level ring in each service).
// English-only, like the rest of AdminPage (operator-facing, no i18n consumer
// in this page — see AdminPage's existing note). See ADR-021.
const SERVICES: ServerLogService[] = ['backend', 'duckdb-service', 'image-service'];
const DEFAULT_LINES = 200;
const MAX_LINES = 1000;

export default function ServerLogsPanel() {
  const [service, setService] = useState<ServerLogService>('backend');
  const [lines, setLines] = useState(DEFAULT_LINES);
  const [log, setLog] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getServerLogs(service, lines);
      setLog(res.lines);
      setTruncated(res.truncated);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'unauthorized'
          ? 'Session expired — reload and log in again.'
          : `Failed to fetch ${service} logs. Is the service running?`,
      );
      setLog([]);
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
          <p className="text-xs text-gray-400 mb-2">Showing the most recent {log.length} lines.</p>
        )}
        {!error && log.length === 0 && !loading ? (
          <p className="text-sm text-gray-400">
            No log lines captured yet (rings reset on restart).
          </p>
        ) : (
          <pre
            data-testid="server-logs-output"
            className="bg-gray-900 text-gray-100 text-xs font-mono rounded-lg p-3 overflow-auto max-h-[28rem] whitespace-pre-wrap break-words"
          >
            {log.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
