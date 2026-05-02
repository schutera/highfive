import { useEffect, useId, useState } from 'react';
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

// Brief beat after a successful save so the user reads the success state
// before the wizard auto-advances to the verify step.
const AUTO_ADVANCE_DELAY_MS = 1800;

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

  useEffect(() => {
    if (!configSent) return;
    const handle = setTimeout(onNext, AUTO_ADVANCE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [configSent, onNext]);

  const canSave = moduleName.trim() && wifiSsid.trim() && wifiPassword.trim();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSave) sendConfig();
  };

  // ---- SENDING ----
  // Skill: progress is the focus during a transition state. Single spinner,
  // weight-driven hierarchy, no decorative honey-tinted disc behind it.
  if (configSending) {
    return (
      <section
        className="flex flex-col items-center text-center"
        aria-labelledby="step4-sending"
        role="status"
        aria-live="polite"
      >
        <div
          className="w-10 h-10 rounded-full border-4 border-hf-honey-200 border-t-hf-honey-500 animate-spin mb-5"
          aria-hidden="true"
        />
        <h2
          id="step4-sending"
          className="font-bold text-hf-fg mb-2"
          style={{ fontSize: 'var(--fs-xl)' }}
        >
          {t('step4.sending')}
        </h2>
        <p className="text-hf-fg-soft max-w-md text-hf-base">{t('step4.sendingText')}</p>
      </section>
    );
  }

  // ---- SENT ----
  // Skill: "At most 2 prominent elements per section." Kept the success check
  // (status signal, paired with weight, not color alone) and the primary CTA.
  // The info-tinted reconnect card was a third prominent element — demoted to
  // a plain numbered list.
  if (configSent) {
    return (
      <section
        className="flex flex-col"
        aria-labelledby="step4-sent"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3 mb-3">
          <svg
            className="w-6 h-6 shrink-0 animate-scale-in"
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
          <h2 id="step4-sent" className="font-bold text-hf-fg" style={{ fontSize: 'var(--fs-xl)' }}>
            {t('step4.reconnectTitle')}
          </h2>
        </div>
        <p className="text-hf-fg-soft mb-6 text-hf-base">{t('step4.reconnectText')}</p>

        <p className="text-hf-sm font-semibold text-hf-fg mb-2">{t('step4.reconnectWifiLabel')}</p>
        <ol className="text-hf-sm text-hf-fg-soft space-y-1 list-decimal list-inside mb-8">
          <li>{t('step4.reconnectStep1')}</li>
          <li>{t('step4.reconnectStep2')}</li>
          <li>{t('step4.reconnectStep3')}</li>
        </ol>

        <div className="flex justify-end">
          <button onClick={onNext} className="hf-btn hf-btn-primary w-full md:w-auto px-8 py-3">
            {t('step4.reconnectBtn')}
          </button>
        </div>
      </section>
    );
  }

  // ---- IDLE / ERROR ----
  // Skill rules applied:
  // - "The fix is usually to remove three." Dropped 80px settings-cog icon.
  // - "Default to left-aligned; center only with intent."
  // - Form is the single focus. Error keeps icon+weight, lighter chrome.
  // - Footer: text-link Back (tertiary) — Save inside the form is the primary.
  return (
    <section className="flex flex-col" aria-labelledby="step4-title">
      <h2
        id="step4-title"
        className="font-bold text-hf-fg mb-2"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step4.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 text-hf-base">{t('step4.text')}</p>

      {configError && (
        <div
          id="step4-error"
          className="rounded-hf p-3 mb-4 w-full border"
          role="alert"
          style={{
            background: 'color-mix(in oklch, var(--hf-danger) 6%, transparent)',
            borderColor: 'color-mix(in oklch, var(--hf-danger) 25%, transparent)',
          }}
        >
          <p className="text-hf-sm font-semibold" style={{ color: 'var(--hf-danger)' }}>
            {t('step4.error')}
          </p>
          <p className="text-hf-xs mt-1" style={{ color: 'var(--hf-danger)' }}>
            {configError}
          </p>
          <p className="text-hf-xs text-hf-fg-mute mt-1">{t('step4.errorHint')}</p>
        </div>
      )}

      <form className="hf-card p-5 w-full space-y-4" onSubmit={onSubmit}>
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
            autoComplete="off"
            required
            aria-invalid={configError ? true : undefined}
            aria-describedby={configError ? 'step4-error' : undefined}
            className="mt-1 w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-hf-honey-500 focus:border-hf-honey-400"
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
            autoComplete="off"
            required
            aria-invalid={configError ? true : undefined}
            aria-describedby={configError ? 'step4-error' : undefined}
            className="mt-1 w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-hf-honey-500 focus:border-hf-honey-400"
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
              autoComplete="new-password"
              required
              minLength={8}
              aria-invalid={configError ? true : undefined}
              aria-describedby={configError ? `${id}-pwd-hint step4-error` : `${id}-pwd-hint`}
              className="w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 pr-10 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-hf-honey-500 focus:border-hf-honey-400"
            />
            <button
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-hf-fg-mute hover:text-hf-fg-soft rounded-full"
              type="button"
              aria-label={t('step4.passwordToggle')}
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
          <p id={`${id}-pwd-hint`} className="text-hf-xs text-hf-fg-mute mt-1">
            {t('step4.passwordMinHint')}
          </p>
        </div>

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
      </form>

      <div className="mt-4">
        <button
          onClick={onBack}
          className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('common.back')}
        </button>
      </div>
    </section>
  );
}
