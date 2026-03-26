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
    <div className="flex flex-col items-center text-center">
      {/* USB Icon */}
      <div className="w-24 h-24 rounded-full bg-amber-100 flex items-center justify-center mb-6">
        <svg className="w-12 h-12 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M12 3v12m0 0l-3-3m3 3l3-3M5 20h14a1 1 0 001-1v-3a1 1 0 00-1-1h-3m-8 0H5a1 1 0 00-1 1v3a1 1 0 001 1" />
        </svg>
      </div>

      <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3">
        {t('step1.title')}
      </h2>
      <p className="text-gray-600 mb-8 max-w-md">
        {t('step1.text')}
      </p>

      {/* Browser check */}
      <div className={`rounded-lg p-4 mb-6 w-full max-w-sm ${
        browserSupported
          ? 'bg-green-50 border border-green-200'
          : 'bg-amber-50 border border-amber-200'
      }`}>
        <div className="flex items-center gap-3">
          {browserSupported ? (
            <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3l9.09 16.91H2.91L12 3z" />
            </svg>
          )}
          <span className={`text-sm font-medium ${browserSupported ? 'text-green-800' : 'text-amber-800'}`}>
            {browserSupported ? t('step1.browserOk') : t('step1.browserFail')}
          </span>
        </div>
      </div>

      {/* Cable tip */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-8 w-full max-w-sm">
        <p className="text-xs text-gray-600">
          <strong className="text-gray-800">{t('step1.tip')}</strong> {t('step1.cableTip')}
        </p>
      </div>

      <button
        onClick={onNext}
        className="w-full md:w-auto bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
      >
        {t('common.next')}
      </button>
    </div>
  );
}
