import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import MapView from '../components/MapView';
import { hasPlausibleLocation } from '../lib/location';
import ModulePanel from '../components/ModulePanel';
import SiteHeader from '../components/SiteHeader';
import { useTranslation } from '../i18n/LanguageContext';
import { api } from '../services/api';
import type { Module } from '@highfive/contracts';

export default function DashboardPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [modules, setModules] = useState<Module[]>([]);
  const [visibleModules, setVisibleModules] = useState<Module[]>([]);
  const [selectedModule, setSelectedModule] = useState<Module | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Mirrors the X-Highfive-Data-Incomplete response header (#31). When true,
  // some module statuses may be 'unknown' instead of accurate, and we show
  // a banner explaining the degradation.
  const [heartbeatsIncomplete, setHeartbeatsIncomplete] = useState(false);
  const [mobileListExpanded, setMobileListExpanded] = useState(false);

  useEffect(() => {
    loadModules();
  }, []);

  const loadModules = async () => {
    try {
      setLoading(true);
      setError(null);
      const { modules: data, dataIncomplete } = await api.getAllModulesWithMeta();
      setModules(data);
      setHeartbeatsIncomplete(dataIncomplete.heartbeats);

      // Auto-select module passed from setup wizard
      const navState = location.state as { selectModuleId?: string } | null;
      if (navState?.selectModuleId) {
        const match = data.find((m: Module) => m.id === navState.selectModuleId);
        if (match) setSelectedModule(match);
        // Clear the navigation state so refresh doesn't re-select
        window.history.replaceState({}, '');
      }
    } catch (err) {
      setError(t('dashboard.errorDetail'));
      console.error('Error loading modules:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleModuleSelect = (module: Module) => {
    setSelectedModule(module);
    setMobileListExpanded(false);
  };

  const onlineCount = modules.filter((m) => m.status === 'online').length;

  /**
   * Status pill for the header — live region so screen readers hear updates
   * after refresh or error.
   */
  const statusPill = (
    <div role="status" aria-live="polite" className="text-hf-xs md:text-hf-sm">
      {loading ? (
        <span className="inline-flex items-center gap-2 text-hf-fg-soft">
          <span
            className="w-3 h-3 border-2 border-hf-honey-500 border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
          <span className="hidden sm:inline">{t('common.loading')}</span>
        </span>
      ) : error ? (
        <span className="inline-flex items-center gap-1.5 text-hf-danger">
          <span className="w-2 h-2 bg-hf-danger rounded-full" aria-hidden="true" />
          <span className="hidden sm:inline">{t('common.error')}</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-hf-fg-soft">
          <span className="w-2 h-2 bg-hf-success rounded-full" aria-hidden="true" />
          <span
            aria-label={
              heartbeatsIncomplete
                ? `${onlineCount} of ${modules.length} modules online (some statuses unknown)`
                : `${onlineCount} of ${modules.length} modules online`
            }
          >
            {onlineCount}/{modules.length}
          </span>
          <span className="hidden sm:inline">{t('common.online')}</span>
        </span>
      )}
    </div>
  );

  return (
    <div className="h-[100dvh] flex flex-col bg-hf-bg overflow-hidden">
      <SiteHeader title={t('dashboard.title')} right={statusPill} />

      {/* Heartbeat-data-incomplete banner (#31). Shown when the backend
          flagged the heartbeats endpoint as unreachable on the last fetch
          — some module statuses may be 'unknown' rather than accurate. */}
      {!loading && !error && heartbeatsIncomplete && (
        <div
          role="status"
          aria-live="polite"
          className="px-4 py-2 text-hf-xs md:text-hf-sm border-b border-hf-honey-300 bg-hf-honey-50 text-hf-honey-900"
        >
          {t('common.heartbeatDataIncomplete')}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Error state — backend down */}
        {error && (
          <div
            className="flex-1 flex items-center justify-center p-4 md:p-8"
            style={{
              background: 'linear-gradient(135deg, var(--hf-honey-50), var(--hf-honey-100))',
            }}
          >
            <div className="max-w-md text-center px-4">
              <div className="mb-6 md:mb-8" aria-hidden="true">
                <div className="text-5xl md:text-7xl animate-bounce">🐝</div>
              </div>
              <h2 className="text-hf-fg mb-2 md:mb-3" style={{ fontSize: 'var(--fs-lg)' }}>
                {t('dashboard.errorTitle')}
              </h2>
              <p className="text-hf-fg-soft mb-6 md:mb-8 text-hf-sm">
                {t('dashboard.errorSubtitle')}
              </p>
              <button onClick={loadModules} className="hf-btn hf-btn-primary px-6 py-3 mx-auto">
                <svg
                  className="w-4 h-4 md:w-5 md:h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                {t('common.tryAgain')}
              </button>
              <div className="mt-6 md:mt-8 p-3 md:p-4 hf-card">
                <p className="text-hf-xs text-hf-fg-mute font-mono break-words">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Map */}
        {!error && (
          <div className="flex-1 relative min-h-0">
            {!loading && (
              <MapView
                modules={modules}
                selectedModule={selectedModule}
                onModuleSelect={handleModuleSelect}
                onVisibleModulesChange={setVisibleModules}
              />
            )}

            {loading && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ background: 'var(--hf-line-soft)' }}
              >
                <div className="text-center">
                  <div
                    className="w-10 h-10 border-4 border-hf-honey-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
                    aria-hidden="true"
                  />
                  <p className="text-hf-fg-soft text-hf-sm">{t('dashboard.loadingMap')}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Desktop: right side panel */}
        {!error && selectedModule && (
          <aside
            className="hidden md:flex w-[360px] lg:w-[400px] shadow-hf-2 overflow-hidden flex-col border-l border-hf-border bg-hf-surface"
            aria-label={t('dashboard.moduleDetails')}
          >
            {/* Brittle invariant: ModulePanel is always opened from
                the listing, so a banner-on-listing strategy works for
                surfacing heartbeats-incomplete state. If a deep-link
                route to /modules/:id is ever added, ModulePanel itself
                must surface the 'unknown' degradation hint inline. */}
            <ModulePanel
              module={selectedModule}
              onClose={() => setSelectedModule(null)}
              onError={(errorMsg) => {
                setError(errorMsg);
                setSelectedModule(null);
              }}
            />
          </aside>
        )}
      </div>

      {/* Mobile: full-screen sheet */}
      {!error && selectedModule && (
        <div
          className="fixed inset-0 z-[1000] md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t('dashboard.moduleDetails')}
          onClick={() => setSelectedModule(null)}
        >
          <div className="absolute inset-0 bg-black/40 animate-fade-in" aria-hidden="true" />
          <div
            className="absolute inset-0 bg-hf-surface flex flex-col animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-hf-border bg-hf-surface shrink-0 pt-safe-top">
              <button
                onClick={() => setSelectedModule(null)}
                className="w-10 h-10 flex items-center justify-center hover:bg-hf-fg/5 rounded-full transition-colors -ml-2"
                aria-label={t('common.back')}
              >
                <svg
                  className="w-6 h-6 text-hf-fg"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
              <span className="font-semibold text-hf-fg">{t('dashboard.moduleDetails')}</span>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain">
              <ModulePanel
                module={selectedModule}
                onClose={() => setSelectedModule(null)}
                onError={(errorMsg) => {
                  setError(errorMsg);
                  setSelectedModule(null);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Desktop: floating module list */}
      {!loading && !error && visibleModules.length > 0 && (
        <div className="hidden md:flex absolute bottom-6 left-6 w-80 hf-card hf-glass z-[999] max-h-[420px] flex-col overflow-hidden">
          <div className="p-4 border-b border-hf-border shrink-0">
            <h2 className="font-bold text-hf-honey-700" style={{ fontSize: 'var(--fs-md)' }}>
              {t('common.hiveModules')}
            </h2>
            <p className="text-hf-xs text-hf-fg-mute mt-0.5">
              {t('dashboard.modulesInView', { count: visibleModules.length })}
            </p>
          </div>
          <ul className="overflow-y-auto flex-1 p-3 space-y-1.5">
            {visibleModules.map((module) => (
              <li key={module.id}>
                <button
                  onClick={() => setSelectedModule(module)}
                  className={`w-full text-left p-3 rounded-hf transition-all border ${
                    selectedModule?.id === module.id
                      ? 'border-hf-honey-400 bg-hf-honey-50/60'
                      : 'border-transparent bg-hf-fg/[0.025] hover:bg-hf-honey-50/40 hover:border-hf-honey-200'
                  }`}
                  aria-current={selectedModule?.id === module.id ? 'true' : undefined}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-hf-fg truncate text-hf-sm">
                        {module.displayName ?? module.name}
                      </h3>
                      {/* Leading 4 hex of the MAC — same-batch hardware
                          shares the *trailing* octets (issue #92 field
                          incident), so the prefix is the disambiguator.
                          See ADR-011. */}
                      <p className="text-[10px] font-mono tracking-wider text-hf-fg-mute">
                        {module.id.slice(0, 4).toUpperCase()}
                      </p>
                      {/* "Location pending" pill (PR II / issue #89).
                          Shown when the module is at the (0,0) sentinel
                          — firmware failed boot-time getGeolocation
                          and hasn't yet recovered via heartbeat-side
                          retry. Filtered out of the map's marker set
                          by `hasPlausibleLocation` in MapView. */}
                      {!hasPlausibleLocation(module.location) && (
                        <span
                          className="inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider bg-hf-fg/[0.06] text-hf-fg-mute"
                          title={t('dashboard.locationPendingTooltip')}
                        >
                          {t('dashboard.locationPending')}
                        </span>
                      )}
                    </div>
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0 ml-2"
                      style={{
                        background:
                          module.status === 'online'
                            ? 'var(--hf-success)'
                            : module.status === 'unknown'
                              ? 'var(--hf-line-soft)'
                              : 'var(--hf-fg-mute)',
                      }}
                      aria-label={
                        module.status === 'online'
                          ? t('common.online')
                          : module.status === 'unknown'
                            ? t('common.unknown')
                            : t('common.offline')
                      }
                    />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Mobile: collapsed pill + bottom-sheet */}
      {!loading && !error && visibleModules.length > 0 && !selectedModule && (
        <div className="md:hidden absolute bottom-0 left-0 right-0 z-[999]">
          {!mobileListExpanded && (
            <div className="p-3 pb-safe-bottom">
              <button
                onClick={() => setMobileListExpanded(true)}
                className="w-full hf-card hf-glass p-3 flex items-center justify-between active:scale-95 transition-all"
                aria-expanded="false"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center"
                    style={{ background: 'var(--hf-honey-100)' }}
                    aria-hidden="true"
                  >
                    <span className="text-lg">🐝</span>
                  </div>
                  <div className="text-left">
                    <div className="font-semibold text-hf-fg text-hf-sm">
                      {t('common.hiveModules')}
                    </div>
                    <div className="text-hf-xs text-hf-fg-mute">
                      {t('dashboard.inViewTap', { count: visibleModules.length })}
                    </div>
                  </div>
                </div>
                <svg
                  className="w-5 h-5 text-hf-fg-mute"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 15l7-7 7 7"
                  />
                </svg>
              </button>
            </div>
          )}

          {mobileListExpanded && (
            <div
              className="fixed inset-0 z-50"
              role="dialog"
              aria-modal="true"
              aria-label={t('common.hiveModules')}
              onClick={() => setMobileListExpanded(false)}
            >
              <div className="absolute inset-0 bg-black/30 animate-fade-in" aria-hidden="true" />
              <div
                className="absolute inset-x-0 bottom-0 bg-hf-surface rounded-t-hf-xl shadow-hf-3 max-h-[70vh] flex flex-col animate-slide-up border-t border-hf-border"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Drag handle */}
                <div className="flex justify-center py-2 shrink-0">
                  <div className="w-10 h-1 bg-hf-fg/20 rounded-full" aria-hidden="true" />
                </div>
                <div className="flex justify-between items-center px-4 pb-3 border-b border-hf-border shrink-0">
                  <div>
                    <h2 className="font-bold text-hf-fg">{t('common.hiveModules')}</h2>
                    <p className="text-hf-xs text-hf-fg-mute">
                      {t('dashboard.modulesInView', { count: visibleModules.length })}
                    </p>
                  </div>
                  <button
                    onClick={() => setMobileListExpanded(false)}
                    className="w-8 h-8 flex items-center justify-center hover:bg-hf-fg/5 rounded-full"
                    aria-label={t('common.back')}
                  >
                    <svg
                      className="w-5 h-5 text-hf-fg-mute"
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
                </div>
                <ul className="overflow-y-auto overscroll-contain flex-1 p-4 pb-safe-bottom space-y-2">
                  {visibleModules.map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => handleModuleSelect(m)}
                        className="w-full text-left p-3 rounded-hf-lg border min-h-[56px] flex items-center transition-all bg-hf-fg/[0.025] active:bg-hf-honey-50 border-hf-border"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background:
                                m.status === 'online'
                                  ? 'var(--hf-forest-100)'
                                  : m.status === 'unknown'
                                    ? 'var(--hf-bg)'
                                    : 'var(--hf-line-soft)',
                              outline:
                                m.status === 'unknown' ? '1px dashed var(--hf-fg-mute)' : 'none',
                            }}
                            aria-hidden="true"
                          >
                            <span className="text-lg">🐝</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-hf-fg truncate text-hf-sm">
                              {m.displayName ?? m.name}
                            </h3>
                            {/* Leading 4 hex — see DashboardPage desktop
                                list comment + ADR-011. */}
                            <p className="text-[10px] font-mono tracking-wider text-hf-fg-mute">
                              {m.id.slice(0, 4).toUpperCase()}
                            </p>
                            {!hasPlausibleLocation(m.location) && (
                              <span
                                className="inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider bg-hf-fg/[0.06] text-hf-fg-mute"
                                title={t('dashboard.locationPendingTooltip')}
                              >
                                {t('dashboard.locationPending')}
                              </span>
                            )}
                            <p
                              className="text-hf-xs"
                              style={{
                                color:
                                  m.status === 'online'
                                    ? 'var(--hf-success)'
                                    : m.status === 'unknown'
                                      ? 'var(--hf-fg-soft)'
                                      : 'var(--hf-fg-mute)',
                                fontStyle: m.status === 'unknown' ? 'italic' : 'normal',
                              }}
                            >
                              {m.status === 'online'
                                ? t('dashboard.statusOnline')
                                : m.status === 'unknown'
                                  ? t('common.unknown')
                                  : t('dashboard.statusOffline')}
                            </p>
                          </div>
                          <svg
                            className="w-5 h-5 text-hf-fg-mute shrink-0"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
