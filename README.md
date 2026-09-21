# WebSynapse

**Driverless, browser-based configuration tool for the Razer Naga V2 Pro.**

No Razer Synapse installation required. WebSynapse talks directly to your mouse over [WebHID](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API) — zero dependencies, zero build steps, just open `index.html` in your browser.

**Created by [CheekyEntity](https://github.com/CheekyEntity)**

## Features

### Sensor Performance
- **DPI** — Read and set your current DPI (100–30,000)
- **DPI Stages** — Configure 5 DPI presets with active stage indicator
- **Polling Rate** — 125 / 500 / 1000 Hz

### Power & Battery
- **Live Battery Level** with auto-refresh every 60 seconds
- **Charging Status** detection (⚡ icon)
- **Low Battery Threshold** — Configure warning percentage
- **Wireless Idle Time** — Set sleep timeout (1–15 min)
- **Charge Effect & Color** — Customize LED behavior while charging

### Advanced Lighting (Per-Zone)
- **Independent zone control** — Logo LED, Scroll Wheel, or All Zones
- **Brightness** — 0–100%
- **Effects** — Off, Static, Breathing, Spectrum Cycling, Reactive, Wave
- **Full RGB color picker** for color-based effects

### Quality of Life
- **Save/Load Profiles** — Default, Gaming, Work presets via localStorage
- **Export/Import JSON** — Share profiles across browsers and machines
- **Toast Notifications** — Clean animated feedback (no alert popups)
- **Auto Disconnect Detection** — UI resets with reconnect prompt
- **Reconnect Button** — Resume without reloading the page

## Requirements

- **Browser**: Any Chromium-based browser (Edge, Chrome, Brave, Opera)
  - Firefox and Safari do **not** support WebHID
- **Mouse**: Razer Naga V2 Pro (Vendor ID `0x1532`, Product ID `0x00A7`)
- **Important**: Close Razer Synapse before connecting — it locks the HID interface

## Getting Started

1. Clone this repo or download the ZIP
2. Open `index.html` in Microsoft Edge or Google Chrome
3. Click **Connect Mouse**
4. Authorize your Razer Naga V2 Pro in the browser popup
5. Done — all your current settings are fetched automatically

No server, no install, no build step required.

## How It Works

WebSynapse constructs 90-byte Razer HID feature reports in JavaScript and sends them via the browser's WebHID API. The protocol was reverse-engineered from the [OpenRazer](https://github.com/openrazer/openrazer) Linux driver.

Key implementation details:
- **Transaction ID**: `0xFF` for standard commands, `0x1F` for extended matrix/lighting (class `0x0F`)
- **Interface Discovery**: Razer mice expose multiple HID interfaces; Windows blocks the standard mouse ones. WebSynapse brute-forces each interface with a safe GET command to find the unlocked vendor-defined one.
- **Checksum**: XOR of bytes 2–87, stored at byte 88

## Project Structure

```
WebSynapse/
├── index.html    # UI layout
├── styles.css    # Dark Razer-themed styling
├── app.js        # All WebHID communication and UI logic
├── README.md     # This file
└── LICENSE       # MIT License
```

## Supported Device

Currently supports the **Razer Naga V2 Pro** only. The command structure should be similar for other Razer mice — pull requests to add device support are welcome! You'll need the device's USB Product ID and to verify the command mappings against the [OpenRazer driver source](https://github.com/openrazer/openrazer/blob/master/driver/razermouse_driver.c).

## Credits

- Protocol research based on [OpenRazer](https://github.com/openrazer/openrazer) (GPL-2.0)
- Built with the [WebHID API](https://wicg.github.io/webhid/)

## License

[MIT](LICENSE)
