#ifndef LED_H
#define LED_H

#include "led_state.h"

// On-board LED driver. Thin Arduino wrapper around hf::ledOnAt — all the
// pattern logic lives in the host-testable lib/led_state/ module.
//
// Usage: ledInit() once during setup(); ledSetMode() at any state
// transition; ledTick() called frequently from loop() (and from any
// blocking wait that we want to keep the LED alive through, e.g. the
// 30 s WiFi-connect window in setupWifiConnection()).

// Single source of truth for the on-board flash LED GPIO. Camera pin
// definitions in esp_init.cpp used to carry their own duplicate macro;
// this header is now the only declaration.
#define LED_PIN 4

void ledInit();
void ledSetMode(hf::LedMode mode);
void ledTick();

#endif
