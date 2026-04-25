import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dedicated vitest config — keeps the dev/build vite.config.ts
// (which has a Node-only LAN-IP plugin) out of the test pipeline.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
  define: {
    // Provide stable VITE_* env values for tests so import.meta.env
    // doesn't leak undefined into components.
    'import.meta.env.VITE_API_URL': JSON.stringify('http://localhost:3002/api'),
    'import.meta.env.VITE_API_KEY': JSON.stringify('hf_test_key'),
    'import.meta.env.VITE_STRIPE_LINK': JSON.stringify('#'),
    'import.meta.env.VITE_INIT_BASE_URL': JSON.stringify('http://localhost:8002'),
    'import.meta.env.VITE_UPLOAD_BASE_URL': JSON.stringify('http://localhost:8000'),
  },
});
