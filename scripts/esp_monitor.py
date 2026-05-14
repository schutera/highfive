"""Passive serial capture from an ESP32-CAM — no reset, no DTR/RTS poke.

`esp_capture.py` resets the chip via RTS before reading, which is great
for "I want to see the boot log right now". This one is the opposite:
attach without disturbing the running chip so you can observe what it's
doing across an existing OTA cycle (T2/T4 manual testing) without
restarting setup() and losing the state we want to inspect.

The captured bytes are streamed to disk continuously (`flush()` after
every chunk) so a Ctrl-C or an out-of-context-window process exit
still leaves a usable log file behind. The decoded text is also
printed to stdout at the end for inline inspection.

Usage:
    python scripts/esp_monitor.py [PORT] [DURATION_SECONDS] [OUTFILE]
    # default PORT=COM9, DURATION=120, OUTFILE=<TEMP>/esp_monitor.log

Note: opening the serial port can briefly toggle EN on some Windows
drivers regardless of `dsrdtr=False`. If you need a guaranteed
no-reset attach, use `pio device monitor` first (which has
`monitor_dtr = 0 / monitor_rts = 0` baked in via `platformio.ini`)
and only fall back to this when the interactive monitor flakes.
"""

import os
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM9"
duration = int(sys.argv[2]) if len(sys.argv) > 2 else 120

default_log_dir = os.environ.get("TEMP") or "/tmp"
outfile = (
    sys.argv[3]
    if len(sys.argv) > 3
    else os.path.join(default_log_dir, "esp_monitor.log")
)

buf = b""
with serial.Serial(port, 115200, timeout=0.2, rtscts=False, dsrdtr=False) as s:
    # Hold DTR/RTS deasserted so the chip stays in run mode.
    s.setDTR(False)
    s.setRTS(False)

    deadline = time.time() + duration
    with open(outfile, "wb") as f:
        while time.time() < deadline:
            x = s.read(1024)
            if x:
                buf += x
                f.write(x)
                f.flush()

# Same encoding trick as esp_capture.py — Windows' default cp1252
# console chokes on U+FFFD otherwise.
text = buf.decode("utf-8", errors="replace")
sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
sys.stdout.buffer.write(
    f"\n--- captured {len(buf)} bytes to {outfile} ---\n".encode("utf-8")
)
