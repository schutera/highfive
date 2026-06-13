import { useEffect, type ReactNode } from 'react';

interface ImageLightboxProps {
  src: string;
  alt: string;
  /** Optional bar below the image. Callers own its content — the admin
      gallery passes module info + a Delete button, the public module
      panel passes a label + timestamp. The component itself never
      renders destructive actions. */
  caption?: ReactNode;
  closeLabel?: string;
  onClose: () => void;
}

/**
 * Full-screen image overlay shared by the admin gallery and the public
 * module panel. Closes on Escape, backdrop click, or the close button;
 * clicks inside the content area do not bubble to the backdrop.
 */
export default function ImageLightbox({
  src,
  alt,
  caption,
  closeLabel = 'Close (Esc)',
  onClose,
}: ImageLightboxProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      // z-[2000] sits above the Leaflet map (panes/controls reach ~1000)
      // and the dashboard's own panels (z-[1000]); at z-50 the map tiles
      // painted over the open lightbox — the bug this value fixes.
      className="fixed inset-0 z-[2000] bg-black/80 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      data-testid="image-lightbox"
      onClick={onClose}
    >
      <div
        className="relative max-w-5xl max-h-[90vh] w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm font-medium"
        >
          {closeLabel}
        </button>

        {/* Image */}
        <div className="flex-1 flex items-center justify-center min-h-0">
          <img src={src} alt={alt} className="max-w-full max-h-[80vh] object-contain rounded-lg" />
        </div>

        {/* Info bar */}
        {caption && (
          <div className="mt-4 bg-white/10 backdrop-blur rounded-lg p-3 flex items-center justify-between text-sm text-white">
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}
