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
  if (detectedModule) {
    return (
      <section className="flex flex-col items-center text-center" aria-labelledby="step5-success">
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center mb-6 animate-scale-in"
          style={{ background: 'var(--hf-forest-100)' }}
          aria-hidden="true"
        >
          <svg
            className="w-14 h-14"
            style={{ color: 'var(--hf-success)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h2
          id="step5-success"
          className="font-bold text-hf-fg mb-2"
          style={{ fontSize: 'var(--fs-xl)' }}
        >
          {t('step5.successTitle')}
        </h2>
        <p className="text-hf-fg-soft mb-8 max-w-md">{t('step5.successText')}</p>

        <div
          className="hf-card p-5 mb-8 w-full max-w-sm border-2"
          style={{ borderColor: 'color-mix(in oklch, var(--hf-success) 35%, transparent)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="font-bold text-hf-fg text-hf-md">{detectedModule.name}</span>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-hf-xs font-medium"
              style={{ background: 'var(--hf-forest-100)', color: 'var(--hf-forest-700)' }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full bg-[var(--hf-success)] animate-pulse"
                aria-hidden="true"
              />
              {t('common.online')}
            </span>
          </div>
          <div className="flex items-center gap-2 text-hf-sm text-hf-fg-soft">
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
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span>{t('step5.connected')}</span>
          </div>
        </div>

        <Link
          to="/dashboard"
          viewTransition
          className="hf-btn hf-btn-primary w-full md:w-auto px-8 py-3"
        >
          {t('step5.viewDashboard')}
        </Link>
      </section>
    );
  }

  // ---- BACKEND UNREACHABLE ----
  if (backendReachable === false) {
    return (
      <section
        className="flex flex-col items-center text-center"
        aria-labelledby="step5-down"
        role="alert"
      >
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center mb-6"
          style={{ background: 'color-mix(in oklch, var(--hf-danger) 12%, transparent)' }}
          aria-hidden="true"
        >
          <svg
            className="w-12 h-12"
            style={{ color: 'var(--hf-danger)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v2m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
            />
          </svg>
        </div>
        <h2
          id="step5-down"
          className="font-bold text-hf-fg mb-2"
          style={{ fontSize: 'var(--fs-lg)' }}
        >
          {t('step5.backendUnreachable')}
        </h2>
        <p className="text-hf-fg-soft mb-4 max-w-md">{t('step5.backendUnreachableText')}</p>
        <div className="rounded-hf px-4 py-2 mb-6" style={{ background: 'var(--hf-line-soft)' }}>
          <code className="text-hf-sm text-hf-fg-soft">{BACKEND_URL}</code>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <button
            onClick={onBack}
            className="hf-btn hf-btn-secondary flex-1 md:flex-none px-6 py-3"
          >
            {t('common.back')}
          </button>
          <button
            onClick={checkBackendAndStart}
            disabled={checkingBackend}
            className="hf-btn hf-btn-primary flex-1 md:flex-none px-8 py-3 disabled:opacity-50"
          >
            {checkingBackend ? t('common.loading') : t('step5.retryHealth')}
          </button>
        </div>
      </section>
    );
  }

  // ---- TIMEOUT ----
  if (verificationTimedOut) {
    return (
      <section className="flex flex-col items-center text-center" aria-labelledby="step5-timeout">
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center mb-6"
          style={{ background: 'var(--hf-honey-100)' }}
          aria-hidden="true"
        >
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
              d="M12 8v4m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
            />
          </svg>
        </div>
        <h2
          id="step5-timeout"
          className="font-bold text-hf-fg mb-2"
          style={{ fontSize: 'var(--fs-lg)' }}
        >
          {t('step5.timeoutTitle')}
        </h2>
        <p className="text-hf-fg-soft mb-6 max-w-md">{t('step5.timeoutText')}</p>

        <div className="hf-card p-5 mb-6 w-full max-w-md text-left space-y-3">
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

        <div className="flex gap-3 w-full md:w-auto">
          <button
            onClick={onBack}
            className="hf-btn hf-btn-secondary flex-1 md:flex-none px-6 py-3"
          >
            {t('common.back')}
          </button>
          <button
            onClick={checkBackendAndStart}
            className="hf-btn hf-btn-primary flex-1 md:flex-none px-8 py-3"
          >
            {t('common.tryAgain')}
          </button>
        </div>
      </section>
    );
  }

  // ---- WAITING ----
  return (
    <section
      className="flex flex-col items-center text-center"
      aria-labelledby="step5-waiting"
      role="status"
      aria-live="polite"
    >
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center mb-6"
        style={{ background: 'var(--hf-honey-100)' }}
        aria-hidden="true"
      >
        <div className="w-12 h-12 rounded-full border-4 border-hf-honey-200 border-t-hf-honey-500 animate-spin" />
      </div>

      <h2
        id="step5-waiting"
        className="font-bold text-hf-fg mb-3"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step5.waitingTitle')}
      </h2>
      <p className="text-hf-fg-soft mb-4 max-w-md">{t('step5.waitingText')}</p>

      <div className="flex items-center gap-2 text-hf-sm text-hf-fg-mute mb-4">
        <div className="w-2 h-2 rounded-full bg-hf-honey-400 animate-pulse" aria-hidden="true" />
        {pollingActive ? t('step5.checking') : t('step5.starting')}
      </div>

      <aside
        className="rounded-hf p-3 mb-6 w-full max-w-sm border"
        style={{
          background: 'color-mix(in oklch, var(--hf-info) 8%, transparent)',
          borderColor: 'color-mix(in oklch, var(--hf-info) 30%, transparent)',
        }}
      >
        <p className="text-hf-xs" style={{ color: 'var(--hf-info)' }}>
          {t('step5.wifiReminder')}
        </p>
      </aside>

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
