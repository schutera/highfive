import { useEffect, useState } from 'react';
import { api, ModuleDetail, TelemetryEntry } from '../services/api';
import { BEE_TYPES } from '../types';
import { useTranslation } from '../i18n/LanguageContext';

// Admin-only UI is unlocked by opening the dashboard with ?admin=1 in the URL.
// The flag persists in sessionStorage so it survives navigation within the
// session but is gone after the tab is closed.
function isAdminMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('admin') === '1') {
    sessionStorage.setItem('hf_admin', '1');
    return true;
  }
  return sessionStorage.getItem('hf_admin') === '1';
}

interface ModulePanelProps {
  module: { id: string; name: string; status: 'online' | 'offline' };
  onClose: () => void;
  onError: (error: string) => void;
}

export default function ModulePanel({ module, onClose, onError }: ModulePanelProps) {
  const { t, lang } = useTranslation();
  const [moduleDetail, setModuleDetail] = useState<ModuleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [logs, setLogs] = useState<TelemetryEntry[] | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const adminMode = isAdminMode();

  useEffect(() => {
    loadModuleDetail();
    setLogs(null);
    setLogsOpen(false);
    setLogsError(null);
  }, [module.id]);

  const loadModuleDetail = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getModuleById(module.id);
      setModuleDetail(data);
    } catch (err) {
      const errorMsg = t('modulePanel.failedToLoad');
      setError(errorMsg);
      console.error('Error loading module details:', err);
      onError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const ensureAdminKey = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (sessionStorage.getItem('hf_admin_key')) return true;
    const entered = window.prompt('Enter admin key to view telemetry');
    if (!entered) return false;
    sessionStorage.setItem('hf_admin_key', entered);
    return true;
  };

  const loadLogs = async () => {
    if (!ensureAdminKey()) {
      setLogsError('Admin key required');
      return;
    }
    try {
      setLogsLoading(true);
      setLogsError(null);
      const data = await api.getModuleLogs(module.id, 10);
      setLogs(data);
    } catch (err) {
      console.error('Error loading telemetry:', err);
      if (err instanceof Error && err.message === 'unauthorized') {
        setLogsError('Invalid admin key — click Refresh to re-enter');
      } else {
        setLogsError('Failed to load telemetry');
      }
    } finally {
      setLogsLoading(false);
    }
  };

  const toggleLogs = () => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next && logs === null && !logsLoading) {
      loadLogs();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-600">{t('common.loading')}</div>
      </div>
    );
  }

  if (error || !moduleDetail) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-600">{error || t('modulePanel.moduleNotFound')}</div>
      </div>
    );
  }

  const isOnline = moduleDetail.status === 'online';
  const lastApiCall = new Date(moduleDetail.lastApiCall);
  // const batteryLevel = Math.round(moduleDetail.batteryLevel);
  // const batteryColor = batteryLevel > 50 ? 'text-green-500' : batteryLevel > 20 ? 'text-amber-500' : 'text-red-500';

  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  const formattedTime = lastApiCall.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Calculate totals per bee type and get latest progress
  const beeTypeSummaries = BEE_TYPES.map((beeType) => {
    const nestsForType = moduleDetail.nests.filter((n) => n.beeType === beeType.key);
    const totalHatched = nestsForType.reduce((sum, nest) => {
      const latestData = nest.dailyProgress[nest.dailyProgress.length - 1];
      return sum + (latestData?.hatched || 0);
    }, 0);

    return {
      ...beeType,
      nests: nestsForType.map((nest) => {
        const latestData = nest.dailyProgress[nest.dailyProgress.length - 1];
        return {
          nest_id: nest.nest_id,
          sealed: latestData?.sealed || 0,
          hatched: latestData?.hatched || 0,
        };
      }),
      totalHatched,
    };
  });

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-amber-50/50 to-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-4 md:p-5 text-white relative">
        {/* Desktop close button - hidden on mobile since parent handles it */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-white/80 hover:text-white hover:bg-white/20 rounded-full p-1.5 transition-colors hidden md:flex items-center justify-center"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        <div className="pr-0 md:pr-8">
          <h2 className="text-xl md:text-2xl font-bold mb-2 md:mb-3">{moduleDetail.name}</h2>

          <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2">
            {/* Status Badge */}
            <div
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${isOnline ? 'bg-green-500/90' : 'bg-gray-500/90'}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-white animate-pulse' : 'bg-white/70'}`}
              />
              {isOnline ? t('common.online') : t('common.offline')}
            </div>

            {/* Image Count Badge */}
            <div className="inline-flex items-center gap-1.5 bg-white/20 rounded-full px-3 py-1 text-xs font-semibold">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              {moduleDetail.imageCount} {t('modulePanel.images')}
            </div>
          </div>

          <div className="text-amber-100/90 text-xs">
            <div>{t('modulePanel.lastUpdate', { time: formattedTime })}</div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Telemetry / Logs — admin view (unlock via ?admin=1) */}
        {adminMode && (
          <div className="mb-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
            <button
              onClick={toggleLogs}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors"
            >
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 17v-2a4 4 0 014-4h4m0 0l-3-3m3 3l-3 3M3 7h6a2 2 0 012 2v10a2 2 0 01-2 2H3"
                  />
                </svg>
                <span className="font-semibold text-sm text-gray-800">Telemetry</span>
                {logs && logs.length > 0 && (
                  <span className="text-xs text-gray-500">({logs.length})</span>
                )}
              </div>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${logsOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {logsOpen && (
              <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50">
                {logsLoading && <div className="text-xs text-gray-500">Loading telemetry…</div>}
                {logsError && <div className="text-xs text-red-600">{logsError}</div>}
                {!logsLoading && !logsError && logs && logs.length === 0 && (
                  <div className="text-xs text-gray-500">
                    No telemetry yet. Logs arrive with each uploaded image.
                  </div>
                )}
                {!logsLoading &&
                  logs &&
                  logs.map((entry, i) => <TelemetryRow key={i} entry={entry} />)}
                {logs && logs.length > 0 && (
                  <button
                    onClick={loadLogs}
                    className="text-xs text-amber-600 hover:text-amber-700 font-medium"
                  >
                    Refresh
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Species Cards - Responsive grid on larger mobile, stack on small */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 gap-3 md:gap-4">
          {beeTypeSummaries.map((summary) => (
            <div key={summary.key}>
              {/* Summary Card */}
              <div
                className="rounded-xl p-3 md:p-4 shadow-sm border-2 transition-transform active:scale-[0.98] md:active:scale-100"
                style={{
                  backgroundColor: summary.lightColor,
                  borderColor: summary.color,
                }}
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div
                      className="text-base md:text-lg font-bold"
                      style={{ color: summary.color }}
                    >
                      {summary.size}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className="text-2xl md:text-3xl font-bold"
                      style={{ color: summary.color }}
                    >
                      {summary.totalHatched}
                    </div>
                    <div className="text-xs text-gray-500">{t('modulePanel.hatches')}</div>
                  </div>
                </div>

                {/* Individual nest progress bars */}
                <div className="space-y-2 mt-3">
                  {summary.nests.map((nest, index) => (
                    <div key={nest.nest_id}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-600 font-medium">
                          {t('modulePanel.nest', { index: index + 1 })}
                        </span>
                        <span className="text-xs font-bold" style={{ color: summary.color }}>
                          {nest.sealed}%
                        </span>
                      </div>
                      <div className="h-2 bg-white/60 rounded-full overflow-hidden shadow-inner">
                        <div
                          className="h-full transition-all duration-500 rounded-full"
                          style={{
                            width: `${nest.sealed}%`,
                            backgroundColor: summary.color,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TelemetryRow({ entry }: { entry: TelemetryEntry }) {
  const uptime = typeof entry.uptime_s === 'number' ? formatUptime(entry.uptime_s) : '—';
  const heap =
    typeof entry.free_heap === 'number' ? `${Math.round(entry.free_heap / 1024)} KB` : '—';
  const rssi = typeof entry.rssi === 'number' ? `${entry.rssi} dBm` : '—';
  const received = entry._received_at || '';

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-2.5 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-gray-700">{received}</span>
        {entry.fw && <span className="text-gray-400">fw {entry.fw}</span>}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600">
        <div>
          <span className="text-gray-400">uptime</span> {uptime}
        </div>
        <div>
          <span className="text-gray-400">heap</span> {heap}
        </div>
        <div>
          <span className="text-gray-400">rssi</span> {rssi}
        </div>
        <div>
          <span className="text-gray-400">reset</span> {entry.last_reset_reason || '—'}
        </div>
        {typeof entry.wifi_reconnects === 'number' && (
          <div>
            <span className="text-gray-400">reconnects</span> {entry.wifi_reconnects}
          </div>
        )}
        {entry.last_http_codes && entry.last_http_codes.length > 0 && (
          <div className="col-span-2">
            <span className="text-gray-400">http</span> {entry.last_http_codes.join(', ')}
          </div>
        )}
      </div>
      {entry.log && (
        <details className="mt-1.5">
          <summary className="text-gray-400 cursor-pointer hover:text-gray-600">log</summary>
          <pre className="mt-1 text-[10px] font-mono whitespace-pre-wrap text-gray-600 bg-gray-50 p-2 rounded max-h-40 overflow-y-auto">
            {entry.log}
          </pre>
        </details>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}
