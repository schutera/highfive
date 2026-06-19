import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pin the rotation config passed to rotating-file-stream (#178 / ADR-022). The
// actual eviction is the library's well-tested behaviour; what this guards is
// that BOTH retention bounds (≤30 files via maxFiles AND ≤100 MB via maxSize)
// plus the 50 MB active-file trigger are configured — a silent drop of either
// would let the disk fill. The Flask side's hand-rolled prune/rollover is
// covered behaviourally in test_logs.py.
// vi.hoisted so the fn exists before the hoisted vi.mock factory references it.
const createStream = vi.hoisted(() =>
  vi.fn(() => ({ write: vi.fn(), end: vi.fn((cb?: () => void) => cb?.()) })),
);
vi.mock('rotating-file-stream', () => ({ createStream }));

import { initLogPersistence, __resetLogRingForTest } from '../src/logRing';

let dir: string;

beforeEach(() => {
  __resetLogRingForTest();
  createStream.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-rot-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('disk rotation config (#178 / ADR-022)', () => {
  it('configures rotating-file-stream with both retention bounds + size trigger', () => {
    initLogPersistence(dir);
    expect(createStream).toHaveBeenCalledTimes(1);
    expect(createStream).toHaveBeenCalledWith(
      'backend.log',
      expect.objectContaining({
        path: dir,
        interval: '1d', // daily rotation
        size: '50M', // …and an active-file size trigger
        maxFiles: 30, // ≤30 retained files
        maxSize: '100M', // …AND ≤100 MB total
      }),
    );
  });

  it('does not configure a stream when LOG_DIR is absent', () => {
    initLogPersistence(undefined);
    expect(createStream).not.toHaveBeenCalled();
  });
});
