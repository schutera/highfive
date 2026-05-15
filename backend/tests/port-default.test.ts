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

  // ----- malformed PORT: trailing garbage rejected -----
  //
  // Round-2 review caught that parseInt('3002junk', 10) returning 3002
  // was being treated as silent success, contradicting resolvePort's
  // "warn on misconfig" docstring. Anything that isn't a clean run of
  // digits (after .trim()) is now a default + warn case. The first
  // production deploy with a botched env file should fail loud.

  it('returns the default 3002 when PORT has trailing garbage, with warned=true', () => {
    expect(resolvePort('3002junk')).toEqual({ port: 3002, warned: true });
  });

  it('returns the default 3002 when PORT has leading garbage, with warned=true', () => {
    expect(resolvePort('junk3002')).toEqual({ port: 3002, warned: true });
  });

  // ----- whitespace-padded numeric PORT: accept, no warn -----

  it('returns the parsed env value when PORT is a number with surrounding whitespace, no warn', () => {
    // A trailing newline from a docker-compose env_file or a leading
    // space from a shell-edit is honest operator intent, not garbage.
    // .trim() handles it; no warning fires.
    expect(resolvePort('  3002  ')).toEqual({ port: 3002, warned: false });
    expect(resolvePort('\t4000\n')).toEqual({ port: 4000, warned: false });
  });
});
