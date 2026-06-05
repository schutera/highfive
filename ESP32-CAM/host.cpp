#include <WiFi.h>
#include <SPIFFS.h>
#include <FS.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include "esp_init.h"   // setESPConfigured
#include "form_query.h" // hf::urlDecode, hf::getParam, hf::resolveKeepCurrentField (host-testable)
#include "led.h"        // ledTick during the AP server loop
#include <string>

const char *HOST_SSID = "ESP32-Access-Point";
const char *HOST_PASSWORD = "esp-12345";

WiFiServer server(80); // port 80
int server_running = 0;
String sessionToken;

String header;

// The captive portal is Wi-Fi-credentials-only (PR: simplify ESP config to
// SSID+password). Module name, server URLs and camera settings are no longer
// operator-editable — they are derived under the hood at boot by
// esp_init.cpp's loadConfig (MAC-derived name, compile-time URL defaults from
// firmware_defaults.h, production camera fallbacks). So only the two Wi-Fi
// fields have a RAM shadow here.
String cfg_ssid     = "";
String cfg_password = "";


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

// HTML-attribute-escape an operator-controlled value before echoing it
// into the config form. The only reflected operator input on this page is
// the saved SSID (`cfg_ssid`); the password is never echoed and the
// session token is server-generated hex. See `hf::htmlEscape` for why
// this matters now that the saved page runs a script and holds a
// window.opener handle to the wizard tab.
String htmlEscape(const String& src) {
  return String(hf::htmlEscape(std::string(src.c_str())).c_str());
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

  // Wi-Fi-credentials-only captive portal: prefill only the SSID (so a
  // reconfiguring operator sees their current network). The password is
  // never echoed back into the form (#46) but we load it so the "leave
  // blank to keep current" contract in `/save` can fall through to it.
  // Module name, server URLs and camera settings are not operator-editable
  // here — esp_init.cpp's loadConfig owns those defaults — so they are not
  // read.
  cfg_ssid     = doc["NETWORK"]["SSID"]     | "";
  cfg_password = doc["NETWORK"]["PASSWORD"] | "";
}

