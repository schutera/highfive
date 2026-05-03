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

  return (
    <section className="flex flex-col items-center text-center" aria-labelledby="step1-title">
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center mb-6"
        style={{ background: 'var(--hf-honey-100)' }}
        aria-hidden="true"
      >
        <svg
          className="w-12 h-12 text-hf-honey-700"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 3v12m0 0l-3-3m3 3l3-3M5 20h14a1 1 0 001-1v-3a1 1 0 00-1-1h-3m-8 0H5a1 1 0 00-1 1v3a1 1 0 001 1"
          />
        </svg>
      </div>

      <h2
        id="step1-title"
        className="font-bold text-hf-fg mb-3"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step1.title')}
      </h2>
      <p className="text-hf-fg-soft mb-8 max-w-md text-hf-base">{t('step1.text')}</p>

      {/* Browser check */}
      <div
        className={`rounded-hf-lg p-4 mb-6 w-full max-w-sm border-2`}
        style={{
          background: browserSupported
            ? 'color-mix(in oklch, var(--hf-success) 8%, transparent)'
            : 'color-mix(in oklch, var(--hf-warn) 12%, transparent)',
          borderColor: browserSupported
            ? 'color-mix(in oklch, var(--hf-success) 30%, transparent)'
            : 'color-mix(in oklch, var(--hf-warn) 40%, transparent)',
        }}
        role={browserSupported ? 'status' : 'alert'}
      >
        <div className="flex items-center gap-3">
          {browserSupported ? (
            <svg
              className="w-5 h-5 shrink-0"
              style={{ color: 'var(--hf-success)' }}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          ) : (
            <svg
              className="w-5 h-5 shrink-0"
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
      </div>

      {/* Cable tip */}
      <aside className="hf-card p-4 mb-8 w-full max-w-sm text-left">
        <p className="text-hf-xs text-hf-fg-soft">
          <strong className="text-hf-fg">{t('step1.tip')}</strong> {t('step1.cableTip')}
        </p>
      </aside>

      <button onClick={onNext} className="hf-btn hf-btn-primary w-full md:w-auto px-8 py-3">
        {t('common.next')}
      </button>
    </section>
  );
}
