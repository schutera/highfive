import { useTranslation } from '../i18n/LanguageContext';

interface LanguageToggleProps {
  className?: string;
}

/**
 * Two-state EN/DE toggle. Renders the *target* language code (the one
 * you'll switch *to*) so the button label answers "what does this do?"
 * rather than "what language am I in?".
 */
export default function LanguageToggle({ className = '' }: LanguageToggleProps) {
  const { lang, setLang } = useTranslation();
  const isDe = lang === 'de';
  return (
    <button
      type="button"
      onClick={() => setLang(isDe ? 'en' : 'de')}
      className={`inline-flex items-center justify-center min-w-[36px] h-9 px-2 rounded-full text-hf-xs font-semibold tracking-wide text-hf-fg-soft hover:text-hf-fg hover:bg-hf-fg/5 transition-colors ${className}`}
      title={isDe ? 'Switch to English' : 'Auf Deutsch wechseln'}
      aria-label={isDe ? 'Switch language to English' : 'Sprache auf Deutsch wechseln'}
      lang={isDe ? 'en' : 'de'}
    >
      {isDe ? 'EN' : 'DE'}
    </button>
  );
}
