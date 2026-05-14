#include <WiFi.h>
#include <SPIFFS.h>
#include <FS.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include "esp_init.h"   // setESPConfigured
#include "firmware_defaults.h" // hf::defaults::k*FormFallback (issue #66)
#include "form_query.h" // hf::urlDecode, hf::getParam, hf::resolveKeepCurrentField, hf::splitUrlForForm, hf::joinUrlFromForm (host-testable)
#include "led.h"        // ledTick during the AP server loop
#include <string>

const char *HOST_SSID = "ESP32-Access-Point";
const char *HOST_PASSWORD = "esp-12345";

WiFiServer server(80); // port 80
int server_running = 0;
String sessionToken;

String header;

String cfg_module_name = "";
String cfg_ssid           = "";
String cfg_password       = "";
String cfg_upload_url     = "";
String cfg_init_url       = "";
String cfg_resolution     = hf::defaults::kResolutionFormFallback;
int    cfg_vflip          = hf::defaults::kVerticalFlipFormFallback;
int    cfg_brightness     = hf::defaults::kBrightnessFormFallback;
int    cfg_saturation     = hf::defaults::kSaturationFormFallback;


/*
  -----------------------------
  ---------- HELPERS ----------
  -----------------------------
*/
// Thin Arduino-String wrappers around the host-testable implementations
// in lib/form_query. Behavior must remain byte-compatible with the
// previous on-device versions; the unit tests in
// test/test_native_form_query/ pin that contract.
String urlDecode(const String& src) {
  return String(hf::urlDecode(std::string(src.c_str())).c_str());
}

String getParam(const String& query, const String& name) {
  return String(
      hf::getParam(std::string(query.c_str()), std::string(name.c_str())).c_str()
  );
}

// Server-side half of the captive-portal "blank means keep current"
// contract for the password field (#46/#57). See header notes on
// `hf::resolveKeepCurrentField` for semantics. This wrapper exists so
// `runAccessPoint` can use Arduino `String` call sites while the logic
// stays host-testable in `lib/form_query/`.
String resolveKeepCurrentField(const String& submitted, const String& current) {
  return String(
      hf::resolveKeepCurrentField(
          std::string(submitted.c_str()),
          std::string(current.c_str())
      ).c_str()
  );
}

/*
  -------------------------------------
  -- LOAD EXISTING CONFIG TO PREFILL --
  -------------------------------------
*/
void loadConfig() {


  if (!SPIFFS.exists("/config.json")) {
    Serial.println("config.json not found, using defaults");
    return;
  }

  File f = SPIFFS.open("/config.json", "r");
  if (!f) {
    Serial.println("Failed to open config.json");
    return;
  }

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.print("Failed to parse config.json: ");
    Serial.println(err.f_str());
    return;
  }

  cfg_module_name = doc["NETWORK"]["MODULE_NAME"] | "";
  cfg_ssid        = doc["NETWORK"]["SSID"]           | "";
  cfg_password    = doc["NETWORK"]["PASSWORD"]       | "";
  cfg_upload_url  = doc["NETWORK"]["UPLOAD_URL"]     | "";
  cfg_init_url    = doc["NETWORK"]["INIT_URL"]       | "";

  // Mirror the legacy-http migration esp_init.cpp::loadConfig applies
  // on the main-firmware boot path. host.cpp::loadConfig runs on the
  // captive-portal entry, which is after WiFi-auth has failed three
  // times (auto-AP fallback) or on an explicit factory reset — in the
  // common case esp_init.cpp will have already migrated SPIFFS, so
  // this is a defensive in-memory rewrite. The captive portal does
  // NOT re-save on read; the operator must click Save to persist.
  // See lib/firmware_defaults/firmware_defaults.h for the dual-reader
  // contract this honours, and rewriteLegacyHighfiveUrl in
  // lib/form_query/ for the prefix-match rule. Issue #79.
  cfg_upload_url = String(hf::rewriteLegacyHighfiveUrl(std::string(cfg_upload_url.c_str())).c_str());
  cfg_init_url   = String(hf::rewriteLegacyHighfiveUrl(std::string(cfg_init_url.c_str())).c_str());

  // Form-prefill fallbacks. Asymmetric on purpose with the production
  // reader in `esp_init.cpp`'s `loadConfig` (form prefills the operator-
  // facing default; the production side picks the conservative "do
  // nothing surprising" value when the key is missing). Each pair lives
  // in `lib/firmware_defaults/firmware_defaults.h` as a named constant
  // so the asymmetry survives future "deduplicate the literals"
  // refactors — see chapter-11 "Dual-reader asymmetry" for the lesson.
  cfg_resolution  = doc["CAMERA"]["RESOLUTION"]     | hf::defaults::kResolutionFormFallback;
  cfg_vflip       = doc["CAMERA"]["VERTICAL_FLIP"]  | hf::defaults::kVerticalFlipFormFallback;
  cfg_brightness  = doc["CAMERA"]["BRIGHTNESS"]     | hf::defaults::kBrightnessFormFallback;
  cfg_saturation  = doc["CAMERA"]["SATURATION"]    | hf::defaults::kSaturationFormFallback;
}

