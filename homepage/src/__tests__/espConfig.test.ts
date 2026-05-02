// WiFi-credential handover regression tests for the wizard side.
//
// A previous shape of `sendConfigToEsp` would silently treat an unclear
// HTTP response as success, and would happily send a 64+ char password
// that the firmware then truncated in `strlcpy(... wifi_config.PASSWORD)`.
// Either failure mode shipped a non-functional config to the device with
// no surfaced error.
//
// These tests pin:
//   1. Pre-flight validation rejects empty / too-long SSIDs and out-of-range
//      passwords BEFORE the network round-trip.
//   2. The body posted to the ESP is properly URL-encoded so the firmware's
//      hf::getParam can recover the SSID/password byte-for-byte.
//   3. A 200 OK response that does NOT contain "saved" is treated as a
//      failure — never as silent success.
//   4. A network error mid-POST is still treated as success (ESP rebooted
//      after accepting the config — the AP socket drops).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialValidationError,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  SSID_MAX_BYTES,
  sendConfigToEsp,
  validateCredentials,
} from '../components/setup/espConfig';

// A canned form HTML the ESP would serve from GET /, including the session
// token + esp_id markers that espConfig.ts greps out. The 12-hex `esp_id`
// lets the wizard wait for *this specific* module to come online (a
// reflashed module keeps its MAC, so the id is the only way to tell the
// fresh boot from the stale "already known" entry).
const MODULE_ID = 'aabbccddeeff';
const FORM_HTML = `<!DOCTYPE html><html><body>
<form>
<input type="hidden" name="session" value="deadbeef">
<input type="hidden" name="esp_id" value="${MODULE_ID}">
</form>
</body></html>`;

function baseConfig(overrides: Partial<Parameters<typeof sendConfigToEsp>[0]> = {}) {
  return {
    moduleName: 'Hive 1',
    ssid: 'HomeNet',
    password: 'hunter22', // 8 chars, just at the WPA2 minimum
    initBase: 'http://192.168.0.36:8002',
    initEndpoint: '/new_module',
    uploadBase: 'http://192.168.0.36:8000',
    uploadEndpoint: '/upload',
    ...overrides,
  };
}

describe('validateCredentials', () => {
  it('accepts a typical SSID + password', () => {
    expect(() => validateCredentials('HomeNet', 'hunter22')).not.toThrow();
  });

  it('rejects an empty SSID', () => {
    expect(() => validateCredentials('', 'hunter22')).toThrow(CredentialValidationError);
  });

  it(`rejects an SSID over ${SSID_MAX_BYTES} bytes`, () => {
    const tooLong = 'a'.repeat(SSID_MAX_BYTES + 1);
    expect(() => validateCredentials(tooLong, 'hunter22')).toThrow(CredentialValidationError);
  });

  it(`rejects a password under ${PASSWORD_MIN_BYTES} bytes`, () => {
    expect(() => validateCredentials('HomeNet', 'short')).toThrow(CredentialValidationError);
  });

  it(`rejects a password over ${PASSWORD_MAX_BYTES} bytes`, () => {
    const tooLong = 'a'.repeat(PASSWORD_MAX_BYTES + 1);
    expect(() => validateCredentials('HomeNet', tooLong)).toThrow(CredentialValidationError);
  });

  it(`accepts a password at exactly the boundary lengths (${PASSWORD_MIN_BYTES} and ${PASSWORD_MAX_BYTES})`, () => {
    expect(() => validateCredentials('HomeNet', 'a'.repeat(PASSWORD_MIN_BYTES))).not.toThrow();
    expect(() => validateCredentials('HomeNet', 'a'.repeat(PASSWORD_MAX_BYTES))).not.toThrow();
  });

  it('counts bytes, not code points (non-ASCII passwords)', () => {
    // 'ü' is 2 bytes in UTF-8; a 33-char string of 'ü' is 66 bytes
    // — over the WPA2 limit even though it's only 33 visible chars.
    const sneaky = 'ü'.repeat(33);
    expect(() => validateCredentials('HomeNet', sneaky)).toThrow(CredentialValidationError);
  });
});

