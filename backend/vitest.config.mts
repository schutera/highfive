import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live alongside src in tests/. Each .test.ts is a separate suite;
    // module-level vi.mock() calls are hoisted by vitest before imports run.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // No module-level fetch leaks between test files: each suite resets its
    // global stubs in afterEach. Enforced by the test bodies, not config.
    globals: false,
    reporters: ['default'],
  },
});
