import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/LanguageContext';
import LanguageToggle from '../components/LanguageToggle';

export default function HomePage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50">
      {/* Hero Section */}
      <section className="relative h-screen flex items-center justify-center overflow-hidden">
        <div
          className="absolute inset-0 z-0"
          style={{
        backgroundImage: 'url(/heroimage_hive.jpg)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'brightness(0.7)'
          }}
        />
        {/* Overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/60 z-10" />

        {/* Language Toggle */}
        <div className="absolute top-4 right-4 z-30">
          <div className="bg-white/20 backdrop-blur-md rounded-md">
            <LanguageToggle />
          </div>
        </div>

        {/* Content */}
        <div className="relative z-20 text-center px-4 max-w-5xl">
          <h1 className="text-7xl md:text-9xl font-bold text-white mb-6 drop-shadow-2xl">
        🙌 HighFive
          </h1>
          <p className="text-2xl md:text-4xl text-amber-100 mb-8 font-light">
        {t('home.heroSubtitle')}
          </p>
          <p className="text-xl md:text-2xl text-white/90 mb-12 max-w-3xl mx-auto">
        {t('home.heroText')}
          </p>

          <div className="flex flex-col sm:flex-row gap-4 md:gap-6 justify-center items-center">
        <Link
          to="/dashboard"
          className="w-full sm:w-auto bg-amber-500 hover:bg-amber-600 text-white px-8 md:px-12 py-3 md:py-5 rounded-full text-lg md:text-xl font-semibold shadow-2xl transition-all transform hover:scale-105 flex items-center justify-center"
        >
          {t('home.viewDashboard')}
        </Link>
        <a
          href="#how-it-works"
          className="w-full sm:w-auto bg-white/10 backdrop-blur-md hover:bg-white/20 text-white px-8 md:px-12 py-3 md:py-5 rounded-full text-lg md:text-xl font-semibold border-2 border-white/30 transition-all flex items-center justify-center"
        >
          {t('home.howItWorks')}
        </a>
          </div>
        </div>

        {/* Scroll Indicator */}
        <div className="absolute left-1/2 bottom-10 -translate-x-1/2 z-20 flex justify-center w-full pointer-events-none">
          <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" className="py-16 md:py-24 px-3 md:px-4 bg-white">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center text-gray-900 mb-12 md:mb-16">
            {t('home.getStartedTitle')}
          </h2>

          <div className="flex flex-col gap-8 md:gap-12 max-w-2xl mx-auto">
            {/* Step 1 */}
            <div className="relative">
              <div className="bg-gradient-to-br from-amber-400 to-orange-500 w-14 h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center text-white text-2xl md:text-3xl font-bold mb-4 md:mb-6 shadow-lg">
                1
              </div>
              <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 md:mb-4">{t('home.step1Title')}</h3>
              <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-4 md:mb-6">
                {t('home.step1Text')}
              </p>

              <Link
                to="/hive-module"
                className="flex items-center justify-center w-full bg-amber-500 hover:bg-amber-600 text-white px-3 md:px-4 py-3 rounded-lg font-semibold text-sm md:text-base transition-colors"
              >
                {t('home.step1Cta')}
              </Link>
            </div>

            {/* Step 2 */}
            <div className="relative">
              <div className="bg-gradient-to-br from-amber-400 to-orange-500 w-14 h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center text-white text-2xl md:text-3xl font-bold mb-4 md:mb-6 shadow-lg">
                2
              </div>
              <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 md:mb-4">{t('home.step2Title')}</h3>
              <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-3 md:mb-4">
                {t('home.step2Text')}
              </p>

              <div className="bg-blue-50 rounded-lg p-3 md:p-4 border-2 border-blue-200">
                <h4 className="font-bold text-sm md:text-base text-gray-900 mb-2">{t('home.step2GuidedTitle')}</h4>
                <p className="text-xs md:text-sm text-gray-600 mb-3">
                  {t('home.step2GuidedText')}
                </p>
                <a
                  href="/setup"
                  className="flex items-center justify-center w-full bg-blue-500 hover:bg-blue-600 text-white px-3 md:px-4 py-2 rounded-lg font-semibold text-sm md:text-base transition-colors"
                >
                  {t('home.step2Cta')}
                </a>
              </div>
            </div>

            {/* Step 3 */}
            <div className="relative">
              <div className="bg-gradient-to-br from-amber-400 to-orange-500 w-14 h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center text-white text-2xl md:text-3xl font-bold mb-4 md:mb-6 shadow-lg">
                3
              </div>

              <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 md:mb-4">{t('home.step3Title')}</h3>

              <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-3 md:mb-4">
                {t('home.step3Text')}
              </p>
                            <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg p-3 md:p-4 mb-3 md:mb-4 border-2 border-green-200">
                <p className="text-xs md:text-sm text-gray-700 mb-2">
                  {t('home.step3Community')}
                </p>
              </div>
              <Link
                to="/dashboard"
                className="mt-2 flex items-center justify-center w-full bg-amber-500 hover:bg-amber-600 text-white px-4 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-sm md:text-base transition-colors"
              >
                {t('home.step3Cta')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-12 px-4">
        <div className="max-w-6xl mx-auto text-center">
          <p className="text-gray-400">{t('home.footer')}</p>
          <div className="mt-6">
            <a href="https://partner.schutera.com/impressum" className="text-amber-400 hover:text-amber-300 mx-4">
              {t('common.impressum')}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
