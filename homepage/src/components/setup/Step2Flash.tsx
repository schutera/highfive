import { useState, useCallback } from 'react';
import { useTranslation } from '../../i18n/LanguageContext';
import { flashEsp, FlashProgress } from './flashEsp';

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

    await flashEsp('/manifest.json', (progress: FlashProgress) => {
      setFlashState(progress.state);

      if (progress.percent !== undefined) {
        setFlashPercent(progress.percent);
      }

      if (progress.error) {
        setFlashError(progress.error);
      }

      if (progress.state === 'finished') {
        markFlashComplete();
      }
    });
  }, [markFlashComplete]);

  const flashStateLabel = (): string => {
    switch (flashState) {
      case 'connecting': return t('step2.stateConnecting');
      case 'preparing': return t('step2.statePreparing');
      case 'erasing': return t('step2.stateErasing');
      case 'writing': return t('step2.stateWriting') + (flashPercent > 0 ? ` (${flashPercent}%)` : '');
      case 'finished': return t('step2.stateFinished');
      case 'error': return t('step2.stateError');
      default: return '';
    }
  };

  const isFlashing = flashState !== 'idle' && flashState !== 'finished' && flashState !== 'error';

  return (
    <div className="flex flex-col items-center text-center">
      {/* Icon */}
      <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-6 transition-colors duration-500 ${
        flashComplete ? 'bg-green-100' : 'bg-amber-100'
      }`}>
        {flashComplete ? (
          <svg className="w-12 h-12 text-green-600 animate-scale-in" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-12 h-12 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        )}
      </div>

      <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3">
        {flashComplete ? t('step2.titleDone') : t('step2.title')}
      </h2>
      <p className="text-gray-600 mb-6 max-w-md">
        {flashComplete ? t('step2.textDone') : t('step2.text')}
      </p>

      {/* Firmware version badge */}
      {!flashComplete && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 mb-4 inline-flex items-center gap-2">
          <span className="text-sm text-gray-600">{t('step2.firmware')}</span>
          {firmwareLoading ? (
            <span className="text-sm text-gray-400">{t('common.loading')}</span>
          ) : (
            <span className="text-sm font-semibold text-blue-600">{firmwareVersion}</span>
          )}
        </div>
      )}

      {/* USB hint — shown before flashing starts */}
      {!flashComplete && flashState === 'idle' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 max-w-md text-left">
          <div className="flex gap-3 items-start">
            <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20 10 10 0 010-20z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-900">{t('step2.usbHintLabel')}</p>
              <p className="text-xs text-amber-800 mt-1">{t('step2.usbHint')}</p>
              <p className="text-xs text-amber-700 mt-2">{t('step2.usbHintDetail')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Unplug instruction — shown after flash succeeds */}
      {flashComplete && (
        <div className="bg-green-50 border-2 border-green-200 rounded-xl p-4 mb-6 max-w-md text-left">
          <div className="flex gap-3 items-start">
            <span className="text-2xl shrink-0">🔌</span>
            <div>
              <p className="text-sm font-bold text-green-900">{t('step2.unplugTitle')}</p>
              <ol className="text-xs text-green-800 mt-2 space-y-1 list-decimal list-inside">
                <li>{t('step2.unplugStep1')}</li>
                <li>{t('step2.unplugStep2')}</li>
                <li>{t('step2.unplugStep3')}</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* Inline flash progress */}
      {flashState !== 'idle' && !flashComplete && (
        <div className="w-full max-w-md mb-6">
          <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              {isFlashing && (
                <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
              )}
              {flashState === 'error' && (
                <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3l9.09 16.91H2.91L12 3z" />
                </svg>
              )}
              <span className={`text-sm font-medium ${flashState === 'error' ? 'text-red-700' : 'text-gray-800'}`}>
                {flashStateLabel()}
              </span>
            </div>

            {/* Progress bar */}
            {isFlashing && (
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all duration-300"
                  style={{
                    width: flashState === 'connecting' ? '10%'
                      : flashState === 'preparing' ? '20%'
                      : flashState === 'erasing' ? '30%'
                      : flashState === 'writing' ? `${30 + flashPercent * 0.7}%`
                      : '0%',
                  }}
                />
              </div>
            )}

            {flashState === 'error' && flashError && (
              <p className="text-xs text-red-600 mt-2">{flashError}</p>
            )}
            {flashState === 'error' && (
              <p className="text-xs text-gray-500 mt-1">{t('step2.errorHint')}</p>
            )}
          </div>
        </div>
      )}

      {/* Flash button — only shown when idle or on error (retry) */}
      {!flashComplete && (flashState === 'idle' || flashState === 'error') && (
        <button
          onClick={startFlash}
          className="mb-6 bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
        >
          {flashState === 'error' ? t('common.tryAgain') : t('step2.installBtn')}
        </button>
      )}

      {/* Fallback — if flash ran but detection may have failed */}
      {flashStarted && !flashComplete && (flashState === 'idle' || flashState === 'error') && (
        <button
          onClick={markFlashComplete}
          className="mb-4 text-sm text-amber-600 hover:text-amber-800 underline transition-colors"
        >
          {t('step2.markComplete')}
        </button>
      )}

      {/* Navigation */}
      <div className="flex gap-3 w-full md:w-auto">
        <button
          onClick={onBack}
          className="flex-1 md:flex-none px-6 py-3 rounded-lg font-semibold border-2 border-gray-200 text-gray-600 hover:border-gray-300 transition-colors"
        >
          {t('common.back')}
        </button>
        <button
          onClick={onNext}
          disabled={!flashComplete}
          className={`flex-1 md:flex-none px-8 py-3 rounded-lg font-semibold transition-colors ${
            flashComplete
              ? 'bg-amber-500 hover:bg-amber-600 text-white'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {t('common.next')}
        </button>
      </div>

      {/* Skip option */}
      {!flashComplete && (
        <button
          onClick={() => { markFlashComplete(); onNext(); }}
          className="mt-4 text-sm text-gray-400 hover:text-gray-600 underline transition-colors"
        >
          {t('step2.skipAlreadyFlashed')}
        </button>
      )}
    </div>
  );
}
