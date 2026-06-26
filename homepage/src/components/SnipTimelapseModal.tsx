import { useEffect, useState } from 'react';
import { api, type NestSnip } from '../services/api';
import { BEE_TYPES } from '../types';
import { useTranslation } from '../i18n/LanguageContext';

interface SnipTimelapseModalProps {
  moduleId: string;
  beeType: NestSnip['beeType'];
  nestIndex: number;
  onClose: () => void;
}

/**
 * Per-nest time-lapse (#166 phase 3, feature 1). Opened from a snip in
 * NestSnipGrid: fetches that single hole's full capture history (oldest first)
 * and lets the visitor scrub it across days with a slider, watching the hole get
 * sealed. Built on the ImageLightbox overlay conventions (Escape / backdrop /
 * close button, `z-[2000]` above the Leaflet map) — but with a frame scrubber
 * instead of a single image, so it is its own component rather than a prop on
 * ImageLightbox.
 *
 * Degrades gracefully: a loading skeleton, a single-frame note when only one
 * capture exists (slider disabled), an empty/error message otherwise. Never
 * tears down the parent panel.
 */
export default function SnipTimelapseModal({
  moduleId,
  beeType,
  nestIndex,
  onClose,
}: SnipTimelapseModalProps) {
  const { t, lang } = useTranslation();
  const [frames, setFrames] = useState<NestSnip[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    api
      .getSnipTimeline(moduleId, beeType, nestIndex)
      .then((rows) => {
        if (cancelled) return;
        setFrames(rows);
        // Open on the most recent capture — the current state of the hole — and
        // let the visitor scrub back through its history.
        setIndex(rows.length > 0 ? rows.length - 1 : 0);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error loading nest snip timeline:', err);
        setErrored(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, beeType, nestIndex]);

  const beeMeta = BEE_TYPES.find((b) => b.key === beeType);
  const beeLabel = beeMeta?.size ?? beeType;
  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  const title = t('modulePanel.timelapseTitle', { beeType: beeLabel, index: nestIndex });

  const current = frames[index];
  // `detectedAt` is "YYYY-MM-DD HH:MM:SS" UTC (no T/Z). Parse defensively:
  // append a `T` and `Z` so the browser reads it as UTC rather than local time.
  const frameDate = current
    ? new Date(`${current.detectedAt.replace(' ', 'T')}Z`).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '';
  const stateLabel = current
    ? current.state === 'sealed'
      ? t('modulePanel.snipSealed')
      : current.state === 'empty'
        ? t('modulePanel.snipEmpty')
        : t('modulePanel.snipDetected')
    : '';

  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/80 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="snip-timelapse-modal"
      onClick={onClose}
    >
      <div className="relative w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm font-medium"
        >
          {t('modulePanel.timelapseClose')}
        </button>

        <div className="bg-white rounded-hf-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-hf-border">
            <div className="font-semibold text-hf-sm text-hf-fg" style={{ color: beeMeta?.color }}>
              {title}
            </div>
            <div className="text-hf-xs text-hf-fg-mute">{t('modulePanel.timelapseHint')}</div>
          </div>

          {loading ? (
            <div className="hf-skeleton aspect-square m-4 rounded-hf-md" />
          ) : errored ? (
            <p className="p-6 text-center text-hf-sm text-hf-fg-mute">
              {t('modulePanel.timelapseLoadError')}
            </p>
          ) : frames.length === 0 ? (
            <p className="p-6 text-center text-hf-sm text-hf-fg-mute">
              {t('modulePanel.timelapseEmpty')}
            </p>
          ) : (
            <div className="p-4 flex flex-col gap-3">
              <figure
                className="relative aspect-square overflow-hidden rounded-hf-md border-2"
                style={{ borderColor: beeMeta?.color, backgroundColor: beeMeta?.lightColor }}
              >
                <img
                  // `key` forces a fresh <img> per frame so the browser doesn't
                  // briefly show the previous crop while the next one decodes.
                  key={current!.snipFilename}
                  src={api.getSnipUrl(current!.snipFilename)}
                  alt={t('modulePanel.snipAlt', {
                    beeType: beeLabel,
                    index: nestIndex,
                    state: stateLabel,
                  })}
                  data-testid="timelapse-frame"
                  className="w-full h-full object-cover"
                />
                <span
                  className="absolute bottom-0 inset-x-0 text-center text-hf-xs font-semibold leading-tight py-1 text-white"
                  style={{
                    backgroundColor:
                      current!.state === 'sealed' ? beeMeta?.color : 'rgba(0,0,0,0.55)',
                  }}
                >
                  {stateLabel}
                </span>
              </figure>

              <div className="flex items-center justify-between text-hf-xs text-hf-fg-mute tabular-nums">
                <span data-testid="timelapse-frame-date">{frameDate}</span>
                <span>
                  {t('modulePanel.timelapseFrameOf', {
                    current: index + 1,
                    total: frames.length,
                  })}
                </span>
              </div>

              {frames.length > 1 ? (
                <input
                  type="range"
                  min={0}
                  max={frames.length - 1}
                  value={index}
                  step={1}
                  aria-label={t('modulePanel.timelapseScrubLabel')}
                  data-testid="timelapse-scrubber"
                  onChange={(e) => setIndex(Number(e.target.value))}
                  className="w-full accent-hf-honey-500"
                />
              ) : (
                <p className="text-hf-xs text-hf-fg-mute text-center">
                  {t('modulePanel.timelapseSingleFrame')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
