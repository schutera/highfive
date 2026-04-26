import { useId, useState } from 'react';
import { useTranslation } from '../i18n/LanguageContext';

interface AdminKeyFormProps {
  /** Called with the key the user submitted. Should attempt the protected fetch. */
  onSubmit: (key: string) => void;
  /** Optional cancel hook — if provided, a Cancel button is rendered. */
  onCancel?: () => void;
  /** When true, the form disables inputs and shows a busy indicator. */
  busy?: boolean;
  /** Inline error to display (e.g. "Invalid key"). */
  error?: string | null;
}

/**
 * Inline admin-key entry form. Replaces the legacy window.prompt() used to
 * gate the Telemetry section. Stays a plain inline panel — no modal — and
 * mirrors the 2026 design tokens (honey amber, focus-visible rings, hf-card).
 */
export default function AdminKeyForm({ onSubmit, onCancel, busy, error }: AdminKeyFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="hf-card p-3 space-y-3"
      aria-label={t('adminKey.formLabel')}
    >
      <div>
        <label htmlFor={`${id}-key`} className="text-hf-xs font-medium text-hf-fg-soft">
          {t('adminKey.label')}
        </label>
        <input
          id={`${id}-key`}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          autoFocus
          disabled={busy}
          placeholder={t('adminKey.placeholder')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          className="mt-1 w-full bg-hf-bg border border-hf-border rounded-hf px-3 py-2 text-hf-sm text-hf-fg placeholder:text-hf-fg-mute focus:outline-none focus:ring-2 focus:ring-hf-honey-300 focus:border-hf-honey-400 disabled:opacity-50"
        />
      </div>

      {error && (
        <p
          id={`${id}-err`}
          role="alert"
          className="text-hf-xs"
          style={{ color: 'var(--hf-danger)' }}
        >
          {error}
        </p>
      )}

      <div className="flex gap-2 items-center">
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="hf-btn hf-btn-primary px-4 py-1.5 text-hf-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? t('common.loading') : t('adminKey.unlock')}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="hf-btn hf-btn-ghost px-3 py-1.5 text-hf-xs disabled:opacity-50"
          >
            {t('adminKey.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
