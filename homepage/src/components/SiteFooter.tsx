import { useTranslation } from '../i18n/LanguageContext';

/**
 * Compact footer used on all marketing pages. Keeps the Impressum link
 * required for German legal compliance front-and-centre.
 *
 * The Open-Meteo CC-BY 4.0 attribution that ADR-017/ADR-015 added here
 * was removed alongside disabling the dashboard weather chart
 * (ActivityWeatherChart in ModulePanel) — with no weather data rendered
 * to the operator anywhere in the UI, the attribution is no longer tied
 * to a visible use. Restore both together when the weather chart is
 * re-enabled against real data.
 */
export default function SiteFooter() {
  const { t } = useTranslation();
  return (
    <footer className="bg-hf-fg/95 text-hf-honey-50 py-12 px-4 mt-auto">
      <div className="max-w-6xl mx-auto text-center flex flex-col items-center gap-4">
        <p className="text-hf-honey-100 text-hf-sm">{t('home.footer')}</p>
        <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 text-hf-sm">
          <a
            href="https://partner.schutera.com/impressum"
            className="text-hf-honey-300 hover:text-hf-honey-200 underline underline-offset-4 rounded-md"
          >
            {t('common.impressum')}
          </a>
        </div>
      </div>
    </footer>
  );
}
