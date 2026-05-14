"""Reset an ESP32-CAM via the CH340's RTS line.

Toggles RTS low briefly to pull EN low, then releases. Equivalent to
pressing the physical RST button on the ESP32-CAM-MB but doesn't need
hands at the bench. Used to trigger a fresh boot during T2/T4 manual
testing without disturbing the rest of the dev stack. Compatible with
`platformio.ini`'s `monitor_rts = 0 / monitor_dtr = 0` setting.

Usage:
    python scripts/esp_reset.py [PORT]      # default PORT = COM9
"""

import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM9"

# Brief delay so a concurrent monitor process can release its port handle
# if the user called us right after Ctrl-C'ing pio device monitor.
time.sleep(2)

s = serial.Serial(port, 115200, timeout=0.1, rtscts=False, dsrdtr=False)
s.setDTR(False)
s.setRTS(True)  # EN low — hold reset
time.sleep(0.15)
s.setRTS(False)  # release — chip runs
s.close()

print(f"reset {port}")
