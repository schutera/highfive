#include "led.h"

#include <Arduino.h>

// On-board flash LED. esp_init.cpp owns the camera pinouts; we duplicate
// the GPIO number here rather than expose a header purely for one int.
// Drift would manifest as a stuck-off LED in the field — caught by the
// first manual onboarding run.
#define LED_PIN 4

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
