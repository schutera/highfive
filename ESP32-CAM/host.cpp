#include <WiFi.h>
#include <SPIFFS.h>
#include <FS.h>
#include <ArduinoJson.h>
#include "esp_init.h"

const char *HOST_SSID = "HiveHive-Access-Point";
const char *HOST_PASSWORD = NULL;  // open network (no password)

WiFiServer server(80); // port 80
int server_running = 0;
String sessionToken;

String header;

String cfg_module_name = "";
String cfg_ssid           = "";
String cfg_password       = "";
String cfg_email          = "";
String cfg_upload_url     = "http://highfive.schutera.com/upload";
String cfg_init_url       = "http://highfive.schutera.com/new_module";
String cfg_resolution     = "VGA";
int    cfg_interval_ms    = 86400000; // 24 hours
int    cfg_vflip          = 1;
int    cfg_brightness     = 1;
int    cfg_saturation     = -1;


/*
  -----------------------------
  ---------- HELPERS ----------
  -----------------------------
*/
String urlDecode(const String& src) {
  String decoded = "";
  char c;
  for (size_t i = 0; i < src.length(); i++) {
    c = src[i];
    if (c == '+') {
      decoded += ' ';
    } else if (c == '%' && i + 2 < src.length()) {
      char h1 = src[i + 1];
      char h2 = src[i + 2];
      int hi = isdigit(h1) ? h1 - '0' : toupper(h1) - 'A' + 10;
      int lo = isdigit(h2) ? h2 - '0' : toupper(h2) - 'A' + 10;
      decoded += char(hi * 16 + lo);
      i += 2;
    } else {
      decoded += c;
    }
  }
  return decoded;
}

String getParam(const String& query, const String& name) {
  String key = name + "=";
  int start = query.indexOf(key);
  if (start < 0) return "";
  start += key.length();
  int end = query.indexOf('&', start);
  if (end < 0) end = query.length();
  String value = query.substring(start, end);
  return urlDecode(value);
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
  cfg_email       = doc["NETWORK"]["EMAIL"]          | "";
  cfg_upload_url  = doc["NETWORK"]["UPLOAD_URL"]     | "";
  cfg_init_url    = doc["NETWORK"]["INIT_URL"]       | "";

  cfg_interval_ms = doc["CAMERA"]["CAPTURE_INTERVAL_IN_MS"] | 0;
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
  net["EMAIL"]       = cfg_email;
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
  if (serializeJson(doc, f) == 0) {
    Serial.println("Failed to write JSON to file");
  }
  f.close();

  setESPConfigured(true);
}

