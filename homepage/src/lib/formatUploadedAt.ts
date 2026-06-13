// Single source of truth for rendering `ImageUpload.uploaded_at`
// (same one-helper-per-wire-field pattern as displayLabel.ts).
//
// `uploaded_at` arrives as "YYYY-MM-DD HH:MM:SS" in UTC — NOT ISO-8601
// (see the ImageUpload contract note "parse defensively"). Appending the
// explicit Z keeps the rendered time UTC-correct in every viewer
// timezone; a bare `new Date(str)` would parse as *local* time (and is
// Invalid Date on Safari). Same approach as ActivityWeatherChart's
// bucket parsing. Do NOT use this for genuinely ISO fields like
// `lastApiCall` — those parse correctly without help.
export function formatUploadedAt(uploadedAt: string, locale?: string): string {
  const date = new Date(uploadedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return uploadedAt;
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
