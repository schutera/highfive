import { useTranslation } from '../i18n/LanguageContext';

/**
 * Compact footer used on all marketing pages. Keeps the Impressum link
 * required for German legal compliance front-and-centre. The Open-Meteo
 * attribution next to it satisfies the CC-BY 4.0 licence requirement
 * that ADR-017 carries forward from ADR-015 (also satisfied
 * browser-side by the activity chart, but the server-side worker
 * means the data lands on the dashboard regardless of whether the
 * chart was opened).
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
          <a
            href="https://open-meteo.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-hf-honey-300 hover:text-hf-honey-200 underline underline-offset-4 rounded-md"
          >
            {t('common.weatherAttribution')}
          </a>
        </div>
      </div>
    </footer>
  );
}
