import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, Module } from '../../services/api';
import { useTranslation } from '../../i18n/LanguageContext';

const BACKEND_URL = import.meta.env.VITE_API_URL || '/api';

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
  const navigate = useNavigate();
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);
  const [checkingBackend, setCheckingBackend] = useState(false);

  // Auto-redirect to dashboard with module selected after detection
  useEffect(() => {
    if (!detectedModule) return;
    const timer = setTimeout(() => {
      navigate('/dashboard', { state: { selectModuleId: detectedModule.id } });
    }, 3000);
    return () => clearTimeout(timer);
  }, [detectedModule, navigate]);

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

  // Check backend health on mount
  useEffect(() => {
    checkBackendAndStart();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- SUCCESS ----
  if (detectedModule) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="w-24 h-24 rounded-full bg-green-100 flex items-center justify-center mb-6 animate-scale-in">
          <svg className="w-14 h-14 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2">
          {t('step5.successTitle')}
        </h2>
        <p className="text-gray-600 mb-8 max-w-md">
          {t('step5.successText')}
        </p>

        {/* Module info card */}
        <div className="bg-white border-2 border-green-200 rounded-xl p-5 mb-8 w-full max-w-sm shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="font-bold text-gray-900 text-lg">{detectedModule.name}</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {t('common.online')}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{t('step5.connected')}</span>
          </div>
        </div>

        <Link
          to="/dashboard"
          state={{ selectModuleId: detectedModule.id }}
          className="w-full md:w-auto bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors text-center block"
        >
          {t('step5.viewDashboard')}
        </Link>
      </div>
    );
  }

  // ---- BACKEND UNREACHABLE ----
  if (backendReachable === false) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="w-24 h-24 rounded-full bg-red-100 flex items-center justify-center mb-6">
          <svg className="w-12 h-12 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v2m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" />
          </svg>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {t('step5.backendUnreachable')}
        </h2>
        <p className="text-gray-600 mb-4 max-w-md">
          {t('step5.backendUnreachableText')}
        </p>

        {/* Server URL display */}
        <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-2 mb-6">
          <code className="text-sm text-gray-700">{BACKEND_URL}</code>
        </div>

        <div className="flex gap-3 w-full md:w-auto">
          <button
            onClick={onBack}
            className="flex-1 md:flex-none px-6 py-3 rounded-lg font-semibold border-2 border-gray-200 text-gray-600 hover:border-gray-300 transition-colors"
          >
            {t('common.back')}
          </button>
          <button
            onClick={checkBackendAndStart}
            disabled={checkingBackend}
            className="flex-1 md:flex-none bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50"
          >
            {checkingBackend ? t('common.loading') : t('step5.retryHealth')}
          </button>
        </div>
      </div>
    );
  }

  // ---- TIMEOUT ----
  if (verificationTimedOut) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="w-24 h-24 rounded-full bg-amber-100 flex items-center justify-center mb-6">
          <svg className="w-12 h-12 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 8v4m0 4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" />
          </svg>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {t('step5.timeoutTitle')}
        </h2>
        <p className="text-gray-600 mb-6 max-w-md">
          {t('step5.timeoutText')}
        </p>

        {/* Troubleshooting tips */}
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 mb-6 w-full max-w-md text-left space-y-3">
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
            className="flex-1 md:flex-none px-6 py-3 rounded-lg font-semibold border-2 border-gray-200 text-gray-600 hover:border-gray-300 transition-colors"
          >
            {t('common.back')}
          </button>
          <button
            onClick={checkBackendAndStart}
            className="flex-1 md:flex-none bg-amber-500 hover:bg-amber-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
          >
            {t('common.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  // ---- WAITING ----
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-24 h-24 rounded-full bg-amber-100 flex items-center justify-center mb-6">
        <div className="w-12 h-12 rounded-full border-4 border-amber-200 border-t-amber-500 animate-spin" />
      </div>

      <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3">
        {t('step5.waitingTitle')}
      </h2>
      <p className="text-gray-600 mb-4 max-w-md">
        {t('step5.waitingText')}
      </p>

      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        {pollingActive ? t('step5.checking') : t('step5.starting')}
      </div>

      {/* WiFi reminder */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-6 w-full max-w-sm">
        <p className="text-xs text-blue-800">{t('step5.wifiReminder')}</p>
      </div>

      <button
        onClick={onBack}
        className="text-sm text-gray-400 hover:text-gray-600 underline transition-colors"
      >
        {t('step5.goBackConfig')}
      </button>
    </div>
  );
}

function TroubleshootItem({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
      <p className="text-xs text-gray-600 mt-0.5">{description}</p>
    </div>
  );
}
