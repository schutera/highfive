import { useMemo } from 'react';
import { useTranslation } from '../../i18n/LanguageContext';

interface Step1ConnectProps {
  onNext: () => void;
}

export default function Step1Connect({ onNext }: Step1ConnectProps) {
  const { t } = useTranslation();
  const browserSupported = useMemo(() => {
    const ua = navigator.userAgent;
    return /Chrome|Edg/i.test(ua) && !/Firefox/i.test(ua);
  }, []);

  // Skill rules applied:
  // - "Default to left-aligned; center only with intent." Removed text-center.
  // - "The fix is usually to remove three." Removed the 96px icon circle.
  // - "Don't communicate via color alone — pair with icon, weight, or position."
  //   Browser-check status keeps its icon but loses the heavy 2px tinted border;
  //   it is now an inline status row, not a competing card.
  // - Cable tip demoted from card chrome to a plain hint paragraph.
  return (
    <section className="flex flex-col" aria-labelledby="step1-title">
      <h2
        id="step1-title"
        className="font-bold text-hf-fg mb-2"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step1.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 text-hf-base">{t('step1.text')}</p>

      {/* Browser check — inline row, icon + weight, no tinted card */}
      <div className="flex items-center gap-2 mb-3" role={browserSupported ? 'status' : 'alert'}>
        {browserSupported ? (
          <svg
            className="w-4 h-4 shrink-0"
            style={{ color: 'var(--hf-success)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M5 13l4 4L19 7"
            />
          </svg>
        ) : (
          <svg
            className="w-4 h-4 shrink-0"
            style={{ color: 'var(--hf-warn)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01M12 3l9.09 16.91H2.91L12 3z"
            />
          </svg>
        )}
        <span className="text-hf-sm font-medium text-hf-fg">
          {browserSupported ? t('step1.browserOk') : t('step1.browserFail')}
        </span>
      </div>

      {/* Cable tip — chromeless tertiary text */}
      <p className="text-hf-xs text-hf-fg-mute mb-8">
        <span className="font-semibold text-hf-fg-soft">{t('step1.tip')}</span>{' '}
        {t('step1.cableTip')}
      </p>

      <div className="flex justify-end">
        <button onClick={onNext} className="hf-btn hf-btn-primary w-full md:w-auto px-8 py-3">
          {t('common.next')}
        </button>
      </div>
    </section>
  );
}
