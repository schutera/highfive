import { useTranslation } from '../i18n/LanguageContext';

export default function LanguageToggle() {
  const { lang, setLang } = useTranslation();

  return (
    <button
      onClick={() => setLang(lang === 'en' ? 'de' : 'en')}
      className="text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors px-2 py-1 rounded-md hover:bg-gray-100"
      title={lang === 'en' ? 'Auf Deutsch wechseln' : 'Switch to English'}
    >
      {lang === 'en' ? 'DE' : 'EN'}
    </button>
  );
}
