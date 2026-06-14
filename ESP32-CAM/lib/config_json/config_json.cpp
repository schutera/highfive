#include "config_json.h"

#include <ArduinoJson.h>

namespace hf {

namespace {

// Capacity matches host.cpp::saveConfig and esp_init.cpp's migration re-save,
// which already serialize a NETWORK block carrying both 128-char URLs.
using ConfigDoc = StaticJsonDocument<1024>;

// Parse `input` into `doc`. Empty/whitespace input becomes a fresh empty
// object. Returns false on a genuine parse error of non-empty input or a
// non-object root ("null", arrays) so callers can refuse to clobber.
bool loadInto(ConfigDoc& doc, const std::string& input) {
  bool blank = true;
  for (char c : input) {
    if (c != ' ' && c != '\t' && c != '\r' && c != '\n') {
      blank = false;
      break;
    }
  }
  if (blank) {
    doc.to<JsonObject>();
    return true;
  }
  DeserializationError err = deserializeJson(doc, input);
  if (err) return false;
  if (!doc.is<JsonObject>()) return false;
  return true;
}

// Return the NETWORK object, creating it if absent.
JsonObject networkObject(ConfigDoc& doc) {
  if (doc["NETWORK"].is<JsonObject>()) return doc["NETWORK"].as<JsonObject>();
  return doc.createNestedObject("NETWORK");
}

// Serialize, or "" on overflow (the #19 truncation guard).
std::string dump(ConfigDoc& doc) {
  std::string out;
  if (serializeJson(doc, out) == 0) return std::string();
  return out;
}

}  // namespace

std::string setWifiCredsInConfigJson(const std::string& input,
                                     const std::string& ssid,
                                     const std::string& password) {
  ConfigDoc doc;
  if (!loadInto(doc, input)) {
    // Corrupt-but-present file: rebuild a fresh Wi-Fi-only config rather than
    // refuse, so first-time and recovery saves still succeed (this matches
    // the pre-#156 saveConfig, which always built from scratch).
    doc.clear();
    doc.to<JsonObject>();
  }
  JsonObject net = networkObject(doc);
  net["SSID"] = ssid;          // ArduinoJson copies std::string contents
  net["PASSWORD"] = password;
  return dump(doc);
}

std::string setServerUrlsInConfigJson(const std::string& input,
                                      const std::string& initUrl,
                                      const std::string& uploadUrl) {
  ConfigDoc doc;
  if (!loadInto(doc, input)) return std::string();  // refuse to clobber
  JsonObject net = networkObject(doc);
  net["INIT_URL"] = initUrl;
  net["UPLOAD_URL"] = uploadUrl;
  return dump(doc);
}

std::string clearServerUrlsInConfigJson(const std::string& input) {
  ConfigDoc doc;
  if (!loadInto(doc, input)) return std::string();  // refuse to clobber
  if (doc["NETWORK"].is<JsonObject>()) {
    JsonObject net = doc["NETWORK"].as<JsonObject>();
    net.remove("INIT_URL");
    net.remove("UPLOAD_URL");
  }
  return dump(doc);
}

}  // namespace hf
