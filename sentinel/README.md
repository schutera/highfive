# ESP32-CAM-MB Code

This directory contains all code and resources for the ESP32-CAM-MB module used in the highfive project.

## Overview
The ESP32-CAM-MB is a low-cost development board with a camera module, ideal for IoT and computer vision applications. In this project, it will be used to monitor wild bees and collect image data, which is send to a central application via WiFi.

## Contents
- Firmware source code for the ESP32-CAM-MB
- Example sketches and scripts
- Documentation for setup and usage

## Getting Started
1. **Hardware Required:**
   - ESP32-CAM-MB module
   - The development board (ESP32-CAM-MB base) where the USB cable is plugged in
   - Camera module (OV2640)


2. **Software Options:**
**a. Arduino IDE:**
    - Download and install the [Arduino IDE](https://www.arduino.cc/en/software).
    - Install the ESP32 board support via Boards Manager (search for "esp32" by Espressif Systems).
    - Open the provided `esp32-cam-capture.ino` sketch.
    - Select the correct board (e.g., "AI Thinker ESP32-CAM") and COM port.
    - Enter your WiFi credentials in the sketch.
    - Upload the sketch to your ESP32-CAM-MB.

---

Alternatively, you can use the ESP-IDF Extension in VS Code:

- Open the ESP-IDF Extension (ESP icon in sidebar).
- Follow the setup wizard if prompted.
- Create a new project: Press F1 (or Ctrl+Shift+P) → `ESP-IDF: New Project`.
- Select a template, workspace folder, and project name.
- Configure, build, flash, and monitor using the command palette (F1) and searching for `ESP-IDF:` commands.

---

- Connect the ESP32-CAM-MB to your computer (USB).
- Open or create a project in your chosen environment.
- Select the correct board and port.
- Upload the firmware from this repo.

## Functionality
A basic Arduino sketch is provided in this folder as `esp32-cam-capture.ino`. This sketch will:
- Initialize the ESP32-CAM-MB and camera module
- Connect to your WiFi network (ESP only supports 2.4GHz networks)
- Start a web server to capture and serve images

### Usage Steps
1. Open `esp32-cam-capture.ino` in Arduino IDE or PlatformIO.
2. Enter your WiFi credentials in the `ssid` and `password` fields.
3. Upload the sketch to your ESP32-CAM-MB.
4. Open the Serial Monitor to find the device's IP address.
5. Access `http://<device-ip>/` in your browser to view captured images.

## ESP32-CAM: Capture and Send Images Over WiFi

You can use your ESP32-CAM-MB to capture images and send them over WiFi. There are two main approaches:

### 1. Using Arduino IDE
- Open `esp32-cam-capture.ino` in Arduino IDE or PlatformIO.
- Enter your WiFi credentials in the `ssid` and `password` fields.
- Upload the sketch to your ESP32-CAM-MB.
- The ESP32-CAM will start a web server. Open the Serial Monitor to find the device's IP address.
- Access `http://<device-ip>/` in your browser to view and capture images.

#### Example Use Case
This setup is ideal for remote monitoring, such as observing wild bees, by capturing images and sending them to a central application or server over WiFi.


## How to Store WiFi Credentials Securely

To avoid exposing WiFi credentials we use a separate `secrets.h` file that is not tracked by git:

1. **Create a file named `secrets.h` in the same directory as your sketch:**
   ```cpp
   // secrets.h
   #define WIFI_SSID "your_real_ssid"
   #define WIFI_PASSWORD "your_real_password"
   ```
2. **Add `secrets.h` to your `.gitignore` file:**
   ```
   secrets.h
   ```
3. **In your sketch, include `secrets.h` and use the defines:**
   ```cpp
   #include "secrets.h"
   const char* ssid = WIFI_SSID;
   const char* password = WIFI_PASSWORD;
   ```

This way, your credentials are never pushed to GitHub, but your code will still compile and run locally.
Of course, if you only work locally or do not plan to share your code, you can simply insert your credentials directly in the code (not recommended for public repositories).

If you need to share your code or work in a team, always use the `secrets.h` approach to keep your WiFi credentials private and secure.

## References
- [ESP32-CAM-MB Documentation](https://randomnerdtutorials.com/esp32-cam-video-streaming-web-server-camera-home-assistant/)
- [Espressif ESP32-CAM Datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-cam_datasheet_en.pdf)

## Note for Arduino IDE Users

If you are using the Arduino IDE (and not ESP-IDF), you only need the `esp32-cam-capture.ino` sketch provided in this folder. You do not need to use the ESP-IDF or its related instructions. 

**Quick Steps:**
1. Open Arduino IDE.
2. Install the ESP32 board support via Boards Manager.
3. Select the correct board (e.g., "AI Thinker ESP32-CAM") and COM port.
4. Open `esp32-cam-capture.ino`.
5. Enter your WiFi credentials in the sketch.
6. Upload the sketch to your ESP32-CAM-MB.
7. Open the Serial Monitor to find the device's IP address.
8. Access `http://<device-ip>/` in your browser to view captured images.

You can ignore any ESP-IDF-specific instructions if you are only using Arduino IDE.

---

## Step-by-Step: Flashing ESP32-CAM with Arduino IDE

1. **Open Arduino IDE.**
2. **Install ESP32 board support:**
   - Go to File > Preferences.
   - In “Additional Boards Manager URLs”, add:
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   - Go to Tools > Board > Boards Manager, search for “esp32”, and install it.
3. **Select the correct board and port:**
   - Tools > Board > “AI Thinker ESP32-CAM” (or similar).
   - Tools > Port > (select your ESP32-CAM’s COM port).
4. **Open your `esp32-cam-capture.ino` sketch.**
5. **Create a `secrets.h` file** (if you haven’t already) with your WiFi credentials:
   - Make sure `secrets.h` is in the same folder as your `.ino` file.
6. **Upload the sketch to your ESP32-CAM-MB:**
   - Click the upload arrow.
7. **Open the Serial Monitor** to find the device’s IP address:
    - In Arduino IDE, click the magnifying glass icon in the top right corner or go to **Tools > Serial Monitor**.
    - Set the baud rate to `115200` (or the value specified in your sketch).
    - Wait for the device to connect to WiFi; the IP address will appear in the Serial Monitor output.
8. **Access `http://<device-ip>/` in your browser** to view the camera image.

If you need help with any of these steps or run into errors, let me know!

---
Add your code and documentation in this folder.
