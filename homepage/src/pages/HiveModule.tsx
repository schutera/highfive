import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/LanguageContext';
import LanguageToggle from '../components/LanguageToggle';

const STRIPE_LINK = import.meta.env.VITE_STRIPE_LINK || '#';

export default function HiveModule() {
  const { t } = useTranslation();

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
            {t('hiveModule.pageTitle')}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle />
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
            {t('common.backToHome')}
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto py-8 md:py-12 px-4">
        {/* Hero */}
        <div className="text-center mb-10 md:mb-14">
          <h1 className="text-3xl md:text-5xl font-bold text-gray-900 mb-3">
            {t('hiveModule.heroTitle')}
          </h1>
          <p className="text-lg md:text-xl text-gray-600 max-w-2xl mx-auto">
            {t('hiveModule.heroText')}
          </p>
        </div>

        {/* Hive Module Video */}
        <div className="rounded-2xl overflow-hidden mb-10 md:mb-14 shadow-lg aspect-video bg-black">
          <video
            className="w-full h-full object-cover"
            autoPlay
            loop
            muted
            playsInline
          >
            <source src="/assets/hiveshow.mp4" type="video/mp4" />
          </video>
        </div>

        {/* Two columns: Order + DIY */}
        <div className="grid md:grid-cols-2 gap-6 mb-10 md:mb-14">
          {/* Order wooden parts */}
          <div className="bg-white rounded-xl border-2 border-amber-200 p-6 flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900">{t('hiveModule.orderTitle')}</h2>
            </div>
            <p className="text-sm text-gray-600 mb-4 flex-1">
              {t('hiveModule.orderText')}
            </p>
            <a
              href={STRIPE_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center justify-center w-full py-3 rounded-lg font-semibold transition-colors ${
                STRIPE_LINK === '#'
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                  : 'bg-amber-500 hover:bg-amber-600 text-white'
              }`}
              onClick={e => { if (STRIPE_LINK === '#') e.preventDefault(); }}
            >
              {STRIPE_LINK === '#' ? t('hiveModule.comingSoon') : t('hiveModule.orderCta')}
            </a>
          </div>

          {/* DIY / CAD files */}
          <div className="bg-white rounded-xl border-2 border-gray-200 p-6 flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900">{t('hiveModule.diyTitle')}</h2>
            </div>
            <p className="text-sm text-gray-600 mb-4 flex-1">
              {t('hiveModule.diyText')}
            </p>
            <a
              href="/assets/HiveModule.FCStd"
              download="HiveModule.FCStd"
              className="flex items-center justify-center w-full bg-gray-100 hover:bg-gray-200 text-gray-800 py-3 rounded-lg font-semibold transition-colors"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {t('hiveModule.diyCta')}
            </a>
          </div>
        </div>

        {/* Electronics parts list */}
        <div className="mb-10 md:mb-14">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2 text-center">
            {t('hiveModule.electronicsTitle')}
          </h2>
          <p className="text-gray-600 text-center mb-8">
            {t('hiveModule.electronicsSubtitle')}
          </p>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 md:px-6 py-3 text-sm font-semibold text-gray-700">{t('hiveModule.component')}</th>
                  <th className="text-left px-4 md:px-6 py-3 text-sm font-semibold text-gray-700 hidden md:table-cell">{t('hiveModule.description')}</th>
                  <th className="text-right px-4 md:px-6 py-3 text-sm font-semibold text-gray-700">{t('hiveModule.estPrice')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <PartRow name={t('hiveModule.esp32cam')} description={t('hiveModule.esp32camDesc')} price="8–12€" />
                <PartRow name={t('hiveModule.pvModule')} description={t('hiveModule.pvModuleDesc')} price="12–18€" />
                <PartRow name={t('hiveModule.chargeController')} description={t('hiveModule.chargeControllerDesc')} price="2–4€" />
                <PartRow name={t('hiveModule.batteryPack')} description={t('hiveModule.batteryPackDesc')} price="8–16€" />
                <PartRow name={t('hiveModule.bms')} description={t('hiveModule.bmsDesc')} price="3–5€" />
                <PartRow name={t('hiveModule.boostConverter')} description={t('hiveModule.boostConverterDesc')} price="2–4€" />
              </tbody>
              <tfoot>
                <tr className="bg-amber-50">
                  <td className="px-4 md:px-6 py-3 font-bold text-gray-900" colSpan={2}>{t('hiveModule.estimatedTotal')}</td>
                  <td className="px-4 md:px-6 py-3 font-bold text-amber-600 text-right text-lg">35–59€</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Tools needed */}
        <div className="mb-10 md:mb-14">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2 text-center">
            {t('hiveModule.toolsTitle')}
          </h2>
          <p className="text-gray-600 text-center mb-8">
            {t('hiveModule.toolsSubtitle')}
          </p>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 md:px-6 py-3 text-sm font-semibold text-gray-700">{t('hiveModule.tool')}</th>
                  <th className="text-left px-4 md:px-6 py-3 text-sm font-semibold text-gray-700 hidden md:table-cell">{t('hiveModule.purpose')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <ToolRow name={t('hiveModule.solderingIron')} description={t('hiveModule.solderingIronDetail')} />
                <ToolRow name={t('hiveModule.doubleSidedTape')} description={t('hiveModule.doubleSidedTapeDetail')} />
                <ToolRow name={t('hiveModule.smallScrewdriver')} description={t('hiveModule.smallScrewdriverDetail')} />
              </tbody>
            </table>
          </div>
        </div>

        {/* Next step CTA */}
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border-2 border-amber-200 p-6 md:p-8 text-center">
          <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">
            {t('hiveModule.ctaTitle')}
          </h3>
          <p className="text-gray-600 mb-6">
            {t('hiveModule.ctaText')}
          </p>
          <Link
            to="/assembly"
            className="inline-block bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
          >
            {t('hiveModule.ctaCta')}
          </Link>
        </div>
      </main>
    </div>
  );
}

function ToolRow({ name, description }: { name: string; description: string }) {
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 md:px-6 py-3">
        <span className="font-semibold text-gray-900 text-sm">{name}</span>
        <p className="text-xs text-gray-500 md:hidden mt-0.5">{description}</p>
      </td>
      <td className="px-4 md:px-6 py-3 text-sm text-gray-600 hidden md:table-cell">{description}</td>
    </tr>
  );
}

function PartRow({ name, description, price }: { name: string; description: string; price: string }) {
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 md:px-6 py-3">
        <span className="font-semibold text-gray-900 text-sm">{name}</span>
        <p className="text-xs text-gray-500 md:hidden mt-0.5">{description}</p>
      </td>
      <td className="px-4 md:px-6 py-3 text-sm text-gray-600 hidden md:table-cell">{description}</td>
      <td className="px-4 md:px-6 py-3 text-sm font-semibold text-amber-600 text-right whitespace-nowrap">{price}</td>
    </tr>
  );
}
