#ifndef SERIAL_CONSOLE_H
#define SERIAL_CONSOLE_H

#include "esp_init.h"  // esp_config_t

// Developer USB-serial console (issue #156). A developer-only side channel for
// retargeting a flashed module's server URLs without a rebuild/reflash, and for
// reopening the captive portal without erasing Wi-Fi. The captive portal itself
// stays Wi-Fi-only (ADR-018); this is out-of-band over the USB cable a
// developer already has attached.
//
// Commands (one per line):
//   set-server <host>            compose dev URLs from a bare host/IP
//                                (http://<host>:8002/new_module + :8000/upload)
//   set-server <init> <upload>   set both URLs verbatim (https, custom ports)
//   clear-server                 drop the override; baked defaults resume
//   reopen-portal                reopen Wi-Fi setup AP WITHOUT erasing creds
//   show-config                  print SSID + on-disk/in-RAM URLs + fw version
//   help                         list the commands

// Drain pending serial bytes and dispatch any complete command lines.
// Non-blocking: it only consumes bytes already buffered, so it is safe to call
// from setup() windows and loop() without starving the task watchdog.
//
// `cfg` may be null (e.g. during the captive-portal AP loop, before a config
// struct exists); the config path then defaults to "/config.json".
//
// When `inBootWindow` is true a successful set-server/clear-server re-runs
// loadConfig(cfg) so the override takes effect on THIS boot, before
// registration. In loop() (false) the override lands on the next reboot.
//
// Returns true if at least one command line was handled.
bool serialConsolePoll(esp_config_t* cfg, bool inBootWindow);

// Print the one-line availability hint (called once at boot).
void serialConsolePrintHint();

#endif  // SERIAL_CONSOLE_H
