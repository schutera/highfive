#include "ota.h"

#include "breadcrumb.h"
#include "logbuf.h"
#include "ota_version.h"
#include "url.h"

#include <Arduino.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <esp_task_wdt.h>
#include "tls_roots.h" // hf::tls::kIsrgRootX1Pem — issue #79

#include <cstring>
#include <string>

namespace hf {

namespace {

// Manifest is < 256 bytes today (5 short string/int fields + framing).
// 1 KB cap is generous and bounds heap pressure during boot.
constexpr size_t kManifestMaxBytes = 1024;

// Bytes per Update.write() call. Chosen to keep esp_task_wdt_reset()
// fired at least every ~400 ms over a 10 KB/s WiFi link, well under
// TASK_WDT_TIMEOUT_S=60. `postImage` in client.cpp uses 16 KB
// multipart chunks; OTA goes smaller because each Update.write() also
// performs a flash-erase amortisation step and we'd rather keep the
// WDT-feed cadence dense than save a few function-call boundaries.
constexpr size_t kOtaChunkBytes = 4096;

// Hard ceiling on the binary download wall-clock. Past this point a
// hung connection has more than exhausted the WDT budget anyway; the
// timeout is the secondary defence and exists mostly so a stale TCP
// half-close doesn't keep us in read() until the WDT panics.
constexpr unsigned long kOtaBinaryDeadlineMs = 120UL * 1000UL;

bool readLine(WiFiClient& c, char* out, size_t outLen, unsigned long timeoutMs) {
    size_t w = 0;
    unsigned long deadline = millis() + timeoutMs;
    while (millis() < deadline) {
        if (!c.available()) {
            if (!c.connected()) break;
            // Feed the WDT in the slow-poll branch. A header-read or
            // status-line-read on a drip-feeding server could otherwise
            // sit here for the full `timeoutMs` without feeding —
            // safe today because every caller uses <60 s, but a future
            // bump above TASK_WDT_TIMEOUT_S would silently watchdog-
            // reset. Defensive feed mirrors the binary body loop.
            esp_task_wdt_reset();
            delay(1);
            continue;
        }
        int b = c.read();
        if (b < 0) continue;
        if (b == '\r') continue;       // strip CR
        if (b == '\n') {
            if (w >= outLen) return false;
            out[w] = '\0';
            return true;
        }
        if (w + 1 >= outLen) return false;  // line too long, refuse
        out[w++] = static_cast<char>(b);
    }
    return false;
}

// Parse a status line of the form `HTTP/1.x NNN ...`. Returns the
// numeric status, or -1 on malformed.
int parseStatus(const char* statusLine) {
    if (!statusLine) return -1;
    const char* sp = std::strchr(statusLine, ' ');
    if (!sp) return -1;
    int code = 0;
    ++sp;
    while (*sp >= '0' && *sp <= '9') {
        code = code * 10 + (*sp - '0');
        ++sp;
    }
    return code > 0 ? code : -1;
}

// Read response headers up to the blank line. Captures Content-Length
// into *contentLen if present (0 if absent — caller must decide what
// to do with that).
bool readHeaders(WiFiClient& c, uint32_t* contentLen, unsigned long timeoutMs) {
    *contentLen = 0;
    char line[256];
    for (;;) {
        if (!readLine(c, line, sizeof(line), timeoutMs)) return false;
        if (line[0] == '\0') return true;  // end of headers
        // Case-insensitive "Content-Length:" match. Headers are
        // RFC-defined as case-insensitive; nginx ships them
        // capitalised but a different upstream may differ.
        if (strncasecmp(line, "Content-Length:", 15) == 0) {
            const char* v = line + 15;
            while (*v == ' ' || *v == '\t') ++v;
            uint64_t acc = 0;
            while (*v >= '0' && *v <= '9') {
                acc = acc * 10 + (*v - '0');
                if (acc > 0xFFFFFFFFULL) return false;
                ++v;
            }
            *contentLen = static_cast<uint32_t>(acc);
        }
    }
}

bool sendGet(WiFiClient& c, const std::string& host, uint16_t port,
             const std::string& path) {
    if (!c.connect(host.c_str(), port)) return false;
    c.print("GET ");
    c.print(path.c_str());
    c.print(" HTTP/1.1\r\nHost: ");
    c.print(host.c_str());
    // Omit the explicit ":<port>" when it matches the scheme default
    // (80 for HTTP, 443 for HTTPS) — RFC 7230 §5.4 says the Host header
    // SHOULD omit a default-port specifier, and some upstreams normalise
    // virthost lookup on the literal Host string.
    if (port != 80 && port != 443) {
        c.print(":");
        c.print(port);
    }
    c.print("\r\nUser-Agent: hivehive-ota/1.0\r\nConnection: close\r\n\r\n");
    return true;
}

}  // namespace

void httpOtaCheckAndApply(const esp_config_t* config) {
    if (!config) return;

    // Derive the homepage origin from the captive-portal-saved
    // INIT_URL. Production: host-nginx fronts homepage and backend on
    // the same hostname; the `location = /firmware.json` and
    // `location = /firmware.app.bin` blocks in the port-80 vhost (see
    // production-deployment.md) proxy to the homepage static. Dev /
    // self-hosted topologies that put homepage on a different port can
    // set INIT_URL with the explicit `:<port>` and that is honoured.
    hf::breadcrumbSet("ota:parse_url");
    hf::Url initParsed = hf::parseUrl(std::string(config->INIT_URL));
    if (initParsed.host.empty()) {
        logf("[OTA] no host in INIT_URL — skipping");
        return;
    }
    // OTA traffic uses verified TLS to the same host as the rest of
    // the firmware's calls (highfive.schutera.com). #79 added the
    // server-trust infrastructure and migrated the heartbeat / upload
    // / registration paths; this fetch piggybacks on the same trust
    // anchor (ISRG Root X1). LAN-dev topologies that put the homepage
    // on a different port / host are still honoured — the operator's
    // INIT_URL is parsed as-is and the same scheme+port are used here.
    // Originally tracked separately as issue #81; folded in.
    const bool useTls = (initParsed.scheme == "https");
    const uint16_t port = initParsed.port ? initParsed.port :
                          (useTls ? 443 : 80);

    // ---- Manifest fetch ----
    // The TLS handshake heap (~30 KB transient) is in scope of the
    // function — only one of `client` / `binClient` is alive at a
    // time, so we don't double-pay the BearSSL context cost.
    hf::breadcrumbSet("ota:manifest_fetch");
    WiFiClientSecure tlsClient;
    WiFiClient plainClient;
    WiFiClient& client = useTls ? static_cast<WiFiClient&>(tlsClient)
                                : plainClient;
    if (useTls) {
        tlsClient.setCACert(hf::tls::kIsrgRootX1Pem);
    }
    client.setTimeout(10);  // seconds, applies to read

    if (!sendGet(client, initParsed.host, port, "/firmware.json")) {
        logf("[OTA] manifest connect failed");
        client.stop();
        return;
    }

    char statusLine[64];
    if (!readLine(client, statusLine, sizeof(statusLine), 10000)) {
        logf("[OTA] manifest no status line");
        client.stop();
        return;
    }
    const int manifestStatus = parseStatus(statusLine);
    logbufNoteHttpCode(manifestStatus);
    if (manifestStatus != 200) {
        logf("[OTA] manifest HTTP %d", manifestStatus);
        client.stop();
        return;
    }

    uint32_t manifestLen = 0;
    if (!readHeaders(client, &manifestLen, 10000)) {
        logf("[OTA] manifest header read failed");
        client.stop();
        return;
    }
    // manifestLen is 0 if the server sends chunked transfer-encoding
    // (no Content-Length header). nginx serves static files with a
    // Content-Length, so this is expected to be always set in
    // production. A chunked response is silently treated as "out of
    // range" and skipped — safe fallback, better than guessing the body.
    if (manifestLen == 0 || manifestLen > kManifestMaxBytes) {
        logf("[OTA] manifest length %u out of range", (unsigned)manifestLen);
        client.stop();
        return;
    }

    char body[kManifestMaxBytes + 1];
    size_t got = 0;
    unsigned long readDeadline = millis() + 10000UL;
    while (got < manifestLen && millis() < readDeadline) {
        if (!client.available()) {
            if (!client.connected() && client.available() == 0) break;
            delay(1);
            continue;
        }
        int b = client.read();
        if (b < 0) continue;
        body[got++] = static_cast<char>(b);
    }
    client.stop();
    if (got != manifestLen) {
        logf("[OTA] manifest short read %u/%u", (unsigned)got, (unsigned)manifestLen);
        return;
    }
    body[got] = '\0';

    hf::breadcrumbSet("ota:manifest_parse");
    hf::OtaManifest manifest{};
    if (!hf::parseOtaManifest(body, &manifest)) {
        logf("[OTA] manifest parse failed");
        return;
    }

    if (!hf::shouldOtaUpdate(FIRMWARE_VERSION, manifest.version)) {
        logf("[OTA] already current (version=%s)", manifest.version);
        return;
    }
    logf("[OTA] update available: %s -> %s (%u bytes, md5=%s)",
         FIRMWARE_VERSION, manifest.version,
         (unsigned)manifest.app_size, manifest.app_md5);

    // ---- Binary fetch + Update.write streaming ----
    // Fresh client for the second hop. The manifest's `client` went
    // out of scope (Connection: close), freeing its TLS context, so
    // this BearSSL handshake re-pays the heap cost — still cheaper
    // than holding two TLS contexts open simultaneously.
    hf::breadcrumbSet("ota:binary_fetch");
    WiFiClientSecure tlsBinClient;
    WiFiClient plainBinClient;
    WiFiClient& binClient = useTls ? static_cast<WiFiClient&>(tlsBinClient)
                                   : plainBinClient;
    if (useTls) {
        tlsBinClient.setCACert(hf::tls::kIsrgRootX1Pem);
    }
    binClient.setTimeout(15);

    if (!sendGet(binClient, initParsed.host, port, "/firmware.app.bin")) {
        logf("[OTA] binary connect failed");
        binClient.stop();
        return;
    }
    if (!readLine(binClient, statusLine, sizeof(statusLine), 15000)) {
        logf("[OTA] binary no status line");
        binClient.stop();
        return;
    }
    const int binStatus = parseStatus(statusLine);
    logbufNoteHttpCode(binStatus);
    if (binStatus != 200) {
        logf("[OTA] binary HTTP %d", binStatus);
        binClient.stop();
        return;
    }
    uint32_t binLen = 0;
    if (!readHeaders(binClient, &binLen, 15000)) {
        logf("[OTA] binary header read failed");
        binClient.stop();
        return;
    }
    if (binLen != manifest.app_size) {
        logf("[OTA] binary length %u != manifest %u",
             (unsigned)binLen, (unsigned)manifest.app_size);
        binClient.stop();
        return;
    }

    hf::breadcrumbSet("ota:update_begin");
    if (!Update.begin(binLen, U_FLASH)) {
        logf("[OTA] Update.begin failed (err=%u): %s",
             Update.getError(), Update.errorString());
        binClient.stop();
        return;
    }
    // setMD5 must be called before Update.end(true) so the rolling MD5
    // computed during Update.write() is compared against the manifest
    // value at end()-time. A mismatch causes end() to return false and
    // leaves the inactive slot unbootable — the bootloader continues
    // running the current slot on the next reset.
    if (!Update.setMD5(manifest.app_md5)) {
        logf("[OTA] Update.setMD5 failed");
        Update.abort();
        binClient.stop();
        return;
    }

    uint8_t buf[kOtaChunkBytes];
    uint32_t written = 0;
    unsigned long binDeadline = millis() + kOtaBinaryDeadlineMs;
    while (written < binLen) {
        if (millis() > binDeadline) {
            logf("[OTA] binary read deadline exceeded at %u/%u",
                 (unsigned)written, (unsigned)binLen);
            Update.abort();
            binClient.stop();
            return;
        }
        int avail = binClient.available();
        if (avail <= 0) {
            if (!binClient.connected() && binClient.available() == 0) {
                logf("[OTA] binary connection closed at %u/%u",
                     (unsigned)written, (unsigned)binLen);
                Update.abort();
                binClient.stop();
                return;
            }
            // Feed the WDT even on a stalled receive: kOtaBinaryDeadlineMs
            // (120 s) exceeds TASK_WDT_TIMEOUT_S (60 s), so a hung
            // connection that keeps the loop pegged with avail<=0 would
            // otherwise watchdog-reset before the deadline check fires.
            // The deadline is the desired bound; the WDT here is a
            // belt-and-braces against an extended silent stall.
            esp_task_wdt_reset();
            delay(1);
            continue;
        }
        const size_t want = (binLen - written) < kOtaChunkBytes
                                ? (binLen - written)
                                : kOtaChunkBytes;
        const int got_chunk = binClient.readBytes(buf, want);
        if (got_chunk <= 0) {
            delay(1);
            continue;
        }
        const size_t wrote = Update.write(buf, static_cast<size_t>(got_chunk));
        if (wrote != static_cast<size_t>(got_chunk)) {
            logf("[OTA] Update.write short %u/%d (err=%u)",
                 (unsigned)wrote, got_chunk, Update.getError());
            Update.abort();
            binClient.stop();
            return;
        }
        written += static_cast<uint32_t>(got_chunk);
        // Feed the WDT after every chunk. 4 KB at 10 KB/s WiFi = 400 ms,
        // comfortably under TASK_WDT_TIMEOUT_S=60.
        esp_task_wdt_reset();
        // Per-100KB breadcrumb so a stall mid-stream lands on a useful
        // crumb instead of staying on "ota:update_begin" for the entire
        // download. Compare the 100KB bucket before vs after this write
        // — true exactly when the running total crosses a boundary.
        const uint32_t prev = written - static_cast<uint32_t>(got_chunk);
        if (written / 102400u != prev / 102400u) {
            char crumb[40];
            snprintf(crumb, sizeof(crumb), "ota:body_read_%u_kb",
                     (unsigned)(written / 1024));
            hf::breadcrumbSet(crumb);
        }
    }
    binClient.stop();

    hf::breadcrumbSet("ota:update_end");
    if (!Update.end(true)) {
        logf("[OTA] Update.end failed (err=%u): %s",
             Update.getError(), Update.errorString());
        return;
    }
    if (!Update.isFinished()) {
        logf("[OTA] Update.isFinished false after end()");
        return;
    }
    logf("[OTA] flash complete — restarting onto new slot");
    delay(200);
    ESP.restart();
}

}  // namespace hf
