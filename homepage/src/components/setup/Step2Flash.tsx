import { useState, useCallback } from 'react';
import { useTranslation } from '../../i18n/LanguageContext';
import { flashEsp, FlashProgress, Manifest } from './flashEsp';
// Vite emits this with a content hash; only loaded when this step renders
// (the wizard route is itself lazy-loaded, so this asset never lands in the
// homepage's first-paint budget).
import firmwareUrl from '../../assets/firmware.bin?url';

const FIRMWARE_MANIFEST: Manifest = {
  name: 'HighFive ESP32',
  version: '0.2.0',
  builds: [
    {
      chipFamily: 'ESP32',
      parts: [{ path: firmwareUrl, offset: 0 }],
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
  const startFlash = useCallback(async () => {
    setFlashState('connecting');
    setFlashError(null);

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

  // Skill rules applied:
  // - "The fix is usually to remove three." Dropped 96px icon circle, the
  //   firmware-version tinted pill, and the emoji-decorated success card.
  // - "Default to left-aligned; center only with intent."
  // - During flashing the progress bar is the single focus — the surrounding
  //   chrome (idle hint, firmware pill) is hidden so nothing competes.
  // - Footer: Back as text-link (tertiary), Next solid (primary). "No two
  //   equal-weight CTAs side-by-side."
  // - Replaced `🔌` emoji with weight + position.
  return (
    <section className="flex flex-col" aria-labelledby="step2-title">
      <h2
        id="step2-title"
        className="font-bold text-hf-fg mb-2"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {flashComplete ? t('step2.titleDone') : t('step2.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 text-hf-base">
        {flashComplete ? t('step2.textDone') : t('step2.text')}
      </p>

      {/* Idle: install CTA + firmware version inline + USB hint as plain prose */}
      {!flashComplete && flashState === 'idle' && (
        <>
          <p className="text-hf-xs text-hf-fg-mute mb-4">
            {t('step2.firmware')}{' '}
            {firmwareLoading ? (
              <span>{t('common.loading')}</span>
            ) : (
              <span className="font-mono text-hf-fg-soft">{firmwareVersion}</span>
            )}
          </p>
          <div className="mb-6 text-hf-xs text-hf-fg-mute">
            <p className="font-semibold text-hf-fg-soft">{t('step2.usbHintLabel')}</p>
            <p className="mt-1">{t('step2.usbHint')}</p>
            <p className="mt-1">{t('step2.usbHintDetail')}</p>
          </div>
        </>
      )}

      {/* Flashing or error: progress card is the single focus */}
      {flashState !== 'idle' && !flashComplete && (
        <div className="w-full mb-8" role="status" aria-live="polite">
          <div className="flex items-center gap-3 mb-3">
            {isFlashing && (
              <div
                className="w-4 h-4 border-2 border-hf-honey-500 border-t-transparent rounded-full animate-spin shrink-0"
                aria-hidden="true"
              />
            )}
            {flashState === 'error' && (
              <svg
                className="w-4 h-4 shrink-0"
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
              className="text-hf-sm font-medium text-hf-fg"
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
      )}

      {/* Done state: numbered list, no tile chrome */}
      {flashComplete && (
        <div className="mb-8">
          <p className="text-hf-sm font-semibold text-hf-fg mb-2">{t('step2.unplugTitle')}</p>
          <ol className="text-hf-sm text-hf-fg-soft space-y-1 list-decimal list-inside">
            <li>{t('step2.unplugStep1')}</li>
            <li>{t('step2.unplugStep2')}</li>
            <li>{t('step2.unplugStep3')}</li>
          </ol>
        </div>
      )}

      {/* Install CTA appears alone before flashing has produced any progress */}
      {!flashComplete && (flashState === 'idle' || flashState === 'error') && (
        <div className="mb-6">
          <button onClick={startFlash} className="hf-btn hf-btn-primary w-full md:w-auto px-8 py-3">
            {flashState === 'error' ? t('common.tryAgain') : t('step2.installBtn')}
          </button>
        </div>
      )}

      {/* Footer: text-link Back (tertiary) + solid Next (primary). Skip-link
          and mark-complete demoted to tertiary text-links so the primary
          action stays unambiguous. */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('common.back')}
        </button>

        <div className="flex items-center gap-4">
          {!flashComplete && (
            <button
              onClick={() => {
                markFlashComplete();
                onNext();
              }}
              className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
            >
              {t('step2.skipAlreadyFlashed')}
            </button>
          )}
          <button
            onClick={onNext}
            disabled={!flashComplete}
            className={`hf-btn px-8 py-3 ${flashComplete ? 'hf-btn-primary' : 'cursor-not-allowed'}`}
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
      </div>
    </section>
  );
}
