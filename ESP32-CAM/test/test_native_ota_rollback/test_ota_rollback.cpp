// Native (host) unit tests for the OTA rollback gate state machine
// (lib/ota_rollback) — issue #26, extended for #148 Phase 3.
//
// State is injected as a plain struct, so these run on the native target with
// no Arduino/NVS/IDF dependency. They pin the behaviours that brick or strand a
// field module if they regress: a fresh OTA validates on contact; a mute fresh
// OTA reverts at the threshold; a panic-loop reverts via the faulty counter;
// and — the safety invariant — a proven/factory slot is NEVER reverted by the
// no-contact path no matter how long it goes silent.

#include <unity.h>

#include "ota_rollback.h"

using hf::OtaGateAction;
using hf::OtaGateState;
using hf::kOtaMaxFaultyBoots;
using hf::kOtaMaxNoContactBoots;
using hf::otaBootGate;
using hf::otaOnFirstContact;
using hf::otaOnSetupComplete;
using hf::otaResetForRollback;

void setUp() {}
void tearDown() {}

// Helper: simulate one boot of the gate. Returns the action; mutates state as
// the .ino would persist it.
static OtaGateAction boot(OtaGateState& s, bool faulty) {
  return otaBootGate(s, faulty);
}

// ---- Faulty-reset (panic/WDT) loop — original #26 behaviour ----------------

static void test_clean_boot_no_rollback(void) {
  OtaGateState s;  // factory: proven, counters 0
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, /*faulty=*/false));
  TEST_ASSERT_EQUAL_UINT32(0, s.pvBoots);
  TEST_ASSERT_EQUAL_UINT32(0, s.ncBoots);
}

static void test_faulty_loop_rolls_back_at_threshold(void) {
  OtaGateState s;
  // Three consecutive faulty resets → rollback on the third.
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, true));   // pv=1
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, true));   // pv=2
  TEST_ASSERT_EQUAL(OtaGateAction::Rollback, boot(s, true));   // pv=3 → revert
}

static void test_faulty_count_survives_proven_slot_only_via_setup(void) {
  // A proven slot's transient panic must NOT accumulate to a false rollback:
  // each clean setup completion resets pvBoots (otaOnSetupComplete).
  OtaGateState s;  // proven
  boot(s, true);                       // pv=1 after a one-off panic
  TEST_ASSERT_TRUE(otaOnSetupComplete(s));
  TEST_ASSERT_EQUAL_UINT32(0, s.pvBoots);   // crash-loop guard cleared
  boot(s, true);                       // pv=1 again, not 2
  TEST_ASSERT_EQUAL_UINT32(1, s.pvBoots);
}

// ---- #148 Phase 3: no-contact rollback for fresh OTA slots -----------------

static void test_fresh_ota_validates_on_first_contact(void) {
  OtaGateState s;
  s.unproven = true;  // set by ota.cpp before booting the new slot
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, false));  // nc=1
  // First heartbeat/upload 2xx lands this boot:
  TEST_ASSERT_TRUE(otaOnFirstContact(s));   // → caller marks app valid
  TEST_ASSERT_FALSE(s.unproven);
  TEST_ASSERT_EQUAL_UINT32(0, s.ncBoots);
  TEST_ASSERT_EQUAL_UINT32(0, s.pvBoots);
  // Idempotent: a second contact this boot is a no-op.
  TEST_ASSERT_FALSE(otaOnFirstContact(s));
}

static void test_mute_fresh_ota_rolls_back_after_threshold_boots(void) {
  // Boots clean every time but never makes contact (broken request shape, dead
  // upload URL, etc.). The liveness watchdog reboots it each cycle; nc_boots
  // accumulates until the gate reverts it. kOtaMaxNoContactBoots full attempts,
  // then revert on the next boot.
  OtaGateState s;
  s.unproven = true;
  for (uint32_t i = 0; i < kOtaMaxNoContactBoots; ++i) {
    TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, false));
    // No otaOnFirstContact() — mute — and otaOnSetupComplete must NOT validate:
    TEST_ASSERT_FALSE(otaOnSetupComplete(s));
    TEST_ASSERT_TRUE(s.unproven);
  }
  TEST_ASSERT_EQUAL_UINT32(kOtaMaxNoContactBoots, s.ncBoots);
  // The next boot reaches the threshold at boot-start → revert.
  TEST_ASSERT_EQUAL(OtaGateAction::Rollback, boot(s, false));
}

