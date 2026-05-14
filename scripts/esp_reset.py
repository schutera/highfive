"""Reset an ESP32-CAM via the CH340's RTS line.

Toggles RTS low briefly to pull EN low, then releases. Equivalent to
pressing the physical RST button on the ESP32-CAM-MB but doesn't need
hands at the bench. Used to trigger a fresh boot during T2/T4 manual
testing without disturbing the rest of the dev stack. Compatible with
`platformio.ini`'s `monitor_rts = 0 / monitor_dtr = 0` setting.

Usage:
    python scripts/esp_reset.py [PORT] [--wait-for-monitor]
    # default PORT = COM9
    # --wait-for-monitor sleeps 2 s before opening the port, useful
    # when you just Ctrl-C'd `pio device monitor` and pyserial needs
    # a moment for the OS handle to clear.
"""

import sys
import time

import serial

args = [a for a in sys.argv[1:]]
wait_for_monitor = "--wait-for-monitor" in args
positional = [a for a in args if not a.startswith("--")]
port = positional[0] if positional else "COM9"

if wait_for_monitor:
    time.sleep(2)

with serial.Serial(port, 115200, timeout=0.1, rtscts=False, dsrdtr=False) as s:
    s.setDTR(False)
    s.setRTS(True)  # EN low — hold reset
    time.sleep(0.15)
    s.setRTS(False)  # release — chip runs

print(f"reset {port}")
