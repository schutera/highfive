#include "tls_client.h"

namespace hf {
namespace tls {

void configureBoundedClient(WiFiClientSecure& client, const char* caPem) {
  // Pin the trust anchor first (peer verification), then bound the
  // handshake. Both must be set before connect(); order between them is
  // irrelevant. setCACert on an already-connected TLS client is undefined
  // behaviour in mbedTLS, so callers invoke this only on a fresh connect.
  client.setCACert(caPem);
  client.setHandshakeTimeout(kHandshakeTimeoutSec);  // seconds; ESP32 default 120 s
}

}  // namespace tls
}  // namespace hf
