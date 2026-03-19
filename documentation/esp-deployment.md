# HiveHive ESP32-CAM Module

HiveHive is a hardware module based on an ESP32 with an integrated camera.  
It captures images and uploads them to a server for processing and analysis.

---

# Initial Setup

## 1. Power On the Module
- Connect the HiveHive module to a power source
- On first startup, the module creates its own Wi-Fi network

## 2. Connect to the Module
- Open Wi-Fi settings on your computer or smartphone
- Connect to: **HiveHive-Access-Point**
- If connection fails:
  - Disconnect the module from power
  - Plug it in again and retry

## 3. Open Configuration Page
- Once connected, open a browser and go to:  
  **http://192.168.4.1**
- A configuration page will appear
- The module **must be configured before first use**

---

## Configuration Fields

### General
- **Module Name**  
  - Custom name of the module  
  - Can be set freely

- **Wi-Fi SSID & Password**  
  - Credentials of your local Wi-Fi network  

---

### Developer Setup

- **Initialization Base URL**  
  - IP address and port of the HiveHive manager server  
  - Default port: `8002`

- **Initialization Endpoint**  
  - Endpoint path for module registration  
  - Default: `/new_module`

- **Upload Base URL**  
  - IP address and port of the image processing server  
  - Default port: `8000`

- **Upload Endpoint**  
  - Endpoint path for image upload  
  - Default: `/upload`

---

### Optional

- **Image Quality Settings**  
  - Adjust image resolution and quality  

---

## What Happens After Configuration
- The ESP32 creates a HiveHive module automatically  
- The module appears on the dashboard:  
  **http://<hivehive.com>:5173/dashboard**  
- It automatically transmits:
  - Current location  
  - Battery level  
- The module connects to the backend and starts uploading images automatically  

---

## Network Requirements
- The module **requires a 2.4 GHz Wi-Fi network**
- A valid **server base URL** and **endpoint** must be provided
- Final request URLs are constructed as:  
  `Base URL + Endpoint`

---

## Reconfiguration (Factory Reset)
To reset and reconfigure the module:
- Press and hold the **left button** on the module for **10–15 seconds**
- The configuration will be reset
- Repeat the initial setup process

---

# Firmware Update

## Update Process
1. Connect the ESP32 module to your computer via USB  
2. Open:  
   **http://<hivehive.com>/web-installer**  
3. Use **Google Chrome** or **Microsoft Edge**  
4. Once the device is detected, click:  
   **"Firmware aufspielen"**  
5. The update process will start  
6. **Do not disconnect the USB cable during the update**

---

# Developer Notes (Troubleshooting)

## Compiling & Flashing via Arduino IDE

### Prerequisites
- Arduino IDE with ESP32 support installed  
- USB adapter for ESP32-CAM  
- 2.4 GHz Wi-Fi network  

### Steps
1. Open the project in Arduino IDE  
2. Select the correct ESP32 board and serial port  
3. Compile and upload the firmware  
4. Open **Tools → Serial Monitor**  
5. Set baud rate to **115200**  

The Serial Monitor provides logs for:
- Wi-Fi connection  
- Image capture  
- Upload attempts  
- Errors and debugging  

---

-------

# Design Decisions

## Technology Choice
- The ESP32 firmware is implemented in **C++ using the Arduino IDE**

## User Experience Focus
The system is designed to minimize user effort:

- The user only needs to:
  - Connect once to the ESP32 access point  
  - Set a module name  
  - Enter Wi-Fi credentials  

- After that, everything happens automatically:
  - The ESP detects its location  
  - Connects to the target server  
  - Registers itself as a new module  
  - Starts automatic image uploads  

- The backend system:
  - Performs intelligent beehive detection  
  - Displays results in the HiveHive dashboard  

This ensures a **fully automated workflow after initial setup**, requiring no further user interaction.