/*
  ----------------------------------
  -- UPDATE JSON CONFIG ON DEVICE --
  ----------------------------------
*/
void saveConfig() {
  StaticJsonDocument<1024> doc;

  JsonObject net  = doc.createNestedObject("NETWORK");
  JsonObject cam  = doc.createNestedObject("CAMERA");

  net["MODULE_NAME"] = cfg_module_name;
  net["SSID"]        = cfg_ssid;
  net["PASSWORD"]    = cfg_password;
  net["UPLOAD_URL"]  = cfg_upload_url;
  net["INIT_URL"]    = cfg_init_url;

  cam["RESOLUTION"]             = cfg_resolution;
  cam["VERTICAL_FLIP"]          = cfg_vflip;
  cam["BRIGHTNESS"]             = cfg_brightness;
  cam["SATURATION"]             = cfg_saturation;

  File f = SPIFFS.open("/config.json", "w");
  if (!f) {
    Serial.println("Failed to open config.json for writing");
    return;
  }
  // Truncation gate (issue #19). If `serializeJson` returns 0 the document
  // overflowed the StaticJsonDocument pool. The on-disk `/config.json` has
  // already been opened "w" (truncated to zero bytes) by `SPIFFS.open`
  // above, so a previously-good file is now empty regardless of what we
  // do next — but we can still skip `setESPConfigured(true)`. On first-time
  // setup that keeps the NVS `configured` flag false, so next boot re-enters
  // the captive portal; the captive-portal reader (`host.cpp`'s own
  // `loadConfig`) will trip over the empty file once, log "Failed to parse
  // config.json", and fall back to the compiled-in `cfg_*` defaults. On
  // re-configuration the flag persists `true` from an earlier successful
  // save; next boot calls `esp_init.cpp`'s `loadConfig`, `deserializeJson`
  // returns a parse error on the empty file, `loadConfig` logs "JSON parse
  // error" and returns false without touching `esp_config->wifi_config`,
  // so the SSID/PASSWORD fields keep their BSS-zero defaults.
  // `setupWifiConnection` then times out trying to join an empty SSID, the
  // WiFi-fail counter advances, and after `WIFI_FAIL_AP_FALLBACK_THRESH`
  // consecutive failures the setup path in `ESP32-CAM/ESP32-CAM.ino`
  // re-enters the captive portal. Either way the device does not run with
  // truncated credentials in the field.
  size_t bytes_written = serializeJson(doc, f);
  f.close();
  if (bytes_written == 0) {
    Serial.println("[saveConfig] serializeJson wrote 0 bytes — config.json "
                   "is now empty, skipping setESPConfigured so the next boot "
                   "lands back in the captive portal (first-time or via "
                   "WiFi-fail auto-fallback on re-config)");
    return;
  }

  setESPConfigured(true);
}

