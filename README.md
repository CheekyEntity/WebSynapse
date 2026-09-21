# WebSynapse

**Driverless configuration tool for the Razer Naga V2 Pro on Windows.**

WebSynapse talks directly to the mouse through a small local Windows HID bridge. Razer Synapse is not required.

**Created by [CheekyEntity](https://github.com/CheekyEntity)**

## Features

### Sensor Performance

- **DPI** — Read and set the current DPI (100–30,000)
- **DPI Stages** — Configure five DPI presets with an active-stage indicator
- **Polling Rate** — 125 / 500 / 1000 Hz

### Power & Battery

- **Live Battery Level** with automatic refresh every 60 seconds
- **Charging Status** detection
- **Low Battery Threshold** — Configure warning percentage
- **Wireless Idle Time** — Set sleep timeout (1–15 min)
- **Charge Effect & Color** — Customize LED behaviour while charging

### Advanced Lighting

- **Independent zone control** — Logo LED, Scroll Wheel, or All Zones
- **Brightness** — 0–100%
- **Effects** — Off, Static, Breathing, Spectrum Cycling, Reactive, Wave
- **RGB colour picker** for colour-based effects

### Profiles

- **Save/Load Profiles** — Default, Gaming, and Work presets in local storage
- **Export/Import JSON** — Share profiles across browsers and machines

## Windows setup

1. Connect the Naga V2 Pro by cable or its wireless receiver.
2. In this folder, run `node server.js`.
3. Open [http://localhost:8000](http://localhost:8000) in Edge, Chrome, or another modern browser.
4. Click **Connect Mouse**. There is no browser device-picker step.

The server automatically starts `native-bridge.ps1`, which opens the mouse’s Windows HID feature interface. The page must be opened through the local server—opening `index.html` directly with `file://` cannot use the bridge.

### Why the local bridge is necessary

The Naga V2 Pro exposes its configuration report inside its standard mouse HID collection. Chromium deliberately protects mouse and keyboard HID collections, so Edge/Chrome WebHID may show the device but block feature-report writes with `NotAllowedError`. The bridge uses the Windows HID API locally and is restricted to the Naga V2 Pro’s wired/wireless product IDs.

## How it works

WebSynapse constructs 90-byte Razer feature reports in JavaScript. The local bridge adds the Windows report-ID byte, communicates with the Naga through the Windows HID API, and returns the response to the page. The command protocol was reverse-engineered from the [OpenRazer](https://github.com/openrazer/openrazer) Linux driver.

Key implementation details:

- **Transaction ID**: `0xFF` for standard commands, `0x1F` for extended matrix/lighting commands
- **Checksum**: XOR of bytes 2–87, stored at byte 88
- **Command interface**: The bridge selects the Naga mouse collection with the 91-byte Windows feature report

## Project structure

```
WebSynapse/
├── index.html           # UI layout
├── styles.css           # Dark Razer-themed styling
├── app.js               # Razer protocol and UI logic
├── server.js            # Local server and bridge API
├── native-bridge.ps1    # Windows HID implementation
└── README.md            # This file
```

## Supported device

WebSynapse currently supports the **Razer Naga V2 Pro** only (USB vendor ID `0x1532`, product IDs `0x00A7` and `0x00A8`).

## Credits

- Protocol research based on [OpenRazer](https://github.com/openrazer/openrazer) (GPL-2.0)
- Original browser API approach based on [WebHID](https://wicg.github.io/webhid/)

## License

[MIT](LICENSE)
