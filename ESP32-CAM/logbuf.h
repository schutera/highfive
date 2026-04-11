#ifndef LOGBUF_H
#define LOGBUF_H

#include <Arduino.h>

#define LOGBUF_SIZE       2048
#define HTTP_CODES_LEN    8

/*
  Circular log buffer + telemetry metrics collected on-device.

  logf() works like Serial.printf() but also appends to an in-memory
  ring buffer. The latest ~LOGBUF_SIZE bytes are then embedded in the
  JSON telemetry payload sent alongside each uploaded image, so that
  failures in the field can be diagnosed after the fact.
*/
void logbufInit();
void logf(const char *fmt, ...);

/* Metrics that upload_image includes in the telemetry payload */
void logbufNoteHttpCode(int code);
void logbufNoteWifiReconnect();

/*
  Serializes the log buffer + metrics into a compact JSON object.
  The returned String is intended to be put into a multipart form
  field named "logs".
*/
String buildTelemetryJson();

#endif
