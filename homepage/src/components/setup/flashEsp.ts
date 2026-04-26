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

/** Convert a Blob to a binary string (each char = one byte). */
function blobToBinaryString(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsBinaryString(blob);
  });
}
