import { useEffect, useState } from 'react';
import { api, type NestSnip } from '../services/api';
import { BEE_TYPES } from '../types';
import { useTranslation } from '../i18n/LanguageContext';

interface NestSnipGridProps {
  moduleId: string;
}

/**
 * Per-nest hole-detection snip grid (#165). A grid mirroring the physical
 * laser-cut block: one row per bee type (ascending hole diameter, matching the
 * species cards), each row the cropped close-ups of that type's nest holes with
 * an empty/sealed badge. The crop is the privacy mechanism (#154) — only the
 * hole is shown, no garden/house background — so this renders on the public
 * panel without auth.
 *
 * Self-contained and progressive-enhancement, like LatestCaptures: renders
 * nothing for modules without detections and degrades silently on fetch error
 * (never tears down the parent ModulePanel).
 */
export default function NestSnipGrid({ moduleId }: NestSnipGridProps) {
  const { t } = useTranslation();
  const [snips, setSnips] = useState<NestSnip[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSnips([]);
    setLoading(true);
    api
      .getSnips(moduleId)
      .then((rows) => {
        if (!cancelled) setSnips(rows);
      })
      .catch((err) => {
        console.error('Error loading nest snips:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  if (loading) {
    return <div className="hf-skeleton h-40 rounded-hf-lg mb-4 md:shrink-0" />;
  }
  if (snips.length === 0) return null;

  // Group by bee type (BEE_TYPES order = ascending diameter), nests left→right.
  const rows = BEE_TYPES.map((beeType) => ({
    ...beeType,
    snips: snips.filter((s) => s.beeType === beeType.key).sort((a, b) => a.nestIndex - b.nestIndex),
  })).filter((row) => row.snips.length > 0);

  if (rows.length === 0) return null;

  return (
    <div className="mb-4 hf-card overflow-hidden md:shrink-0">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-semibold text-hf-sm text-hf-fg">{t('modulePanel.nestSnips')}</span>
        <span className="text-hf-xs text-hf-fg-mute">{t('modulePanel.nestSnipsHint')}</span>
      </div>

      <div className="flex flex-col gap-2 px-4 pb-3">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <div
              className="w-10 shrink-0 text-hf-xs font-bold tabular-nums"
              style={{ color: row.color }}
            >
              {row.size}
            </div>
            <div className="grid grid-cols-4 gap-2 flex-1">
              {row.snips.map((snip) => {
                const stateLabel =
                  snip.state === 'sealed'
                    ? t('modulePanel.snipSealed')
                    : t('modulePanel.snipEmpty');
                return (
                  <figure
                    key={`${snip.beeType}-${snip.nestIndex}`}
                    className="relative aspect-square overflow-hidden rounded-hf-md border-2"
                    style={{ borderColor: row.color, backgroundColor: row.lightColor }}
                    title={t('modulePanel.snipAlt', {
                      beeType: row.size,
                      index: snip.nestIndex,
                      state: stateLabel,
                    })}
                  >
                    <img
                      src={api.getSnipUrl(snip.snipFilename)}
                      alt={t('modulePanel.snipAlt', {
                        beeType: row.size,
                        index: snip.nestIndex,
                        state: stateLabel,
                      })}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                    <span
                      className="absolute bottom-0 inset-x-0 text-center text-[0.6rem] font-semibold leading-tight py-0.5 text-white"
                      style={{
                        backgroundColor: snip.state === 'sealed' ? row.color : 'rgba(0,0,0,0.55)',
                      }}
                    >
                      {stateLabel}
                    </span>
                  </figure>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
