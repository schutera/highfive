import { describe, it, expect } from 'vitest';
import { assertFirmwareResponse, ESP_IMAGE_MAGIC } from '../components/setup/flashEsp';

// Issue #43: when /firmware.bin is missing, Vite's SPA fallback returns
// index.html with HTTP 200 + content-type: text/html. flashEsp used to read
// that as binary string and hand it to esptool-js, which silently no-op'd.
// The wizard then "succeeded" in <1s while the chip kept its old firmware.
//
// These tests pin the validator that now stands between the fetch and
// writeFlash. Only the helper is exercised — Web Serial / ESPLoader are
// not mockable from jsdom and aren't the layer at risk here.

describe('assertFirmwareResponse', () => {
  function html(body: string, headers: Record<string, string> = { 'content-type': 'text/html' }) {
    return new Response(body, { status: 200, headers });
  }

  function bin(bytes: number[], headers: Record<string, string> = {}) {
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  }

  it('rejects an HTML response (Vite SPA fallback)', async () => {
    const resp = html('<!doctype html><html><body>vite</body></html>');
    const blob = await resp.clone().blob();
    await expect(assertFirmwareResponse(resp, blob, '/firmware.bin')).rejects.toThrow(
      /Firmware not found at \/firmware\.bin/,
    );
  });

  it('rejects an HTML response even when content-type uses charset suffix', async () => {
    const resp = html('<!doctype html>', { 'content-type': 'text/html; charset=utf-8' });
    const blob = await resp.clone().blob();
    await expect(assertFirmwareResponse(resp, blob, '/firmware.bin')).rejects.toThrow(
      /not found.*HTML/,
    );
  });

  it('rejects a non-0xE9 first byte even with octet-stream content-type', async () => {
    // The defence-in-depth case: a static server that serves the SPA
    // fallback as application/octet-stream would slip past the
    // content-type check; magic-byte check catches it.
    const resp = bin([0x3c, 0x21, 0x64, 0x6f], { 'content-type': 'application/octet-stream' });
    const blob = await resp.clone().blob();
    await expect(assertFirmwareResponse(resp, blob, '/firmware.bin')).rejects.toThrow(
      /not a valid ESP32 image.*0x3C.*expected 0xE9/,
    );
  });

  it('rejects an empty body', async () => {
    const resp = bin([], { 'content-type': 'application/octet-stream' });
    const blob = await resp.clone().blob();
    await expect(assertFirmwareResponse(resp, blob, '/firmware.bin')).rejects.toThrow(/empty/);
  });

  it('accepts a binary starting with the ESP32 image magic byte', async () => {
    const resp = bin([ESP_IMAGE_MAGIC, 0x00, 0x10, 0x20], {
      'content-type': 'application/octet-stream',
    });
    const blob = await resp.clone().blob();
    await expect(assertFirmwareResponse(resp, blob, '/firmware.bin')).resolves.toBeUndefined();
  });

  it('accepts the magic byte even when content-type is missing', async () => {
    // arduino-cli's merged.bin served by Vite's static handler doesn't
    // always carry an explicit content-type. The magic byte is the
    // authoritative check.
    const resp = bin([ESP_IMAGE_MAGIC, 0x01]);
    const blob = await resp.clone().blob();
    await expect(assertFirmwareResponse(resp, blob, '/firmware.bin')).resolves.toBeUndefined();
  });
});
