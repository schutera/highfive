#include "ota_rollback.h"

namespace hf {

OtaGateAction otaBootGate(OtaGateState& s, bool faultyReset,
                          uint32_t maxFaulty, uint32_t maxNoContact) {
  if (faultyReset) {
    s.pvBoots += 1;
  }
  // Panic/WDT/brownout loop — the original #26 rollback trigger.
  if (s.pvBoots >= maxFaulty) {
    return OtaGateAction::Rollback;
  }
  if (s.unproven) {
    // Check the threshold BEFORE counting this boot: reaching it means the
    // previous `maxNoContact` boots all failed to validate, so revert now and
    // don't bother giving this boot another doomed attempt. Otherwise count
    // this boot as one more unvalidated attempt; otaOnFirstContact() clears it
    // if contact lands later this boot.
    if (s.ncBoots >= maxNoContact) {
      return OtaGateAction::Rollback;
    }
    s.ncBoots += 1;
  }
  return OtaGateAction::Continue;
}

bool otaOnFirstContact(OtaGateState& s) {
  if (!s.unproven) return false;
  s.unproven = false;
  s.ncBoots = 0;
  s.pvBoots = 0;
  return true;
}

bool otaOnSetupComplete(OtaGateState& s) {
  if (s.unproven) {
    // Surviving setup() is no longer proof of health for a fresh OTA slot — it
    // must make server contact to validate. Leave counters untouched.
    return false;
  }
  s.pvBoots = 0;  // proven/factory slot survived setup — clear the crash-loop count
  return true;
}

void otaResetForRollback(OtaGateState& s) {
  s.unproven = false;
  s.pvBoots = 0;
  s.ncBoots = 0;
}

}  // namespace hf
