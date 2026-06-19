import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import type { LogEntry, LogLevel, ServerLogService } from '../services/api';

// Admin-only server-log viewer (#171, #178). Tails a service's own recent
// structured log entries: a REST backfill (GET /api/admin/logs) followed by an
// SSE live tail (GET /api/admin/logs/stream). English-only, like the rest of
// AdminPage (operator-facing). See ADR-021/ADR-022.
const SERVICES: ServerLogService[] = ['backend', 'duckdb-service', 'image-service'];
const DEFAULT_LINES = 200;
const MAX_LINES = 1000;
// Cap the in-memory live list so a long-lived stream can't grow unbounded.
const MAX_LIVE_ENTRIES = 2000;

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
  const [live, setLive] = useState(false);
  // Follow mode: auto-scroll to the newest entry until the user scrolls up.
  const [follow, setFollow] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

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

  // On mount and whenever the service changes: close any prior stream, REST
  // backfill, then open the SSE live tail and append entries as they arrive.
  useEffect(() => {
    let cancelled = false;
    esRef.current?.close();
    esRef.current = null;
    setLive(false);
    setFollow(true);

    load().then(() => {
      if (cancelled) return;
      const es = api.streamServerLogs(service);
      es.addEventListener('open', () => setLive(true));
      es.addEventListener('error', () => setLive(false));
      es.addEventListener('message', (e: MessageEvent) => {
        try {
          const entry = JSON.parse(e.data) as LogEntry;
          setEntries((prev) => {
            const next = [...prev, entry];
            return next.length > MAX_LIVE_ENTRIES
              ? next.slice(next.length - MAX_LIVE_ENTRIES)
              : next;
          });
        } catch {
          // Ignore a malformed SSE payload rather than break the stream.
        }
      });
      esRef.current = es;
    });

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [service]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to the bottom on new entries while following.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, follow]);

  // Pause follow when the user scrolls up; resume when they reach the bottom.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(nearBottom);
  };

  const jumpToLatest = () => {
    setFollow(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-8 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-800">Server Logs</h2>
          <span
            data-testid="logs-live-indicator"
            data-live={live}
            className={`inline-flex items-center gap-1 text-xs font-medium ${
              live ? 'text-green-600' : 'text-gray-400'
            }`}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                live ? 'bg-green-500' : 'bg-gray-300'
              }`}
            />
            {live ? 'Live' : 'Connecting…'}
          </span>
        </div>
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

      <div className="p-4 relative">
        {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
        {truncated && !error && (
          <p className="text-xs text-gray-400 mb-2">
            Backfilled the most recent {entries.length} entries; new entries stream in live.
          </p>
        )}
        {!error && entries.length === 0 && !loading ? (
          <p className="text-sm text-gray-400">No log entries captured yet.</p>
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="server-logs-output"
            className="bg-gray-900 text-xs font-mono rounded-lg p-3 overflow-auto max-h-[32rem]"
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
        {!follow && entries.length > 0 && (
          <button
            data-testid="logs-jump-latest"
            onClick={jumpToLatest}
            className="absolute bottom-6 right-8 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium rounded-full shadow-lg"
          >
            ↓ Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
