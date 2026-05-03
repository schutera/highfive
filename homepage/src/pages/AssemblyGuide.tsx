import { Link } from 'react-router-dom';
import { useTranslation, useTranslationRaw } from '../i18n/LanguageContext';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';

export default function AssemblyGuide() {
  const { t } = useTranslation();
  const tr = useTranslationRaw();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-hf-bg text-hf-fg">
      <SiteHeader
        title={t('assembly.pageTitle')}
        secondary={{ to: '/hive-module', label: t('assembly.backToModule') }}
      />

      <main className="max-w-3xl w-full mx-auto py-8 md:py-12 px-4 flex-1">
        {/* Hero */}
        <header className="text-center mb-10 md:mb-14">
          <h1 className="text-hf-fg mb-3" style={{ fontSize: 'var(--fs-2xl)' }}>
            {t('assembly.heroTitle')}
          </h1>
          <p className="text-hf-fg-soft max-w-xl mx-auto text-hf-md">
            {t('assembly.heroSubtitle')}
          </p>
        </header>

        {/* Steps */}
        <ol className="space-y-6 md:space-y-8" aria-label="Assembly steps">
          {tr.assembly.steps.map((step, i) => (
            <li key={i} className="hf-card overflow-hidden shadow-hf-1">
              {/* Image placeholder — explicit aspect ratio prevents CLS */}
              <div
                className="aspect-video flex items-center justify-center border-b border-hf-border"
                style={{ background: 'var(--hf-line-soft)' }}
                aria-hidden="true"
              >
                <div className="text-center text-hf-fg-mute">
                  <svg
                    className="w-10 h-10 mx-auto mb-2 opacity-40"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                  <p className="text-hf-xs">{t('assembly.photoStep', { n: i + 1 })}</p>
                </div>
              </div>

              <div className="p-5 md:p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-hf-sm shrink-0 text-white"
                    style={{
                      background:
                        'linear-gradient(135deg, var(--hf-honey-400), var(--hf-honey-600))',
                    }}
                    aria-hidden="true"
                  >
                    {i + 1}
                  </div>
                  <h3 className="font-bold text-hf-fg" style={{ fontSize: 'var(--fs-md)' }}>
                    {step.title}
                  </h3>
                </div>

                <p className="text-hf-base text-hf-fg-soft mb-4 leading-relaxed">
                  {step.description}
                </p>

                <div
                  className="rounded-hf p-3 border"
                  style={{
                    background: 'color-mix(in oklch, var(--hf-honey-100) 60%, transparent)',
                    borderColor: 'color-mix(in oklch, var(--hf-honey-300) 35%, transparent)',
                  }}
                >
                  <h4 className="text-hf-xs font-semibold text-hf-honey-800 uppercase tracking-wider mb-2">
                    {t('assembly.tips')}
                  </h4>
                  <ul className="space-y-1.5">
                    {step.tips.map((tip, j) => (
                      <li
                        key={j}
                        className="flex items-start gap-2 text-hf-xs md:text-hf-sm"
                        style={{ color: 'var(--hf-honey-900)' }}
                      >
                        <span className="text-hf-honey-600 mt-0.5 shrink-0" aria-hidden="true">
                          ●
                        </span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {/* Factory reset note */}
        <aside className="rounded-hf p-4 mt-8 text-hf-sm hf-card">
          <strong className="text-hf-fg">{t('assembly.factoryResetLabel')}</strong>{' '}
          <span className="text-hf-fg-soft">{t('assembly.factoryReset')}</span>
        </aside>

        {/* Next step */}
        <div
          className="rounded-hf-xl p-6 md:p-8 text-center mt-8 border-2"
          style={{
            background:
              'linear-gradient(135deg, color-mix(in oklch, var(--hf-honey-100) 80%, transparent), color-mix(in oklch, var(--hf-honey-200) 60%, transparent))',
            borderColor: 'color-mix(in oklch, var(--hf-honey-300) 50%, transparent)',
          }}
        >
          <h3 className="text-hf-fg mb-2" style={{ fontSize: 'var(--fs-lg)' }}>
            {t('assembly.ctaTitle')}
          </h3>
          <p className="text-hf-fg-soft mb-6 text-hf-base">{t('assembly.ctaText')}</p>
          <Link to="/setup" className="hf-btn hf-btn-primary inline-flex px-8 py-3">
            {t('assembly.ctaCta')}
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
