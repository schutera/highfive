#ifndef LED_H
#define LED_H

#include "lib/led_state/led_state.h"

// On-board LED driver. Thin Arduino wrapper around hf::ledOnAt — all the
// pattern logic lives in the host-testable lib/led_state/ module.
//
// Usage: ledInit() once during setup(); ledSetMode() at any state
// transition; ledTick() called frequently from loop() (and from any
// blocking wait that we want to keep the LED alive through, e.g. the
// 30 s WiFi-connect window in setupWifiConnection()).

void ledInit();
void ledSetMode(hf::LedMode mode);
void ledTick();

#endif
