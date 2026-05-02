import { useState } from 'react';
import { useTranslation } from '../../i18n/LanguageContext';

interface Step4ConfigureProps {
  configSent: boolean;
  markConfigDone: () => void;
  onNext: () => void;
  onBack: () => void;
}

export default function Step4Configure({
  configSent,
  markConfigDone,
  onNext,
  onBack,
}: Step4ConfigureProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);

  const handleOpen = () => {
    window.open('http://192.168.4.1', '_blank');
    setOpened(true);
  };

  return (
    <section className="flex flex-col items-center" aria-labelledby="step4-title">
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center mb-5 transition-colors duration-500"
        style={{ background: configSent ? 'var(--hf-forest-100)' : 'var(--hf-honey-100)' }}
        aria-hidden="true"
      >
        {configSent ? (
          <svg
            className="w-10 h-10 animate-scale-in"
            style={{ color: 'var(--hf-success)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            className="w-10 h-10 text-hf-honey-700"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        )}
      </div>

      <h2
        id="step4-title"
        className="font-bold text-hf-fg mb-2 text-center"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {configSent ? t('step4.reconnectTitle') : t('step4.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 text-center max-w-md text-hf-base">
        {configSent ? t('step4.reconnectText') : t('step4.text')}
      </p>

      {configSent && (
        <aside
          className="rounded-hf-xl p-5 mb-6 w-full max-w-md text-left border-2"
          style={{
            background: 'color-mix(in oklch, var(--hf-info) 8%, transparent)',
            borderColor: 'color-mix(in oklch, var(--hf-info) 35%, transparent)',
          }}
        >
          <div className="flex gap-3 items-start">
            <svg
              className="w-6 h-6 shrink-0 mt-0.5"
              style={{ color: 'var(--hf-info)' }}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0"
              />
            </svg>
            <div>
              <p className="text-hf-sm font-bold text-hf-fg">{t('step4.reconnectWifiLabel')}</p>
              <ol className="text-hf-xs text-hf-fg-soft mt-2 space-y-1 list-decimal list-inside">
                <li>{t('step4.reconnectStep1')}</li>
                <li>{t('step4.reconnectStep2')}</li>
                <li>{t('step4.reconnectStep3')}</li>
              </ol>
            </div>
          </div>
        </aside>
      )}

      {/* Configuration instructions — shown before done */}
      {!configSent && (
        <>
          <button
            onClick={handleOpen}
            className="hf-btn hf-btn-primary px-8 py-3 inline-flex items-center gap-2"
          >
            {t('step4.openConfigPage')}
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
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </button>

          {opened && (
            <button onClick={markConfigDone} className="hf-btn hf-btn-secondary mt-4 px-8 py-3">
              {t('step4.configDoneBtn')}
            </button>
          )}
        </>
      )}

      {/* Navigation */}
      <div className="flex gap-3 w-full md:w-auto mt-4">
        <button onClick={onBack} className="hf-btn hf-btn-secondary flex-1 md:flex-none px-6 py-3">
          {t('common.back')}
        </button>
        {configSent && (
          <button onClick={onNext} className="hf-btn hf-btn-primary flex-1 md:flex-none px-8 py-3">
            {t('step4.reconnectBtn')}
          </button>
        )}
      </div>
    </section>
  );
}
