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
}: SiteHeaderProps) {
  const surface = variant === 'glass' ? 'hf-glass' : 'bg-hf-surface border-b border-hf-border';

  return (
    <header
      className={`${surface} px-3 md:px-6 py-2 md:py-3 flex items-center justify-between shrink-0 z-20 pt-safe-top`}
    >
      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        <Link
          to="/"
          className="text-hf-md md:text-hf-lg font-bold text-hf-honey-700 hover:text-hf-honey-800 flex items-center gap-1.5 rounded-md"
          aria-label="HighFive home"
        >
          <span className="text-xl md:text-2xl" aria-hidden="true">
            🙌
          </span>
          <span>HighFive</span>
        </Link>
        {title && (
          <>
            <span className="text-hf-border hidden md:inline" aria-hidden="true">
              |
            </span>
            <h1 className="hidden md:block text-hf-md font-semibold text-hf-fg truncate">
              {title}
            </h1>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 md:gap-2">
        {right}
        <LanguageToggle />
        <ThemeToggle />
        {secondary && (
          <Link
            to={secondary.to}
            className="hidden md:inline-block text-hf-sm text-hf-fg-mute hover:text-hf-fg-soft transition-colors px-2 py-1"
          >
            {secondary.label}
          </Link>
        )}
      </div>
    </header>
  );
}
