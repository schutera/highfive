import { parseModuleId, type ModuleId } from '@highfive/contracts';

/**
 * In dev, the Vite proxy at /esp-api forwards to http://192.168.4.1,
 * bypassing CORS entirely. In production (static build), we hit the
 * ESP directly — requires CORS headers in firmware.
 */
const ESP_BASE = import.meta.env.DEV ? '/esp-api' : 'http://192.168.4.1';
const TIMEOUT_MS = 10000;

// IEEE 802.11 caps SSID at 32 octets. WPA2-PSK passphrase is 8-63 ASCII
// chars or exactly 64 hex chars (raw PSK). The firmware enforces the same
// bounds; pre-flighting them here gives the user an immediate, actionable
// error instead of an opaque "ESP didn't connect" later.
export const SSID_MAX_BYTES = 32;
export const PASSWORD_MIN_BYTES = 8;
export const PASSWORD_MAX_BYTES = 64;

export class CredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialValidationError';
  }
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function validateCredentials(ssid: string, password: string): void {
  const ssidBytes = utf8ByteLength(ssid);
  const pwBytes = utf8ByteLength(password);
  if (ssidBytes === 0) {
    throw new CredentialValidationError('WiFi network name is empty.');
  }
  if (ssidBytes > SSID_MAX_BYTES) {
    throw new CredentialValidationError(
      `WiFi network name is ${ssidBytes} bytes; the 802.11 limit is ${SSID_MAX_BYTES}.`,
    );
  }
  if (pwBytes < PASSWORD_MIN_BYTES) {
    throw new CredentialValidationError(
      `WiFi password must be at least ${PASSWORD_MIN_BYTES} characters (WPA2 minimum).`,
    );
  }
  if (pwBytes > PASSWORD_MAX_BYTES) {
    throw new CredentialValidationError(
      `WiFi password is ${pwBytes} bytes; the WPA2 maximum is ${PASSWORD_MAX_BYTES}.`,
    );
  }
}

export interface EspConfig {
  moduleName: string;
  ssid: string;
  password: string;
  initBase: string;
  initEndpoint: string;
  uploadBase: string;
  uploadEndpoint: string;
}

/**
 * Send configuration directly to the ESP module over its AP.
 *
 * Protocol (from ESP32-CAM/host.cpp):
 *  1. GET /          → HTML form with hidden session token + esp_id
 *  2. POST /save     → form-encoded config including session token
 *
 * After a successful save the ESP reboots, dropping the connection.
 *
 * Returns the module's canonical id parsed out of the form HTML so the
 * setup wizard can wait for that specific module to come online — the
 * id is needed because reflashed modules keep the same MAC and would
 * otherwise be indistinguishable from their stale "already known" entry.
 */
export async function sendConfigToEsp(config: EspConfig): Promise<{ moduleId: ModuleId }> {
  // Pre-flight: surface bad credentials BEFORE the round trip. The
  // firmware enforces the same bounds on the device side, but failing
  // here gives the user an immediate, actionable error instead of an
  // opaque "ESP never connected to your WiFi" two minutes later.
  validateCredentials(config.ssid, config.password);

  // --- Step 1: Fetch the form page to extract the session token ---
  let sessionToken = '';

  console.log('[espConfig] Fetching form page from', ESP_BASE);
  const formResp = await fetchWithTimeout(`${ESP_BASE}/`, TIMEOUT_MS);
  if (!formResp.ok) {
    throw new Error('Could not reach the module. Is it powered on?');
  }

  const html = await formResp.text();
  console.log('[espConfig] Got form HTML, length:', html.length);
  const match =
    html.match(/name=["']session["']\s+value=["']([^"']+)["']/i) ||
    html.match(/name=session\s+value=["']?([^"'\s>]+)/i);
  if (match) {
    sessionToken = match[1];
    console.log('[espConfig] Extracted session token:', sessionToken);
  } else {
    console.warn('[espConfig] No session token found in form HTML');
  }

  // The firmware now emits a hidden `esp_id` input alongside `session`.
  // We need it to disambiguate a freshly reflashed module from its stale
  // "already known" entry in the module list — the wizard polls for this
  // specific id to come online, so a missing/invalid id is a hard error.
  const idMatch =
    html.match(/name=["']esp_id["']\s+value=["']([^"']+)["']/i) ||
    html.match(/name=esp_id\s+value=["']?([^"'\s>]+)/i);
  if (!idMatch) {
    throw new Error(
      'The module did not advertise a valid id (esp_id). Re-flash the firmware and retry.',
    );
  }
  let moduleId: ModuleId;
  try {
    moduleId = parseModuleId(idMatch[1]);
  } catch {
    throw new Error(
      'The module did not advertise a valid id (esp_id). Re-flash the firmware and retry.',
    );
  }
  console.log('[espConfig] Extracted module id:', moduleId);

  // --- Step 2: POST config to /save ---
  const params = new URLSearchParams({
    session: sessionToken,
    module_name: config.moduleName,
    ssid: config.ssid,
    password: config.password,
    init_base: config.initBase,
    init_endpoint: config.initEndpoint,
    upload_base: config.uploadBase,
    upload_endpoint: config.uploadEndpoint,
    // Sensible defaults for settings the user shouldn't see
    interval: '300',
    res: 'vga',
    vflip: '0',
    bright: '0',
    sat: '0',
  });

  // Byte-count diagnostics — never log the credential values themselves.
  // Mismatches between the four points (here, on-wire, post-decode,
  // post-load-from-SPIFFS) tell us which segment dropped bytes.
  console.log('[espConfig] body bytes:', params.toString().length, {
    ssidLen: utf8ByteLength(config.ssid),
    pwLen: utf8ByteLength(config.password),
  });

  console.log('[espConfig] POSTing config to', `${ESP_BASE}/save`);
  let saveResp: Response;
  try {
    saveResp = await fetchWithTimeout(`${ESP_BASE}/save`, TIMEOUT_MS, {
      method: 'POST',
      body: params,
    });
  } catch (err) {
    // Network error or timeout — ESP likely rebooted mid-response (= success).
    // The device drops the AP socket once it accepts the config.
    console.warn('[espConfig] POST failed/timed out (may mean ESP rebooted):', err);
    return { moduleId };
  }

  console.log('[espConfig] POST response status:', saveResp.status);
  if (!saveResp.ok) {
    throw new Error(
      `The module rejected the configuration (HTTP ${saveResp.status}). ` +
        `Re-check the WiFi credentials and try again.`,
    );
  }

  const text = await saveResp.text();
  console.log('[espConfig] POST response body length:', text.length);
  if (!text.toLowerCase().includes('saved')) {
    // The ESP responded but did NOT confirm save. Previously this code
    // assumed success — that's exactly how silent credential-handover
    // failures slip through. Surface it instead.
    throw new Error(
      "The module returned a response but didn't confirm 'saved'. " +
        'The credentials may not have been persisted — please retry.',
    );
  }

  return { moduleId };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
