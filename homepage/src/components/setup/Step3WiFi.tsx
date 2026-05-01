import { useState } from 'react';
import CopyButton from './CopyButton';
import { useTranslation } from '../../i18n/LanguageContext';

interface Step3WiFiProps {
  onNext: () => void;
  onBack: () => void;
}

const AP_SSID = 'HiveHive-Access-Point';

export default function Step3WiFi({ onNext, onBack }: Step3WiFiProps) {
  const { t } = useTranslation();
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);

  // Skill rules applied:
  // - "The fix is usually to remove three." Dropped 96px icon circle and the
  //   warn-tinted disconnect-notice tile (now plain hint text below SSID).
  // - "At most 2 prominent elements per section." The SSID card is THE focus;
  //   the honey-toned 2px border was decoration on a card that's already
  //   prominent enough — switched to a single subtle border via hf-card.
  // - "Default to left-aligned; center only with intent."
  // - Footer: text-link Back (tertiary) + solid primary Next.
  return (
    <section className="flex flex-col" aria-labelledby="step3-title">
      <h2
        id="step3-title"
        className="font-bold text-hf-fg mb-2"
        style={{ fontSize: 'var(--fs-xl)' }}
      >
        {t('step3.title')}
      </h2>
      <p className="text-hf-fg-soft mb-6 text-hf-base">{t('step3.text')}</p>

      <div className="hf-card p-5 mb-3 w-full">
        <label
          className="text-hf-xs text-hf-fg-mute uppercase tracking-wider font-medium"
          htmlFor="ap-ssid"
        >
          {t('step3.networkName')}
        </label>
        <div
          className="flex items-center justify-between mt-2 rounded-hf px-4 py-3"
          style={{ background: 'var(--hf-line-soft)' }}
        >
          <code id="ap-ssid" className="text-hf-md font-mono font-bold text-hf-fg">
            {AP_SSID}
          </code>
          <CopyButton text={AP_SSID} label={t('step3.networkName')} />
        </div>
        <p className="text-hf-xs text-hf-fg-mute mt-2">{t('step3.openNetwork')}</p>
      </div>

      <p className="text-hf-xs text-hf-fg-mute mb-6">{t('step3.disconnectNotice')}</p>

      <div className="w-full mb-8">
        <button
          onClick={() => setShowTroubleshoot(!showTroubleshoot)}
          aria-expanded={showTroubleshoot}
          className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('step3.cantSeeNetwork')}
        </button>

        {showTroubleshoot && (
          <div className="mt-3 space-y-3">
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

      <div className="flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft underline transition-colors"
        >
          {t('common.back')}
        </button>
        <button onClick={onNext} className="hf-btn hf-btn-primary px-8 py-3">
          {t('step3.connected')}
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
