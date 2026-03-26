#ifndef CLIENT_H
#define CLIENT_H

#include <Arduino.h>
#include "esp_init.h"

typedef struct {
  String host;
  uint16_t port;
  String path;
} url_t;

int postImage(esp_config_t *esp_config);

#endif