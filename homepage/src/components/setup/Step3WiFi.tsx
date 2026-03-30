import { useState } from 'react';
import CopyButton from './CopyButton';
import { useTranslation } from '../../i18n/LanguageContext';

interface Step3WiFiProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const AP_SSID = 'HiveHive-Access-Point';

export default function Step3WiFi({ onNext, onBack, onSkip }: Step3WiFiProps) {
  const { t } = useTranslation();
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);

  return (
    <div className="flex flex-col items-center text-center">
      {/* WiFi icon */}
      <div className="w-24 h-24 rounded-full bg-amber-100 flex items-center justify-center mb-6">
        <svg className="w-12 h-12 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
        </svg>
      </div>

      <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3">
        {t('step3.title')}
      </h2>
      <p className="text-gray-600 mb-6 max-w-md">
        {t('step3.text')}
      </p>

      {/* AP network card */}
      <div className="bg-white border-2 border-amber-200 rounded-xl p-6 mb-6 w-full max-w-sm shadow-sm">
        <label className="text-xs text-gray-500 uppercase tracking-wider font-medium">{t('step3.networkName')}</label>
        <div className="flex items-center justify-between mt-1 bg-gray-50 rounded-lg px-4 py-3">
          <code className="text-lg font-mono font-bold text-gray-900">{AP_SSID}</code>
          <CopyButton text={AP_SSID} label={t('step3.networkName')} />
        </div>
        <p className="text-xs text-gray-400 mt-2">{t('step3.openNetwork')}</p>
      </div>

      {/* Info callout */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 w-full max-w-sm">
        <p className="text-sm text-amber-800">
          {t('step3.disconnectNotice')}
        </p>
      </div>

      {/* Troubleshooting section */}
      <div className="w-full max-w-sm mb-6">
        <button
          onClick={() => setShowTroubleshoot(!showTroubleshoot)}
          className="text-sm text-gray-500 hover:text-gray-700 underline transition-colors"
        >
          {t('step3.cantSeeNetwork')}
        </button>

        {showTroubleshoot && (
          <div className="mt-3 bg-gray-50 border border-gray-200 rounded-xl p-4 text-left space-y-3">
            <TroubleshootItem
              number={1}
              title={t('step3.troubleshoot.resetTitle')}
              text={t('step3.troubleshoot.resetText')}
            />
            <TroubleshootItem
              number={2}
              title={t('step3.troubleshoot.waitTitle')}
              text={t('step3.troubleshoot.waitText')}
            />
            <TroubleshootItem
              number={3}
              title={t('step3.troubleshoot.reflashTitle')}
              text={t('step3.troubleshoot.reflashText')}
            />
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex flex-col items-center gap-2 w-full md:w-auto">
        <div className="flex gap-3 w-full md:w-auto">
          <button
            onClick={onBack}
            className="flex-1 md:flex-none px-6 py-3 rounded-lg font-semibold border-2 border-gray-200 text-gray-600 hover:border-gray-300 transition-colors"
          >
            {t('common.back')}
          </button>
          <button
            onClick={onNext}
            className="flex-1 md:flex-none bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
          >
            {t('step3.connected')}
          </button>
        </div>
        <button
          onClick={onSkip}
          className="text-sm text-gray-400 hover:text-gray-600 underline transition-colors"
        >
          {t('step3.skip')}
        </button>
      </div>
    </div>
  );
}

function TroubleshootItem({ number, title, text }: { number: number; title: string; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-xs font-bold flex items-center justify-center mt-0.5">
        {number}
      </span>
      <div>
        <p className="text-sm font-medium text-gray-800">{title}</p>
        <p className="text-xs text-gray-500 mt-0.5">{text}</p>
      </div>
    </div>
  );
}
