import { describe, it, expect, beforeEach } from 'vitest';
import { installLogRing, getRecentEntries, __resetLogRingForTest } from '../src/logRing';
import { log } from '../src/log';

// The structured logger pushes one entry AND writes a human line to the saved
// original stream, which bypasses the tee — so a logged message must appear in
// the ring exactly once, not twice (#178).
installLogRing();

beforeEach(() => {
  __resetLogRingForTest();
});

describe('log (#178 structured logger)', () => {
  it('records the level and message it is given', () => {
    log.warn('hf-log warn message');
    const entry = getRecentEntries(10).entries.find((e) => e.msg === 'hf-log warn message');
    expect(entry?.level).toBe('warn');
    expect(entry?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('does not double-capture: a logged line lands in the ring exactly once', () => {
    log.info('hf-log unique-once');
    const count = getRecentEntries(50).entries.filter((e) => e.msg === 'hf-log unique-once').length;
    expect(count).toBe(1);
  });

  it('error() produces an error-level entry', () => {
    log.error('hf-log boom');
    const entry = getRecentEntries(10).entries.find((e) => e.msg === 'hf-log boom');
    expect(entry?.level).toBe('error');
  });
});