/*
  ----------------------------------
  -------- HTML CONFIG FORM --------
  ----------------------------------
*/
void sendConfigForm(WiFiClient &client, bool saved = false) {
  // Three-fields-per-URL pre-fill (issue #79). Logic lives in
  // hf::splitUrlForForm (lib/form_query/) so test_native_form_query
  // pins the split shape. Port defaults to the LAN-dev convention
  // (8002 for init, 8000 for upload) ONLY when no URL is saved —
  // first-boot. On reconfigure the stored URL's port (which may be
  // empty for production https://highfive.schutera.com) wins so the
  // operator doesn't see a phantom "8002" appear on a production
  // module. Endpoint defaults likewise — first-boot prefills the
  // wire-protocol constants (`upload` / `new_module`) pinned by
  // `image-service/app.py::upload_image` and
  // `duckdb-service/routes/modules.py::add_module`.
  hf::FormUrlParts uploadParts = hf::splitUrlForForm(std::string(cfg_upload_url.c_str()));
  hf::FormUrlParts initParts   = hf::splitUrlForForm(std::string(cfg_init_url.c_str()));

  String uploadBase     = String(uploadParts.base.c_str());
  String uploadPort     = (cfg_upload_url.length() == 0)
                              ? "8000"
                              : String(uploadParts.port.c_str());
  String uploadEndpoint = uploadParts.endpoint.empty()
                              ? "upload"
                              : String(uploadParts.endpoint.c_str());

  String initBase       = String(initParts.base.c_str());
  String initPort       = (cfg_init_url.length() == 0)
                              ? "8002"
                              : String(initParts.port.c_str());
  String initEndpoint   = initParts.endpoint.empty()
                              ? "new_module"
                              : String(initParts.endpoint.c_str());


  client.println("HTTP/1.1 200 OK");
  client.println("Content-type:text/html");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Connection: close");
  client.println();
  client.println("<!DOCTYPE html><html><head>");
  client.println("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  client.println("<title>ESP32 Configuration</title>");

  client.println(
  "<style>"
  ":root{"
  "  --primary:#2563eb;"
  "  --primary-dark:#1e40af;"
  "  --bg:#f3f6fb;"
  "  --card:#ffffff;"
  "  --text:#1f2937;"
  "  --muted:#6b7280;"
  "  --border:#e5e7eb;"
  "  --error:#dc2626;"
  "}"

  "*{box-sizing:border-box;}"
  "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);}"
  ".container{max-width:760px;margin:40px auto;padding:0 20px;}"
  ".card{background:var(--card);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.08);padding:32px;}"
  "h1{text-align:center;margin-top:0;font-size:26px;}"

  ".section{margin-top:28px;padding-top:18px;border-top:1px solid var(--border);}"
  ".section h2,.summary-as-h2{margin:0 0 10px 0;font-size:18px;font-weight:600;cursor:pointer;}"
  ".section-desc{font-size:13px;color:var(--muted);margin-bottom:16px;}"

  ".field{margin-bottom:18px;}"
  "label{display:block;font-weight:600;font-size:14px;margin-bottom:6px;}"

  "input,select{"
  "  width:100%;padding:10px 12px;border-radius:8px;"
  "  border:1px solid var(--border);font-size:14px;background:#fafafa;"
  "}"

  "input:focus,select:focus{outline:none;border-color:var(--primary);background:#fff;box-shadow:0 0 0 3px rgba(37,99,235,0.15);}"

  ".row{display:flex;gap:14px;}"
  ".row .field{flex:1;}"

  ".description{font-size:12px;color:var(--muted);margin-top:6px;}"

  ".error-field{border-color:var(--error) !important;background:#fff5f5 !important;}"
  ".error-message{color:var(--error);font-size:13px;margin-top:12px;text-align:center;display:none;}"

  "button{margin-top:20px;width:100%;padding:12px;border:none;border-radius:999px;font-size:15px;font-weight:600;background:var(--primary);color:#fff;cursor:pointer;transition:0.2s;}"
  "button:hover{background:var(--primary-dark);}"

  ".message{background:#e6f4ea;color:#14532d;padding:12px;border-radius:8px;margin-bottom:16px;font-size:14px;}"
  "</style>"
  );

  /* ===== VALIDATION SCRIPT ===== */
  client.println(
  "<script>"
  "function validateForm(event){"
  "  event.preventDefault();"
  "  let valid=true;"
  "  const fields=document.querySelectorAll('input, select');"
  "  fields.forEach(f=>{"
  "    if(f.dataset.keepCurrentOnEmpty==='1' && f.value===''){"
  "      f.classList.remove('error-field');"
  "      return;"
  "    }"
  // data-keep-empty (issue #79) — port fields are legitimately
  // empty when the URL uses an implicit scheme-default port
  // (e.g. 443 for https). Numeric range is enforced by the
  // input's min/max plus a defensive parseInt check below.
  "    if(f.dataset.keepEmpty==='1' && f.value===''){"
  "      f.classList.remove('error-field');"
  "      return;"
  "    }"
  "    if(f.type==='number' && f.value!==''){"
  "      const n=parseInt(f.value,10);"
  "      if(isNaN(n)||n<(parseInt(f.min,10)||0)||n>(parseInt(f.max,10)||0x7fffffff)){"
  "        f.classList.add('error-field');"
  "        valid=false;"
  "        return;"
  "      }"
  "    }"
  "    if(f.type!=='hidden' && f.value.trim()===''){"
  "      f.classList.add('error-field');"
  "      valid=false;"
  "    }else{"
  "      f.classList.remove('error-field');"
  "    }"
  "  });"
  "  const errorMsg=document.getElementById('errorText');"
  "  if(!valid){"
  "    errorMsg.style.display='block';"
  "    return false;"
  "  }"
  "  errorMsg.style.display='none';"
  "  event.target.submit();"
  "}"
  "</script>"
  );

  client.println("</head><body>");
  client.println("<div class=\"container\"><div class=\"card\">");
  client.println("<h1>ESP32 Module Configuration</h1>");

  if (saved) {
    client.println("<div class=\"message\"><strong>Configuration saved successfully.</strong></div>");
  }

  client.println("<form action=\"/save\" method=\"POST\" autocomplete=\"off\" onsubmit=\"validateForm(event)\">");
  client.println("<input type=\"hidden\" name=\"session\" value=\"" + sessionToken + "\">");

  /* ===== GENERAL ===== */
  client.println("<div class=\"section\">");
  client.println("<h2>General</h2>");
  client.println("<div class=\"section-desc\">Basic identification settings for this device.</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Module Name</label>");
  client.println("<input type=\"text\" name=\"module_name\" value=\"" + cfg_module_name + "\">");
  client.println("<div class=\"description\">You can name the module however you want.</div>");
  client.println("</div>");
  client.println("</div>");

  /* ===== NETWORK ===== */
  client.println("<div class=\"section\">");
  client.println("<h2>Network</h2>");
  client.println("<div class=\"section-desc\">WiFi credentials and communication endpoints.</div>");

  client.println("<div class=\"field\">");
  client.println("<label>WiFi SSID</label>");
  client.println("<input type=\"text\" name=\"ssid\" value=\"" + cfg_ssid + "\">");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>WiFi Password</label>");
  // Never echo the saved password back into the form: the captive portal is
  // served over a WPA2 AP whose PSK (HOST_PASSWORD at the top of this file)
  // is hardcoded in source, so anyone who has read the codebase, the wiki,
  // or guessed the default can join and View Source. See #46.
  // First-boot vs. reconfigure: only hint at "keep current" when one is
  // saved, and tag the input data-keep-current-on-empty so validateForm
  // permits empty submission. The /save handler completes the contract
  // by calling `hf::resolveKeepCurrentField` (whitespace-trim, blank-or-
  // all-whitespace falls through to "keep current"); to add a second
  // keep-current field, tag the input here and route its `/save`
  // assignment through the same helper rather than writing a fresh
  // inline check.
  String pwHint     = (cfg_password.length() > 0) ? "(leave blank to keep current password)" : "WiFi password";
  String pwKeepAttr = (cfg_password.length() > 0) ? " data-keep-current-on-empty=\"1\"" : "";
  client.println("<input type=\"password\" name=\"password\"" + pwKeepAttr + " value=\"\" placeholder=\"" + pwHint + "\">");
  client.println("</div>");

  // Three fields per URL since #79: base, port, endpoint. Port is
  // its own input so production (`https://highfive.schutera.com`,
  // implicit :443) and LAN dev (`http://10.0.0.5:8002`) share the
  // same shape — the operator only types numbers in one place. Flex
  // sizes intentionally non-uniform: base is the widest input, port
  // is the narrowest. Empty port is permitted (data-keep-empty="1")
  // so production submissions don't fail validation.
  client.println("<div class=\"row\">");
  client.println("<div class=\"field\" style=\"flex:3\">");
  client.println("<label>Initialization Base URL</label>");
  client.println("<input type=\"text\" name=\"init_base\" value=\"" + initBase + "\">");
  client.println("</div>");
  client.println("<div class=\"field\" style=\"flex:1\">");
  client.println("<label>Port</label>");
  client.println("<input type=\"number\" name=\"init_port\" min=\"1\" max=\"65535\" data-keep-empty=\"1\" value=\"" + initPort + "\">");
  client.println("</div>");
  client.println("<div class=\"field\" style=\"flex:1\">");
  client.println("<label>Endpoint</label>");
  client.println("<input type=\"text\" name=\"init_endpoint\" value=\"" + initEndpoint + "\">");
  client.println("</div>");
  client.println("</div>");

  client.println("<div class=\"row\">");
  client.println("<div class=\"field\" style=\"flex:3\">");
  client.println("<label>Upload Base URL</label>");
  client.println("<input type=\"text\" name=\"upload_base\" value=\"" + uploadBase + "\">");
  client.println("</div>");
  client.println("<div class=\"field\" style=\"flex:1\">");
  client.println("<label>Port</label>");
  client.println("<input type=\"number\" name=\"upload_port\" min=\"1\" max=\"65535\" data-keep-empty=\"1\" value=\"" + uploadPort + "\">");
  client.println("</div>");
  client.println("<div class=\"field\" style=\"flex:1\">");
  client.println("<label>Endpoint</label>");
  client.println("<input type=\"text\" name=\"upload_endpoint\" value=\"" + uploadEndpoint + "\">");
  client.println("</div>");
  client.println("</div>");
  client.println("</div>");

  /* ===== CAMERA ===== */
  client.println("<div class=\"section\">");
  client.println("<h2>Camera</h2>");
  client.println("<div class=\"section-desc\">Image capture and quality settings.</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Resolution</label>");
  client.println("<select name=\"res\">");
  client.println("<option value=\"qvga\""  + String(cfg_resolution.equalsIgnoreCase("qvga")  ? " selected" : "") + ">QVGA - 320x240</option>");
  client.println("<option value=\"vga\""   + String(cfg_resolution.equalsIgnoreCase("vga")   ? " selected" : "") + ">VGA - 640x480</option>");
  client.println("<option value=\"qxga\""  + String(cfg_resolution.equalsIgnoreCase("qxga")  ? " selected" : "") + ">QXGA - 800x600</option>");
  client.println("<option value=\"sxga\""  + String(cfg_resolution.equalsIgnoreCase("sxga")  ? " selected" : "") + ">SXGA - 1280x1024</option>");
  client.println("<option value=\"uxga\""  + String(cfg_resolution.equalsIgnoreCase("uxga")  ? " selected" : "") + ">UXGA - 1600x1200</option>");
  client.println("</select>");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Vertical Flip (0 or 1)</label>");
  client.println("<input type=\"number\" name=\"vflip\" min=\"0\" max=\"1\" value=\"" + String(cfg_vflip) + "\">");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Brightness</label>");
  client.println("<input type=\"number\" name=\"bright\" value=\"" + String(cfg_brightness) + "\">");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Saturation</label>");
  client.println("<input type=\"number\" name=\"sat\" value=\"" + String(cfg_saturation) + "\">");
  client.println("</div>");

  client.println("</div>");

  client.println("<button type=\"submit\">Save Configuration</button>");
  client.println("<div id=\"errorText\" class=\"error-message\">Enter missing details before saving configuration.</div>");

  client.println("</form>");

  // Factory reset is a separate form so the main Save button can't
  // accidentally trigger it. Collapsed inside <details> by default.
  // Issue #40: replaces the old "hold IO0 at boot" path which never
  // actually worked because GPIO0 is a strap pin.
  client.println("<form action=\"/factory_reset\" method=\"POST\" autocomplete=\"off\">");
  client.println("<input type=\"hidden\" name=\"session\" value=\"" + sessionToken + "\">");
  client.println("<details class=\"section\">");
  // <summary> is the screen-reader heading for the disclosure widget;
  // wrapping <h2> inside it would announce the label twice.
  client.println("<summary class=\"summary-as-h2\">Factory reset (advanced)</summary>");
  client.println("<div class=\"section-desc\">Reboots the module back into this configuration portal so you can re-enter or edit the saved settings. Your previous values prefill the form for editing. Use this when moving the module to a new WiFi network or when login credentials changed.</div>");
  client.println("<div class=\"field\">");
  client.println("<label><input type=\"checkbox\" name=\"confirm\" value=\"yes\" required> I understand this reboots the module and reopens the configuration portal.</label>");
  client.println("</div>");
  client.println("<button type=\"submit\">Factory reset</button>");
  client.println("</details>");
  client.println("</form>");

  client.println("</div></div></body></html>");
  client.println();
}


/*
  --------------------------------------
  -------- RUN THE ACCESS POINT --------
  --------------------------------------
*/
void runAccessPoint() {
  server_running = 1;

  while (server_running) {
    esp_task_wdt_reset();
    ledTick();
    WiFiClient client = server.available();
    if (client) {
      Serial.println("\n------ CLIENT CONNECTED ------");
      String currentLine = "";
      header = "";

      while (client.connected()) {
        if (client.available()) {
          char c = client.read();
          header += c;

          if (c == '\n') {
            // blank line: end of HTTP headers
            if (currentLine.length() == 0) {

              // --------- Parse method + path from first line ---------
              // Example first line: "POST /save HTTP/1.1"
              int methodEnd = header.indexOf(' ');
              int pathStart = methodEnd + 1;
              int pathEnd   = header.indexOf(' ', pathStart);

              String method = header.substring(0, methodEnd);
              String fullPath = header.substring(pathStart, pathEnd);  // "/save" or "/save?ssid=..."

              bool isPost = method.equalsIgnoreCase("POST");
              bool isGet  = method.equalsIgnoreCase("GET");

              // --------- Extract Content-Length (for POST body) ---------
              int contentLength = 0;
              int clIndex = header.indexOf("Content-Length:");
              if (clIndex != -1) {
                int lineEnd = header.indexOf('\n', clIndex);
                String clLine = header.substring(clIndex + 15, lineEnd); // after "Content-Length:"
                clLine.trim();
                contentLength = clLine.toInt();
              }

              // Read body if POST
              String body = "";
              if (isPost && contentLength > 0) {
                while ((int)body.length() < contentLength) {
                  if (client.available()) {
                    char ch = client.read();
                    body += ch;
                  }
                }
              }

              // --------- Handle /save ---------
              if (fullPath.startsWith("/save")) {
                String query;

                if (isPost) {
                  // For POST, form data is in body:
                  // "ssid=...&password=...&upload_base=...&upload_endpoint=...&..."
                  query = body;
                } else if (isGet && fullPath.startsWith("/save?")) {
                  // Backwards-compatible GET handler
                  query = fullPath.substring(String("/save?").length());
                }

                // If we got some parameters, process them
                if (query.length() > 0) {
                  // Only treat as valid if session token matches
                  String sessionParam = getParam(query, "session");
                  if (sessionParam == sessionToken) {
                    cfg_module_name = getParam(query, "module_name");

                    cfg_ssid        = getParam(query, "ssid");
                    // Empty submission means "keep current password" (#46): the
                    // form no longer pre-fills the field, so a user editing only
                    // the SSID would otherwise wipe their saved credential. The
                    // HTML half (`pwKeepAttr` in `sendConfigForm` above) tags
                    // the password input with `data-keep-current-on-empty="1"`
                    // and the JS validator (also rendered by `sendConfigForm`)
                    // skips validation when empty; this assignment honours the
                    // same shape on the server. Logic lives in
                    // `hf::resolveKeepCurrentField` (lib/form_query/) — host-
                    // testable as of #57; whitespace-trim and blank-keep
                    // semantics are pinned by 5 Unity tests in
                    // test/test_native_form_query/.
                    cfg_password = resolveKeepCurrentField(getParam(query, "password"), cfg_password);

                    // Three-fields-per-URL form (issue #79). Read base, port,
                    // endpoint; trim each; recombine via hf::joinUrlFromForm so
                    // the slash-normalisation + scheme-default-port-stripping
                    // is pinned by test_native_form_query rather than inlined
                    // here. Empty port submissions are normal (production
                    // https://highfive.schutera.com on implicit :443) — the
                    // joiner omits ":port" for empty values.
                    String uploadBase     = getParam(query, "upload_base");
                    String uploadPort     = getParam(query, "upload_port");
                    String uploadEndpoint = getParam(query, "upload_endpoint");

                    String initBase       = getParam(query, "init_base");
                    String initPort       = getParam(query, "init_port");
                    String initEndpoint   = getParam(query, "init_endpoint");

                    uploadBase.trim();
                    uploadPort.trim();
                    uploadEndpoint.trim();
                    initBase.trim();
                    initPort.trim();
                    initEndpoint.trim();

                    cfg_upload_url = String(
                        hf::joinUrlFromForm(
                            std::string(uploadBase.c_str()),
                            std::string(uploadPort.c_str()),
                            std::string(uploadEndpoint.c_str())
                        ).c_str()
                    );
                    cfg_init_url = String(
                        hf::joinUrlFromForm(
                            std::string(initBase.c_str()),
                            std::string(initPort.c_str()),
                            std::string(initEndpoint.c_str())
                        ).c_str()
                    );

                    cfg_resolution  = getParam(query, "res");
                    cfg_vflip       = getParam(query, "vflip").toInt();
                    cfg_brightness  = getParam(query, "bright").toInt();
                    cfg_saturation  = getParam(query, "sat").toInt();

                    saveConfig();
                    sendConfigForm(client, true);
                    server_running = 0;
                  } else {
                    // invalid / missing session -> just show form again
                    sendConfigForm(client, false);
                  }
                } else {
                  // /save but no params: show form
                  sendConfigForm(client, false);
                }

              } else if (fullPath.startsWith("/factory_reset")) {
                // POST-only endpoint that wipes the NVS configured flag
                // and reboots straight into AP mode. Issue #40 option A —
                // replaces the broken GPIO0-hold path that never worked
                // because GPIO0 is a strap pin on the AI Thinker board.
                String query;
                if (isPost) {
                  query = body;
                }

                String sessionParam = getParam(query, "session");
                String confirmParam = getParam(query, "confirm");
                if (!isPost || sessionParam != sessionToken || confirmParam != "yes") {
                  // Bad request. Render the form without leaking which check failed
                  // to the client, but log the reason locally so a developer at the
                  // serial monitor can see why their curl test isn't working.
                  Serial.printf("[host] /factory_reset rejected: isPost=%d sessionOk=%d confirmOk=%d\n",
                                (int)isPost,
                                (int)(sessionParam == sessionToken),
                                (int)(confirmParam == "yes"));
                  sendConfigForm(client, false);
                } else {
                  Serial.println("[host] Factory reset requested via captive portal");
                  // Tiny inline response page; the restart cuts the socket within ms.
                  // The 60 s meta-refresh is a best-effort nudge — meta-refresh has
                  // no event hook for "SSID has come back", just a fixed timer, and
                  // an iOS/Android SSID switch round-trip can be 30+ s. If the user
                  // is still off-network when the timer fires, the page errors and
                  // the copy below tells them to reload manually. Better than
                  // pretending the browser knows when the AP is back.
                  client.println("HTTP/1.1 200 OK");
                  client.println("Content-type:text/html");
                  client.println("Connection: close");
                  client.println();
                  client.println("<!doctype html><html><head>");
                  client.println("<meta http-equiv=\"refresh\" content=\"60; url=http://192.168.4.1/\">");
                  client.println("</head><body>");
                  client.println("<h1>Factory reset</h1>");
                  client.println("<p>The module is rebooting and will reopen the WiFi access point in a moment. Reconnect your phone to <code>ESP32-Access-Point</code>, then either wait up to 60 seconds for this page to refresh on its own, or reload it manually.</p>");
                  client.println("</body></html>");
                  // WiFiClient::flush() on Arduino-ESP32 is best-effort — it
                  // doesn't guarantee bytes have actually left the radio. The
                  // 500 ms FACTORY_RESET_SETTLE_MS below is what gives the TCP
                  // stack a fighting chance to drain before ESP.restart().
                  client.flush();

                  setESPConfigured(false);
                  delay(FACTORY_RESET_SETTLE_MS);  // give the kernel time to flush the TCP FIN
                  ESP.restart();
                }

              } else {
                // Any other path -> show form
                sendConfigForm(client, false);
              }

              break; // done handling request

            } else {
              currentLine = "";
            }
          } else if (c != '\r') {
            currentLine += c;
          }
        }
      }

      client.stop();
      // Serial.println("Client disconnected");
    }
  }

  Serial.println("Exiting runAccessPoint()");
}

void setupAccessPoint() {
  if (!SPIFFS.begin(true)) {        // true = format if mount fails
    Serial.println("SPIFFS mount failed");
  }

  loadConfig();

  sessionToken = String((uint32_t)esp_random(), HEX);

  WiFi.mode(WIFI_AP_STA);
  bool ok = WiFi.softAP(HOST_SSID, HOST_PASSWORD, 1, 0);
  if (!ok) {
    Serial.println("!!! WiFi.softAP FAILED");
  }

  WiFi.begin();

  IPAddress IP = WiFi.softAPIP();
  Serial.print("---- AccessPoint IP: ");
  Serial.print(IP);

  server.begin();
  runAccessPoint();
}

