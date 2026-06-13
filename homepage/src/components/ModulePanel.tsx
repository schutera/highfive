import { useEffect, useState } from 'react';
import { api, type TelemetryEntry } from '../services/api';
import type { HeartbeatSnapshot, Module, ModuleDetail } from '@highfive/contracts';
import { BEE_TYPES } from '../types';
import { useTranslation } from '../i18n/LanguageContext';
import AdminKeyForm from './AdminKeyForm';
import LatestCaptures from './LatestCaptures';
import { hasPlausibleLocation } from '../lib/location';
import { displayLabel } from '../lib/displayLabel';
// TODO(perf/data): Re-enable once these panels are backed by real data.
// Both were disabled because the series are not real telemetry — the ESP
// has no battery-voltage sensing, so `carpenter`+ firmware OMITS battery from
// the heartbeat (the `battery_pct` dual-write source), leaving an honest gap
// rather than a fabricated 0%/`random(1,100)` series (see BatteryHistoryChart
// docstring), and the activity/weather chart fired a slow browser-direct
// Open-Meteo fetch on every panel open. Removing them is the bulk of the
// side-panel load-time fix. Keep them OFF until real battery sensing lands.
// import ActivityWeatherChart from './ActivityWeatherChart';
// import BatteryHistoryChart from './BatteryHistoryChart';

