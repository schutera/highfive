import { describe, it, expect } from 'vitest';
import translations from '../i18n/translations';

// The pre-#40 prose ("hold IO0 / the left button for 5 seconds while
// powered to factory-reset") was unreachable on AI Thinker
// ESP32-CAM-MB because GPIO0 is a strap pin. See
// docs/11-risks-and-technical-debt/README.md "GPIO0 is a strap pin"
// for the post-mortem. This test pins the four user-facing strings
// against the regex regression class so the next translator can't
// accidentally re-introduce the broken instruction.
//
// Mechanical companion to scripts/check-stale-reset-prose.sh, which
// catches the same shape across docs/ + .claude/skills/ + ESP32-CAM/.
describe('i18n: factory-reset copy is post-#40', () => {
  const STALE_RESET_PROSE =
    /(IO0|hold.*5\s*second|left\s*button.*ESP32-CAM|linken\s+Knopf.*[0-9]+\s*Sekunden)/i;

  type AnyDict = { [k: string]: unknown };

  const lookup = (root: AnyDict, path: string[]): string => {
    let cur: unknown = root;
    for (const segment of path) {
      if (typeof cur !== 'object' || cur === null) {
        throw new Error(`i18n key ${path.join('.')} stops at non-object before "${segment}"`);
      }
      cur = (cur as AnyDict)[segment];
    }
    if (typeof cur !== 'string') {
      throw new Error(`i18n key ${path.join('.')} is not a string`);
    }
    return cur;
  };

  const pinned: Array<[string, string[]]> = [
    ['en.assembly.factoryReset', ['en', 'assembly', 'factoryReset']],
    ['en.step5.troubleshoot.resetText', ['en', 'step5', 'troubleshoot', 'resetText']],
    ['de.assembly.factoryReset', ['de', 'assembly', 'factoryReset']],
    ['de.step5.troubleshoot.resetText', ['de', 'step5', 'troubleshoot', 'resetText']],
  ];

  for (const [label, path] of pinned) {
    it(`${label} does not contain stale "hold IO0/5-second/left-button" prose`, () => {
      const value = lookup(translations as unknown as AnyDict, path);
      expect(value).not.toMatch(STALE_RESET_PROSE);
    });
  }
});
