import { describe, it, expect } from 'vitest';
import { flagEnabled } from '../lib/featureFlags';

// The safe-default contract behind ADR-022: a build-time feature flag is on
// ONLY for the exact string 'true'. This is the single assertion guarding
// against a silent prod-on regression (e.g. a future edit that also accepts
// '1' or trims whitespace would have to change this test on purpose).
describe('flagEnabled', () => {
  it('enables only for the exact string "true"', () => {
    expect(flagEnabled('true')).toBe(true);
  });

  it.each([undefined, '', 'TRUE', 'True', '1', ' true', 'true ', 'false', 'yes', '0'])(
    'reads %j as off',
    (value) => {
      expect(flagEnabled(value as string | undefined)).toBe(false);
    },
  );
});
