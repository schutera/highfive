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
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).rejects.toThrow(
      /Firmware not found at \/firmware\.bin/,
    );
  });

  it('rejects an HTML response even when content-type uses charset suffix', async () => {
    const resp = html('<!doctype html>', { 'content-type': 'text/html; charset=utf-8' });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).rejects.toThrow(/not found.*HTML/);
  });

  it('rejects a non-0xE9 first byte even with octet-stream content-type', async () => {
    // The defence-in-depth case: a static server that serves the SPA
    // fallback as application/octet-stream would slip past the
    // content-type check; magic-byte check catches it.
    const resp = bin([0x3c, 0x21, 0x64, 0x6f], { 'content-type': 'application/octet-stream' });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).rejects.toThrow(
      /not a valid ESP32 image.*0x3C.*expected 0xE9/,
    );
  });

  it('rejects an empty body', async () => {
    const resp = bin([], { 'content-type': 'application/octet-stream' });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).rejects.toThrow(/empty/);
  });

  it('accepts a binary starting with the ESP32 image magic byte', async () => {
    const resp = bin([ESP_IMAGE_MAGIC, 0x00, 0x10, 0x20], {
      'content-type': 'application/octet-stream',
    });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).resolves.toBeUndefined();
  });

  it('accepts the magic byte even when content-type is missing', async () => {
    // arduino-cli's merged.bin served by Vite's static handler doesn't
    // always carry an explicit content-type. The magic byte is the
    // authoritative check.
    const resp = bin([ESP_IMAGE_MAGIC, 0x01]);
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).resolves.toBeUndefined();
  });

  it('leaves the original Response body readable after validation (pins resp.clone() invariant)', async () => {
    // Pins the production sequence at flashEsp.ts's flashEsp():
    //   await assertFirmwareResponse(firmwareResp, part.path);
    //   const blob = await firmwareResp.blob();
    // A future refactor that drops `resp.clone()` from the validator
    // would still pass the 6 cases above (they discard the response)
    // but would break this round-trip because Response bodies can only
    // be consumed once. Issue #100.
    const resp = bin([ESP_IMAGE_MAGIC, 0x00, 0x10, 0x20], {
      'content-type': 'application/octet-stream',
    });
    await assertFirmwareResponse(resp, '/firmware.bin');
    const blob = await resp.blob();
    expect(blob.size).toBe(4);
  });

  it('accepts the esptool merge_bin layout (0xFF pad at byte 0, 0xE9 bootloader at 0x1000)', async () => {
    // Production wire shape: build.sh's `esptool merge_bin` invocation
    // places the bootloader at 0x1000 and pads bytes [0, 0x1000) with
    // 0xFF (flash-erase pattern). The pre-#107 validator rejected this
    // because it only inspected byte 0; the new validator reaches the
    // bootloader byte and accepts. Issue #107.
    const bytes = new Uint8Array(0x1001).fill(0xff);
    bytes[0x1000] = ESP_IMAGE_MAGIC;
    const resp = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).resolves.toBeUndefined();
  });

  it('rejects a merge_bin-shaped body truncated before the bootloader offset', async () => {
    // A short body whose byte 0 looks like the merge_bin pad (0xFF) but
    // doesn't reach offset 0x1000 must be rejected — otherwise the
    // bootloader byte read would index past the buffer.
    const bytes = new Uint8Array(0x800).fill(0xff);
    const resp = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).rejects.toThrow(
      /truncated.*2048 bytes/,
    );
  });

  it('rejects 0xFF pad with wrong bootloader magic at 0x1000', async () => {
    // A mis-merged blob (e.g., partition-table magic 0xAA where the
    // bootloader should be) is the realistic failure mode if merge_bin's
    // offset args got reordered. The validator catches it.
    const bytes = new Uint8Array(0x1001).fill(0xff);
    bytes[0x1000] = 0xaa;
    const resp = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    await expect(assertFirmwareResponse(resp, '/firmware.bin')).rejects.toThrow(
      /byte 0x1000 is 0xAA.*expected 0xE9/,
    );
  });
});
