# ESP32-CAM Stream Test (Arduino IDE)

The fastest way to test your ESP32-CAM is the built-in **CameraWebServer** example — no extra code required.

## Install ESP32 Board Package

1. Open Arduino IDE
2. Go to **File > Preferences**
3. In **Additional Board Manager URLs**, add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
   (If there are already other URLs, separate them with a comma)
4. Go to **Tools > Board > Boards Manager**
5. Search for **esp32** and install **esp32 by Espressif Systems**
6. Restart Arduino IDE

## Stream Test

1. Go to **File > Examples > ESP32 > Camera > CameraWebServer**
3. In the sketch, uncomment the line for your board model:
   ```cpp
   #define CAMERA_MODEL_AI_THINKER
   ```
   Make sure all other `CAMERA_MODEL_*` defines are commented out.
4. Set your WiFi credentials near the top of the sketch:
   ```cpp
   const char *ssid = "YOUR_SSID";
   const char *password = "YOUR_PASSWORD";
   ```
5. Select board **AI Thinker ESP32-CAM** and flash it
6. Open **Serial Monitor** at **115200 baud** — it will print an IP address once connected
7. Open that IP in a browser — you get a live stream viewer with controls for resolution, quality, brightness, etc.

## Notes

- The ESP32 and your PC must be on the same WiFi network.
- If the serial monitor shows no IP, double-check SSID/password and make sure the antenna is connected.
- The browser UI has a **Start Stream** button — click it to begin the MJPEG stream.
