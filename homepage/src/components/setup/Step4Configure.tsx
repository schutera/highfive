import { useState } from 'react';
import { useTranslation } from '../../i18n/LanguageContext';

interface Step4ConfigureProps {
  moduleName: string;
  wifiSsid: string;
  wifiPassword: string;
  setModuleName: (v: string) => void;
  setWifiSsid: (v: string) => void;
  setWifiPassword: (v: string) => void;
  configSending: boolean;
  configSent: boolean;
  configError: string | null;
  sendConfig: () => void;
  onNext: () => void;
  onBack: () => void;
}

export default function Step4Configure({
  moduleName,
  wifiSsid,
  wifiPassword,
  setModuleName,
  setWifiSsid,
  setWifiPassword,
  configSending,
  configSent,
  configError,
  sendConfig,
  onNext,
  onBack,
}: Step4ConfigureProps) {
  const { t } = useTranslation();
  const [showPassword, setShowPassword] = useState(false);

  const canSave = moduleName.trim() && wifiSsid.trim() && wifiPassword.trim() && !configSending && !configSent;

  return (
    <div className="flex flex-col items-center">
      {/* Icon */}
      <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-5 transition-colors duration-500 ${
        configSent ? 'bg-green-100' : 'bg-amber-100'
      }`}>
        {configSent ? (
          <svg className="w-10 h-10 text-green-600 animate-scale-in" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-10 h-10 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        )}
      </div>

      <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2 text-center">
        {configSent ? t('step4.reconnectTitle') : t('step4.title')}
      </h2>
      <p className="text-gray-600 mb-6 text-center max-w-md">
        {configSent ? t('step4.reconnectText') : t('step4.text')}
      </p>

      {/* WiFi reconnect instruction — shown after config is saved */}
      {configSent && (
        <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-5 mb-6 w-full max-w-md text-left">
          <div className="flex gap-3 items-start">
            <svg className="w-6 h-6 text-blue-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
            </svg>
            <div>
              <p className="text-sm font-bold text-blue-900">{t('step4.reconnectWifiLabel')}</p>
              <ol className="text-xs text-blue-800 mt-2 space-y-1 list-decimal list-inside">
                <li>{t('step4.reconnectStep1')}</li>
                <li>{t('step4.reconnectStep2')}</li>
                <li>{t('step4.reconnectStep3')}</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* Config form — hidden after success */}
      {!configSent && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 w-full max-w-md shadow-sm space-y-4">
          {/* Module Name */}
          <div>
            <label className="text-sm font-medium text-gray-700">{t('step4.moduleName')}</label>
            <input
              type="text"
              value={moduleName}
              onChange={e => setModuleName(e.target.value)}
              placeholder={t('step4.moduleNamePlaceholder')}
              disabled={configSending}
              className="mt-1 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-400 disabled:opacity-50"
            />
          </div>

          {/* WiFi SSID */}
          <div>
            <label className="text-sm font-medium text-gray-700">{t('step4.wifiNetwork')}</label>
            <input
              type="text"
              value={wifiSsid}
              onChange={e => setWifiSsid(e.target.value)}
              placeholder={t('step4.wifiPlaceholder')}
              disabled={configSending}
              className="mt-1 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-400 disabled:opacity-50"
            />
          </div>

          {/* WiFi Password */}
          <div>
            <label className="text-sm font-medium text-gray-700">{t('step4.wifiPassword')}</label>
            <div className="mt-1 relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={wifiPassword}
                onChange={e => setWifiPassword(e.target.value)}
                placeholder={t('step4.wifiPasswordPlaceholder')}
                disabled={configSending}
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-400 disabled:opacity-50"
              />
              <button
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                type="button"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {showPassword ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                  ) : (
                    <>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sending indicator */}
      {configSending && (
        <div className="flex items-center gap-3 mt-4 mb-2">
          <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium text-gray-700">{t('step4.sending')}</span>
        </div>
      )}

      {/* Error message */}
      {configError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mt-4 w-full max-w-md">
          <p className="text-sm font-medium text-red-800">{t('step4.error')}</p>
          <p className="text-xs text-red-600 mt-1">{configError}</p>
          <p className="text-xs text-gray-500 mt-2">{t('step4.errorHint')}</p>
        </div>
      )}

      {/* Save button — shown when form is visible and not yet sent */}
      {!configSent && !configSending && (
        <button
          onClick={sendConfig}
          disabled={!canSave}
          className={`mt-6 px-8 py-3 rounded-lg font-semibold transition-colors ${
            canSave
              ? 'bg-amber-500 hover:bg-amber-600 text-white'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {configError ? t('common.tryAgain') : t('step4.saveBtn')}
        </button>
      )}

      {/* Navigation */}
      <div className="flex gap-3 w-full md:w-auto mt-4">
        <button
          onClick={onBack}
          disabled={configSending}
          className="flex-1 md:flex-none px-6 py-3 rounded-lg font-semibold border-2 border-gray-200 text-gray-600 hover:border-gray-300 transition-colors disabled:opacity-50"
        >
          {t('common.back')}
        </button>
        {configSent && (
          <button
            onClick={onNext}
            className="flex-1 md:flex-none bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
          >
            {t('step4.reconnectBtn')}
          </button>
        )}
      </div>
    </div>
  );
}
