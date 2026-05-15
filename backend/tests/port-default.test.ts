import { describe, it, expect } from 'vitest';
import { resolvePort } from '../src/port';

// Pure-function tests for the PORT-resolution helper. The previous
// inline `parseInt(process.env.PORT || '3001', 10)` was bisect-hostile:
// changing the default required reading the test-runner side effects
// (socket binding) to verify. The extracted helper makes the decision
// logic directly testable.
//
// The 3002 default closes the incident shape that ea7dc73 fixed:
// PORT removed from docker-compose.yml caused server.ts to bind 3001
// while host mapping pointed at 3002, silently breaking the dashboard.
// Now the default matches the host map; warn-on-unset surfaces the
// configuration drift to the operator.

describe('resolvePort', () => {
  // ----- explicit PORT: env value wins, no warning -----

  it('returns the parsed env value when PORT is set numerically', () => {
    expect(resolvePort('4000')).toEqual({ port: 4000, warned: false });
  });

  it('returns the parsed env value when PORT is 3002 (dev default)', () => {
    expect(resolvePort('3002')).toEqual({ port: 3002, warned: false });
  });

  it('returns the parsed env value when PORT is 80 (privileged)', () => {
    // Privileged ports are operator responsibility; resolvePort doesn't
    // gate on the value, only on parse-ability. Pins that contract.
    expect(resolvePort('80')).toEqual({ port: 80, warned: false });
  });

  // ----- PORT unset: default 3002, with warning -----

  it('returns the default 3002 when PORT is undefined, with warned=true', () => {
    expect(resolvePort(undefined)).toEqual({ port: 3002, warned: true });
  });

  // ----- PORT non-numeric: default 3002, with warning -----
  //
  // parseInt('') === NaN, same as parseInt('abc'). Treating that as
  // "operator gave us garbage" and routing to the default + warning
  // is safer than crashing with NaN or binding a port the operator
  // didn't intend. The warn surfaces the misconfiguration loudly.

  it('returns the default 3002 when PORT is an empty string, with warned=true', () => {
    expect(resolvePort('')).toEqual({ port: 3002, warned: true });
  });

  it('returns the default 3002 when PORT is non-numeric, with warned=true', () => {
    expect(resolvePort('abc')).toEqual({ port: 3002, warned: true });
  });

  // ----- parseInt edge cases worth pinning -----

  it('returns the parsed prefix when PORT has trailing garbage (parseInt behaviour)', () => {
    // parseInt('3002junk', 10) === 3002. This is JavaScript's documented
    // parseInt semantics — pinning so a future Number() refactor that
    // would return NaN for '3002junk' triggers the test rather than the
    // first production deploy with a botched env file.
    expect(resolvePort('3002junk')).toEqual({ port: 3002, warned: false });
  });
});
