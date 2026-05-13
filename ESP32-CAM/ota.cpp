#include "ota.h"

#include "breadcrumb.h"
#include "logbuf.h"
#include "ota_version.h"
#include "url.h"

#include <Arduino.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <esp_task_wdt.h>

#include <cstring>
#include <string>

namespace hf {

namespace {

// Manifest is < 256 bytes today (5 short string/int fields + framing).
// 1 KB cap is generous and bounds heap pressure during boot.
constexpr size_t kManifestMaxBytes = 1024;

// Bytes per Update.write() call. Chosen to keep esp_task_wdt_reset()
// fired at least every ~100 ms over a 10 KB/s WiFi link, well under
// TASK_WDT_TIMEOUT_S=60. Matches the cadence postImage uses for the
// multipart body write in client.cpp's postImage.
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
    if (port != 80) {
        c.print(":");
        c.print(port);
    }
    c.print("\r\nUser-Agent: hivehive-ota/1.0\r\nConnection: close\r\n\r\n");
    return true;
}

}  // namespace

void httpOtaCheckAndApply(const esp_config_t* config) {
    if (!config) return;

    // Derive the homepage origin from the captive-portal-saved INIT_URL.
    // Production: host-nginx fronts homepage and backend on the same
    // hostname, port 80. Dev modules speak a different port and won't
    // resolve the manifest path — those are USB-flashed anyway.
    hf::breadcrumbSet("ota:parse_url");
    hf::Url initParsed = hf::parseUrl(std::string(config->INIT_URL));
    if (initParsed.host.empty()) {
        logf("[OTA] no host in INIT_URL — skipping");
        return;
    }
    const uint16_t port = 80;  // homepage is served on :80 by host-nginx

    // ---- Manifest fetch ----
    hf::breadcrumbSet("ota:manifest_fetch");
    WiFiClient client;
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
    hf::breadcrumbSet("ota:binary_fetch");
    WiFiClient binClient;
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
