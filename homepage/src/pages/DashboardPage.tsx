import { useState, useEffect } from 'react';
import MapView from '../components/MapView';
import ModulePanel from '../components/ModulePanel';
import SiteHeader from '../components/SiteHeader';
import { useTranslation } from '../i18n/LanguageContext';
import { api } from '../services/api';
import type { Module } from '@highfive/contracts';

export default function DashboardPage() {
  const { t } = useTranslation();
  const [modules, setModules] = useState<Module[]>([]);
  const [visibleModules, setVisibleModules] = useState<Module[]>([]);
  const [selectedModule, setSelectedModule] = useState<Module | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobileListExpanded, setMobileListExpanded] = useState(false);

  useEffect(() => {
    loadModules();
  }, []);

  const loadModules = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getAllModules();
      setModules(data);
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
          <span aria-label={`${onlineCount} of ${modules.length} modules online`}>
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
            <div className="max-w-md px-4">
              <h2 className="text-hf-fg mb-2 md:mb-3" style={{ fontSize: 'var(--fs-lg)' }}>
                {t('dashboard.errorTitle')}
              </h2>
              <p className="text-hf-fg-soft mb-6 md:mb-8 text-hf-sm">
                {t('dashboard.errorSubtitle')}
              </p>
              <button onClick={loadModules} className="hf-btn hf-btn-primary px-6 py-3">
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
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
          <div
            className="absolute inset-0 bg-hf-surface flex flex-col"
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
        <div className="hidden md:flex absolute bottom-6 left-6 w-80 hf-card z-[999] max-h-[420px] flex-col overflow-hidden">
          <div className="p-4 border-b border-hf-border shrink-0">
            <h2 className="font-semibold text-hf-fg" style={{ fontSize: 'var(--fs-md)' }}>
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
                    <h3 className="font-semibold text-hf-fg truncate text-hf-sm">{module.name}</h3>
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0 ml-2"
                      style={{
                        background:
                          module.status === 'online' ? 'var(--hf-success)' : 'var(--hf-fg-mute)',
                      }}
                      aria-label={
                        module.status === 'online' ? t('common.online') : t('common.offline')
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
                className="w-full hf-card p-3 flex items-center justify-between"
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
              <div className="absolute inset-0 bg-black/30" aria-hidden="true" />
              <div
                className="absolute inset-x-0 bottom-0 bg-hf-surface rounded-t-hf-xl shadow-hf-3 max-h-[70vh] flex flex-col border-t border-hf-border"
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
                  {visibleModules.map((module) => (
                    <li key={module.id}>
                      <button
                        onClick={() => handleModuleSelect(module)}
                        className="w-full text-left p-3 rounded-hf-lg border min-h-[56px] flex items-center transition-all bg-hf-fg/[0.025] active:bg-hf-honey-50 border-hf-border"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background:
                                module.status === 'online'
                                  ? 'var(--hf-forest-100)'
                                  : 'var(--hf-line-soft)',
                            }}
                            aria-hidden="true"
                          >
                            <span className="text-lg">🐝</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-hf-fg truncate text-hf-sm">
                              {module.name}
                            </h3>
                            <p
                              className="text-hf-xs"
                              style={{
                                color:
                                  module.status === 'online'
                                    ? 'var(--hf-success)'
                                    : 'var(--hf-fg-mute)',
                              }}
                            >
                              {module.status === 'online'
                                ? t('dashboard.statusOnline')
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
