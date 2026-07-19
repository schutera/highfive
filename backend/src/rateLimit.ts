// Generic sliding-window rate limiter (2026-07 audit, for #206).
//
// The login path has its own failure-count limiter in `session.ts` (it
// counts *failed* attempts and resets on success — different semantics).
// This one counts *events* regardless of outcome, for endpoints where any
// submission consumes budget (e.g. the public waitlist → Discord relay).
//
// Same honesty caveat as the login limiter: in-memory, per-process.
// Sufficient for the single-instance deployment behind host-Nginx; a
// multi-instance future needs a shared store (flagged in ADR-019).

export class SlidingWindowLimiter {
  private events = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    // Keys are client IPs — unauthenticated input. Bound the map so an
    // address-diverse flood can't grow it without limit (same failure
    // class as the userLocation cache, capped in the same audit).
    private readonly maxTrackedKeys = 10_000,
  ) {}

  /** True iff `key` is under budget; records the event when allowed. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let stamps = this.events.get(key);
    if (!stamps) {
      this.pruneIfNeeded(cutoff);
      stamps = [];
      this.events.set(key, stamps);
    }
    while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
    if (stamps.length >= this.maxPerWindow) return false;
    stamps.push(now);
    return true;
  }

  /** Test-only: wipe all state between cases. */
  __resetForTests(): void {
    this.events.clear();
  }

  private pruneIfNeeded(cutoff: number): void {
    if (this.events.size < this.maxTrackedKeys) return;
    for (const [key, stamps] of this.events) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) {
        this.events.delete(key);
      }
    }
    // Still over after dropping expired keys → drop oldest-inserted.
    const it = this.events.keys();
    while (this.events.size >= this.maxTrackedKeys) {
      const next = it.next();
      if (next.done) break;
      this.events.delete(next.value);
    }
  }
}
