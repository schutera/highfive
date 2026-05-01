import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/LanguageContext';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
// Vite-managed video and poster — emitted with content hashes and hosted
// alongside the page chunk so the homepage doesn't pay for them.
import hiveshowMp4 from '../assets/hiveshow.mp4?url';
import hiveshowPoster from '../assets/hiveshow-poster.webp?url';
// CAD source file — same idea; preserves cache busting on update.
import cadFileUrl from '../assets/HiveModule.FCStd?url';

const STRIPE_LINK = import.meta.env.VITE_STRIPE_LINK || '#';

export default function HiveModule() {
  const { t } = useTranslation();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-hf-bg text-hf-fg">
      <SiteHeader
        title={t('hiveModule.pageTitle')}
        secondary={{ to: '/', label: t('common.backToHome') }}
      />

      <main className="max-w-4xl w-full mx-auto py-8 md:py-12 px-4 flex-1">
        {/* Hero */}
        <header className="text-center mb-10 md:mb-14">
          <h1 className="text-hf-fg mb-3" style={{ fontSize: 'var(--fs-2xl)' }}>
            {t('hiveModule.heroTitle')}
          </h1>
          <p className="text-hf-fg-soft max-w-2xl mx-auto" style={{ fontSize: 'var(--fs-md)' }}>
            {t('hiveModule.heroText')}
          </p>
        </header>

        {/* Video — preload metadata only so mobile doesn't pay full cost */}
        <div className="rounded-hf-xl overflow-hidden mb-10 md:mb-14 shadow-hf-2 aspect-video bg-black">
          <video
            className="w-full h-full object-cover"
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            poster={hiveshowPoster}
            aria-label={t('hiveModule.heroTitle')}
          >
            <source src={hiveshowMp4} type="video/mp4" />
          </video>
        </div>

        {/* Order + DIY */}
        <div
          className="grid gap-6 mb-10 md:mb-14"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' }}
        >
          {/* Order */}
          <article
            className="hf-card p-6 flex flex-col border-2"
            style={{ borderColor: 'color-mix(in oklch, var(--hf-honey-300) 60%, transparent)' }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                style={{ background: 'var(--hf-honey-100)' }}
                aria-hidden="true"
              >
                <svg
                  className="w-5 h-5 text-hf-honey-700"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z"
                  />
                </svg>
              </div>
              <h2 className="font-bold text-hf-fg" style={{ fontSize: 'var(--fs-md)' }}>
                {t('hiveModule.orderTitle')}
              </h2>
            </div>
            <p className="text-hf-sm text-hf-fg-soft mb-4 flex-1">{t('hiveModule.orderText')}</p>
            <a
              href={STRIPE_LINK}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={STRIPE_LINK === '#'}
              className={`hf-btn w-full py-3 ${STRIPE_LINK === '#' ? 'cursor-not-allowed' : 'hf-btn-primary'}`}
              style={
                STRIPE_LINK === '#'
                  ? { background: 'var(--hf-line-soft)', color: 'var(--hf-fg-mute)' }
                  : undefined
              }
              onClick={(e) => {
                if (STRIPE_LINK === '#') e.preventDefault();
              }}
            >
              {STRIPE_LINK === '#' ? t('hiveModule.comingSoon') : t('hiveModule.orderCta')}
            </a>
          </article>

          {/* DIY */}
          <article className="hf-card p-6 flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                style={{ background: 'var(--hf-line-soft)' }}
                aria-hidden="true"
              >
                <svg
                  className="w-5 h-5 text-hf-fg-soft"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
              </div>
              <h2 className="font-bold text-hf-fg" style={{ fontSize: 'var(--fs-md)' }}>
                {t('hiveModule.diyTitle')}
              </h2>
            </div>
            <p className="text-hf-sm text-hf-fg-soft mb-4 flex-1">{t('hiveModule.diyText')}</p>
            <a
              href={cadFileUrl}
              download="HiveModule.FCStd"
              className="hf-btn hf-btn-secondary w-full py-3"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              {t('hiveModule.diyCta')}
            </a>
          </article>
        </div>

        {/* Electronics */}
        <section className="mb-10 md:mb-14" aria-labelledby="parts-title">
          <h2
            id="parts-title"
            className="text-hf-fg mb-2 text-center"
            style={{ fontSize: 'var(--fs-xl)' }}
          >
            {t('hiveModule.electronicsTitle')}
          </h2>
          <p className="text-hf-fg-soft text-center mb-8 text-hf-base">
            {t('hiveModule.electronicsSubtitle')}
          </p>

          <div className="hf-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr
                  style={{ background: 'var(--hf-line-soft)' }}
                  className="border-b border-hf-border"
                >
                  <th className="text-left px-4 md:px-6 py-3 text-hf-sm font-semibold text-hf-fg-soft">
                    {t('hiveModule.component')}
                  </th>
                  <th className="text-left px-4 md:px-6 py-3 text-hf-sm font-semibold text-hf-fg-soft hidden md:table-cell">
                    {t('hiveModule.description')}
                  </th>
                  <th className="text-right px-4 md:px-6 py-3 text-hf-sm font-semibold text-hf-fg-soft">
                    {t('hiveModule.estPrice')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hf-border">
                <PartRow
                  name={t('hiveModule.esp32cam')}
                  description={t('hiveModule.esp32camDesc')}
                  price="8–12€"
                />
                <PartRow
                  name={t('hiveModule.pvModule')}
                  description={t('hiveModule.pvModuleDesc')}
                  price="12–18€"
                />
                <PartRow
                  name={t('hiveModule.chargeController')}
                  description={t('hiveModule.chargeControllerDesc')}
                  price="2–4€"
                />
                <PartRow
                  name={t('hiveModule.batteryPack')}
                  description={t('hiveModule.batteryPackDesc')}
                  price="8–16€"
                />
                <PartRow
                  name={t('hiveModule.bms')}
                  description={t('hiveModule.bmsDesc')}
                  price="3–5€"
                />
                <PartRow
                  name={t('hiveModule.boostConverter')}
                  description={t('hiveModule.boostConverterDesc')}
                  price="2–4€"
                />
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--hf-honey-50)' }}>
                  <td className="px-4 md:px-6 py-3 font-bold text-hf-fg" colSpan={2}>
                    {t('hiveModule.estimatedTotal')}
                  </td>
                  <td className="px-4 md:px-6 py-3 font-bold text-right text-hf-md text-hf-honey-700 tabular-nums">
                    35–59€
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* Tools */}
        <section className="mb-10 md:mb-14" aria-labelledby="tools-title">
          <h2
            id="tools-title"
            className="text-hf-fg mb-2 text-center"
            style={{ fontSize: 'var(--fs-xl)' }}
          >
            {t('hiveModule.toolsTitle')}
          </h2>
          <p className="text-hf-fg-soft text-center mb-8 text-hf-base">
            {t('hiveModule.toolsSubtitle')}
          </p>

          <div className="hf-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr
                  style={{ background: 'var(--hf-line-soft)' }}
                  className="border-b border-hf-border"
                >
                  <th className="text-left px-4 md:px-6 py-3 text-hf-sm font-semibold text-hf-fg-soft">
                    {t('hiveModule.tool')}
                  </th>
                  <th className="text-left px-4 md:px-6 py-3 text-hf-sm font-semibold text-hf-fg-soft hidden md:table-cell">
                    {t('hiveModule.purpose')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hf-border">
                <ToolRow
                  name={t('hiveModule.solderingIron')}
                  description={t('hiveModule.solderingIronDetail')}
                />
                <ToolRow
                  name={t('hiveModule.doubleSidedTape')}
                  description={t('hiveModule.doubleSidedTapeDetail')}
                />
                <ToolRow
                  name={t('hiveModule.smallScrewdriver')}
                  description={t('hiveModule.smallScrewdriverDetail')}
                />
              </tbody>
            </table>
          </div>
        </section>

        {/* Next CTA */}
        <div
          className="rounded-hf-xl p-6 md:p-8 text-center border-2"
          style={{
            background:
              'linear-gradient(135deg, color-mix(in oklch, var(--hf-honey-100) 80%, transparent), color-mix(in oklch, var(--hf-honey-200) 60%, transparent))',
            borderColor: 'color-mix(in oklch, var(--hf-honey-300) 50%, transparent)',
          }}
        >
          <h3 className="text-hf-fg mb-2" style={{ fontSize: 'var(--fs-lg)' }}>
            {t('hiveModule.ctaTitle')}
          </h3>
          <p className="text-hf-fg-soft mb-6 text-hf-base">{t('hiveModule.ctaText')}</p>
          <Link
            to="/assembly"
            viewTransition
            className="hf-btn hf-btn-primary inline-flex px-8 py-3"
          >
            {t('hiveModule.ctaCta')}
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function ToolRow({ name, description }: { name: string; description: string }) {
  return (
    <tr className="hover:bg-hf-fg/[0.025] transition-colors">
      <td className="px-4 md:px-6 py-3">
        <span className="font-semibold text-hf-fg text-hf-sm">{name}</span>
        <p className="text-hf-xs text-hf-fg-mute md:hidden mt-0.5">{description}</p>
      </td>
      <td className="px-4 md:px-6 py-3 text-hf-sm text-hf-fg-soft hidden md:table-cell">
        {description}
      </td>
    </tr>
  );
}

function PartRow({
  name,
  description,
  price,
}: {
  name: string;
  description: string;
  price: string;
}) {
  return (
    <tr className="hover:bg-hf-fg/[0.025] transition-colors">
      <td className="px-4 md:px-6 py-3">
        <span className="font-semibold text-hf-fg text-hf-sm">{name}</span>
        <p className="text-hf-xs text-hf-fg-mute md:hidden mt-0.5">{description}</p>
      </td>
      <td className="px-4 md:px-6 py-3 text-hf-sm text-hf-fg-soft hidden md:table-cell">
        {description}
      </td>
      <td className="px-4 md:px-6 py-3 text-hf-sm font-semibold text-hf-honey-700 text-right whitespace-nowrap tabular-nums">
        {price}
      </td>
    </tr>
  );
}
