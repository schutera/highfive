#pragma once

#include "esp_init.h"

namespace hf {

// Boot-time HTTP OTA check (#26 phase 2).
//
// Fetches `<homepage host>:80/firmware.json`, compares the manifest's
// `version` to compiled-in FIRMWARE_VERSION, and if they differ
// downloads `<homepage host>:80/firmware.app.bin`, verifies the MD5,
// flashes the inactive OTA slot, and calls ESP.restart() so the new
// slot boots. On any failure path (network, parse, hash mismatch,
// flash write) the function logs via logf() and returns without
// restarting; the caller's setup() continues on the current slot.
//
// Host derived from `config->INIT_URL` (the captive-portal-saved
// backend URL — in production the host-nginx fronts homepage and
// backend on the same hostname, port 80, so this works without a
// second config field). Manifest fetch uses a 10 s read timeout; the
// app binary fetch uses a 15 s per-read timeout and a 120 s wall-clock
// deadline (kOtaBinaryDeadlineMs), with the task watchdog fed every
// 4 KB during the body read.
//
// Safe to call once WiFi is connected and esp_config has been loaded.
// On a non-OTA-capable boot (default partition table), Update.begin()
// fails fast — the function then logs and returns; setup() proceeds.
void httpOtaCheckAndApply(const esp_config_t* config);

}  // namespace hf
