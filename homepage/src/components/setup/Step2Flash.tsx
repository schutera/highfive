import { useState, useCallback } from 'react';
import { useTranslation } from '../../i18n/LanguageContext';
import { flashEsp, FlashProgress, Manifest } from './flashEsp';

// Firmware lives at /firmware.bin (served from public/ and dropped there by
// ESP32-CAM/build.sh at deploy time). Importing as a Vite asset under
// homepage/src/assets/ would re-bake a stale binary into the homepage bundle.
const FIRMWARE_MANIFEST: Manifest = {
  name: 'HighFive ESP32',
  version: '0.2.0',
  builds: [
    {
      chipFamily: 'ESP32',
      parts: [{ path: '/firmware.bin', offset: 0 }],
    },
  ],
};

interface Step2FlashProps {
  firmwareUrl: string;
  firmwareVersion: string;
  firmwareLoading: boolean;
  flashComplete: boolean;
  markFlashComplete: () => void;
  onNext: () => void;
  onBack: () => void;
}

type FlashState = FlashProgress['state'] | 'idle';

export default function Step2Flash({
  firmwareVersion,
  firmwareLoading,
  flashComplete,
  markFlashComplete,
  onNext,
  onBack,
}: Step2FlashProps) {
  const { t } = useTranslation();
  const [flashState, setFlashState] = useState<FlashState>('idle');
  const [flashPercent, setFlashPercent] = useState(0);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [flashStarted, setFlashStarted] = useState(false);

  const startFlash = useCallback(async () => {
    setFlashState('connecting');
    setFlashError(null);
    setFlashStarted(true);

    await flashEsp(FIRMWARE_MANIFEST, (progress: FlashProgress) => {
      setFlashState(progress.state);
      if (progress.percent !== undefined) setFlashPercent(progress.percent);
      if (progress.error) setFlashError(progress.error);
      if (progress.state === 'finished') markFlashComplete();
    });
  }, [markFlashComplete]);

  const flashStateLabel = (): string => {
    switch (flashState) {
      case 'connecting':
        return t('step2.stateConnecting');
      case 'preparing':
        return t('step2.statePreparing');
      case 'erasing':
        return t('step2.stateErasing');
      case 'writing':
        return t('step2.stateWriting') + (flashPercent > 0 ? ` (${flashPercent}%)` : '');
      case 'finished':
        return t('step2.stateFinished');
      case 'error':
        return t('step2.stateError');
      default:
        return '';
    }
  };

  const isFlashing = flashState !== 'idle' && flashState !== 'finished' && flashState !== 'error';

  return (
    <section className="flex flex-col items-center text-center" aria-labelledby="step2-title">
      {/* Icon */}
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center mb-6 transition-colors duration-500"
        style={{
          background: flashComplete ? 'var(--hf-forest-100)' : 'var(--hf-honey-100)',
        }}
        aria-hidden="true"
      >
        {flashComplete ? (
          <svg
            className="w-12 h-12 animate-scale-in"
            style={{ color: 'var(--hf-success)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
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
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        )}
      </div>

      <h2
        id="step2-title"
        className="font-bold text-hf-fg mb-3"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {flashComplete ? t('step2.titleDone') : t('step2.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 max-w-md text-hf-base">
        {flashComplete ? t('step2.textDone') : t('step2.text')}
      </p>

      {!flashComplete && (
        <div
          className="rounded-hf-lg px-4 py-2 mb-4 inline-flex items-center gap-2 border"
          style={{
            background: 'color-mix(in oklch, var(--hf-info) 8%, transparent)',
            borderColor: 'color-mix(in oklch, var(--hf-info) 30%, transparent)',
          }}
        >
          <span className="text-hf-sm text-hf-fg-soft">{t('step2.firmware')}</span>
          {firmwareLoading ? (
            <span className="text-hf-sm text-hf-fg-mute">{t('common.loading')}</span>
          ) : (
            <span className="text-hf-sm font-semibold" style={{ color: 'var(--hf-info)' }}>
              {firmwareVersion}
            </span>
          )}
        </div>
      )}

      {!flashComplete && flashState === 'idle' && (
        <aside
          className="rounded-hf-xl p-4 mb-4 max-w-md text-left border"
          style={{
            background: 'color-mix(in oklch, var(--hf-warn) 10%, transparent)',
            borderColor: 'color-mix(in oklch, var(--hf-warn) 35%, transparent)',
          }}
        >
          <div className="flex gap-3 items-start">
            <svg
              className="w-5 h-5 shrink-0 mt-0.5"
              style={{ color: 'var(--hf-honey-700)' }}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20 10 10 0 010-20z"
              />
            </svg>
            <div>
              <p className="text-hf-sm font-medium text-hf-fg">{t('step2.usbHintLabel')}</p>
              <p className="text-hf-xs text-hf-fg-soft mt-1">{t('step2.usbHint')}</p>
              <p className="text-hf-xs text-hf-fg-mute mt-2">{t('step2.usbHintDetail')}</p>
            </div>
          </div>
        </aside>
      )}

      {flashComplete && (
        <aside
          className="rounded-hf-xl p-4 mb-6 max-w-md text-left border-2"
          style={{
            background: 'color-mix(in oklch, var(--hf-success) 10%, transparent)',
            borderColor: 'color-mix(in oklch, var(--hf-success) 40%, transparent)',
          }}
        >
          <div className="flex gap-3 items-start">
            <span className="text-2xl shrink-0" aria-hidden="true">
              🔌
            </span>
            <div>
              <p className="text-hf-sm font-bold" style={{ color: 'var(--hf-forest-700)' }}>
                {t('step2.unplugTitle')}
              </p>
              <ol
                className="text-hf-xs mt-2 space-y-1 list-decimal list-inside"
                style={{ color: 'var(--hf-forest-700)' }}
              >
                <li>{t('step2.unplugStep1')}</li>
                <li>{t('step2.unplugStep2')}</li>
                <li>{t('step2.unplugStep3')}</li>
              </ol>
            </div>
          </div>
        </aside>
      )}

      {flashState !== 'idle' && !flashComplete && (
        <div className="w-full max-w-md mb-6" role="status" aria-live="polite">
          <div className="hf-card p-4">
            <div className="flex items-center gap-3 mb-3">
              {isFlashing && (
                <div
                  className="w-5 h-5 border-2 border-hf-honey-500 border-t-transparent rounded-full animate-spin shrink-0"
                  aria-hidden="true"
                />
              )}
              {flashState === 'error' && (
                <svg
                  className="w-5 h-5 shrink-0"
                  style={{ color: 'var(--hf-danger)' }}
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
              <span
                className={`text-hf-sm font-medium ${flashState === 'error' ? '' : 'text-hf-fg'}`}
                style={flashState === 'error' ? { color: 'var(--hf-danger)' } : undefined}
              >
                {flashStateLabel()}
              </span>
            </div>

            {isFlashing && (
              <div
                className="w-full rounded-full h-2 overflow-hidden"
                style={{ background: 'var(--hf-line-soft)' }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={flashPercent}
              >
                <div
                  className="h-full bg-hf-honey-500 rounded-full transition-all duration-300"
                  style={{
                    width:
                      flashState === 'connecting'
                        ? '10%'
                        : flashState === 'preparing'
                          ? '20%'
                          : flashState === 'erasing'
                            ? '30%'
                            : flashState === 'writing'
                              ? `${30 + flashPercent * 0.7}%`
                              : '0%',
                  }}
                />
              </div>
            )}

            {flashState === 'error' && flashError && (
              <p className="text-hf-xs mt-2" style={{ color: 'var(--hf-danger)' }}>
                {flashError}
              </p>
            )}
            {flashState === 'error' && (
              <p className="text-hf-xs text-hf-fg-mute mt-1">{t('step2.errorHint')}</p>
            )}
          </div>
        </div>
      )}

      {!flashComplete && (flashState === 'idle' || flashState === 'error') && (
        <button onClick={startFlash} className="hf-btn hf-btn-primary mb-6 px-8 py-3">
          {flashState === 'error' ? t('common.tryAgain') : t('step2.installBtn')}
        </button>
      )}

      {flashStarted && !flashComplete && (flashState === 'idle' || flashState === 'error') && (
        <button
          onClick={markFlashComplete}
          className="mb-4 text-hf-sm text-hf-honey-700 hover:text-hf-honey-800 underline transition-colors"
        >
          {t('step2.markComplete')}
        </button>
      )}

      <div className="flex gap-3 w-full md:w-auto">
        <button onClick={onBack} className="hf-btn hf-btn-secondary flex-1 md:flex-none px-6 py-3">
          {t('common.back')}
        </button>
        <button
          onClick={onNext}
          disabled={!flashComplete}
          className={`hf-btn flex-1 md:flex-none px-8 py-3 ${
            flashComplete ? 'hf-btn-primary' : 'cursor-not-allowed'
          }`}
          style={
            flashComplete
              ? undefined
              : {
                  background: 'color-mix(in oklch, var(--hf-fg) 5%, transparent)',
                  color: 'var(--hf-fg-mute)',
                }
          }
        >
          {t('common.next')}
        </button>
      </div>

      {!flashComplete && (
        <button
          onClick={() => {
            markFlashComplete();
            onNext();
          }}
          className="mt-4 text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('step2.skipAlreadyFlashed')}
        </button>
      )}
    </section>
  );
}
