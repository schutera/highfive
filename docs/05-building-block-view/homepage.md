# Homepage Documentation

This document describes the structure, pages, and backend connection of the
HighFive homepage — a React frontend application served on port `5173`.

The homepage guides users through the full workflow:

- **Hardware acquisition** — parts list and assembly guide
- **Firmware installation** — web-based ESP32 flashing
- **Module configuration** — WiFi and backend setup
- **Data exploration** — dashboard access

<br>

## 1. Tech Stack

| Layer      | Technology                        |
| ---------- | --------------------------------- |
| Framework  | React 18 + Vite                   |
| Language   | TypeScript                        |
| Styling    | Tailwind CSS                      |
| Routing    | React Router DOM                  |
| ESP Flash  | esp-web-tools (Web Serial API)    |

<br>

## 2. Pages & Routes

The application is a single-page app with client-side routing.
All routes are registered in `homepage/src/App.tsx`.

| Route            | Component         | Description                                      |
| ---------------- | ----------------- | ------------------------------------------------ |
| `/`              | `HomePage`        | Landing page with hardware options and user flow |
| `/dashboard`     | `DashboardPage`   | Live module data and map view                    |
| `/parts-list`    | `PartsList`       | Hardware components, prices, and assembly guide  |
| `/web-installer` | `WebInstaller`    | ESP32 firmware flashing via browser              |
| `/setup-guide`   | `SetupGuide`      | WiFi config, backend setup, troubleshooting      |

<br>

## 3. Page Details

### HomePage (`/`)

Entry point for new users. Contains:

- Hero section with link to dashboard and scroll-to how-it-works anchor
- **Get Hardware** section — links to `/parts-list` for DIY builds and a
  `mailto:` link for complete kit purchase inquiries
- **Flash & Setup** section — links to `/web-installer`
- **Discover & Contribute** section — links to `/dashboard`

The buy button uses a `mailto:` link for kit purchase inquiries:

```tsx
href="mailto:info@highfive-bees.com?subject=HighFive%20Kit%20Inquiry"
```

### PartsList (`/parts-list`)

Two-part page:

**1. Parts List** — all hardware components with specifications and indicative prices:

| Component         | Key Specification               | Indicative Price |
| ----------------- | ------------------------------- | ---------------- |
| ESP32-CAM Board   | Development board with camera   | 8–12 €           |
| PV Module         | 10 Wp mono 12 V panel           | 12–18 €          |
| Charge Controller | CN3791 MPPT single-cell module  | 2–4 €            |
| Battery Pack      | 2 × LiFePO₄ 3.2 V, 3–4 Ah      | 8–16 €           |
| BMS               | 1S LiFePO₄ with temp. cut-off   | 3–5 €            |
| Boost Converter   | MT3608 3.2 V → 5 V module       | 2–4 €            |

Estimated total: **35–59 €**

**2. Assembly Guide** — four step-by-step sections:

- Step 1: Wire the power system (solar panel → CN3791 → BMS → MT3608 → ESP32-CAM)
- Step 2: Flash the firmware via web installer
- Step 3: Configure the module via `HiveHive-Access-Point` and `192.168.4.1`
- Step 4: Mount the module outdoors (south-facing, 1–2 m height, camera aimed at bee hotel)

### WebInstaller (`/web-installer`)

Handles ESP32 firmware flashing directly in the browser using
[esp-web-tools](https://esphome.github.io/esp-web-tools/).

**Requirements:**
- Google Chrome or Microsoft Edge (Web Serial API)
- USB data cable (not charge-only)

**Flow:**

1. Page loads the `esp-web-install-button` script from `unpkg.com`
2. On mount, the latest firmware version is fetched from the GitHub Releases API:
   ```
   GET https://api.github.com/repos/schutera/highfive/releases/latest
   ```
3. If a `firmware.bin` asset is found in the release, its download URL is used.
   Otherwise the page falls back to `/firmware.bin` (local file).
4. The user connects the ESP32 via USB and clicks **Install firmware**
5. After successful flash, a link leads to `/setup-guide`

### SetupGuide (`/setup-guide`)

Three-step configuration guide shown after flashing:

- **Step 1: WiFi Configuration** — connect to `HiveHive-Access-Point`,
  open `192.168.4.1`, enter home WiFi credentials
- **Step 2: Module Deployment** — placement guidelines (south-facing,
  weather protection, 1–2 m height, camera alignment)
- **Step 3: Backend Configuration** — set Initialization Base URL
  (port `8002`, endpoint `/new_module`) and Upload Base URL
  (port `8000`, endpoint `/upload`)

**Interactive Troubleshooting** — accordion section with six common issues:

| Issue | Solution |
| --- | --- |
| Access point does not appear | Power cycle the module and retry |
| `192.168.4.1` does not open | Ensure connected to `HiveHive-Access-Point`, navigate manually |
| ESP32 not detected in installer | Use a data USB cable, use Chrome or Edge |
| Module not on dashboard | Check port `8002` and `/new_module` endpoint |
| No image uploads | Check port `8000` and `/upload` endpoint |
| Need to reconfigure | Hold left button 10–15 seconds for factory reset |

<br>

## 4. Backend Connection

The homepage connects to two backend services at runtime.

### DuckDB Service (port `8002`)

Used by the dashboard to load module data. All requests go through
`homepage/src/services/api.ts`.

Example calls:

```
GET http://<host>:8002/modules        → list all registered modules
GET http://<host>:8002/module/<id>    → get single module details
```

### Classification Backend (port `8000`)

The ESP32 modules upload images directly to this service — not through
the homepage. The homepage only reads the processed results via the
DuckDB service.

```
POST http://<host>:8000/upload        → image upload from ESP32 module
```

<br>

## 5. What Changed

Previously the homepage contained only placeholder buttons that led
nowhere. The following pages were built out as part of the
`web_installer_dev` branch:

| What | Before | After |
| --- | --- | --- |
| Buy Kit button | `href="#buy-kit"` (dead anchor) | `mailto:` link for purchase inquiries |
| Parts List | Placeholder components and prices | Real hardware specs and prices from BOM |
| Assembly Guide | Did not exist | Four-step guide based on actual hardware wiring and `esp-deployment.md` |
| Web Installer | Flash button only, one-line instruction | "Before you start" connection guide with USB cable note |
| Setup Guide | Two steps (WiFi + placement) | Three steps + interactive troubleshooting accordion (6 issues) |
