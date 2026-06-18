import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initLogPersistence,
  pushEntry,
  getRecentEntries,
  __resetLogRingForTest,
  __flushDiskForTest,
} from '../src/logRing';

// Disk persistence + startup backfill (#178 / ADR-022). Gated on LOG_DIR: these
// tests pass an explicit tmp dir; unit tests that don't enable persistence stay
// in-memory and write nothing.

let dir: string;

beforeEach(() => {
  __resetLogRingForTest();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-logs-'));
});

afterEach(async () => {
  await __flushDiskForTest();
  __resetLogRingForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (msg: string) =>
  ({ ts: new Date().toISOString(), level: 'info', msg }) as const;

describe('log persistence (#178/ADR-022)', () => {
  it('appends each entry as a JSONL line to the log file', async () => {
    initLogPersistence(dir);
    pushEntry(entry('hf-persist alpha'));
    pushEntry(entry('hf-persist bravo'));
    // Flush buffered writes to disk before reading.
    await __flushDiskForTest();

    const file = path.join(dir, 'backend.log');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].msg).toBe('hf-persist alpha');
    expect(parsed[1].msg).toBe('hf-persist bravo');
    expect(parsed[0]).toHaveProperty('ts');
    expect(parsed[0]).toHaveProperty('level', 'info');
  });

  it('backfills the ring from a prior file on startup (survives restart)', async () => {
    // Simulate a previous process having written history, then exiting.
    initLogPersistence(dir);
    pushEntry(entry('hf-prior 1'));
    pushEntry(entry('hf-prior 2'));
    await __flushDiskForTest(); // flush + close == "process exit"
    __resetLogRingForTest(); // ring cleared

    // New process: ring is empty until we re-init from disk.
    expect(getRecentEntries(10).entries).toHaveLength(0);
    initLogPersistence(dir);
    const msgs = getRecentEntries(10).entries.map((e) => e.msg);
    expect(msgs).toEqual(['hf-prior 1', 'hf-prior 2']);
  });

  it('is a no-op when no dir is provided (in-memory only, no file written)', () => {
    initLogPersistence(undefined);
    pushEntry(entry('hf-nomem'));
    expect(getRecentEntries(10).entries.map((e) => e.msg)).toContain('hf-nomem');
    expect(fs.readdirSync(dir)).toHaveLength(0); // nothing persisted
  });

  it('skips malformed trailing lines during backfill', () => {
    const file = path.join(dir, 'backend.log');
    fs.writeFileSync(
      file,
      `${JSON.stringify(entry('good 1'))}\n${JSON.stringify(entry('good 2'))}\n{partial`,
    );
    initLogPersistence(dir);
    expect(getRecentEntries(10).entries.map((e) => e.msg)).toEqual(['good 1', 'good 2']);
  });
});
