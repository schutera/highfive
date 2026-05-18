import { ESPLoader, Transport } from 'esptool-js';

export type FlashState = 'connecting' | 'preparing' | 'erasing' | 'writing' | 'finished' | 'error';

export interface FlashProgress {
  state: FlashState;
  /** 0–100 percentage, only set during 'writing' */
  percent?: number;
  error?: string;
}

interface ManifestPart {
  path: string;
  offset: number;
}

interface ManifestBuild {
  chipFamily: string;
  parts: ManifestPart[];
}

export interface Manifest {
  name: string;
  version: string;
  builds: ManifestBuild[];
}

/**
 * Flash firmware to an ESP32 using Web Serial + esptool-js.
 * The only browser UI that appears is the native serial port picker.
 *
 * @param manifest    Manifest object describing the firmware build(s).
 *                    Part `path` values are fetched as URLs (absolute or
 *                    relative to the document). Build the object in-app and
 *                    pass Vite-imported asset URLs so the firmware binary
 *                    gets a content hash for cache busting.
 * @param onProgress  Callback receiving state updates for inline UI
 */
export async function flashEsp(
  manifest: Manifest,
  onProgress: (progress: FlashProgress) => void,
): Promise<void> {
  let transport: Transport | null = null;

  try {
    // --- 1. Request serial port (native browser picker — unavoidable) ---
    const serial = (navigator as unknown as { serial?: { requestPort: () => Promise<SerialPort> } })
      .serial;
    if (!serial) {
      throw new Error('Web Serial API not supported. Use Chrome or Edge.');
    }
    const port = await serial.requestPort();

    onProgress({ state: 'connecting' });

    // --- 2. Open transport & connect ESPLoader ---
    transport = new Transport(port);
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      romBaudrate: 115200,
      terminal: {
        clean: () => {},
        write: () => {},
        writeLine: () => {},
      },
    });

    await loader.main();
    await loader.flashId();

    onProgress({ state: 'preparing' });

    // --- 3. Fetch firmware binary (manifest is supplied directly) ---
    const build = manifest.builds[0];
    if (!build || build.parts.length === 0) {
      throw new Error('No firmware builds found in manifest');
    }

    const fileArray: { data: string; address: number }[] = [];

    for (const part of build.parts) {
      const firmwareResp = await fetch(part.path);
      if (!firmwareResp.ok) throw new Error(`Failed to fetch firmware: ${part.path}`);
      await assertFirmwareResponse(firmwareResp, part.path);
      const blob = await firmwareResp.blob();
      const data = await blobToBinaryString(blob);
      fileArray.push({ data, address: part.offset });
    }

    onProgress({ state: 'erasing' });

    // --- 4. Flash firmware with progress callback ---
    await loader.writeFlash({
      fileArray,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        const percent = Math.round((written / total) * 100);
        onProgress({ state: 'writing', percent });
      },
    });

    // --- 5. Hard-reset the ESP so it boots into the new firmware ---
    try {
      await loader.after('hard_reset');
    } catch {
      // Some boards don't support auto-reset — that's okay
    }

    // Release the serial port so the ESP can fully reboot
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        /* ignore */
      }
      transport = null;
    }

    // Close the port entirely to free the USB interface
    try {
      await port.close();
    } catch {
      /* ignore */
    }

    onProgress({ state: 'finished' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // User cancelling the port picker is not an error to show
    if (message.includes('No port selected') || message.includes('user cancelled')) {
      onProgress({ state: 'connecting', percent: undefined, error: undefined });
      return;
    }
    onProgress({ state: 'error', error: message });
  } finally {
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * ESP32 application image header magic byte (esp_image_format.h
 * `ESP_IMAGE_HEADER_MAGIC`). The bootloader and every app slot
 * begin with 0xE9. Partition tables have a different magic
 * (0xAA 0x50 — `ESP_PARTITION_MAGIC`).
 *
 * Important: the merged single-blob produced by `esptool merge_bin`
 * does NOT begin with 0xE9. Its first 0x1000 bytes are 0xFF —
 * flash-erase padding placed before the bootloader, which lives at
 * 0x1000 in the merged layout. `assertFirmwareResponse` therefore
 * accepts two byte-0 patterns; see issue #107 and chapter 11
 * "Lessons learned" for the wire-shape evidence.
 */
export const ESP_IMAGE_MAGIC = 0xe9;

/**
 * Reject a /firmware.bin response that obviously isn't firmware before we
 * hand its bytes to esptool-js.
 *
 * Two checks, layered:
 *
 * 1. **Content-Type** — Vite's SPA dev fallback returns `index.html` with
 *    HTTP 200 + `text/html` when the requested path doesn't exist. Without
 *    this check the wizard would treat the HTML payload as firmware,
 *    `esptool-js`'s `writeFlash` would silently no-op on garbage bytes,
 *    `hard_reset` would boot the chip into its previous firmware, and
 *    Step 2 would flash green ("Firmware installiert!") in <1 s.
 *
 * 2. **Magic byte** — defence in depth. Catches misconfigured static
 *    servers that send `application/octet-stream` for the SPA fallback,
 *    and corrupt/truncated downloads.
 *
 * See issue #43.
 */
export async function assertFirmwareResponse(resp: Response, path: string): Promise<void> {
  const ctype = resp.headers.get('content-type') || '';
  if (/text\/html/i.test(ctype)) {
    throw new Error(
      `Firmware not found at ${path} (server returned HTML). Run "make firmware" (or ESP32-CAM/build.sh) before opening the setup wizard.`,
    );
  }

  // resp.clone() is required because the caller consumes the original body
  // via firmwareResp.blob() right after this returns. We read via Response
  // (not Blob) because jsdom 25's Blob prototype is missing arrayBuffer()
  // entirely — vitest's jsdom env then shadows globalThis.Blob, so any
  // blob.slice().arrayBuffer() or blob.arrayBuffer() path throws TypeError
  // under tests (issue #100). Native Response.arrayBuffer() is unaffected.
  const buf = await resp.clone().arrayBuffer();
  if (buf.byteLength === 0) {
    throw new Error(`Firmware at ${path} is empty.`);
  }

  const bytes = new Uint8Array(buf);
  const head = bytes[0];

  // Two valid layouts (see issue #107 and chapter 11 "Lessons learned"):
  //   1. byte 0 == 0xE9 — a raw ESP image (app-only, or a future manifest
  //      that points at the bootloader offset directly).
  //   2. byte 0 == 0xFF AND byte 0x1000 == 0xE9 — an esptool merge_bin
  //      output. The bytes [0, 0x1000) are flash-erase padding placed
  //      BEFORE the bootloader. This is what build.sh produces today and
  //      what the wizard's in-app manifest fetches at offset 0.
  if (head === ESP_IMAGE_MAGIC) {
    return;
  }
  if (head === 0xff) {
    if (bytes.length <= 0x1000) {
      throw new Error(
        `Firmware at ${path} looks like an esptool merge_bin output but is truncated (${bytes.length} bytes, need at least 4097 to reach the bootloader at 0x1000). Rebuild with "make firmware".`,
      );
    }
    if (bytes[0x1000] === ESP_IMAGE_MAGIC) {
      return;
    }
    const bootHex = bytes[0x1000].toString(16).padStart(2, '0').toUpperCase();
    throw new Error(
      `Firmware at ${path} starts with the merge_bin pad (0xFF) but byte 0x1000 is 0x${bootHex} (expected 0xE9 for the ESP32 bootloader). Rebuild with "make firmware".`,
    );
  }
  const hex = head.toString(16).padStart(2, '0').toUpperCase();
  throw new Error(
    `Firmware at ${path} is not a valid ESP32 image (first byte 0x${hex}, expected 0xE9 for a raw image or 0xFF for an esptool merge_bin output with bootloader at 0x1000). Rebuild with "make firmware".`,
  );
}

/** Convert a Blob to a binary string (each char = one byte). */
function blobToBinaryString(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsBinaryString(blob);
  });
}
