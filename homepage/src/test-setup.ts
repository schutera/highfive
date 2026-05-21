import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Clean up DOM between tests
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement ResizeObserver — provide a stub that fires
// once with a sensible non-zero contentRect on `observe`, so any
// component that gates its render on "we have measured dimensions"
// (e.g. ActivityWeatherChart, which feeds explicit width/height into
// ComposedChart to avoid Recharts' pre-layout warning) can proceed
// inside tests without needing a real ResizeObserver implementation.
// Unconditional override: jsdom 24+ ships a `ResizeObserver` class
// but its `observe()` is a no-op that never calls the callback, so
// gates like "wait until first measurement" never open. We install
// our own that fires once with a sensible non-zero contentRect on
// the first `observe()` call.
{
  class ResizeObserverStub {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      const contentRect = {
        width: 800,
        height: 240,
        top: 0,
        left: 0,
        bottom: 240,
        right: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly;
      const entry = {
        target,
        contentRect,
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry;
      // Real browsers dispatch ResizeObserver entries after the current
      // microtask batch / commit phase, not synchronously inside
      // observe(). Mirror that: a synchronous fire would land setState
      // calls in the middle of React's commit, which works by luck for
      // our chart but is a latent ordering hazard for any future
      // consumer that sets state only from the observer.
      queueMicrotask(() => this.cb([entry], this as unknown as ResizeObserver));
    }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

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
  const stubFetch = vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch & { _isStub: boolean };
  (stubFetch as unknown as { _isStub: boolean })._isStub = true;
  globalThis.fetch = stubFetch;
}
