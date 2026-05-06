#include "led.h"

#include <Arduino.h>

// LED_PIN is owned by led.h — single source of truth for the on-board
// flash LED GPIO. esp_init.cpp's camera-pin block no longer redeclares it.

static hf::LedMode g_mode = hf::LedMode::Off;
static uint32_t g_modeSetAt = 0;
static bool g_lastWritten = false;

void ledInit() {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);
    g_mode = hf::LedMode::Off;
    g_modeSetAt = (uint32_t)millis();
    g_lastWritten = false;
}

void ledSetMode(hf::LedMode mode) {
    g_mode = mode;
    g_modeSetAt = (uint32_t)millis();
    // Force a fresh write on the next tick so transitions are visible
    // immediately rather than waiting for the next ledTick() call.
    ledTick();
}

void ledTick() {
    const uint32_t elapsed = (uint32_t)millis() - g_modeSetAt;
    const bool on = hf::ledOnAt(g_mode, elapsed);
    if (on != g_lastWritten) {
        digitalWrite(LED_PIN, on ? HIGH : LOW);
        g_lastWritten = on;
    }
}
