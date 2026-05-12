#include <WiFi.h>
#include <SPIFFS.h>
#include <FS.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include "esp_init.h"   // setESPConfigured
#include "form_query.h" // hf::urlDecode, hf::getParam (host-testable)
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
String cfg_resolution     = "VGA";
int    cfg_interval_ms    = 60000;
int    cfg_vflip          = 0;
int    cfg_brightness     = 0;
int    cfg_saturation     = 0;


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
  cfg_init_url  = doc["NETWORK"]["INIT_URL"]     | "";

  // Form-prefill fallback (issue #20). Asymmetric on purpose with the
  // production reader in `esp_init.cpp`'s `loadConfig` (which falls back to
  // 86400000 / 24 h — the "do nothing aggressive when unconfigured" value).
  // This reader's job is to render a sensible operator-facing default in the
  // captive-portal form when the key is missing from a pre-existing config.
  // ArduinoJson v6 `|` fires only on missing or non-numeric values — a
  // stored 0 reads as 0 and would still appear in the form; the `/save`
  // POST handler's `< 10` floor is what keeps a 0 from being saved in the
  // first place. The two-defaults dance is tracked at issue #66 — a shared
  // `firmware_defaults.h` with named constants is the permanent fix.
  cfg_interval_ms = doc["CAMERA"]["CAPTURE_INTERVAL_IN_MS"] | 60000;
  cfg_resolution  = doc["CAMERA"]["RESOLUTION"]              | "VGA";
  cfg_vflip       = doc["CAMERA"]["VERTICAL_FLIP"]          | 0;
  cfg_brightness  = doc["CAMERA"]["BRIGHTNESS"]             | 0;
  cfg_saturation  = doc["CAMERA"]["SATURATION"]             | 0;
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

  cam["CAPTURE_INTERVAL_IN_MS"] = cfg_interval_ms;
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
  // Optional: split cfg_upload_url into base + endpoint for pre-filling
  String uploadBase = cfg_upload_url;
  String uploadEndpoint = "";
  int lastSlash = uploadBase.lastIndexOf('/');
  if (lastSlash > 7) { // after "http://", "https://"
    uploadEndpoint = uploadBase.substring(lastSlash + 1);
    uploadBase = uploadBase.substring(0, lastSlash);
  }

  String initBase = cfg_init_url;
  String initEndpoint = "";
  int lastSlashInit = initBase.lastIndexOf('/');
  if (lastSlashInit > 7) { // after "http://", "https://"
    initEndpoint = initBase.substring(lastSlashInit + 1);
    initBase = initBase.substring(0, lastSlashInit);
  }


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
  // permits empty submission. The /save handler mirrors the contract by
  // assigning cfg_password only when getParam("password") is non-empty;
  // if a future field also adopts this attribute, mirror it server-side.
  String pwHint     = (cfg_password.length() > 0) ? "(leave blank to keep current password)" : "WiFi password";
  String pwKeepAttr = (cfg_password.length() > 0) ? " data-keep-current-on-empty=\"1\"" : "";
  client.println("<input type=\"password\" name=\"password\"" + pwKeepAttr + " value=\"\" placeholder=\"" + pwHint + "\">");
  client.println("</div>");

  client.println("<div class=\"row\">");
  client.println("<div class=\"field\">");
  client.println("<label>Initialization Base URL</label>");
  client.println("<input type=\"text\" name=\"init_base\" value=\"" + initBase + "\">");
  client.println("</div>");
  client.println("<div class=\"field\">");
  client.println("<label>Initialization Endpoint</label>");
  client.println("<input type=\"text\" name=\"init_endpoint\" value=\"" + initEndpoint + "\">");
  client.println("</div>");
  client.println("</div>");

  client.println("<div class=\"row\">");
  client.println("<div class=\"field\">");
  client.println("<label>Upload Base URL</label>");
  client.println("<input type=\"text\" name=\"upload_base\" value=\"" + uploadBase + "\">");
  client.println("</div>");
  client.println("<div class=\"field\">");
  client.println("<label>Upload Endpoint</label>");
  client.println("<input type=\"text\" name=\"upload_endpoint\" value=\"" + uploadEndpoint + "\">");
  client.println("</div>");
  client.println("</div>");
  client.println("</div>");

  /* ===== CAMERA ===== */
  client.println("<div class=\"section\">");
  client.println("<h2>Camera</h2>");
  client.println("<div class=\"section-desc\">Image capture and quality settings.</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Capture Interval (ms)</label>");
  client.println("<input type=\"number\" name=\"interval\" min=\"10\" value=\"" + String(cfg_interval_ms) + "\">");
  client.println("<div class=\"description\">Stored for forward compatibility. Current firmware schedules captures on a hardcoded cadence (once on boot plus once daily at noon local time, CET/CEST per TZ_EU_CENTRAL) and does not yet read this field at runtime. The 60000 ms default is preserved against the eventual wiring; tracked at issue #65.</div>");
  client.println("</div>");

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
                    // client-side validator skips this field when the input is
                    // tagged data-keep-current-on-empty (see sendConfigForm);
                    // the server-side conditional below is the authoritative
                    // half of the contract. Test-debt: this branch is inside
                    // runAccessPoint and is not reachable from the native
                    // unity tests; PR-47 verified it end-to-end on hardware
                    // (View Source → blank submit → WiFi rejoin) but a
                    // regression that re-introduces unconditional assignment
                    // would only surface in hardware testing today. Tracked
                    // for extraction into a host-testable helper at issue #57.
                    String submittedPw = getParam(query, "password");
                    submittedPw.trim();
                    if (submittedPw.length() > 0) {
                      cfg_password = submittedPw;
                    }

                    // NEW: split URL fields
                    String uploadBase     = getParam(query, "upload_base");
                    String uploadEndpoint = getParam(query, "upload_endpoint");


                    // initURL
                    String initBase     = getParam(query, "init_base");
                    String initEndpoint = getParam(query, "init_endpoint");

                    // Normalise and combine into cfg_upload_url
                    uploadBase.trim();
                    uploadEndpoint.trim();
                    initBase.trim();
                    initEndpoint.trim();

                    // upload
                    if (uploadBase.endsWith("/")) {
                      uploadBase.remove(uploadBase.length() - 1);
                    }
                    if (uploadEndpoint.startsWith("/")) {
                      uploadEndpoint = uploadEndpoint.substring(1);
                    }

                    if (uploadBase.length() > 0 && uploadEndpoint.length() > 0) {
                      cfg_upload_url = uploadBase + "/" + uploadEndpoint;
                    } else {
                      // if no endpoint, just store base
                      cfg_upload_url = uploadBase;
                    }

                    // init
                    if (initBase.endsWith("/")) {
                      initBase.remove(initBase.length() - 1);
                    }
                    if (initEndpoint.startsWith("/")) {
                      initEndpoint = initEndpoint.substring(1);
                    }

                    if (initBase.length() > 0 && initEndpoint.length() > 0) {
                      cfg_init_url = initBase + "/" + initEndpoint;
                    } else {
                      // if no endpoint, just store base
                      cfg_init_url = initBase;
                    }

                    cfg_interval_ms = getParam(query, "interval").toInt();
                    // Server-side floor (issue #20). The form's `min="10"` is
                    // client-side only and trivially bypassed by curl, an
                    // empty submit, or a non-numeric value (which `toInt()`
                    // coerces to 0). Clamp to the safe default so SPIFFS can
                    // never hold a near-zero interval. The threshold of 10 ms
                    // mirrors the form's stated minimum and rejects only the
                    // pathological values (0 / negative). TODO when
                    // CAPTURE_INTERVAL is wired through the capture scheduler
                    // (issue #65), raise this to
                    // the form-recommended default (60000 ms) so the lower
                    // bound matches the operational tradeoff the form copy
                    // and `esp-flashing.md` advertise — there is no honest
                    // reason to silently accept a 5 s interval when we tell
                    // the operator 60 s is the field default.
                    if (cfg_interval_ms < 10) {
                      cfg_interval_ms = 60000;
                    }
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

