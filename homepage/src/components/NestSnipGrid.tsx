import { useEffect, useMemo, useState } from 'react';
import { api, type NestSnip } from '../services/api';
import { BEE_TYPES } from '../types';
import { useTranslation } from '../i18n/LanguageContext';

interface NestSnipGridProps {
  moduleId: string;
}

// One capture's worth of snips — every hole detected in a single upload.
interface CaptureFrame {
  sourceFilename: string;
  detectedAt: string;
  snips: NestSnip[];
}

// Fold the flat, oldest-first history into per-capture frames, preserving the
// chronological order the backend already sorted by (first-seen filename order
// is the capture order, since rows arrive `detected_at ASC`).
function groupByCapture(rows: NestSnip[]): CaptureFrame[] {
  const order: string[] = [];
  const byFile = new Map<string, CaptureFrame>();
  for (const row of rows) {
    let frame = byFile.get(row.sourceFilename);
    if (!frame) {
      frame = { sourceFilename: row.sourceFilename, detectedAt: row.detectedAt, snips: [] };
      byFile.set(row.sourceFilename, frame);
      order.push(row.sourceFilename);
    }
    frame.snips.push(row);
  }
  return order.map((f) => byFile.get(f)!);
}

/**
 * Per-nest hole-detection snip grid with a global time-lapse scrubber (#165 +
 * #166 phase 3). A grid mirroring the physical laser-cut block: one row per bee
 * type (ascending hole diameter, matching the species cards), each cell the
 * cropped close-up of a nest hole. A single slider beneath the grid scrubs the
 * whole module across captures — dragging it swaps *every* hole at once to that
 * date's crops and updates the shown capture date/time. Opens on the newest
 * capture (the block's current state). The crop is the privacy mechanism (#154)
 * — only the hole is shown — so this renders on the public panel without auth.
 *
 * Self-contained and progressive-enhancement: renders nothing for modules
 * without detections and degrades silently on fetch error (never tears down the
 * parent ModulePanel).
 */
export default function NestSnipGrid({ moduleId }: NestSnipGridProps) {
  const { t, lang } = useTranslation();
  const [history, setHistory] = useState<NestSnip[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setLoading(true);
    api
      .getSnipHistory(moduleId)
      .then((rows) => {
        if (cancelled) return;
        setHistory(rows);
        // Open on the newest capture — the block's current state — and let the
        // visitor scrub back through its history.
        const frameCount = new Set(rows.map((r) => r.sourceFilename)).size;
        setIndex(frameCount > 0 ? frameCount - 1 : 0);
      })
      .catch((err) => {
        console.error('Error loading nest snip history:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  const frames = useMemo(() => groupByCapture(history), [history]);

  if (loading) {
    return <div className="hf-skeleton h-40 rounded-hf-lg mb-4 md:shrink-0" />;
  }
  if (frames.length === 0) return null;

  // Belt-and-suspenders: the loading gate above already blocks any render with
  // a stale `index` (the effect sets `loading` true before refetch, and lands
  // `history`+`index` together on resolve), but clamp anyway so a future change
  // to that ordering can never index past the array.
  const safeIndex = Math.min(index, frames.length - 1);
  const current = frames[safeIndex];

  // Group the *selected* capture's snips by bee type (ascending diameter),
  // nests left→right. Empty rows are dropped so a 7/5/5/4 block doesn't render
  // gaps for a type with no holes detected in this frame.
  const rows = BEE_TYPES.map((beeType) => ({
    ...beeType,
    snips: current.snips
      .filter((s) => s.beeType === beeType.key)
      .sort((a, b) => a.nestIndex - b.nestIndex),
  })).filter((row) => row.snips.length > 0);

  if (rows.length === 0) return null;

  const locale = lang === 'de' ? 'de-DE' : 'en-US';
  // `detectedAt` is "YYYY-MM-DD HH:MM:SS" UTC (no T/Z). Append a `T` and `Z` so
  // the browser reads it as UTC, then render local date + time of the photo.
  const captureDate = new Date(`${current.detectedAt.replace(' ', 'T')}Z`).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

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
            {/* One visual row per bee type, one column per detected nest. The
                real blocks are irregular (7/5/5/4, not 4×4), so the row width
                follows the hole count — `auto-cols-fr` keeps all of a row's
                snips on a single line instead of wrapping a 7-hole row to 4+3. */}
            <div className="grid grid-flow-col auto-cols-fr gap-2 flex-1">
              {row.snips.map((snip) => {
                // `undetermined` is the learned detector's localize-only state
                // (ADR-027): the hole is found but empty/sealed is deferred, so
                // the badge reads a neutral "Detected" rather than guessing.
                const stateLabel =
                  snip.state === 'sealed'
                    ? t('modulePanel.snipSealed')
                    : snip.state === 'empty'
                      ? t('modulePanel.snipEmpty')
                      : t('modulePanel.snipDetected');
                return (
                  // Static figure: the time-lapse is driven by the single global
                  // scrubber below, not by tapping individual holes.
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
                      // `key` forces a fresh <img> per capture so the browser
                      // doesn't briefly show the previous crop while the next
                      // one decodes as the slider moves.
                      key={snip.snipFilename}
                      src={api.getSnipUrl(snip.snipFilename)}
                      alt={t('modulePanel.snipAlt', {
                        beeType: row.size,
                        index: snip.nestIndex,
                        state: stateLabel,
                      })}
                      loading="lazy"
                      data-testid="snip-frame"
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

        {/* Global time-lapse scrubber (#166 phase 3): one slider under the grid;
            dragging it swaps every hole above to the chosen capture's crops and
            updates the capture date/time. */}
        <div className="flex flex-col gap-1 pt-1">
          <div className="flex items-center justify-between text-hf-xs text-hf-fg-mute tabular-nums">
            <span data-testid="snip-capture-date">{captureDate}</span>
            <span>
              {t('modulePanel.timelapseFrameOf', {
                current: safeIndex + 1,
                total: frames.length,
              })}
            </span>
          </div>
          {frames.length > 1 ? (
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              value={safeIndex}
              step={1}
              aria-label={t('modulePanel.timelapseScrubLabel')}
              data-testid="snip-scrubber"
              onChange={(e) => setIndex(Number(e.target.value))}
              className="w-full accent-hf-honey-500"
            />
          ) : (
            <p className="text-hf-xs text-hf-fg-mute text-center">
              {t('modulePanel.timelapseSingleFrame')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
