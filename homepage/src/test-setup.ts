import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Clean up DOM between tests
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement matchMedia — provide a noop stub.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Stub global fetch so anything that escapes our api mock gets a sane reply
// rather than throwing a generic "fetch is not defined / network" error.
if (!globalThis.fetch || !(globalThis.fetch as { _isStub?: boolean })._isStub) {
  const stubFetch = vi.fn(async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ) as unknown as typeof fetch & { _isStub: boolean };
  (stubFetch as unknown as { _isStub: boolean })._isStub = true;
  globalThis.fetch = stubFetch;
}
