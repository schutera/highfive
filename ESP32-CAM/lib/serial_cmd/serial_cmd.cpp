#include "serial_cmd.h"

#include <cctype>

namespace hf {

// Mirror of ESP32-CAM/build.sh's DEV_URL_FLAGS and extra_scripts.py's
// url_defines. Keep these three sites in lockstep; test_native_serial_cmd
// pins devUrlsFromHost against the build.sh-shaped literals.
const char* const kDevInitPort       = "8002";
const char* const kDevInitEndpoint   = "new_module";
const char* const kDevUploadPort     = "8000";
const char* const kDevUploadEndpoint = "upload";

namespace {
bool isSpace(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}
}  // namespace

SerialCmd parseSerialCmd(const std::string& line) {
  SerialCmd cmd;
  std::string tokens[3];
  int n = 0;
  size_t i = 0;
  const size_t len = line.size();
  while (i < len && n < 3) {
    while (i < len && isSpace(line[i])) ++i;       // skip separators
    if (i >= len) break;
    const size_t start = i;
    while (i < len && !isSpace(line[i])) ++i;       // consume one token
    tokens[n++] = line.substr(start, i - start);
  }
  if (n >= 1) {
    cmd.verb = tokens[0];
    for (char& c : cmd.verb) {
      c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
  }
  if (n >= 2) cmd.arg1 = tokens[1];
  if (n >= 3) cmd.arg2 = tokens[2];
  return cmd;
}

bool isBareHost(const std::string& s) {
  if (s.empty()) return false;
  for (char c : s) {
    if (c == ':' || c == '/' || c == '\\' || isSpace(c)) return false;
  }
  return true;
}

bool devUrlsFromHost(const std::string& host,
                     std::string& initUrlOut,
                     std::string& uploadUrlOut) {
  if (!isBareHost(host)) return false;
  initUrlOut   = "http://" + host + ":" + kDevInitPort   + "/" + kDevInitEndpoint;
  uploadUrlOut = "http://" + host + ":" + kDevUploadPort + "/" + kDevUploadEndpoint;
  return true;
}

}  // namespace hf
