"""Reset an ESP32-CAM and capture its serial output for N seconds.

Combines `esp_reset.py` and a one-shot serial reader into one process,
which avoids the Windows COM-port contention you hit when two pyserial
processes try to share a single handle. The interactive
`pio device monitor` doesn't help here because:

* `[STAGE]` lines + the bootloader's ROM header race past faster than
  the interactive monitor can render them (the user observed "ets J"
  + a replacement char and nothing else on the ESP32-CAM-MB);
* on Windows, opening the port via the interactive monitor sometimes
  pulses DTR/RTS and resets the chip just as you're trying to capture
  the boot log of a *different* event.

Reading raw bytes into a fixed-size buffer here sidesteps both. The
log gets written to `<TEMP>/esp_log.txt` (uses `%TEMP%` or `/tmp`) so
it's reachable without poking inside the project; the same content
is also printed to stdout (UTF-8 with replacement chars where the
ROM bootloader emits non-UTF-8 framing bytes).

Usage:
    python scripts/esp_capture.py [PORT] [DURATION_SECONDS]
    # default PORT=COM9, DURATION=25
"""

import os
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM9"
duration = int(sys.argv[2]) if len(sys.argv) > 2 else 25

log_dir = os.environ.get("TEMP") or "/tmp"
log_path = os.path.join(log_dir, "esp_log.txt")

s = serial.Serial(port, 115200, timeout=0.2, rtscts=False, dsrdtr=False)
# Reset via RTS toggle. Same sequence as scripts/esp_reset.py.
# `monitor_rts = 0` in `platformio.ini` means `setRTS(False)` = run.
s.setDTR(False)
s.setRTS(True)  # EN low — reset
time.sleep(0.1)
s.setRTS(False)  # EN released — boot

print(f"--- capturing {duration}s of serial from {port} after reset ---", flush=True)
deadline = time.time() + duration
buf = b""
while time.time() < deadline:
    x = s.read(1024)
    if x:
        buf += x
s.close()

with open(log_path, "wb") as f:
    f.write(buf)

# Print decoded form. Use surrogateescape to avoid a UnicodeEncodeError
# on Windows' default cp1252 console when the buffer contains bytes that
# decode to replacement characters U+FFFD.
text = buf.decode("utf-8", errors="replace")
sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
sys.stdout.buffer.write(
    f"\n--- captured {len(buf)} bytes (also saved to {log_path}) ---\n".encode("utf-8")
)
