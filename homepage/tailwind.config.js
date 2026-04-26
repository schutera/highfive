/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Toggle dark mode via `[data-theme='dark']` on <html>; falls back
  // to `prefers-color-scheme: dark` via the CSS tokens themselves.
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      screens: {
        xs: '320px',
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1536px',
      },
      spacing: {
        'safe-top': 'max(1rem, env(safe-area-inset-top))',
        'safe-bottom': 'max(1rem, env(safe-area-inset-bottom))',
        'safe-left': 'max(1rem, env(safe-area-inset-left))',
        'safe-right': 'max(1rem, env(safe-area-inset-right))',
      },
      colors: {
        // Token-driven palette so existing Tailwind utilities like
        // `bg-hf-primary` resolve to a CSS variable that respects
        // dark mode automatically.
        hf: {
          bg: 'var(--hf-bg)',
          surface: 'var(--hf-bg-elev)',
          fg: 'var(--hf-fg)',
          'fg-soft': 'var(--hf-fg-soft)',
          'fg-mute': 'var(--hf-fg-mute)',
          border: 'var(--hf-border)',
          primary: 'var(--hf-primary)',
          'primary-fg': 'var(--hf-primary-fg)',
          accent: 'var(--hf-accent)',
          success: 'var(--hf-success)',
          warn: 'var(--hf-warn)',
          danger: 'var(--hf-danger)',
          info: 'var(--hf-info)',
          honey: {
            50: 'var(--hf-honey-50)',
            100: 'var(--hf-honey-100)',
            200: 'var(--hf-honey-200)',
            300: 'var(--hf-honey-300)',
            400: 'var(--hf-honey-400)',
            500: 'var(--hf-honey-500)',
            600: 'var(--hf-honey-600)',
            700: 'var(--hf-honey-700)',
            800: 'var(--hf-honey-800)',
            900: 'var(--hf-honey-900)',
          },
          forest: {
            50: 'var(--hf-forest-50)',
            100: 'var(--hf-forest-100)',
            500: 'var(--hf-forest-500)',
            700: 'var(--hf-forest-700)',
          },
        },
      },
      borderRadius: {
        'hf-sm': 'var(--radius-sm)',
        hf: 'var(--radius-md)',
        'hf-lg': 'var(--radius-lg)',
        'hf-xl': 'var(--radius-xl)',
      },
      boxShadow: {
        'hf-1': 'var(--shadow-1)',
        'hf-2': 'var(--shadow-2)',
        'hf-3': 'var(--shadow-3)',
      },
      fontSize: {
        'hf-xs': 'var(--fs-xs)',
        'hf-sm': 'var(--fs-sm)',
        'hf-base': 'var(--fs-base)',
        'hf-md': 'var(--fs-md)',
        'hf-lg': 'var(--fs-lg)',
        'hf-xl': 'var(--fs-xl)',
        'hf-2xl': 'var(--fs-2xl)',
        'hf-3xl': 'var(--fs-3xl)',
      },
    },
  },
  plugins: [],
};
