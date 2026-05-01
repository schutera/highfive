import StepIndicator from '../components/setup/StepIndicator';
import Step1Connect from '../components/setup/Step1Connect';
import Step2Flash from '../components/setup/Step2Flash';
import Step3WiFi from '../components/setup/Step3WiFi';
import Step4Configure from '../components/setup/Step4Configure';
import Step5Verify from '../components/setup/Step5Verify';
import SiteHeader from '../components/SiteHeader';
import { useSetupWizard } from '../components/setup/useSetupWizard';
import { useTranslation } from '../i18n/LanguageContext';

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

  // Skill rule: "At most 2 prominent elements per section. Counting decorations."
  // The step badges no longer carry icons — numbers carry the load and the
  // step content itself is the focus.
  const stepLabels = t('setup.stepLabels') as unknown as string[];
  const steps = (
    Array.isArray(stepLabels) ? stepLabels : ['Connect', 'Flash', 'WiFi', 'Configure', 'Verify']
  ).map((label) => ({ label }));

  const animationClass =
    state.direction === 'forward' ? 'animate-slide-in-right' : 'animate-slide-in-left';

  return (
    <div className="min-h-[100dvh] flex flex-col bg-hf-bg text-hf-fg">
      <SiteHeader title={t('setup.pageTitle')} />

      <StepIndicator currentStep={state.currentStep} steps={steps} />

      <main
        id="main"
        className="flex-1 flex items-start md:items-center justify-center px-4 py-6 md:py-8 overflow-y-auto"
      >
        <div key={state.currentStep} className={`w-full max-w-lg ${animationClass}`}>
          {state.currentStep === 1 && <Step1Connect onNext={goNext} />}
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
          {state.currentStep === 3 && <Step3WiFi onNext={goNext} onBack={goBack} />}
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
