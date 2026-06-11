#pragma once

#include <cstdint>

// Pure, host-testable decision logic for the OTA two-slot rollback gate
// (issue #26, extended for #148 Phase 3). The firmware ships on Arduino-ESP32's
// prebuilt bootloader, which does NOT enable CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE,
// so rollback is driven application-side: this logic decides, from a few NVS-
// backed counters, whether the running slot should validate itself or revert to
// the previous (known-good) slot. See ADR-008 for the partition/rollback design
// and its load-bearing invariants.
//
// Following the firmware's established pattern (lib/loop_health, lib/ota_version):
// all state is a plain struct of integers/bools so this compiles and is exercised
// on the native test target with no Arduino/NVS/IDF dependency. The .ino + ota.cpp
// own the glue: reading/writing the "ota" Preferences namespace, classifying the
// reset reason, calling esp_ota_mark_app_valid_cancel_rollback() /
// esp_ota_mark_app_invalid_rollback_and_reboot().
//
// The #148 Phase 3 extension closes a gap in the original #26 design: marking the
// slot valid merely on surviving setup() let a fresh OTA image that boots clean
// but can never reach the server (broken TLS bundle, bad request shape, dead Wi-Fi
// join) validate itself and never roll back. Validation now requires a real server
// contact, and a fresh OTA that never makes one rolls back after a bounded number
// of attempts.
//
// SAFETY INVARIANT (the reason this is safe by construction): the no-contact
// rollback path is gated entirely on `unproven`, a flag set ONLY by the OTA writer
// just before it boots a freshly-flashed slot. A factory / USB-flashed / already-
// validated slot has unproven == false and is therefore IMMUNE to no-contact
// rollback — a multi-hour server or Wi-Fi outage can never roll back good firmware.

namespace hf {

// Rollback thresholds. The .ino mirrors these as HF_OTA_MAX_PENDING_BOOTS /
// HF_OTA_MAX_NOCONTACT_BOOTS and passes them in; these defaults are what the
// native tests pin. 3 no-contact boots, with the loop_health liveness watchdog
// rebooting a mute slot every ~2 h, is ~6–8 h of total radio silence before a
// fresh OTA reverts — long enough that a transient outage is unlikely to be the
// cause, short enough to self-heal a genuinely broken push within a workday.
constexpr uint32_t kOtaMaxFaultyBoots = 3;     // panic/WDT/brownout loop (#26)
constexpr uint32_t kOtaMaxNoContactBoots = 3;  // unproven slot never phones home (#148)

// Persistent rollback-gate state, mirrored in NVS namespace "ota":
//   unproven : true iff the running slot was placed by an OTA flash and has not
//              yet proven itself by making server contact. Set ONLY by the OTA
//              writer (ota.cpp); cleared on first contact or on rollback.
//   pvBoots  : consecutive faulty-reset boots since last validation (#26).
//   ncBoots  : consecutive unproven boots that did not validate (#148).
struct OtaGateState {
  bool unproven = false;
  uint32_t pvBoots = 0;
  uint32_t ncBoots = 0;
};

enum class OtaGateAction {
  Continue,  // proceed with setup()
  Rollback,  // caller: persist resetForRollback(), then revert the slot
};

// Called once at setup() start, after the caller has read `s` from NVS and
// classified whether the PREVIOUS run ended in a faulty reset (panic/WDT/
// brownout — NOT a clean ESP_RST_SW; see ADR-008 invariant #1). Mutates `s`
// (the caller persists it) and returns whether to roll back NOW.
//
//  - A faulty reset increments pvBoots (unchanged #26 behaviour).
//  - An unproven slot counts this boot as one more unvalidated attempt
//    (increments ncBoots) — validation, if it happens later this boot, clears
//    it via otaOnFirstContact().
//  - Rolls back if EITHER counter has reached its threshold. The threshold is
//    checked BEFORE this boot's no-contact increment, so an unproven slot gets
//    `maxNoContact` full boots to make contact before the (maxNoContact+1)th
//    boot reverts it.
OtaGateAction otaBootGate(OtaGateState& s, bool faultyReset,
                          uint32_t maxFaulty = kOtaMaxFaultyBoots,
                          uint32_t maxNoContact = kOtaMaxNoContactBoots);

// Called on the first successful server contact of the boot (2xx heartbeat or
// upload). Idempotent: mutates only while unproven. Returns true exactly once
// per fresh OTA — when the caller should PERSIST the cleared state (unproven
// false, counters zeroed). It does NOT mean "mark the app valid now": the IDF
// esp_ota_mark_app_valid_cancel_rollback() call is permanent and must stay at
// end-of-setup(), after the stages that can panic — see the .ino and ADR-008
// invariant #1. Clearing `unproven` here merely lets that later block proceed
// (and satisfies the no-contact rollback gate). Returns false for an already-
// proven/factory slot (nothing to do).
bool otaOnFirstContact(OtaGateState& s);

// Called at end of a clean setup(). A proven/factory slot (unproven == false)
// resets its faulty-boot counter — the existing "I survived setup" crash-loop
// guard — and the caller marks the app valid (idempotent for a VALID slot). An
// unproven slot does NOT reset here: surviving setup is no longer proof of
// health, so its counters stand until it phones home. Returns true iff the
// caller should mark the app valid + zero pvBoots.
bool otaOnSetupComplete(OtaGateState& s);

// Reset state to persist immediately before esp_ota_mark_app_invalid_rollback_
// and_reboot(): the slot we revert TO was previously the running good slot, so
// it boots proven with clean counters (prevents the rolled-back slot from
// immediately re-counting toward another rollback during a prolonged outage).
void otaResetForRollback(OtaGateState& s);

}  // namespace hf