/*
  ----------------------------------
  -------- HTML CONFIG FORM --------
  ----------------------------------
*/
void sendConfigForm(WiFiClient &client, bool saved = false) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-type:text/html");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Connection: close");
  client.println();
  client.println("<!DOCTYPE html><html><head>");
  client.println("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  client.println("<title>HiveHive Module Setup</title>");

  client.println(
  "<style>"
  ":root{"
  "  --primary:#f59e0b;"
  "  --primary-dark:#d97706;"
  "  --bg:#fffbeb;"
  "  --card:#ffffff;"
  "  --text:#1f2937;"
  "  --muted:#6b7280;"
  "  --border:#e5e7eb;"
  "  --error:#dc2626;"
  "}"

  "*{box-sizing:border-box;}"
  "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);}"
  ".container{max-width:480px;margin:40px auto;padding:0 20px;}"
  ".card{background:var(--card);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.08);padding:32px;}"
  "h1{text-align:center;margin-top:0;font-size:24px;}"
  ".subtitle{text-align:center;color:var(--muted);font-size:14px;margin-top:-8px;margin-bottom:24px;}"

  ".field{margin-bottom:18px;}"
  "label{display:block;font-weight:600;font-size:14px;margin-bottom:6px;}"

  "input{"
  "  width:100%;padding:10px 12px;border-radius:8px;"
  "  border:1px solid var(--border);font-size:14px;background:#fafafa;"
  "}"
  "input:focus{outline:none;border-color:var(--primary);background:#fff;box-shadow:0 0 0 3px rgba(245,158,11,0.2);}"

  ".description{font-size:12px;color:var(--muted);margin-top:6px;}"

  ".error-field{border-color:var(--error) !important;background:#fff5f5 !important;}"
  ".error-message{color:var(--error);font-size:13px;margin-top:12px;text-align:center;display:none;}"

  "button{margin-top:20px;width:100%;padding:14px;border:none;border-radius:999px;font-size:16px;font-weight:600;background:var(--primary);color:#fff;cursor:pointer;transition:0.2s;}"
  "button:hover{background:var(--primary-dark);}"

  ".message{background:#e6f4ea;color:#14532d;padding:14px;border-radius:8px;margin-bottom:16px;font-size:14px;text-align:center;}"
  "</style>"
  );

  client.println(
  "<script>"
  "function validateForm(event){"
  "  event.preventDefault();"
  "  let valid=true;"
  "  const fields=document.querySelectorAll('input[type=text],input[type=password]');"
  "  fields.forEach(f=>{"
  "    if(f.value.trim()===''){"
  "      f.classList.add('error-field');"
  "      valid=false;"
  "    }else{"
  "      f.classList.remove('error-field');"
  "    }"
  "  });"
  "  document.querySelectorAll('input[type=email]').forEach(f=>f.classList.remove('error-field'));"
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
  client.println("<h1>HiveHive Module Setup</h1>");
  client.println("<p class=\"subtitle\">Configure your module to get started.</p>");

  if (saved) {
    client.println("<div class=\"message\">Configuration saved! The module will now restart and connect to your WiFi.</div>");
  }

  client.println("<form action=\"/save\" method=\"POST\" autocomplete=\"off\" onsubmit=\"validateForm(event)\">");
  client.println("<input type=\"hidden\" name=\"session\" value=\"" + sessionToken + "\">");

  client.println("<div class=\"field\">");
  client.println("<label>Module Name</label>");
  client.println("<input type=\"text\" name=\"module_name\" placeholder=\"e.g. Garden Cam\" value=\"" + cfg_module_name + "\">");
  client.println("<div class=\"description\">Give your module a name to identify it.</div>");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>WiFi Network</label>");
  client.println("<input type=\"text\" name=\"ssid\" placeholder=\"Your WiFi name\" value=\"" + cfg_ssid + "\">");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>WiFi Password</label>");
  client.println("<input type=\"password\" name=\"password\" placeholder=\"Your WiFi password\" value=\"" + cfg_password + "\">");
  client.println("</div>");

  client.println("<div class=\"field\">");
  client.println("<label>Email <span style=\"font-weight:400;color:var(--muted)\">(optional)</span></label>");
  client.println("<input type=\"email\" name=\"email\" placeholder=\"you@example.com\" value=\"" + cfg_email + "\">");
  client.println("<div class=\"description\">Share your email so we can reach you with updates.</div>");
  client.println("</div>");

  client.println("<button type=\"submit\">Save &amp; Connect</button>");
  client.println("<div id=\"errorText\" class=\"error-message\">Please fill in all fields.</div>");

  client.println("</form></div></div></body></html>");
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
                  if (sessionParam == sessionToken || sessionParam == "hivehive-setup") {
                    cfg_module_name = getParam(query, "module_name");
                    cfg_ssid        = getParam(query, "ssid");
                    cfg_password    = getParam(query, "password");
                    cfg_email       = getParam(query, "email");

                    // Server URLs: web app sends base + endpoint separately
                    String init_base     = getParam(query, "init_base");
                    String init_endpoint = getParam(query, "init_endpoint");
                    String upload_base     = getParam(query, "upload_base");
                    String upload_endpoint = getParam(query, "upload_endpoint");

                    if (init_base.length() > 0 && init_endpoint.length() > 0) {
                      cfg_init_url = init_base + init_endpoint;
                    }
                    if (upload_base.length() > 0 && upload_endpoint.length() > 0) {
                      cfg_upload_url = upload_base + upload_endpoint;
                    }

                    // Camera settings (only overwrite when present)
                    String res = getParam(query, "res");
                    if (res.length() > 0) {
                      cfg_resolution = res;
                    }

                    String interval = getParam(query, "interval");
                    if (interval.length() > 0) {
                      cfg_interval_ms = interval.toInt();
                    }

                    String vflip = getParam(query, "vflip");
                    if (vflip.length() > 0) {
                      cfg_vflip = vflip.toInt();
                    }

                    String bright = getParam(query, "bright");
                    if (bright.length() > 0) {
                      cfg_brightness = bright.toInt();
                    }

                    String sat = getParam(query, "sat");
                    if (sat.length() > 0) {
                      cfg_saturation = sat.toInt();
                    }

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
  bool ok = WiFi.softAP(HOST_SSID);  // open network, no password
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

