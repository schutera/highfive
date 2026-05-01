import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/LanguageContext';
import { api } from '../services/api';
import type { Module } from '@highfive/contracts';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';

export default function HomePage() {
  const { t } = useTranslation();
  const [heroLoaded, setHeroLoaded] = useState(false);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-hf-bg text-hf-fg">
      {/* ============== Hero ============== */}
      <section
        className="relative isolate flex items-center justify-center overflow-hidden"
        style={{ minHeight: '100dvh' }}
        aria-labelledby="hero-title"
      >
        {/* LQIP placeholder — paints instantly from inlined data URL */}
        <div className="hf-hero-image absolute inset-0 z-0" aria-hidden="true" />

        {/* Real LCP image — uses native lazy/eager-decoding policy.
            Single <img> with explicit dimensions to avoid layout shift. */}
        <img
          src="/heroimage_hive.webp"
          alt=""
          width={1600}
          height={1067}
          decoding="async"
          fetchPriority="high"
          onLoad={() => setHeroLoaded(true)}
          className={`absolute inset-0 z-0 w-full h-full object-cover transition-opacity duration-700 ${
            heroLoaded ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {/* Tonal overlay for text legibility (WCAG contrast) */}
        <div
          className="absolute inset-0 z-10 bg-gradient-to-b from-black/30 via-black/15 to-black/70"
          aria-hidden="true"
        />

        {/* Shared SiteHeader, overlaid on the hero in dark/glass mode so
            the same header pattern is used on every route. */}
        <div className="absolute top-0 inset-x-0 z-30">
          <SiteHeader variant="glass" onDark />
        </div>

        {/* Hero content */}
        <div className="relative z-20 text-center px-4 max-w-5xl mx-auto pb-16">
          <h1
            id="hero-title"
            className="text-white font-bold mb-4 drop-shadow-2xl"
            style={{ fontSize: 'var(--fs-3xl)' }}
          >
            <span aria-hidden="true">🙌&nbsp;</span>HighFive
          </h1>
          <p
            className="text-hf-honey-100 mb-6 font-light tracking-wide"
            style={{ fontSize: 'var(--fs-xl)' }}
          >
            {t('home.heroSubtitle')}
          </p>
          <p
            className="text-white/95 mx-auto max-w-2xl mb-8"
            style={{ fontSize: 'var(--fs-md)', lineHeight: 1.6 }}
          >
            {t('home.heroText')}
          </p>

          <HeroStats />

          {/* Two CTAs: explore (low intent) + order (high intent). The
              dashboard sells "what's already happening"; the hive-module
              page sells "join the network". */}
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center items-center">
            <Link
              to="/dashboard"
              viewTransition
              className="hf-btn hf-btn-primary w-full sm:w-auto px-8 py-4 text-hf-md"
              style={{ background: 'var(--hf-honey-500)' }}
            >
              {t('home.viewDashboard')}
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
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </Link>
            <Link
              to="/hive-module"
              viewTransition
              className="hf-btn w-full sm:w-auto px-8 py-4 text-hf-md text-white"
              style={{
                background: 'color-mix(in oklch, white 8%, transparent)',
                border: '1px solid color-mix(in oklch, white 50%, transparent)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              }}
            >
              {t('home.getModule')}
            </Link>
          </div>
        </div>

        {/* Scroll indicator */}
        <a
          href="#how-it-works"
          aria-label="Scroll to How It Works"
          className="absolute left-1/2 bottom-8 -translate-x-1/2 z-20 text-white/80 hover:text-white"
        >
          <svg
            className="w-6 h-6 animate-bounce"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
        </a>
      </section>

      {/* ============== How it works ============== */}
      <section
        id="how-it-works"
        className="relative bg-hf-surface py-16 md:py-24 px-4"
        aria-labelledby="how-title"
      >
        <div className="max-w-6xl mx-auto">
          <h2
            id="how-title"
            className="text-center text-hf-fg mb-3"
            style={{ fontSize: 'var(--fs-2xl)' }}
          >
            {t('home.getStartedTitle')}
          </h2>
          <p
            className="text-center text-hf-fg-soft mb-10 md:mb-14 max-w-xl mx-auto"
            style={{ fontSize: 'var(--fs-base)' }}
          >
            {t('home.heroSubtitle')}
          </p>

          {/* Responsive 3-up grid that stacks on mobile, supports container queries */}
          <ol
            className="grid gap-6 md:gap-8 hf-cq"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' }}
          >
            <StepCard
              n={1}
              title={t('home.step1Title')}
              text={t('home.step1Text')}
              cta={{ to: '/hive-module', label: t('home.step1Cta') }}
              tint="honey"
            />
            <StepCard
              n={2}
              title={t('home.step2Title')}
              text={t('home.step2Text')}
              cta={{ to: '/setup', label: t('home.step2Cta') }}
              tint="honey"
              extra={
                <div
                  className="rounded-hf p-3 md:p-4 mt-3"
                  style={{
                    background: 'color-mix(in oklch, var(--hf-info) 8%, transparent)',
                    border: '1px solid color-mix(in oklch, var(--hf-info) 30%, transparent)',
                  }}
                >
                  <h4 className="font-bold text-hf-fg text-hf-sm mb-1.5">
                    {t('home.step2GuidedTitle')}
                  </h4>
                  <p className="text-hf-fg-soft text-hf-xs leading-relaxed">
                    {t('home.step2GuidedText')}
                  </p>
                </div>
              }
            />
            <StepCard
              n={3}
              title={t('home.step3Title')}
              text={t('home.step3Text')}
              cta={{ to: '/dashboard', label: t('home.step3Cta') }}
              tint="honey"
              extra={
                <div
                  className="rounded-hf p-3 md:p-4 mt-3"
                  style={{
                    background: 'color-mix(in oklch, var(--hf-forest-500) 8%, transparent)',
                    border: '1px solid color-mix(in oklch, var(--hf-forest-500) 30%, transparent)',
                  }}
                >
                  <p className="text-hf-fg-soft text-hf-xs leading-relaxed">
                    {t('home.step3Community')}
                  </p>
                </div>
              }
            />
          </ol>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

interface StepCardProps {
  n: number;
  title: string;
  text: string;
  cta: { to: string; label: string };
  tint: 'honey' | 'forest';
  extra?: React.ReactNode;
}

function StepCard({ n, title, text, cta, extra }: StepCardProps) {
  // Whole card is the click target — no separate CTA button at the
  // bottom. The accessible name comes from the <h3> via aria-labelledby.
  const titleId = `step-card-${n}-title`;
  return (
    <li className="list-none">
      <Link
        to={cta.to}
        viewTransition
        aria-labelledby={titleId}
        className="hf-card group p-6 md:p-7 flex flex-col gap-4 h-full transition-all duration-200 hover:shadow-hf-2 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hf-honey-500 focus-visible:ring-offset-2"
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center text-white font-bold shrink-0 transition-transform group-hover:scale-105"
            style={{
              background: 'linear-gradient(135deg, var(--hf-honey-400), var(--hf-honey-600))',
              fontSize: 'var(--fs-md)',
              boxShadow: 'var(--shadow-1)',
            }}
            aria-hidden="true"
          >
            {n}
          </div>
          <h3
            id={titleId}
            className="text-hf-fg font-bold flex-1"
            style={{ fontSize: 'var(--fs-md)' }}
          >
            {title}
          </h3>
          {/* Subtle directional cue, replaces the explicit CTA button */}
          <svg
            className="w-5 h-5 text-hf-fg-soft transition-transform group-hover:translate-x-0.5 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
        <p className="text-hf-fg-soft leading-relaxed flex-1" style={{ fontSize: 'var(--fs-sm)' }}>
          {text}
        </p>
        {extra}
        {/* SR-only link label so the card's purpose is announced clearly */}
        <span className="sr-only">{cta.label}</span>
      </Link>
    </li>
  );
}

interface StatsBundle {
  modules: number;
  online: number;
  images: number;
  hatches: number;
}

const ZERO_STATS: StatsBundle = { modules: 0, online: 0, images: 0, hatches: 0 };

/**
 * Live stats rendered chromeless over the hero image. Aggregated client-side
 * from the same `/api/modules` payload the dashboard fetches — no new
 * endpoint. The row never collapses: it starts at zeros, animates to real
 * numbers when the fetch resolves, and falls back to zeros on fetch error.
 * Showing zero is the design (pilot-phase honesty) — vanishing isn't.
 */
function HeroStats() {
  const { t, lang } = useTranslation();
  const [stats, setStats] = useState<StatsBundle>(ZERO_STATS);

  useEffect(() => {
    let cancelled = false;
    api
      .getAllModules()
      .then((modules: Module[]) => {
        if (cancelled) return;
        setStats({
          modules: modules.length,
          online: modules.filter((m) => m.status === 'online').length,
          images: modules.reduce((s, m) => s + (m.imageCount ?? 0), 0),
          hatches: modules.reduce((s, m) => s + (m.totalHatches ?? 0), 0),
        });
      })
      .catch(() => {
        // Stay at ZERO_STATS — never let the row disappear under the user.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fmt = (n: number) => n.toLocaleString(lang);

  return (
    <div
      role="group"
      aria-label={t('home.statsTitle')}
      aria-live="polite"
      className="flex items-stretch justify-center divide-x divide-white/20 mx-auto mb-10 max-w-3xl"
    >
      <HeroStatItem label={t('home.statsModulesLabel')} value={fmt(stats.modules)} />
      <HeroStatItem label={t('home.statsOnlineLabel')} value={fmt(stats.online)} live />
      <HeroStatItem label={t('home.statsImagesLabel')} value={fmt(stats.images)} />
      <HeroStatItem label={t('home.statsHatchesLabel')} value={fmt(stats.hatches)} />
    </div>
  );
}

interface HeroStatItemProps {
  label: string;
  value: string;
  /** Adds a pulsing dot to signal the metric is "now". */
  live?: boolean;
}

function HeroStatItem({ label, value, live }: HeroStatItemProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-3 sm:px-6 first:pl-0 last:pr-0">
      <span
        className="text-white font-light tabular-nums leading-none drop-shadow-md transition-[font-size] duration-300"
        style={{ fontSize: 'var(--fs-2xl)', letterSpacing: '-0.02em' }}
      >
        {value}
      </span>
      <span
        className="flex items-center gap-1.5 text-white/70 uppercase leading-none whitespace-nowrap"
        style={{ fontSize: 'var(--fs-xs)', letterSpacing: '0.18em' }}
      >
        {live && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-hf-success animate-pulse"
            aria-hidden="true"
          />
        )}
        {label}
      </span>
    </div>
  );
}
