#include "led.h"

#include <Arduino.h>

// LED_PIN is owned by led.h — single source of truth for the on-board
// flash LED GPIO. esp_init.cpp's camera-pin block no longer redeclares it.

static hf::LedMode g_mode = hf::LedMode::Off;
static bool g_lastWritten = false;

void ledInit() {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);
    g_mode = hf::LedMode::Off;
    g_lastWritten = false;
}

void ledSetMode(hf::LedMode mode) {
    g_mode = mode;
    // Force a fresh write on the next tick so transitions are visible
    // even if the new mode happens to land on the same on/off phase.
    ledTick();
}

void ledTick() {
    const bool on = hf::ledOnAt(g_mode, (uint32_t)millis());
    if (on != g_lastWritten) {
        digitalWrite(LED_PIN, on ? HIGH : LOW);
        g_lastWritten = on;
    }
}
