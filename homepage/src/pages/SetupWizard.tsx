import { Link } from 'react-router-dom';
import StepIndicator from '../components/setup/StepIndicator';
import Step1Connect from '../components/setup/Step1Connect';
import Step2Flash from '../components/setup/Step2Flash';
import Step3WiFi from '../components/setup/Step3WiFi';
import Step4Configure from '../components/setup/Step4Configure';
import Step5Verify from '../components/setup/Step5Verify';
import LanguageToggle from '../components/LanguageToggle';
import { useSetupWizard } from '../components/setup/useSetupWizard';
import { useTranslation } from '../i18n/LanguageContext';

const STEP_ICONS = [
  <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m-3-3l3 3 3-3" />
  </svg>,
  <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>,
  <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01" />
  </svg>,
  <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
  </svg>,
  <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>,
];

export default function SetupWizard() {
  const { t } = useTranslation();
  const {
    state,
    goNext,
    goBack,
    markFlashComplete,
    setModuleName,
    setWifiSsid,
    setWifiPassword,
    sendConfig,
    startVerification,
  } = useSetupWizard();

  const stepLabels = t('setup.stepLabels') as unknown as string[];
  const steps = (Array.isArray(stepLabels) ? stepLabels : ['Connect', 'Flash', 'WiFi', 'Configure', 'Verify']).map(
    (label, i) => ({ label, icon: STEP_ICONS[i] })
  );

  const animationClass =
    state.direction === 'forward' ? 'animate-slide-in-right' : 'animate-slide-in-left';

  return (
    <div className="min-h-[100dvh] flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm px-3 md:px-6 py-2 md:py-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-2 md:gap-4">
          <Link
            to="/"
            className="text-lg md:text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1"
          >
            <span className="text-xl md:text-2xl">🙌</span>
            <span>HighFive</span>
          </Link>
          <span className="text-gray-300 hidden md:inline">|</span>
          <h1 className="hidden md:block text-xl font-semibold text-gray-800">
            {t('setup.pageTitle')}
          </h1>
        </div>
        <LanguageToggle />
      </header>

      {/* Step indicator */}
      <StepIndicator currentStep={state.currentStep} steps={steps} />

      {/* Step content */}
      <main className="flex-1 flex items-start md:items-center justify-center px-4 py-6 md:py-8 overflow-y-auto">
        <div key={state.currentStep} className={`w-full max-w-lg ${animationClass}`}>
          {state.currentStep === 1 && (
            <Step1Connect onNext={goNext} />
          )}
          {state.currentStep === 2 && (
            <Step2Flash
              firmwareUrl={state.firmwareUrl}
              firmwareVersion={state.firmwareVersion}
              firmwareLoading={state.firmwareLoading}
              flashComplete={state.flashComplete}
              markFlashComplete={markFlashComplete}
              onNext={goNext}
              onBack={goBack}
            />
          )}
          {state.currentStep === 3 && (
            <Step3WiFi onNext={goNext} onBack={goBack} />
          )}
          {state.currentStep === 4 && (
            <Step4Configure
              moduleName={state.moduleName}
              wifiSsid={state.wifiSsid}
              wifiPassword={state.wifiPassword}
              setModuleName={setModuleName}
              setWifiSsid={setWifiSsid}
              setWifiPassword={setWifiPassword}
              configSending={state.configSending}
              configSent={state.configSent}
              configError={state.configError}
              sendConfig={sendConfig}
              onNext={goNext}
              onBack={goBack}
            />
          )}
          {state.currentStep === 5 && (
            <Step5Verify
              pollingActive={state.pollingActive}
              detectedModule={state.detectedModule}
              verificationTimedOut={state.verificationTimedOut}
              startVerification={startVerification}
              onBack={goBack}
            />
          )}
        </div>
      </main>
    </div>
  );
}
