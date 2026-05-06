import { useState } from 'react';
import CopyButton from './CopyButton';
import { useTranslation } from '../../i18n/LanguageContext';

interface Step3WiFiProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

// Must match `HOST_SSID` in `ESP32-CAM/host.cpp` (the captive-portal SSID
// the firmware actually advertises). Drift between this and the firmware
// would tell users to look for a network that doesn't exist.
const AP_SSID = 'ESP32-Access-Point';

export default function Step3WiFi({ onNext, onBack, onSkip }: Step3WiFiProps) {
  const { t } = useTranslation();
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);

  return (
    <section className="flex flex-col items-center text-center" aria-labelledby="step3-title">
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
            d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0"
          />
        </svg>
      </div>

      <h2
        id="step3-title"
        className="font-bold text-hf-fg mb-3"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step3.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 max-w-md text-hf-base">{t('step3.text')}</p>

      <div
        className="rounded-hf-xl p-6 mb-6 w-full max-w-sm border-2 hf-card"
        style={{ borderColor: 'color-mix(in oklch, var(--hf-honey-400) 60%, transparent)' }}
      >
        <label
          className="text-hf-xs text-hf-fg-mute uppercase tracking-wider font-medium"
          htmlFor="ap-ssid"
        >
          {t('step3.networkName')}
        </label>
        <div
          className="flex items-center justify-between mt-1 rounded-hf px-4 py-3"
          style={{ background: 'var(--hf-line-soft)' }}
        >
          <code id="ap-ssid" className="text-hf-md font-mono font-bold text-hf-fg">
            {AP_SSID}
          </code>
          <CopyButton text={AP_SSID} label={t('step3.networkName')} />
        </div>
        <p className="text-hf-xs text-hf-fg-mute mt-2">{t('step3.openNetwork')}</p>
      </div>

      <aside
        className="rounded-hf-lg p-4 mb-4 w-full max-w-sm border"
        style={{
          background: 'color-mix(in oklch, var(--hf-warn) 10%, transparent)',
          borderColor: 'color-mix(in oklch, var(--hf-warn) 35%, transparent)',
        }}
      >
        <p className="text-hf-sm" style={{ color: 'var(--hf-honey-800)' }}>
          {t('step3.disconnectNotice')}
        </p>
      </aside>

      <div className="w-full max-w-sm mb-6">
        <button
          onClick={() => setShowTroubleshoot(!showTroubleshoot)}
          aria-expanded={showTroubleshoot}
          className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('step3.cantSeeNetwork')}
        </button>

        {showTroubleshoot && (
          <div className="mt-3 hf-card p-4 text-left space-y-3">
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
            className="hf-btn hf-btn-secondary flex-1 md:flex-none px-6 py-3"
          >
            {t('common.back')}
          </button>
          <button onClick={onNext} className="hf-btn hf-btn-primary flex-1 md:flex-none px-8 py-3">
            {t('step3.connected')}
          </button>
        </div>
        <button
          onClick={onSkip}
          className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('step3.skip')}
        </button>
      </div>
    </section>
  );
}

function TroubleshootItem({
  number,
  title,
  text,
}: {
  number: number;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-3">
      <span
        className="flex-shrink-0 w-6 h-6 rounded-full text-hf-xs font-bold flex items-center justify-center mt-0.5"
        style={{ background: 'var(--hf-line-soft)', color: 'var(--hf-fg-soft)' }}
      >
        {number}
      </span>
      <div>
        <p className="text-hf-sm font-medium text-hf-fg">{title}</p>
        <p className="text-hf-xs text-hf-fg-mute mt-0.5">{text}</p>
      </div>
    </div>
  );
}
