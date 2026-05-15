# Dev helper scripts

Small pyserial / shell utilities that helped exercise the manual OTA
tests in [docs/10-quality-requirements/manual-tests-ota.md](../docs/10-quality-requirements/manual-tests-ota.md).
Live here so the next person doesn't have to re-derive them from
chat history.

| Script                                                             | Purpose                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`esp_reset.py`](esp_reset.py)                                     | Toggle the CH340's RTS line to reset the ESP32-CAM. Equivalent to pressing the physical RST button, useful when the board is wedged on a desk under a soldering iron and triggering T2 / T4 from PowerShell is easier than reaching for it.                                                                    |
| [`esp_capture.py`](esp_capture.py)                                 | Reset the chip AND capture N seconds of serial in one process. Avoids the COM-port contention you hit when two pyserial processes share a single handle, and writes the same content to `<TEMP>/esp_log.txt` for offline inspection. Use this when `pio device monitor` flakes (e.g. shows `ets J` and stops). |
| [`esp_monitor.py`](esp_monitor.py)                                 | Passive serial capture, no reset. Use when you want to observe an existing OTA cycle without disturbing setup() state. Streams to disk continuously so a Ctrl-C still leaves a usable log.                                                                                                                     |
| [`check-doc-citations.sh`](check-doc-citations.sh)                 | Pre-push hook (also invoked by `make check-citations`) that flags `path:line` references in `docs/` whose target line has drifted past EOF or onto blank lines.                                                                                                                                                |
| [`check-no-hardcoded-api-keys.sh`](check-no-hardcoded-api-keys.sh) | Pre-push grep for accidental Google Geolocation API key literals in code or docs.                                                                                                                                                                                                                              |
| [`check-stale-reset-prose.sh`](check-stale-reset-prose.sh)         | Pre-push grep that catches the "hold IO0 for 5 seconds" factory-reset prose, which was removed in #40 because GPIO0 is a strap pin.                                                                                                                                                                            |

## Python prerequisites

The three ESP helpers need `pyserial`:

```powershell
python -m pip install pyserial
```

That's it — they don't depend on the rest of the dev stack.

## Invocation — positional args, never flags

All three ESP helpers take **positional arguments**, never named flags. A
`--port`/`--seconds` invocation silently fails with a Python `ValueError`
because the value following `--port` is fed to `int(sys.argv[2])` and the
script's argparse-free design accepts no `--` prefixes.

```powershell
# RIGHT — positional
python scripts\esp_reset.py   COM9
python scripts\esp_capture.py COM9 60     # 60 s capture (default: 25 s)
python scripts\esp_monitor.py COM9 300    # 300 s monitor (default: 120 s)

# WRONG — named flags fail with: invalid literal for int() with base 10: 'COM9'
python scripts\esp_capture.py --port COM9 --seconds 60
```

`esp_capture.py` also always writes a copy of the log to
`%TEMP%\esp_log.txt` regardless of the calling shell's redirect, so a
follow-up `Get-Content $env:TEMP\esp_log.txt -Tail 60` works even if a
PowerShell tee-redirect chain got mangled.

## Wiring expectations

All three scripts assume the **AI Thinker ESP32-CAM-MB** (the
mother-board variant with built-in CH340 USB-serial — no FTDI cable
needed). On the bare ESP32-CAM with an external FTDI adapter the
DTR/RTS auto-reset wiring is different and `esp_reset.py` may not
work; press the physical button.

The default port is `COM9` — change it as needed. Run
`Get-PnpDevice -Class Ports -Status OK` (PowerShell) or
`ls /dev/ttyUSB*` (Linux) to find yours.
