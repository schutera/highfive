import { useEffect, useRef, useState } from 'react';
import { api, type ImageUpload } from '../services/api';
import ImageLightbox from './ImageLightbox';
import { useTranslation } from '../i18n/LanguageContext';
import { formatUploadedAt } from '../lib/formatUploadedAt';

// How many image-metadata rows to pull per page. The carousel shows two
// cards at a time; a page of 6 means three "pages" of scrolling before the
// next fetch, and keeps the initial render light (only the visible two
// images actually download — the rest are loading="lazy").
const PAGE = 6;

interface LatestCapturesProps {
  moduleId: string;
  moduleName: string;
  locale: string;
}

/**
 * Horizontal gallery of a module's uploads, newest first — two 4:3 cards
 * visible at once, chevron arrows to scroll through the rest, click for a
 * full-size lightbox. Public, read-only (#154). Progressive enhancement:
 * a fetch failure renders nothing and never propagates (it must not tear
 * down the parent ModulePanel).
 */
export default function LatestCaptures({ moduleId, moduleName, locale }: LatestCapturesProps) {
  const { t } = useTranslation();
  const [images, setImages] = useState<ImageUpload[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<ImageUpload | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setImages([]);
    setTotal(0);
    setLightbox(null);
    setLoading(true);
    api
      .getImages(moduleId, { limit: PAGE, offset: 0 })
      .then((page) => {
        if (!cancelled) {
          setImages(page.images);
          setTotal(page.total);
        }
      })
      .catch((err) => {
        console.error('Error loading captures:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  // Append the next page (older images). Guarded so concurrent scroll +
  // arrow taps don't double-fetch the same window.
  const loadingMore = useRef(false);
  const loadMore = async () => {
    if (loadingMore.current || images.length >= total) return;
    loadingMore.current = true;
    try {
      const page = await api.getImages(moduleId, { limit: PAGE, offset: images.length });
      setImages((prev) => [...prev, ...page.images]);
      setTotal(page.total);
    } catch (err) {
      console.error('Error loading more captures:', err);
    } finally {
      loadingMore.current = false;
    }
  };

  const scrollByPage = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    if (dir === 1) loadMore(); // prefetch older images as we move right
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };

  // Lazy-fetch the next page as the strip nears its right edge.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 32) loadMore();
  };

  if (loading) {
    return <div className="hf-skeleton h-40 rounded-hf-lg mb-4 md:shrink-0" />;
  }
  if (images.length === 0) return null;

  // Arrows only matter when there's more than the two visible cards
  // (already-loaded extras, or more pages to fetch).
  const scrollable = images.length > 2 || total > images.length;

  return (
    <div className="mb-4 hf-card overflow-hidden md:shrink-0">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-semibold text-hf-sm text-hf-fg">
          {t('modulePanel.latestCaptures')}
        </span>
        {total > 0 && <span className="text-hf-xs text-hf-fg-mute tabular-nums">{total}</span>}
      </div>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex gap-2 overflow-x-auto snap-x snap-mandatory px-4 pb-3 scroll-smooth"
        >
          {images.map((img) => (
            <figure key={img.filename} className="snap-start shrink-0 w-[calc(50%-0.25rem)]">
              <button
                type="button"
                onClick={() => setLightbox(img)}
                aria-label={t('modulePanel.latestCaptureOpen')}
                className="block w-full aspect-[4/3] overflow-hidden rounded-hf-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-hf-honey-500"
              >
                <img
                  src={api.getImageUrl(img.filename)}
                  alt={t('modulePanel.captureAlt', { name: moduleName })}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </button>
              <figcaption className="mt-1 text-hf-xs text-hf-fg-mute">
                {formatUploadedAt(img.uploaded_at, locale)}
              </figcaption>
            </figure>
          ))}
        </div>

        {scrollable && (
          <>
            <button
              type="button"
              onClick={() => scrollByPage(-1)}
              aria-label={t('modulePanel.galleryPrev')}
              className="absolute left-1 top-[calc(50%-0.75rem)] -translate-y-1/2 grid place-items-center w-8 h-8 rounded-full bg-hf-bg/80 text-hf-fg shadow-hf-1 hover:bg-hf-bg"
            >
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
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => scrollByPage(1)}
              aria-label={t('modulePanel.galleryNext')}
              className="absolute right-1 top-[calc(50%-0.75rem)] -translate-y-1/2 grid place-items-center w-8 h-8 rounded-full bg-hf-bg/80 text-hf-fg shadow-hf-1 hover:bg-hf-bg"
            >
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
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </>
        )}
      </div>

      {lightbox && (
        <ImageLightbox
          src={api.getImageUrl(lightbox.filename)}
          alt={t('modulePanel.captureAlt', { name: moduleName })}
          closeLabel={t('modulePanel.lightboxClose')}
          onClose={() => setLightbox(null)}
          caption={
            <>
              <span className="font-medium">{t('modulePanel.latestCaptures')}</span>
              <span className="text-white/60">
                {formatUploadedAt(lightbox.uploaded_at, locale)}
              </span>
            </>
          }
        />
      )}
    </div>
  );
}
