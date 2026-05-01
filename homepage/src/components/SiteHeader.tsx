import { Link } from 'react-router-dom';
import LanguageToggle from './LanguageToggle';
import ThemeToggle from './ThemeToggle';

interface SiteHeaderProps {
  title?: string;
  /** Optional right-hand side slot (e.g. status pill, secondary CTA). */
  right?: React.ReactNode;
  /** Optional secondary link shown after the toggles (e.g. "Back to home"). */
  secondary?: { to: string; label: string };
  /** Visually-elevated header (used over content) vs. plain. */
  variant?: 'solid' | 'glass';
  /** Use light text + toggle styling. For overlay on dark imagery. */
  onDark?: boolean;
}

/**
 * Shared application header — wordmark on the left, language + theme
 * toggles on the right, optional title and secondary link. Sticky on
 * desktop so the brand mark is always reachable; static on mobile to
 * keep the LCP element of /
 */
export default function SiteHeader({
  title,
  right,
  secondary,
  variant = 'solid',
  onDark = false,
}: SiteHeaderProps) {
  const surface = variant === 'glass' ? 'hf-glass' : 'bg-hf-surface border-b border-hf-border';
  const brandColor = onDark
    ? 'text-white/95 hover:text-white'
    : 'text-hf-honey-700 hover:text-hf-honey-800';
  const titleColor = onDark ? 'text-white/95' : 'text-hf-fg';
  const secondaryColor = onDark
    ? 'text-white/80 hover:text-white'
    : 'text-hf-fg-mute hover:text-hf-fg-soft';
  const toggleOnDark = '!text-white/90 hover:!text-white hover:!bg-white/10';

  return (
    <header
      className={`${surface} px-3 md:px-6 py-2 md:py-3 flex items-center justify-between shrink-0 z-20 pt-safe-top`}
    >
      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        <Link
          to="/"
          viewTransition
          className={`text-hf-md md:text-hf-lg font-bold ${brandColor} flex items-center gap-1.5 rounded-md`}
          aria-label="HighFive home"
        >
          <span className="text-xl md:text-2xl" aria-hidden="true">
            🙌
          </span>
          <span>HighFive</span>
        </Link>
        {title && (
          <>
            <span
              className={`hidden md:inline ${onDark ? 'text-white/40' : 'text-hf-border'}`}
              aria-hidden="true"
            >
              |
            </span>
            {/* Visible on desktop, screen-reader-only on mobile.
                Drops the WCAG "page lacks h1" gap on /dashboard mobile
                without crowding the small-viewport header bar. */}
            <h1
              className={`text-hf-md font-semibold ${titleColor} truncate sr-only md:not-sr-only`}
            >
              {title}
            </h1>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 md:gap-2">
        {right}
        <LanguageToggle className={onDark ? toggleOnDark : undefined} />
        <ThemeToggle className={onDark ? toggleOnDark : undefined} />
        {secondary && (
          <Link
            to={secondary.to}
            viewTransition
            className={`hidden md:inline-block text-hf-sm ${secondaryColor} transition-colors px-2 py-1`}
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </header>
  );
}
