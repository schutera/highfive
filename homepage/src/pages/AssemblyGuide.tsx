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

      <main id="main" className="max-w-3xl w-full mx-auto py-8 md:py-12 px-4 flex-1">
        {/* Hero */}
        <header className="mb-10 md:mb-14">
          <h1 className="text-hf-fg mb-3" style={{ fontSize: 'var(--fs-2xl)' }}>
            {t('assembly.heroTitle')}
          </h1>
          <p className="text-hf-fg-soft max-w-xl text-hf-md">{t('assembly.heroSubtitle')}</p>
        </header>

        {/* Steps */}
        <ol className="space-y-6 md:space-y-8" aria-label="Assembly steps">
          {tr.assembly.steps.map((step, i) => (
            <li key={i} className="hf-card overflow-hidden shadow-hf-1">
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

                <div>
                  <h4 className="text-hf-xs font-semibold text-hf-fg-soft uppercase tracking-wider mb-2">
                    {t('assembly.tips')}
                  </h4>
                  <ul className="list-disc pl-5 space-y-1.5 text-hf-sm text-hf-fg-soft">
                    {step.tips.map((tip, j) => (
                      <li key={j}>{tip}</li>
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
        <div className="hf-card p-6 md:p-8 mt-8">
          <h3 className="text-hf-fg mb-2" style={{ fontSize: 'var(--fs-lg)' }}>
            {t('assembly.ctaTitle')}
          </h3>
          <p className="text-hf-fg-soft mb-6 text-hf-base">{t('assembly.ctaText')}</p>
          <Link to="/setup" viewTransition className="hf-btn hf-btn-primary inline-flex px-8 py-3">
            {t('assembly.ctaCta')}
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
