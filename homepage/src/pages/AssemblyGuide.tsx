import { Link } from 'react-router-dom';
import { useTranslation, useTranslationRaw } from '../i18n/LanguageContext';
import LanguageToggle from '../components/LanguageToggle';

export default function AssemblyGuide() {
  const { t } = useTranslation();
  const tr = useTranslationRaw();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm px-3 md:px-6 py-2 md:py-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-2 md:gap-4">
          <Link
            to="/"
            className="text-lg md:text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1"
          >
            <span className="text-xl md:text-2xl">🙌</span>
            <span>HighFive</span>
          </Link>
          <span className="text-gray-300 hidden md:inline">|</span>
          <h1 className="hidden md:block text-xl font-semibold text-gray-800">
            {t('assembly.pageTitle')}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle />
          <Link to="/hive-module" className="text-sm text-gray-500 hover:text-gray-700">
            {t('assembly.backToModule')}
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto py-8 md:py-12 px-4">
        {/* Hero */}
        <div className="text-center mb-10 md:mb-14">
          <h1 className="text-3xl md:text-5xl font-bold text-gray-900 mb-3">
            {t('assembly.heroTitle')}
          </h1>
          <p className="text-lg text-gray-600 max-w-xl mx-auto">
            {t('assembly.heroSubtitle')}
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-6 md:space-y-8">
          {tr.assembly.steps.map((step, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              {/* Image placeholder */}
              <div className="bg-gray-100 aspect-video flex items-center justify-center border-b border-gray-200">
                <div className="text-center text-gray-400">
                  <svg className="w-10 h-10 mx-auto mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-xs">{t('assembly.photoStep', { n: i + 1 })}</p>
                </div>
              </div>

              {/* Content */}
              <div className="p-5 md:p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="bg-amber-500 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0">
                    {i + 1}
                  </div>
                  <h3 className="text-lg md:text-xl font-bold text-gray-900">{step.title}</h3>
                </div>

                <p className="text-sm md:text-base text-gray-700 mb-4 leading-relaxed">
                  {step.description}
                </p>

                {/* Tips */}
                <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">{t('assembly.tips')}</h4>
                  <ul className="space-y-1.5">
                    {step.tips.map((tip, j) => (
                      <li key={j} className="flex items-start gap-2 text-xs md:text-sm text-amber-900">
                        <span className="text-amber-500 mt-0.5 shrink-0">&#9679;</span>
                        {tip}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Factory reset note */}
        <div className="bg-gray-100 rounded-lg p-4 mt-8 text-sm text-gray-700">
          <strong>{t('assembly.factoryResetLabel')}</strong> {t('assembly.factoryReset')}
        </div>

        {/* Next step CTA */}
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border-2 border-amber-200 p-6 md:p-8 text-center mt-8">
          <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">
            {t('assembly.ctaTitle')}
          </h3>
          <p className="text-gray-600 mb-6">
            {t('assembly.ctaText')}
          </p>
          <Link
            to="/setup"
            className="inline-block bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
          >
            {t('assembly.ctaCta')}
          </Link>
        </div>
      </main>
    </div>
  );
}
