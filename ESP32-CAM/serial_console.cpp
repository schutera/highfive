#include "serial_console.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FS.h>
#include <SPIFFS.h>

#include <string>

#include "serial_cmd.h"  // hf::parseSerialCmd, hf::devUrlsFromHost
#include "url.h"          // hf::parseUrl — host validation

// writeServerUrlsToConfig / clearServerUrlsFromConfig / setESPConfigured /
// isESPConfigured / loadConfig / FACTORY_RESET_SETTLE_MS / FIRMWARE_VERSION all
// come from esp_init.h (pulled in via serial_console.h).

namespace {

// Cross-call line buffer. Commands may arrive split across poll() calls, so the
// partial line persists between invocations. 159 usable chars + NUL — longer
// than any "set-server <init-url> <upload-url>" a developer would paste.
char g_line[160];
size_t g_len = 0;
bool g_overflow = false;

void printHelp() {
  Serial.println("[serial] commands:");
  Serial.println("  set-server <host>            -> http://<host>:8002/new_module + :8000/upload");
  Serial.println("  set-server <init> <upload>   set both URLs verbatim (https / custom ports)");
  Serial.println("  clear-server                 drop override; baked defaults resume");
  Serial.println("  reopen-portal                reopen Wi-Fi setup AP (Wi-Fi creds preserved)");
  Serial.println("  show-config                  print SSID + on-disk/in-RAM URLs + fw version");
  Serial.println("  help                         this list");
}

void printShowConfig(esp_config_t* cfg, const char* path) {
  Serial.println("[serial] show-config:");
  Serial.printf("  firmware:        %s\n", FIRMWARE_VERSION);
  Serial.printf("  configured(NVS): %s\n", isESPConfigured() ? "true" : "false");
  if (cfg) {
    // Password is deliberately never printed.
    Serial.printf("  in-RAM SSID:       %s\n", cfg->wifi_config.SSID);
    Serial.printf("  in-RAM INIT_URL:   %s\n", cfg->INIT_URL);
    Serial.printf("  in-RAM UPLOAD_URL: %s\n", cfg->UPLOAD_URL);
  }
  if (!SPIFFS.exists(path)) {
    Serial.println("  on-disk: <no /config.json>");
    return;
  }
  File f = SPIFFS.open(path, "r");
  if (!f) {
    Serial.println("  on-disk: <open failed>");
    return;
  }
  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.println("  on-disk: <parse error>");
    return;
  }
  const char* ssid = doc["NETWORK"]["SSID"] | "";
  const char* initUrl = doc["NETWORK"]["INIT_URL"] | "(unset — baked default)";
  const char* uploadUrl = doc["NETWORK"]["UPLOAD_URL"] | "(unset — baked default)";
  Serial.printf("  on-disk SSID:       %s\n", ssid);
  Serial.printf("  on-disk INIT_URL:   %s\n", initUrl);
  Serial.printf("  on-disk UPLOAD_URL: %s\n", uploadUrl);
}

void handleSetServer(const hf::SerialCmd& cmd, esp_config_t* cfg,
                     const char* path, bool inBootWindow) {
  std::string initUrl;
  std::string uploadUrl;
  if (!cmd.arg2.empty()) {
    // Verbatim two-URL form. parseUrl must pull a host out of each.
    initUrl = cmd.arg1;
    uploadUrl = cmd.arg2;
    if (hf::parseUrl(initUrl).host.empty() || hf::parseUrl(uploadUrl).host.empty()) {
      Serial.println("[serial] err: could not parse a host from the URL(s) — pass full http(s):// URLs");
      return;
    }
  } else if (!cmd.arg1.empty()) {
    // Bare-host form. devUrlsFromHost STRICTLY rejects anything that looks like
    // a URL (scheme/port/path punctuation), so a pasted "http://host" is caught
    // here rather than silently composing a doubled-scheme target.
    if (!hf::devUrlsFromHost(cmd.arg1, initUrl, uploadUrl)) {
      Serial.println("[serial] err: not a bare host — for a full URL use: set-server <init-url> <upload-url>");
      return;
    }
  } else {
    Serial.println("[serial] err: usage: set-server <host> | set-server <init-url> <upload-url>");
    return;
  }
  if (!writeServerUrlsToConfig(path, initUrl.c_str(), uploadUrl.c_str())) {
    Serial.println("[serial] err: failed to write config (left untouched)");
    return;
  }
  Serial.printf("[serial] ok: set-server\n  INIT_URL=%s\n  UPLOAD_URL=%s\n",
                initUrl.c_str(), uploadUrl.c_str());
  if (inBootWindow && cfg) {
    loadConfig(cfg);
    Serial.println("[serial] applied to this boot — registration will use the new target");
  } else {
    Serial.println("[serial] reboot (or 'reopen-portal') to apply");
  }
}

void handleLine(const char* line, esp_config_t* cfg, bool inBootWindow) {
  const hf::SerialCmd cmd = hf::parseSerialCmd(std::string(line));
  if (cmd.verb.empty()) return;
  const char* path = (cfg && cfg->CONFIG_FILE[0] != '\0') ? cfg->CONFIG_FILE
                                                          : "/config.json";

  if (cmd.verb == "set-server") {
    handleSetServer(cmd, cfg, path, inBootWindow);
  } else if (cmd.verb == "clear-server") {
    if (clearServerUrlsFromConfig(path)) {
      Serial.println("[serial] ok: clear-server — baked defaults resume");
      if (inBootWindow && cfg) {
        loadConfig(cfg);
        Serial.println("[serial] applied to this boot");
      } else {
        Serial.println("[serial] reboot to apply");
      }
    } else {
      Serial.println("[serial] err: failed to write config (left untouched)");
    }
  } else if (cmd.verb == "reopen-portal") {
    Serial.println("[serial] ok: reopening Wi-Fi setup portal — creds preserved, restarting");
    setESPConfigured(false);
    delay(FACTORY_RESET_SETTLE_MS);
    ESP.restart();  // does not return
  } else if (cmd.verb == "show-config") {
    printShowConfig(cfg, path);
  } else if (cmd.verb == "help") {
    printHelp();
  } else {
    Serial.printf("[serial] err: unknown command '%s' — type 'help'\n", cmd.verb.c_str());
  }
}

}  // namespace

bool serialConsolePoll(esp_config_t* cfg, bool inBootWindow) {
  bool handledAny = false;
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (g_overflow) {
        Serial.println("[serial] err: command too long — ignored");
        g_overflow = false;
        g_len = 0;
        continue;
      }
      if (g_len == 0) continue;  // blank line / bare CRLF
      g_line[g_len] = '\0';
      handleLine(g_line, cfg, inBootWindow);
      handledAny = true;
      g_len = 0;
      continue;
    }
    if (g_len >= sizeof(g_line) - 1) {
      g_overflow = true;  // keep draining until newline, then discard the line
      continue;
    }
    g_line[g_len++] = c;
  }
  return handledAny;
}

void serialConsolePrintHint() {
  Serial.println("[serial] dev console ready — 'set-server <host>' to retarget, 'help' for commands");
}
