/**
 * In dev, the Vite proxy at /esp-api forwards to http://192.168.4.1,
 * bypassing CORS entirely. In production (static build), we hit the
 * ESP directly — requires CORS headers in firmware.
 */
const ESP_BASE = import.meta.env.DEV ? '/esp-api' : 'http://192.168.4.1';
const TIMEOUT_MS = 10000;

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
 *  1. GET /          → HTML form with hidden session token
 *  2. POST /save     → form-encoded config including session token
 *
 * After a successful save the ESP reboots, dropping the connection.
 */
export async function sendConfigToEsp(config: EspConfig): Promise<void> {
  // --- Step 1: Fetch the form page to extract the session token ---
  let sessionToken = '';

  console.log('[espConfig] Fetching form page from', ESP_BASE);
  const formResp = await fetchWithTimeout(`${ESP_BASE}/`, TIMEOUT_MS);
  if (!formResp.ok) {
    throw new Error('Could not reach the module. Is it powered on?');
  }

  const html = await formResp.text();
  console.log('[espConfig] Got form HTML, length:', html.length);
  const match = html.match(/name=["']session["']\s+value=["']([^"']+)["']/i)
    || html.match(/name=session\s+value=["']?([^"'\s>]+)/i);
  if (match) {
    sessionToken = match[1];
    console.log('[espConfig] Extracted session token:', sessionToken);
  } else {
    console.warn('[espConfig] No session token found in form HTML');
  }

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

  console.log('[espConfig] POSTing config to', `${ESP_BASE}/save`);
  try {
    const saveResp = await fetchWithTimeout(`${ESP_BASE}/save`, TIMEOUT_MS, {
      method: 'POST',
      body: params,
    });
    console.log('[espConfig] POST response status:', saveResp.status);
    // If readable and contains "saved" → definite success
    if (saveResp.ok) {
      const text = await saveResp.text();
      console.log('[espConfig] POST response body:', text);
      if (text.toLowerCase().includes('saved')) {
        return; // confirmed success
      }
    }
    // Got a response but unclear — ESP may still be processing
    console.warn('[espConfig] POST response unclear, assuming success');
  } catch (err) {
    // Network error or timeout — ESP likely rebooted mid-response (= success)
    console.warn('[espConfig] POST failed/timed out (may mean ESP rebooted):', err);
    return;
  }
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