/*
  ----------------------------------
  -- UPDATE JSON CONFIG ON DEVICE --
  ----------------------------------
*/
void saveConfig() {
  StaticJsonDocument<1024> doc;

  JsonObject net  = doc.createNestedObject("NETWORK");

  // Only Wi-Fi credentials are persisted. Module name, server URLs and
  // camera settings are intentionally absent from /config.json: esp_init.cpp's
  // loadConfig derives them under the hood (MAC-derived name, compile-time
  // URL defaults from firmware_defaults.h, production camera fallbacks) when
  // the keys are missing, so a Wi-Fi-only config is complete.
  net["SSID"]        = cfg_ssid;
  net["PASSWORD"]    = cfg_password;

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
  // config.json", and leave `cfg_ssid`/`cfg_password` at their initial empty
  // strings — the form simply renders as first-time setup. On
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
// Wi-Fi-credentials-only captive portal. The page asks for nothing but the
// home Wi-Fi SSID + password; module name, server URLs and camera settings
// are derived under the hood (see saveConfig / esp_init.cpp's loadConfig).
void sendConfigForm(WiFiClient &client, bool saved = false) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-type:text/html");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Connection: close");
  client.println();
  client.println("<!DOCTYPE html><html><head>");
  client.println("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  client.println("<title>ESP32 Configuration</title>");

  // Honey/bee visual language mirrored from the homepage design tokens
  // (homepage/src/style.css — the sRGB-fallback hex values, chosen for
  // broad in-app-browser compatibility on phones). Keeps the captive
  // portal visually consistent with the setup wizard the operator just
  // came from. Class names are unchanged so the form HTML + validator
  // below keep working.
  client.println(
  "<style>"
  ":root{"
  "  --primary:#ed8936;"      // hf-honey-500
  "  --primary-dark:#dd6b20;" // hf-honey-600
  "  --bg:#fdfcf9;"           // hf-paper
  "  --card:#ffffff;"         // hf-surface
  "  --text:#1f1d18;"         // hf-ink
  "  --soft:#54514a;"         // hf-ink-soft
  "  --muted:#84807a;"        // hf-ink-mute
  "  --border:#e8e4dd;"       // hf-line
  "  --honey-100:#fff3d6;"
  "  --error:#e11d48;"        // hf-danger
  "}"

  "*{box-sizing:border-box;}"
  "body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','Inter','Roboto','Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;background:var(--bg);color:var(--text);line-height:1.55;}"
  ".container{max-width:460px;margin:0 auto;padding:32px 20px;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;}"
  ".card{background:var(--card);border-radius:20px;box-shadow:0 2px 6px rgba(0,0,0,0.05),0 8px 24px rgba(0,0,0,0.08);padding:28px;}"

  ".brand{display:flex;justify-content:center;margin-bottom:14px;}"
  ".brand-badge{width:64px;height:64px;border-radius:999px;background:var(--honey-100);display:flex;align-items:center;justify-content:center;font-size:32px;}"
  "h1{text-align:center;margin:0 0 6px;font-size:22px;font-weight:700;letter-spacing:-0.02em;}"
  ".lede{text-align:center;color:var(--soft);font-size:14px;margin:0 0 22px;}"

  ".section{margin-top:4px;}"
  ".section-desc{font-size:13px;color:var(--muted);margin-bottom:18px;}"

  ".field{margin-bottom:18px;}"
  "label{display:block;font-weight:600;font-size:14px;margin-bottom:6px;}"

  "input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--border);font-size:16px;background:#fcfbf9;color:var(--text);}"
  "input:focus{outline:none;border-color:var(--primary);background:#fff;box-shadow:0 0 0 4px rgba(237,137,54,0.22);}"

  ".description{font-size:12px;color:var(--muted);margin-top:6px;}"

  ".error-field{border-color:var(--error) !important;background:#fff5f5 !important;}"
  ".error-message{color:var(--error);font-size:13px;margin-top:12px;text-align:center;display:none;}"

  "button{margin-top:8px;width:100%;padding:13px;border:none;border-radius:999px;font-size:15px;font-weight:600;background:var(--primary);color:#fff;cursor:pointer;transition:background .2s;}"
  "button:hover{background:var(--primary-dark);}"

  ".message{background:#eaf7ee;color:#14532d;border:1px solid #bfe6cc;padding:14px;border-radius:12px;margin-bottom:18px;font-size:14px;text-align:center;}"
  ".message strong{display:block;margin-bottom:2px;}"

  // Dark mode: honour the device's prefers-color-scheme so the portal
  // matches the rest of the app (which also flips on this query). The
  // portal is a separate origin and can't read the homepage's manual theme
  // toggle, so the OS preference is the only signal — and it's the
  // homepage's primary trigger too. OKLCH values are copied verbatim from
  // the homepage dark tokens (homepage/src/style.css); the honey accents
  // (badge bg, button) intentionally stay as-is, mirroring how the homepage
  // keeps brand colours constant across themes. A browser without OKLCH
  // support keeps the light :root hex above — acceptable degradation.
  "@media (prefers-color-scheme: dark){"
  "  :root{"
  "    --bg:oklch(18% 0.015 60);"
  "    --card:oklch(22% 0.015 60);"
  "    --text:oklch(96% 0.01 80);"
  "    --soft:oklch(80% 0.01 80);"
  "    --muted:oklch(65% 0.01 80);"
  "    --border:oklch(32% 0.015 60);"
  "  }"
  "  input{background:oklch(25% 0.015 60);}"
  "  input:focus{background:oklch(27% 0.015 60);}"
  "  .message{background:oklch(32% 0.05 150);color:oklch(90% 0.08 150);border-color:oklch(45% 0.08 150);}"
  "}"
  "</style>"
  );

  /* ===== VALIDATION SCRIPT ===== */
  // Only the SSID is required. The password input is tagged
  // data-keep-current-on-empty when a password is already saved, so an empty
  // submission is allowed (the /save handler keeps the current password via
  // hf::resolveKeepCurrentField). The hidden session field is skipped.
  client.println(
  "<script>"
  "function validateForm(event){"
  "  event.preventDefault();"
  "  let valid=true;"
  "  const fields=document.querySelectorAll('input');"
  "  fields.forEach(f=>{"
  "    if(f.type==='hidden'){return;}"
  "    if(f.dataset.keepCurrentOnEmpty==='1' && f.value===''){"
  "      f.classList.remove('error-field');"
  "      return;"
  "    }"
  "    if(f.value.trim()===''){"
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
  // Bee badge + lede mirror the setup wizard's branded step cards so the
  // operator sees one continuous visual language. Bee glyph as an HTML
  // entity (&#128029;) keeps this source file pure-ASCII.
  client.println("<div class=\"brand\"><div class=\"brand-badge\" aria-hidden=\"true\">&#128029;</div></div>");
  // Saved render is a clean confirmation that early-returns below — the
  // WiFi form is NOT re-shown. Re-rendering an editable form with a "Save"
  // button under a "Saved!" banner reads as "did it actually save?".
  if (saved) {
    client.println("<h1>You&rsquo;re all set</h1>");
    client.println("<div class=\"message\"><strong>Saved &mdash; your module is connecting.</strong> This page will close and take you back to setup. If it doesn't, switch back to the HiveHive tab.</div>");
    // Auto-return to the setup wizard. The wizard (the window that opened
    // this page via window.open) listens for exactly this message string
    // in homepage/src/components/setup/useSetupWizard.ts and advances to
    // the verification step. targetOrigin '*' because the wizard origin
    // varies (production vs LAN dev) and the payload is a non-secret
    // literal. window.close() only works for script-opened windows; the
    // banner copy above covers browsers that block it.
    client.println("<script>");
    client.println("try{if(window.opener){window.opener.postMessage('hivehive-config-saved','*');}}catch(e){}");
    client.println("setTimeout(function(){try{window.close();}catch(e){}},1800);");
    client.println("</script>");
    client.println("</div></div></body></html>");
    client.println();
    return;
  }

  client.println("<h1>Connect your module to WiFi</h1>");
  client.println("<p class=\"lede\">Enter your home WiFi and your module takes care of the rest.</p>");

  client.println("<form action=\"/save\" method=\"POST\" autocomplete=\"off\" onsubmit=\"validateForm(event)\">");
  client.println("<input type=\"hidden\" name=\"session\" value=\"" + sessionToken + "\">");

  /* ===== WIFI ===== */
  client.println("<div class=\"section\">");
  client.println("<div class=\"section-desc\">Enter your home WiFi name and password. That's all — your module sets everything else up automatically.</div>");

  client.println("<div class=\"field\">");
  client.println("<label>WiFi SSID</label>");
  client.println("<input type=\"text\" name=\"ssid\" value=\"" + htmlEscape(cfg_ssid) + "\">");
  client.println("<div class=\"description\">Your WiFi must be 2.4 GHz — the module cannot use 5 GHz networks.</div>");
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

  client.println("</div>");  // end WIFI section

  client.println("<button type=\"submit\">Save Configuration</button>");
  client.println("<div id=\"errorText\" class=\"error-message\">Enter your WiFi name before saving.</div>");

  client.println("</form>");

  // No factory-reset control: reconfiguring is done by re-flashing (which
  // erases the saved config and reopens this page), and the firmware also
  // auto-reopens this access point after WIFI_FAIL_AP_FALLBACK_THRESH failed
  // joins. See docs/07-deployment-view/esp-flashing.md.
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
                    cfg_ssid     = getParam(query, "ssid");
                    // Empty submission means "keep current password" (#46): the
                    // form never pre-fills the field, so a user editing only the
                    // SSID would otherwise wipe their saved credential. The HTML
                    // half (`pwKeepAttr` in `sendConfigForm` above) tags the
                    // password input with `data-keep-current-on-empty="1"` and the
                    // JS validator skips validation when empty; this assignment
                    // honours the same shape on the server. Logic lives in
                    // `hf::resolveKeepCurrentField` (lib/form_query/) — host-
                    // testable as of #57; whitespace-trim and blank-keep semantics
                    // are pinned by 5 Unity tests in test/test_native_form_query/.
                    cfg_password = resolveKeepCurrentField(getParam(query, "password"), cfg_password);

                    // Wi-Fi-credentials-only: module name, server URLs and camera
                    // settings are no longer operator-entered. Any such fields a
                    // legacy client still POSTs are ignored here; the firmware
                    // derives them under the hood at boot (esp_init.cpp's
                    // loadConfig).
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

