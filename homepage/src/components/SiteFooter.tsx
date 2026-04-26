import { useTranslation } from '../i18n/LanguageContext';

/**
 * Compact footer used on all marketing pages. Keeps the Impressum link
 * required for German legal compliance front-and-centre.
 */
export default function SiteFooter() {
  const { t } = useTranslation();
  return (
    <footer className="bg-hf-fg/95 text-hf-honey-50 py-12 px-4 mt-auto">
      <div className="max-w-6xl mx-auto text-center flex flex-col items-center gap-4">
        <p className="text-hf-honey-100 text-hf-sm">{t('home.footer')}</p>
        <a
          href="https://partner.schutera.com/impressum"
          className="text-hf-honey-300 hover:text-hf-honey-200 underline underline-offset-4 text-hf-sm rounded-md"
        >
          {t('common.impressum')}
        </a>
      </div>
    </footer>
  );
}
