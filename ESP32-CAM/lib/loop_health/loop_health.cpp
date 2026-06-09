#include "loop_health.h"

namespace hf {

bool WifiHealthMonitor::shouldReboot(bool wifiConnected, uint32_t nowMs) {
  if (wifiConnected) {
    // Connected (or recovered): clear any in-progress outage timer so a
    // blip that resolves never counts toward a reboot.
    tracking_ = false;
    return false;
  }
  if (!tracking_) {
    // First tick of a fresh outage — anchor the start and wait. Anchoring
    // here (rather than using 0 as a sentinel) keeps the logic correct even
    // when nowMs == 0 on the very first loop iteration after boot.
    tracking_ = true;
    downSinceMs_ = nowMs;
    return false;
  }
  // Unsigned subtraction wraps correctly across the millis() rollover; the
  // 24 h daily reboot means we never actually approach the ~49 day wrap.
  return (nowMs - downSinceMs_) > rebootAfterMs_;
}

bool HeartbeatScheduler::shouldSend(uint32_t nowMs) const {
  if (!primed_) return true;
  const uint32_t interval = lastOk_ ? intervalMs_ : retryMs_;
  return (nowMs - lastAttemptMs_) > interval;
}

void HeartbeatScheduler::recordResult(uint32_t nowMs, bool ok) {
  primed_ = true;
  lastAttemptMs_ = nowMs;
  lastOk_ = ok;
}

}  // namespace hf
