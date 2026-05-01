import { useEffect, useState } from 'react';
import { api, type TelemetryEntry } from '../services/api';
import type { Module, ModuleDetail } from '@highfive/contracts';
import { BEE_TYPES } from '../types';
import { useTranslation } from '../i18n/LanguageContext';
import AdminKeyForm from './AdminKeyForm';

const ADMIN_KEY_STORAGE = 'hf_admin_key';

function hasAdminKey(): boolean {
  if (typeof window === 'undefined') return false;
  return !!sessionStorage.getItem(ADMIN_KEY_STORAGE);
}

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
  // Pick the fields we actually read from the contract, so the brand
  // on `id: ModuleId` flows through to api.getModuleById / getModuleLogs.
  module: Pick<Module, 'id' | 'name' | 'status'>;
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
  const [keyError, setKeyError] = useState<string | null>(null);
  // Tracks whether a key is currently stored. Updated explicitly on submit /
  // forget so the AdminKeyForm shows or hides reactively.
  const [hasKey, setHasKey] = useState<boolean>(hasAdminKey);
  const adminMode = isAdminMode();

  useEffect(() => {
    loadModuleDetail();
    setLogs(null);
    setLogsOpen(false);
    setLogsError(null);
    setKeyError(null);
    setHasKey(hasAdminKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const loadLogs = async () => {
    if (!hasAdminKey()) {
      // No key stored — the inline AdminKeyForm will be rendered instead.
      // We deliberately don't set logsError here; the form is the prompt.
      setHasKey(false);
      return;
    }
    try {
      setLogsLoading(true);
      setLogsError(null);
      setKeyError(null);
      const data = await api.getModuleLogs(module.id, 10);
      setLogs(data);
    } catch (err) {
      console.error('Error loading telemetry:', err);
      if (err instanceof Error && err.message === 'unauthorized') {
        // api.getModuleLogs already cleared sessionStorage on 401/403.
        setHasKey(false);
        setKeyError(t('adminKey.invalid'));
      } else {
        setLogsError(t('adminKey.loadFailed'));
      }
    } finally {
      setLogsLoading(false);
    }
  };

  const toggleLogs = () => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next && logs === null && !logsLoading && hasAdminKey()) {
      loadLogs();
    }
  };

  const submitAdminKey = (key: string) => {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    setHasKey(true);
    setKeyError(null);
    // Re-attempt the fetch with the freshly stored key. If it 401/403s,
    // api.getModuleLogs clears sessionStorage and loadLogs flips hasKey
    // back to false + sets keyError, re-rendering the form.
    loadLogs();
  };

  const forgetAdminKey = () => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    }
    setHasKey(false);
    setLogs(null);
    setLogsError(null);
    setKeyError(null);
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3 h-full p-4" role="status" aria-live="polite">
        <span className="sr-only">{t('common.loading')}</span>
        <div className="hf-skeleton h-24 rounded-hf-lg" />
        <div className="hf-skeleton h-32 rounded-hf-lg" />
        <div className="hf-skeleton h-32 rounded-hf-lg" />
      </div>
    );
  }

  if (error || !moduleDetail) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="text-hf-danger text-hf-sm text-center">
          {error || t('modulePanel.moduleNotFound')}
        </div>
      </div>
    );
  }

  const isOnline = moduleDetail.status === 'online';
  const lastApiCall = new Date(moduleDetail.lastApiCall);

  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  const formattedTime = lastApiCall.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

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
    <div className="h-full flex flex-col bg-hf-bg">
      {/* Header */}
      <div className="p-4 md:p-5 relative bg-hf-surface border-b border-hf-border">
        <button
          onClick={onClose}
          aria-label={t('common.back')}
          className="absolute top-3 right-3 text-hf-fg-mute hover:text-hf-fg hover:bg-hf-fg/5 rounded-full p-1.5 transition-colors hidden md:flex items-center justify-center"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        <div className="pr-0 md:pr-8">
          <h2 className="font-semibold text-hf-fg mb-2" style={{ fontSize: 'var(--fs-lg)' }}>
            {moduleDetail.name}
          </h2>

          <div className="flex items-center gap-2 text-hf-xs text-hf-fg-soft">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background: isOnline ? 'var(--hf-success)' : 'var(--hf-fg-mute)',
                }}
                aria-hidden="true"
              />
              {isOnline ? t('common.online') : t('common.offline')}
            </span>
            <span className="text-hf-fg-mute" aria-hidden="true">
              ·
            </span>
            <span>
              {moduleDetail.imageCount} {t('modulePanel.images')}
            </span>
          </div>

          <p className="text-hf-fg-mute text-hf-xs mt-1">
            {t('modulePanel.lastUpdate', { time: formattedTime })}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 hf-cq">
        {/* Telemetry / Logs — admin */}
        {adminMode && (
          <div className="mb-4 hf-card overflow-hidden">
            <button
              onClick={toggleLogs}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-hf-fg/5 transition-colors"
              aria-expanded={logsOpen}
              aria-controls="telemetry-content"
            >
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-hf-fg-mute"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 17v-2a4 4 0 014-4h4m0 0l-3-3m3 3l-3 3M3 7h6a2 2 0 012 2v10a2 2 0 01-2 2H3"
                  />
                </svg>
                <span className="font-semibold text-hf-sm text-hf-fg">
                  {t('adminKey.telemetry')}
                </span>
                {logs && logs.length > 0 && (
                  <span className="text-hf-xs text-hf-fg-mute">({logs.length})</span>
                )}
              </div>
              <svg
                className={`w-4 h-4 text-hf-fg-mute transition-transform ${logsOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
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
              <div
                id="telemetry-content"
                className="border-t border-hf-border p-3 space-y-3"
                style={{ background: 'var(--hf-line-soft)' }}
              >
                {!hasKey && (
                  <AdminKeyForm
                    onSubmit={submitAdminKey}
                    onCancel={() => setLogsOpen(false)}
                    busy={logsLoading}
                    error={keyError}
                  />
                )}
                {hasKey && logsLoading && (
                  <div className="text-hf-xs text-hf-fg-mute">{t('adminKey.loading')}</div>
                )}
                {hasKey && logsError && (
                  <div className="text-hf-xs" style={{ color: 'var(--hf-danger)' }}>
                    {logsError}
                  </div>
                )}
                {hasKey && !logsLoading && !logsError && logs && logs.length === 0 && (
                  <div className="text-hf-xs text-hf-fg-mute">{t('adminKey.empty')}</div>
                )}
                {hasKey &&
                  !logsLoading &&
                  logs &&
                  logs.map((entry, i) => <TelemetryRow key={i} entry={entry} />)}
                {hasKey && (
                  <div className="flex items-center gap-3 pt-1">
                    {logs && logs.length > 0 && (
                      <button
                        type="button"
                        onClick={loadLogs}
                        className="text-hf-xs text-hf-honey-700 hover:text-hf-honey-800 font-medium"
                      >
                        {t('adminKey.refresh')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={forgetAdminKey}
                      className="text-hf-xs text-hf-fg-mute hover:text-hf-fg-soft underline ml-auto"
                    >
                      {t('adminKey.forget')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Species cards — single column on small panel widths, 2-col when there's room (container query) */}
        <div
          className="grid gap-3 md:gap-4"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
          }}
        >
          {beeTypeSummaries.map((summary) => (
            <article
              key={summary.key}
              className="rounded-hf-lg p-3 md:p-4 border border-hf-border bg-hf-surface"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="text-hf-sm font-medium text-hf-fg-soft">{summary.size}</div>
                <div className="text-right">
                  <div
                    className="font-semibold text-hf-fg tabular-nums"
                    style={{ fontSize: 'var(--fs-xl)' }}
                  >
                    {summary.totalHatched}
                  </div>
                  <div className="text-hf-xs text-hf-fg-mute">{t('modulePanel.hatches')}</div>
                </div>
              </div>

              <ul className="space-y-2">
                {summary.nests.map((nest, index) => (
                  <li key={nest.nest_id}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-hf-xs text-hf-fg-soft">
                        {t('modulePanel.nest', { index: index + 1 })}
                      </span>
                      <span className="text-hf-xs font-medium tabular-nums text-hf-fg-soft">
                        {nest.sealed}%
                      </span>
                    </div>
                    <div
                      className="h-1.5 rounded-full overflow-hidden"
                      style={{ background: 'var(--hf-line-soft)' }}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={nest.sealed}
                      aria-label={`Nest ${index + 1} sealed`}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${nest.sealed}%`, backgroundColor: summary.color }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </article>
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
    <div className="hf-card p-2.5 text-hf-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-hf-fg-soft">{received}</span>
        {entry.fw && <span className="text-hf-fg-mute">fw {entry.fw}</span>}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-hf-fg-soft">
        <div>
          <span className="text-hf-fg-mute">uptime</span> {uptime}
        </div>
        <div>
          <span className="text-hf-fg-mute">heap</span> {heap}
        </div>
        <div>
          <span className="text-hf-fg-mute">rssi</span> {rssi}
        </div>
        <div>
          <span className="text-hf-fg-mute">reset</span> {entry.last_reset_reason || '—'}
        </div>
        {typeof entry.wifi_reconnects === 'number' && (
          <div>
            <span className="text-hf-fg-mute">reconnects</span> {entry.wifi_reconnects}
          </div>
        )}
        {entry.last_http_codes && entry.last_http_codes.length > 0 && (
          <div className="col-span-2">
            <span className="text-hf-fg-mute">http</span> {entry.last_http_codes.join(', ')}
          </div>
        )}
      </div>
      {entry.log && (
        <details className="mt-1.5">
          <summary className="text-hf-fg-mute cursor-pointer hover:text-hf-fg-soft">log</summary>
          <pre
            className="mt-1 text-[10px] font-mono whitespace-pre-wrap text-hf-fg-soft p-2 rounded max-h-40 overflow-y-auto"
            style={{ background: 'var(--hf-line-soft)' }}
          >
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
