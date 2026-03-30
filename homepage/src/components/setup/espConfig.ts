/**
 * In dev, the Vite proxy at /esp-api forwards to http://192.168.4.1,
 * bypassing CORS entirely. In production (static build), we hit the
 * ESP directly — requires CORS headers in firmware.
 */
const ESP_BASE = import.meta.env.DEV ? '/esp-api' : 'http://192.168.4.1';
const TIMEOUT_MS = 10000;
const BYPASS_SESSION = 'hivehive-setup';

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
 * On HTTPS pages, fetch() to http://192.168.4.1 is blocked by mixed-content
 * policy. We use a hidden form submission instead — form POSTs are top-level
 * navigations and not subject to mixed-content blocking.
 *
 * On HTTP / dev mode, the original fetch approach works fine.
 */
export async function sendConfigToEsp(config: EspConfig): Promise<void> {
  if (window.location.protocol === 'https:') {
    submitConfigViaForm(config);
    return;
  }

  // --- Dev / HTTP: use fetch (via Vite proxy in dev) ---
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

  const params = new URLSearchParams({
    session: sessionToken,
    module_name: config.moduleName,
    ssid: config.ssid,
    password: config.password,
    init_base: config.initBase,
    init_endpoint: config.initEndpoint,
    upload_base: config.uploadBase,
    upload_endpoint: config.uploadEndpoint,
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
    if (saveResp.ok) {
      const text = await saveResp.text();
      console.log('[espConfig] POST response body:', text);
      if (text.toLowerCase().includes('saved')) {
        return;
      }
    }
    console.warn('[espConfig] POST response unclear, assuming success');
  } catch (err) {
    console.warn('[espConfig] POST failed/timed out (may mean ESP rebooted):', err);
    return;
  }
}

/**
 * Submit config to the ESP via a hidden HTML form POST.
 * Form submissions are top-level navigations, not blocked by mixed-content.
 * Uses a bypass session token accepted by the ESP firmware.
 */
function submitConfigViaForm(config: EspConfig): void {
  const fields: Record<string, string> = {
    session: BYPASS_SESSION,
    module_name: config.moduleName,
    ssid: config.ssid,
    password: config.password,
    init_base: config.initBase,
    init_endpoint: config.initEndpoint,
    upload_base: config.uploadBase,
    upload_endpoint: config.uploadEndpoint,
    interval: '300',
    res: 'vga',
    vflip: '0',
    bright: '0',
    sat: '0',
  };

  // Open a small popup to receive the response (auto-closed after a few seconds).
  // If the popup is blocked, falls back to _blank (new tab).
  const popup = window.open('about:blank', 'esp-config', 'width=1,height=1');

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${ESP_BASE}/save`;
  form.target = popup ? 'esp-config' : '_blank';
  form.style.display = 'none';

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);

  // Auto-close the popup after the ESP has time to process
  if (popup) {
    setTimeout(() => {
      try { popup.close(); } catch { /* cross-origin or already closed */ }
    }, 5000);
  }

  console.log('[espConfig] Config submitted via form POST (HTTPS mode)');
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