describe('sendConfigToEsp wire format', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockEspOk(saveBody = 'Configuration saved successfully.') {
    fetchMock.mockResolvedValueOnce(new Response(FORM_HTML, { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(saveBody, { status: 200 }));
  }

  function captureSaveBody(): URLSearchParams {
    const saveCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/save'));
    expect(saveCall).toBeDefined();
    const init = saveCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    // URLSearchParams round-trip: re-parse the bytes that were posted.
    const body = init.body;
    if (body instanceof URLSearchParams) return body;
    return new URLSearchParams(String(body));
  }

  it('round-trips a password with characters that need percent-encoding', async () => {
    mockEspOk();
    // Every char in this password is one URLSearchParams encodes specially:
    // '@' -> %40, '&' -> %26, '!' -> %21, ' ' -> '+'.
    const tricky = 'p@ss&w0!d 9z'; // 12 chars, well within WPA2 bounds
    await sendConfigToEsp(baseConfig({ password: tricky }));
    const body = captureSaveBody();
    // The decoded value must equal what we sent — that's the contract
    // the firmware's getParam relies on.
    expect(body.get('password')).toBe(tricky);
    expect(body.get('ssid')).toBe('HomeNet');
    expect(body.get('session')).toBe('deadbeef');
  });

  it('encodes a literal + in the password as %2B (not as space)', async () => {
    mockEspOk();
    await sendConfigToEsp(baseConfig({ password: 'hunter+2x' }));
    const body = captureSaveBody();
    expect(body.get('password')).toBe('hunter+2x');
    // And the wire form must contain the percent-encoded byte sequence,
    // not a bare '+'. URLSearchParams.toString() gives us the on-wire bytes.
    expect(body.toString()).toContain('password=hunter%2B2x');
  });

  it('round-trips a password at the WPA2 upper bound (63 chars)', async () => {
    mockEspOk();
    const pw63 = 'a'.repeat(63);
    await sendConfigToEsp(baseConfig({ password: pw63 }));
    const body = captureSaveBody();
    expect(body.get('password')).toBe(pw63);
  });

  it('throws (does not POST) when the password is too long', async () => {
    const tooLong = 'a'.repeat(PASSWORD_MAX_BYTES + 1);
    await expect(sendConfigToEsp(baseConfig({ password: tooLong }))).rejects.toThrow(
      CredentialValidationError,
    );
    // Critically: no fetch was made — we want validation to short-circuit.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the password is empty', async () => {
    await expect(sendConfigToEsp(baseConfig({ password: '' }))).rejects.toThrow(
      CredentialValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendConfigToEsp response handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats a 200 OK without "saved" in the body as a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FORM_HTML, { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response('something else, no confirmation here', { status: 200 }),
    );
    await expect(sendConfigToEsp(baseConfig())).rejects.toThrow(/didn't confirm/);
  });

  it('treats a non-2xx save response as a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FORM_HTML, { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(sendConfigToEsp(baseConfig())).rejects.toThrow(/rejected the configuration/);
  });

  it('treats a network error mid-POST as success (ESP rebooted)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FORM_HTML, { status: 200 }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    // Should resolve, not throw — the AP socket drops as the ESP commits
    // the config and reboots into station mode. Critically: even on this
    // "success-by-network-error" path the resolved value must still carry
    // the moduleId we parsed out of the form before POSTing — the wizard
    // relies on it to start polling for the freshly booted module.
    await expect(sendConfigToEsp(baseConfig())).resolves.toEqual({
      moduleId: MODULE_ID,
    });
  });

  it('resolves on a 200 OK with the firmware confirmation string', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FORM_HTML, { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response('Configuration saved successfully.', { status: 200 }),
    );
    await expect(sendConfigToEsp(baseConfig())).resolves.toEqual({
      moduleId: MODULE_ID,
    });
  });
});

describe('sendConfigToEsp module-id parsing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects when the form HTML is missing esp_id entirely', async () => {
    // Old-firmware form: session present but no esp_id at all. We refuse
    // to proceed because the wizard has no way to disambiguate the
    // freshly flashed module from a stale "already known" entry without
    // a canonical id to poll for.
    const html = `<form><input type="hidden" name="session" value="deadbeef"></form>`;
    fetchMock.mockResolvedValueOnce(new Response(html, { status: 200 }));
    await expect(sendConfigToEsp(baseConfig())).rejects.toThrow(/did not advertise a valid id/);
    // We must bail before the POST — no /save call should happen.
    const saveCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/save'));
    expect(saveCall).toBeUndefined();
  });

  it('rejects when esp_id is malformed (not a 12-hex MAC)', async () => {
    const html = `<form>
      <input type="hidden" name="session" value="deadbeef">
      <input type="hidden" name="esp_id" value="not-a-mac">
    </form>`;
    fetchMock.mockResolvedValueOnce(new Response(html, { status: 200 }));
    await expect(sendConfigToEsp(baseConfig())).rejects.toThrow(/did not advertise a valid id/);
  });

  it('normalizes an uppercase MAC esp_id to the canonical lowercase form', async () => {
    // parseModuleId lowercases + strips separators. We pin that here so
    // an over-eager firmware rev that emits uppercase still funnels into
    // the same canonical id the rest of the system uses.
    const html = `<form>
      <input type="hidden" name="session" value="deadbeef">
      <input type="hidden" name="esp_id" value="AABBCCDDEEFF">
    </form>`;
    fetchMock.mockResolvedValueOnce(new Response(html, { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response('Configuration saved successfully.', { status: 200 }),
    );
    await expect(sendConfigToEsp(baseConfig())).resolves.toEqual({
      moduleId: 'aabbccddeeff',
    });
  });
});
