import { useId, useState } from 'react';
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
  const id = useId();

  const canSave =
    moduleName.trim() && wifiSsid.trim() && wifiPassword.trim() && !configSending && !configSent;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSave) sendConfig();
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

      {!configSent && (
        <form className="hf-card p-5 w-full max-w-md space-y-4" onSubmit={onSubmit}>
          <div>
            <label htmlFor={`${id}-name`} className="text-hf-sm font-medium text-hf-fg-soft">
              {t('step4.moduleName')}
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              placeholder={t('step4.moduleNamePlaceholder')}
              disabled={configSending}
              autoComplete="off"
              required
              className="mt-1 w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus:ring-2 focus:ring-hf-honey-300 focus:border-hf-honey-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor={`${id}-ssid`} className="text-hf-sm font-medium text-hf-fg-soft">
              {t('step4.wifiNetwork')}
            </label>
            <input
              id={`${id}-ssid`}
              type="text"
              value={wifiSsid}
              onChange={(e) => setWifiSsid(e.target.value)}
              placeholder={t('step4.wifiPlaceholder')}
              disabled={configSending}
              autoComplete="off"
              required
              className="mt-1 w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus:ring-2 focus:ring-hf-honey-300 focus:border-hf-honey-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor={`${id}-pwd`} className="text-hf-sm font-medium text-hf-fg-soft">
              {t('step4.wifiPassword')}
            </label>
            <div className="mt-1 relative">
              <input
                id={`${id}-pwd`}
                type={showPassword ? 'text' : 'password'}
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
                placeholder={t('step4.wifiPasswordPlaceholder')}
                disabled={configSending}
                autoComplete="new-password"
                required
                className="w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 pr-10 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus:ring-2 focus:ring-hf-honey-300 focus:border-hf-honey-400 disabled:opacity-50"
              />
              <button
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-hf-fg-mute hover:text-hf-fg-soft rounded-full"
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  {showPassword ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                    />
                  ) : (
                    <>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                      />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* Save button — inside form so Enter submits */}
          {!configSending && (
            <button
              type="submit"
              disabled={!canSave}
              className={`hf-btn w-full px-8 py-3 ${canSave ? 'hf-btn-primary' : 'cursor-not-allowed'}`}
              style={
                canSave
                  ? undefined
                  : {
                      background: 'color-mix(in oklch, var(--hf-fg) 5%, transparent)',
                      color: 'var(--hf-fg-mute)',
                    }
              }
            >
              {configError ? t('common.tryAgain') : t('step4.saveBtn')}
            </button>
          )}
        </form>
      )}

      {configSending && (
        <div className="flex items-center gap-3 mt-4 mb-2" role="status" aria-live="polite">
          <div
            className="w-5 h-5 border-2 border-hf-honey-500 border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
          <span className="text-hf-sm font-medium text-hf-fg-soft">{t('step4.sending')}</span>
        </div>
      )}

      {configError && (
        <div
          className="rounded-hf p-4 mt-4 w-full max-w-md border"
          role="alert"
          style={{
            background: 'color-mix(in oklch, var(--hf-danger) 8%, transparent)',
            borderColor: 'color-mix(in oklch, var(--hf-danger) 30%, transparent)',
          }}
        >
          <p className="text-hf-sm font-medium" style={{ color: 'var(--hf-danger)' }}>
            {t('step4.error')}
          </p>
          <p className="text-hf-xs mt-1" style={{ color: 'var(--hf-danger)' }}>
            {configError}
          </p>
          <p className="text-hf-xs text-hf-fg-mute mt-2">{t('step4.errorHint')}</p>
        </div>
      )}

      <div className="flex gap-3 w-full md:w-auto mt-4">
        <button
          onClick={onBack}
          disabled={configSending}
          className="hf-btn hf-btn-secondary flex-1 md:flex-none px-6 py-3 disabled:opacity-50"
        >
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