static void test_fresh_ota_validates_on_last_attempt_no_rollback(void) {
  // Edge: contact finally lands on the final allowed attempt — must NOT revert.
  OtaGateState s;
  s.unproven = true;
  for (uint32_t i = 0; i < kOtaMaxNoContactBoots; ++i) {
    TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, false));
  }
  // Contact on the last attempt:
  TEST_ASSERT_TRUE(otaOnFirstContact(s));
  // A subsequent boot is now a proven slot → never reverts via no-contact.
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, false));
}

static void test_validated_then_panic_loop_still_rolls_back(void) {
  // The sequence behind the P0: a fresh OTA gets ONE good boot heartbeat
  // (clears unproven) and then panic-loops in a later setup stage (camera
  // init). Because mark-valid is deferred to end-of-setup() — which the panic
  // never reaches — the slot stays rollback-eligible and the faulty counter
  // reverts it. (This pins the state-machine half; the .ino/IDF half — that
  // esp_ota_mark_app_valid_cancel_rollback() is NOT called before camera init —
  // is the part a unit test cannot see and that the bench matrix must verify.)
  OtaGateState s;
  s.unproven = true;
  boot(s, false);                       // fresh OTA boot
  TEST_ASSERT_TRUE(otaOnFirstContact(s));  // boot heartbeat lands → proven
  TEST_ASSERT_FALSE(s.unproven);
  // ...then panic-loops before end-of-setup (no otaOnSetupComplete reached):
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, true));   // pv=1
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, true));   // pv=2
  TEST_ASSERT_EQUAL(OtaGateAction::Rollback, boot(s, true));   // pv=3 → revert
}

// ---- THE safety invariant --------------------------------------------------

static void test_proven_slot_immune_to_no_contact_rollback(void) {
  // A proven/factory slot (unproven == false) that goes silent for an unbounded
  // number of boots — e.g. a multi-hour server or Wi-Fi outage — must NEVER be
  // rolled back. ncBoots must never even increment.
  OtaGateState s;  // unproven == false
  for (int i = 0; i < 100; ++i) {
    TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, false));
    TEST_ASSERT_EQUAL_UINT32(0, s.ncBoots);
  }
}

static void test_factory_slot_setup_complete_marks_valid(void) {
  // A factory/USB-flashed slot (never OTA'd → unproven false) validates by
  // surviving setup, exactly as in the pre-#148 design.
  OtaGateState s;
  TEST_ASSERT_TRUE(otaOnSetupComplete(s));
}

static void test_rollback_reset_leaves_clean_proven_state(void) {
  // After reverting, the slot we boot into was previously good: clean + proven,
  // so it can't immediately re-trip a rollback during a prolonged outage.
  OtaGateState s;
  s.unproven = true;
  s.pvBoots = 2;
  s.ncBoots = 3;
  otaResetForRollback(s);
  TEST_ASSERT_FALSE(s.unproven);
  TEST_ASSERT_EQUAL_UINT32(0, s.pvBoots);
  TEST_ASSERT_EQUAL_UINT32(0, s.ncBoots);
  // And it now behaves as a proven slot: silence never reverts it.
  TEST_ASSERT_EQUAL(OtaGateAction::Continue, boot(s, false));
}

static void test_thresholds_are_three(void) {
  TEST_ASSERT_EQUAL_UINT32(3, kOtaMaxFaultyBoots);
  TEST_ASSERT_EQUAL_UINT32(3, kOtaMaxNoContactBoots);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_clean_boot_no_rollback);
  RUN_TEST(test_faulty_loop_rolls_back_at_threshold);
  RUN_TEST(test_faulty_count_survives_proven_slot_only_via_setup);
  RUN_TEST(test_fresh_ota_validates_on_first_contact);
  RUN_TEST(test_mute_fresh_ota_rolls_back_after_threshold_boots);
  RUN_TEST(test_fresh_ota_validates_on_last_attempt_no_rollback);
  RUN_TEST(test_validated_then_panic_loop_still_rolls_back);
  RUN_TEST(test_proven_slot_immune_to_no_contact_rollback);
  RUN_TEST(test_factory_slot_setup_complete_marks_valid);
  RUN_TEST(test_rollback_reset_leaves_clean_proven_state);
  RUN_TEST(test_thresholds_are_three);
  return UNITY_END();
}
