import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import type { Module } from '@highfive/contracts';
import { useTranslation } from '../../i18n/LanguageContext';

const BACKEND_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002/api';

interface Step5VerifyProps {
  pollingActive: boolean;
  detectedModule: Module | null;
  verificationTimedOut: boolean;
  startVerification: () => void;
  onBack: () => void;
}

export default function Step5Verify({
  pollingActive,
  detectedModule,
  verificationTimedOut,
  startVerification,
  onBack,
}: Step5VerifyProps) {
  const { t } = useTranslation();
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);
  const [checkingBackend, setCheckingBackend] = useState(false);

  const checkBackendAndStart = async () => {
    setCheckingBackend(true);
    try {
      await api.healthCheck();
      setBackendReachable(true);
      startVerification();
    } catch {
      setBackendReachable(false);
    } finally {
      setCheckingBackend(false);
    }
  };

  useEffect(() => {
    checkBackendAndStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- SUCCESS ----
  // Skill rules applied:
  // - "At most 2 prominent elements per section. Counting decorations." Was
  //   four (96px green disc, module card with green border halo, pulsing green
  //   pill, primary CTA). Now two: success line + module card + primary CTA.
  // - "Don't communicate via color alone — pair with icon, weight, or position."
  //   Status uses check icon + weight, not a colored pill.
  // - "Add a glow/shadow/border to make it stand out → fix is often to make
  //   competing elements duller." Removed 2px green border on module card.
  if (detectedModule) {
    return (
      <section className="flex flex-col" aria-labelledby="step5-success">
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
          <h2
            id="step5-success"
            className="font-bold text-hf-fg"
            style={{ fontSize: 'var(--fs-xl)' }}
          >
            {t('step5.successTitle')}
          </h2>
        </div>
        <p className="text-hf-fg-soft mb-6">{t('step5.successText')}</p>

        <div className="hf-card p-4 mb-8 w-full">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-hf-fg text-hf-md">{detectedModule.name}</span>
            <span className="inline-flex items-center gap-1.5 text-hf-xs text-hf-fg-soft">
              <span
                className="w-1.5 h-1.5 rounded-full bg-[var(--hf-success)]"
                aria-hidden="true"
              />
              {t('common.online')}
            </span>
          </div>
          <p className="text-hf-xs text-hf-fg-mute mt-1">{t('step5.connected')}</p>
        </div>

        <div className="flex justify-end">
          <Link
            to="/dashboard"
            viewTransition
            className="hf-btn hf-btn-primary w-full md:w-auto px-8 py-3"
          >
            {t('step5.viewDashboard')}
          </Link>
        </div>
      </section>
    );
  }

  // ---- BACKEND UNREACHABLE ----
  // Skill: "The fix is usually to remove three." Dropped 96px danger disc.
  // Footer: text-link Back (tertiary) + solid retry (primary).
  if (backendReachable === false) {
    return (
      <section className="flex flex-col" aria-labelledby="step5-down" role="alert">
        <div className="flex items-center gap-3 mb-3">
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
              d="M12 9v2m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
            />
          </svg>
          <h2 id="step5-down" className="font-bold text-hf-fg" style={{ fontSize: 'var(--fs-lg)' }}>
            {t('step5.backendUnreachable')}
          </h2>
        </div>
        <p className="text-hf-fg-soft mb-3">{t('step5.backendUnreachableText')}</p>
        <code className="text-hf-xs text-hf-fg-mute font-mono mb-8">{BACKEND_URL}</code>

        <div className="flex items-center justify-between gap-4">
          <button
            onClick={onBack}
            className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
          >
            {t('common.back')}
          </button>
          <button
            onClick={checkBackendAndStart}
            disabled={checkingBackend}
            className="hf-btn hf-btn-primary px-8 py-3 disabled:opacity-50"
          >
            {checkingBackend ? t('common.loading') : t('step5.retryHealth')}
          </button>
        </div>
      </section>
    );
  }

  // ---- TIMEOUT ----
  // Skill: dropped 96px warn-tinted icon disc. Troubleshoot list as plain
  // items, no card-on-card. Footer: text-link Back + solid retry.
  if (verificationTimedOut) {
    return (
      <section className="flex flex-col" aria-labelledby="step5-timeout">
        <div className="flex items-center gap-3 mb-3">
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
              d="M12 8v4m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
            />
          </svg>
          <h2
            id="step5-timeout"
            className="font-bold text-hf-fg"
            style={{ fontSize: 'var(--fs-lg)' }}
          >
            {t('step5.timeoutTitle')}
          </h2>
        </div>
        <p className="text-hf-fg-soft mb-6">{t('step5.timeoutText')}</p>

        <div className="space-y-3 mb-8">
          <TroubleshootItem
            title={t('step5.troubleshoot.powerTitle')}
            description={t('step5.troubleshoot.powerText')}
          />
          <TroubleshootItem
            title={t('step5.troubleshoot.wifiTitle')}
            description={t('step5.troubleshoot.wifiText')}
          />
          <TroubleshootItem
            title={t('step5.troubleshoot.apTitle')}
            description={t('step5.troubleshoot.apText')}
          />
          <TroubleshootItem
            title={t('step5.troubleshoot.resetTitle')}
            description={t('step5.troubleshoot.resetText')}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <button
            onClick={onBack}
            className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
          >
            {t('common.back')}
          </button>
          <button onClick={checkBackendAndStart} className="hf-btn hf-btn-primary px-8 py-3">
            {t('common.tryAgain')}
          </button>
        </div>
      </section>
    );
  }

  // ---- WAITING ----
  // Skill: progress is the focus. The 96px honey-tinted disc behind the spinner
  // and the duplicate pulsing-dot status row both competed with it — dropped.
  // The info-tinted reminder card is now plain hint text.
  return (
    <section
      className="flex flex-col items-center text-center"
      aria-labelledby="step5-waiting"
      role="status"
      aria-live="polite"
    >
      <div
        className="w-10 h-10 rounded-full border-4 border-hf-honey-200 border-t-hf-honey-500 animate-spin mb-5"
        aria-hidden="true"
      />

      <h2
        id="step5-waiting"
        className="font-bold text-hf-fg mb-2"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step5.waitingTitle')}
      </h2>
      <p className="text-hf-fg-soft mb-2 max-w-md">{t('step5.waitingText')}</p>
      <p className="text-hf-xs text-hf-fg-mute mb-6">
        {pollingActive ? t('step5.checking') : t('step5.starting')}
      </p>

      <p className="text-hf-xs text-hf-fg-mute max-w-sm mb-6">{t('step5.wifiReminder')}</p>

      <button
        onClick={onBack}
        className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
      >
        {t('step5.goBackConfig')}
      </button>
    </section>
  );
}

function TroubleshootItem({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h4 className="text-hf-sm font-semibold text-hf-fg">{title}</h4>
      <p className="text-hf-xs text-hf-fg-soft mt-0.5">{description}</p>
    </div>
  );
}