// Admin-only UI is unlocked by opening the dashboard with ?admin=1 in the URL.
// The flag persists in sessionStorage so it survives navigation within the
// session but is gone after the tab is closed. This only reveals the admin
// *affordances*; the privileged telemetry fetch is gated server-side by the
// session cookie (#142 / ADR-019), not by this flag.
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
  // Pick from the contracts Module so the status union here can't drift
  // out of sync with the wire shape (#31 reviewer P2). 'unknown' is set
  // when the heartbeat fetch failed and the module would otherwise have
  // been classified as 'offline' — see backend/src/database.ts.
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
  // Tracks whether we believe an admin session cookie is present. Drives the
  // AdminKeyForm-vs-telemetry render; the backend is the real gate.
  const [hasKey, setHasKey] = useState<boolean>(false);
  const adminMode = isAdminMode();

  useEffect(() => {
    loadModuleDetail();
    setLogs(null);
    setLogsOpen(false);
    setLogsError(null);
    setKeyError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module.id]);

  // In admin mode, learn up-front whether a session cookie is already present
  // so opening Telemetry goes straight to the logs rather than flashing the
  // login form at an already-authenticated operator.
  useEffect(() => {
    if (!adminMode) return;
    let cancelled = false;
    api.checkSession().then((ok) => {
      if (!cancelled) setHasKey(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [adminMode]);

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
    try {
      setLogsLoading(true);
      setLogsError(null);
      setKeyError(null);
      const data = await api.getModuleLogs(module.id, 10);
      setLogs(data);
      setHasKey(true);
    } catch (err) {
      console.error('Error loading telemetry:', err);
      if (err instanceof Error && err.message === 'unauthorized') {
        // No valid session cookie — render the login form (AdminKeyForm).
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
    // The fetch itself gates on the session cookie; if it 401s, loadLogs
    // flips hasKey to false and the login form renders.
    if (next && logs === null && !logsLoading) {
      loadLogs();
    }
  };

  // AdminKeyForm now collects the admin password and logs in via the session
  // endpoint (#142 / ADR-019); the key is never stored client-side — only the
  // resulting HttpOnly cookie. On success we fetch the logs; on a wrong key we
  // surface an inline error and keep the form up.
  const submitAdminKey = async (key: string) => {
    setLogsLoading(true);
    setKeyError(null);
    try {
      if (await api.login(key)) {
        setHasKey(true);
        await loadLogs();
      } else {
        setKeyError(t('adminKey.invalid'));
      }
    } catch {
      setKeyError(t('adminKey.invalid'));
    } finally {
      setLogsLoading(false);
    }
  };

  const forgetAdminKey = async () => {
    await api.logout();
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
  const isUnknown = moduleDetail.status === 'unknown';
  const statusLabel = isOnline
    ? t('common.online')
    : isUnknown
      ? t('common.unknown')
      : t('common.offline');
  const statusBgClass = isOnline
    ? 'bg-hf-success/90'
    : isUnknown
      ? 'bg-hf-fg-mute/50'
      : 'bg-hf-fg-mute/80';
  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  const formattedTime = moduleDetail.lastApiCall
    ? new Date(moduleDetail.lastApiCall).toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

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
      <div
        className="p-4 md:p-5 text-white relative"
        style={{
          background: 'linear-gradient(135deg, var(--hf-honey-500), var(--hf-honey-700))',
        }}
      >
        <button
          onClick={onClose}
          aria-label={t('common.back')}
          className="absolute top-3 right-3 text-white/85 hover:text-white hover:bg-white/15 rounded-full p-1.5 transition-colors hidden md:flex items-center justify-center"
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
          <h2 className="font-bold" style={{ fontSize: 'var(--fs-lg)' }}>
            {displayLabel(moduleDetail)}
          </h2>
          {/* MAC-prefix subtitle (first 4 hex chars) so two modules
              that share a label stay visually distinct on the dashboard.
              The *leading* 4 chars are the right choice here, not the
              trailing 4: same-batch ESP32 hardware shares its trailing
              MAC octets (the field incident in issue #92 — MACs
              b0:69:6e:f2:3a:08 and e8:9f:a9:f2:3a:08 share `f2:3a:08`),
              so a trailing-4 disambiguator would render `3A08` on both
              and defeat the whole point. The unique-prefix bytes
              (`B069` vs `E89F`) actually differ. Always rendered —
              even when displayName is null — because two same-batch
              firmwares can still produce identical auto-names until
              an operator runs the rename flow. */}
          <p
            className="text-white/75 text-hf-xs font-mono tracking-wider mb-2 md:mb-3"
            aria-label="module identifier"
          >
            {moduleDetail.id.slice(0, 4).toUpperCase()}
          </p>

          {/* "Location pending" pill (PR II / issue #89). The detail
              panel re-renders the same pill the side-list shows so the
              operator has a single coherent signal: "this module
              registered without a usable geolocation fix". */}
          {!hasPlausibleLocation(moduleDetail.location) && (
            <span
              className="inline-block mb-2 md:mb-3 px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-white/15 text-white/85"
              title={t('dashboard.locationPendingTooltip')}
            >
              {t('dashboard.locationPending')}
            </span>
          )}

          <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2">
            <div
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-hf-xs font-semibold ${statusBgClass}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full bg-white ${
                  isOnline ? 'animate-pulse' : isUnknown ? 'opacity-50' : 'opacity-70'
                }`}
                aria-hidden="true"
              />
              {statusLabel}
            </div>

            <div className="inline-flex items-center gap-1.5 bg-white/20 rounded-full px-3 py-1 text-hf-xs font-semibold">
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
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

            {/* Firmware version pill — sourced from latestHeartbeat
                (ESP fills it on every heartbeat per ADR-006 / #15). Hidden
                when the module has never heartbeated (latestHeartbeat null)
                or when the firmware didn't bake a release version into the
                binary (`FIRMWARE_VERSION="dev-unset"` — Arduino-IDE-only
                path that `ESP32-CAM/build.sh` refuses to ship explicitly,
                but `ESP32-CAM/extra_scripts.py` silently falls back to
                when the VERSION file is missing; this consumer-side filter
                is the second line of defence against the dev-unset
                sentinel reaching an operator-facing surface).
                Note: AdminPage.tsx deliberately renders `dev-unset` literally
                for the diagnostic view; the dashboard hides it so operators
                aren't shown a sentinel they can't act on. Do not "unify"
                these two policies — the asymmetry is intentional. */}
            {moduleDetail.latestHeartbeat?.fwVersion &&
              moduleDetail.latestHeartbeat.fwVersion !== 'dev-unset' && (
                <div
                  className="inline-flex items-center gap-1.5 bg-white/20 rounded-full px-3 py-1 text-hf-xs font-semibold"
                  title={t('modulePanel.firmwareTooltip')}
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  {t('modulePanel.firmware', {
                    version: moduleDetail.latestHeartbeat.fwVersion,
                  })}
                </div>
              )}
          </div>

          {formattedTime && (
            <p className="text-white/85 text-hf-xs">
              {t('modulePanel.lastUpdate', { time: formattedTime })}
            </p>
          )}
        </div>
      </div>

      {/* Content. Mobile (default): natural-height + scroll inside the sheet.
          Desktop (md+): a non-scrolling flex column so the species grid below
          fills the available window height instead of overflowing the aside. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 hf-cq md:flex md:flex-col md:overflow-hidden">
        {/* Telemetry / Logs — admin */}
        {adminMode && (
          <div className="mb-4 hf-card overflow-hidden md:shrink-0">
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
                className="border-t border-hf-border p-3 space-y-3 md:max-h-[40vh] md:overflow-y-auto"
                style={{ background: 'var(--hf-line-soft)' }}
              >
                {/* Freshest heartbeat diagnostics (#148). Sourced from the
                    already-loaded module payload (latestHeartbeat), so it
                    renders without the admin key — the per-upload logs below
                    still require it. This is the surface that distinguishes
                    "healthy" from "boot-looping/hung". */}
                <HeartbeatDiagnostics heartbeat={moduleDetail.latestHeartbeat} />
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

        {/* Latest captures (#154) — newest-first gallery, two 4:3 cards
            visible, arrows to scroll older, click for a full-size lightbox.
            Self-contained: renders nothing for modules without uploads and
            degrades silently on fetch errors (never via onError). */}
        <LatestCaptures
          moduleId={moduleDetail.id}
          moduleName={displayLabel(moduleDetail)}
          locale={locale}
        />

        {/* Species cards. The auto-fit grid flows to 2 columns once the panel is
            wide enough (xl aside ≈ 560px). On desktop the grid grows to fill the
            remaining panel height and its rows share that height equally
            (grid-auto-rows 1fr), so the cards adapt to the window instead of the
            panel scrolling; a card with more nests than fit scrolls internally. */}
        <div
          className="grid gap-3 md:gap-4 md:min-h-0 md:flex-1 md:[grid-auto-rows:minmax(0,1fr)]"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
          }}
        >
          {beeTypeSummaries.map((summary) => (
            <article
              key={summary.key}
              className="rounded-hf-lg p-3 md:p-4 shadow-hf-1 border-2 transition-transform active:scale-[0.98] md:active:scale-100 md:flex md:flex-col md:h-full md:min-h-0 md:overflow-hidden"
              style={{
                backgroundColor: summary.lightColor,
                borderColor: summary.color,
              }}
            >
              <div className="flex items-start justify-between mb-2 md:shrink-0">
                <div className="text-hf-md font-bold" style={{ color: summary.color }}>
                  {summary.size}
                </div>
                <div className="text-right">
                  <div
                    className="font-bold tabular-nums"
                    style={{ color: summary.color, fontSize: 'var(--fs-xl)' }}
                  >
                    {summary.totalHatched}
                  </div>
                  <div className="text-hf-xs text-hf-fg-mute">{t('modulePanel.hatches')}</div>
                </div>
              </div>

              <ul className="space-y-2 mt-3 md:flex-1 md:min-h-0 md:overflow-y-auto">
                {summary.nests.map((nest, index) => (
                  <li key={nest.nest_id}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-hf-xs text-hf-fg-soft font-medium">
                        {t('modulePanel.nest', { index: index + 1 })}
                      </span>
                      <span
                        className="text-hf-xs font-bold tabular-nums"
                        style={{ color: summary.color }}
                      >
                        {nest.sealed}%
                      </span>
                    </div>
                    <div
                      className="h-2 rounded-full overflow-hidden"
                      style={{
                        background: 'rgba(255,255,255,0.6)',
                        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)',
                      }}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={nest.sealed}
                      aria-label={`Nest ${index + 1} sealed`}
                    >
                      <div
                        className="h-full transition-all duration-500 rounded-full"
                        style={{ width: `${nest.sealed}%`, backgroundColor: summary.color }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        {/* TODO(perf/data): Re-enable when backed by real data — both series
            are currently fabricated, and the weather chart's browser-direct
            Open-Meteo fetch was a major side-panel load-time cost.
        <ActivityWeatherChart moduleId={moduleDetail.id} location={moduleDetail.location} />
        <BatteryHistoryChart moduleId={moduleDetail.id} /> */}
      </div>
    </div>
  );
}

// Renders one telemetry sidecar entry. The wire shape is the envelope
// produced by image-service/services/sidecar.py — service-injected
// metadata (mac, received_at, image) at the top level, raw ESP
// telemetry nested under `payload`. Reading off the wrong level was
// the failure mode that caused this row to render `—` for every field
// (silently, since all telemetry fields are optional) until #42
// surfaced it. Keep the destructure explicit so the next reader can
// see the structure.
//
// Copy is hardcoded English — admin-only diagnostic surface, not
// translated. Other surfaces in this file go through the i18n hook;
// this one deliberately doesn't.
export function TelemetryRow({ entry }: { entry: TelemetryEntry }) {
  const t = entry.payload ?? {};
  const uptime = typeof t.uptime_s === 'number' ? formatUptime(t.uptime_s) : '—';
  const heap = typeof t.free_heap === 'number' ? `${Math.round(t.free_heap / 1024)} KB` : '—';
  const rssi = typeof t.rssi === 'number' ? `${t.rssi} dBm` : '—';
  const received = entry.received_at || '';

  return (
    <div className="hf-card p-2.5 text-hf-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-hf-fg-soft">{received}</span>
        {t.fw && <span className="text-hf-fg-mute">fw {t.fw}</span>}
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
          <span className="text-hf-fg-mute">reset</span> {t.last_reset_reason || '—'}
        </div>
        {t.last_stage_before_reboot && (
          <div className="col-span-2 font-mono text-hf-fg-soft">
            <span className="text-hf-fg-mute">stage at previous reboot</span>{' '}
            {t.last_stage_before_reboot}
          </div>
        )}
        {typeof t.wifi_reconnects === 'number' && (
          <div>
            <span className="text-hf-fg-mute">reconnects</span> {t.wifi_reconnects}
          </div>
        )}
        {t.last_http_codes && t.last_http_codes.length > 0 && (
          <div className="col-span-2">
            <span className="text-hf-fg-mute">http</span> {t.last_http_codes.join(', ')}
          </div>
        )}
      </div>
      {t.log && (
        <details className="mt-1.5">
          <summary className="text-hf-fg-mute cursor-pointer hover:text-hf-fg-soft">log</summary>
          <pre
            className="mt-1 text-[10px] font-mono whitespace-pre-wrap text-hf-fg-soft p-2 rounded max-h-40 overflow-y-auto"
            style={{ background: 'var(--hf-line-soft)' }}
          >
            {t.log}
          </pre>
        </details>
      )}
    </div>
  );
}

// Renders the freshest heartbeat's diagnostic fields (#148). The
// per-upload TelemetryRow above only lands ~daily (it rides the noon
// image upload), so a crash-looping or hung module — which never reaches
// that upload — would show nothing there. The hourly heartbeat carries
// reset_reason / min_free_heap / boot_count on *every* boot, so this card
// is the freshest "why did it reset / is it boot-looping" signal.
//
// Fault reset reasons — a crash / watchdog / brownout, as opposed to the
// clean `SW` restart the daily reboot and OTA-apply use (see
// docs/06-runtime-view/esp-reliability.md "Daily reboot" → `ESP_RST_SW`).
// This is the same faulty-reboot set `forceRollbackIfPendingTooLong()` counts
// in ESP32-CAM.ino.
const FAULT_RESET_REASONS = new Set(['PANIC', 'TASK_WDT', 'INT_WDT', 'WDT', 'BROWNOUT']);

// Copy is hardcoded English to match TelemetryRow — admin-only diagnostic
// surface, deliberately not routed through i18n (see TelemetryRow note).
export function HeartbeatDiagnostics({ heartbeat }: { heartbeat: HeartbeatSnapshot | null }) {
  if (!heartbeat) return null;
  const { receivedAt, fwVersion, uptimeMs, resetReason, minFreeHeap, freeHeap, rssi, bootCount } =
    heartbeat;

  const uptime = typeof uptimeMs === 'number' ? formatUptime(Math.floor(uptimeMs / 1000)) : '—';
  const heap = typeof freeHeap === 'number' ? `${Math.round(freeHeap / 1024)} KB` : '—';
  const minHeap = typeof minFreeHeap === 'number' ? `${Math.round(minFreeHeap / 1024)} KB` : '—';
  const rssiStr = typeof rssi === 'number' ? `${rssi} dBm` : '—';
  // What a SINGLE snapshot can honestly assert: "the most recent reset was a
  // fault (watchdog/panic/brownout) and the module hasn't sustained uptime
  // since." That deliberately does NOT fire on the clean `SW` daily reboot
  // (which every healthy module does every 24h at seconds-low uptime), nor on
  // a fresh `POWERON`. It clears once uptime recovers past the threshold.
  //
  // It is NOT "boot-looping" — confirming a *loop* needs the boot_count-rising-
  // while-uptime-flat trend ACROSS consecutive heartbeats, which one snapshot
  // cannot see. That cross-heartbeat verdict is #148 Phase 4 (server-side, where
  // the history is queryable); this card only renders the single-sample signal.
  const recentFaultReset =
    typeof resetReason === 'string' &&
    FAULT_RESET_REASONS.has(resetReason) &&
    typeof uptimeMs === 'number' &&
    uptimeMs < 5 * 60 * 1000;

  return (
    <div className="hf-card p-2.5 text-hf-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold text-hf-fg-soft">latest heartbeat</span>
        <span className="font-mono text-hf-fg-mute">{receivedAt}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-hf-fg-soft">
        <div>
          <span className="text-hf-fg-mute">uptime</span> {uptime}
        </div>
        <div>
          <span className="text-hf-fg-mute">reset</span> {resetReason || '—'}
        </div>
        <div>
          <span className="text-hf-fg-mute">boots</span>{' '}
          {typeof bootCount === 'number' ? bootCount : '—'}
        </div>
        <div>
          <span className="text-hf-fg-mute">rssi</span> {rssiStr}
        </div>
        <div>
          <span className="text-hf-fg-mute">heap</span> {heap}
        </div>
        <div>
          <span className="text-hf-fg-mute">min heap</span> {minHeap}
        </div>
        {fwVersion && (
          <div className="col-span-2">
            <span className="text-hf-fg-mute">fw</span> {fwVersion}
          </div>
        )}
      </div>
      {recentFaultReset && (
        <div className="mt-1.5 font-semibold" style={{ color: 'var(--hf-danger)' }}>
          ⚠ recent fault reset ({resetReason}) — uptime {uptime}, not yet recovered
        </div>
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
