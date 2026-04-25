#ifndef CLIENT_H
#define CLIENT_H

#include "esp_init.h"

// URL parsing now lives in lib/url (host-testable). The old url_t struct
// has been retired; client.cpp uses hf::Url internally.

int postImage(esp_config_t *esp_config);

#endif
