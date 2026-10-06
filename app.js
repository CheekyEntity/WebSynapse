// ============================================================
// WebSynapse — Driverless Razer Naga V2 Pro Controller
// ============================================================

const VENDOR_ID = 0x1532;
// Fix (issue 1.1): A7/A8 were previously reversed in places, and app.js and
// native-bridge.ps1 disagreed with each other on which PID is which. Per
// OpenRazer's device header and the openrazer-daemon USB_PID constants:
//   0x00A7 = Naga V2 Pro WIRED
//   0x00A8 = Naga V2 Pro WIRELESS (stock HyperSpeed receiver)
const WIRED_PID = 0x00A7;
const WIRELESS_PID = 0x00A8;
const PRODUCT_IDS = new Set([WIRED_PID, WIRELESS_PID]);
const MOUSE_USAGE_PAGE = 0x01;
const MOUSE_USAGE = 0x02;
const VARSTORE = 0x01;

let mouseDevice = null;

// --- DOM References ---
const connectBtn = document.getElementById('connect-btn');
const reconnectBtn = document.getElementById('reconnect-btn');
const statusText = document.getElementById('connection-status');
const controlsPanel = document.getElementById('controls');
const refreshBtn = document.getElementById('refresh-btn');
const profileSection = document.getElementById('profile-section');

// Performance
const applyPerfBtn = document.getElementById('apply-performance-btn');
const dpiSlider = document.getElementById('dpi-slider');
const dpiInput = document.getElementById('dpi-input');
const pollSelect = document.getElementById('poll-rate-select');

// Fix (issue 1.3, write side): there was previously no way to actually
// choose which DPI stage is "active" — the Apply handler hardcoded
// active=0 regardless of what the device (or the user) wanted. This is
// the in-memory selection, 1-based to match the device's own numbering;
// refreshValues() updates it from the mouse, and clicking a badge updates
// it locally (sent to the device on the next "Apply Performance Settings").
let selectedActiveStage = 1;

[1, 2, 3, 4, 5].forEach(n => {
    const badge = document.getElementById(`stage-badge-${n}`);
    if (!badge) return;
    badge.addEventListener('click', () => {
        selectedActiveStage = n;
        for (let i = 1; i <= 5; i++) {
            const b = document.getElementById(`stage-badge-${i}`);
            if (b) b.classList.toggle('active-stage', i === n);
        }
        document.getElementById('active-stage-label').innerText = `Active: Stage ${n} (unsaved — click Apply)`;
    });
});

// Power
const applyPowerBtn = document.getElementById('apply-power-btn');
const batteryLevelEl = document.getElementById('battery-level');
const batteryStatusDiv = document.querySelector('.battery-status');
const lowBattSlider = document.getElementById('low-batt-slider');
const lowBattInput = document.getElementById('low-batt-input');
const idleSlider = document.getElementById('idle-slider');
const idleInput = document.getElementById('idle-input');

// Lighting
const applyLightBtn = document.getElementById('apply-lighting-btn');
const lightZoneSelect = document.getElementById('light-zone-select');
const brightSlider = document.getElementById('bright-slider');
const brightInput = document.getElementById('bright-input');
const lightEffectSelect = document.getElementById('light-effect-select');
const lightColorPicker = document.getElementById('light-color-picker');
const colorPickerRow = document.getElementById('color-picker-row');

// Charge Effect
const chargeEffectRow = document.getElementById('charge-effect-row');
const chargeEffectSelect = document.getElementById('charge-effect-select');
const chargeColorPicker = document.getElementById('charge-color-picker');
const chargeColorRow = document.getElementById('charge-color-row');

// --- Slider ↔ Input Sync ---
dpiSlider.addEventListener('input', e => { dpiInput.value = e.target.value; });
dpiInput.addEventListener('input', e => { dpiSlider.value = e.target.value; });
lowBattSlider.addEventListener('input', e => { lowBattInput.value = e.target.value; });
lowBattInput.addEventListener('input', e => { lowBattSlider.value = e.target.value; });
idleSlider.addEventListener('input', e => { idleInput.value = e.target.value; });
idleInput.addEventListener('input', e => { idleSlider.value = e.target.value; });
brightSlider.addEventListener('input', e => { brightInput.value = e.target.value; });
brightInput.addEventListener('input', e => { brightSlider.value = e.target.value; });

// Hide color picker when effect doesn't need it
lightEffectSelect.addEventListener('change', e => {
    const v = e.target.value;
    colorPickerRow.style.display = (v === 'static' || v === 'breathing' || v === 'reactive') ? 'flex' : 'none';
});
colorPickerRow.style.display = 'none';

// Show/hide charge color picker
chargeEffectSelect.addEventListener('change', e => {
    chargeColorRow.style.display = e.target.value === '1' ? 'flex' : 'none';
});

// ============================================================
// Utilities
// ============================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function hexToRgb(hex) {
    return [
        parseInt(hex.substring(1, 3), 16),
        parseInt(hex.substring(3, 5), 16),
        parseInt(hex.substring(5, 7), 16)
    ];
}

/** Toast notification system — replaces ugly alert() calls */
function showToast(msg, isError = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 3500);
}

/** Flash a button green momentarily on success */
function flashSuccess(btn) {
    btn.classList.add('btn-success');
    setTimeout(() => btn.classList.remove('btn-success'), 600);
}

// ============================================================
// Razer HID Protocol
// ============================================================

/**
 * Builds the 90-byte Uint8Array for a Razer feature report.
 *
 * Fix (issue 1.4): the old `class===0x0F ? 0x1F : 0xFF` rule was wrong for
 * this device far more broadly than just matrix/lighting commands. Checked
 * every Naga V2 Pro command OpenRazer defines across classes 0x00 (poll
 * rate/device mode), 0x03 (charge effect/colour), 0x04 (DPI/DPI stages),
 * 0x07 (battery/idle/low-threshold), and 0x0F (lighting) — this device uses
 * transaction_id 0x1F for essentially everything, not just class 0x0F.
 * (The one documented exception in OpenRazer, the legacy
 * razer_chroma_standard_matrix_effect_none() path, uses a different command
 * entirely that WebSynapse never sends, so it doesn't apply here.)
 */
function buildRazerReport(commandClass, commandId, dataSize, args = []) {
    const report = new Uint8Array(90);
    report[0] = 0x00; // status
    report[1] = 0x1F; // transaction_id
    report[5] = dataSize;
    report[6] = commandClass;
    report[7] = commandId;

    for (let i = 0; i < args.length; i++) {
        report[8 + i] = args[i];
    }

    let crc = 0;
    for (let i = 2; i < 88; i++) crc ^= report[i];
    report[88] = crc;

    return report;
}

// ============================================================
// Fix (issues 1.6, 1.7, 1.8, 1.9): a single serialized, verified
// transaction helper used by every HID read and write.
//
// Previously every call site built its own report, fired
// sendFeatureReport, waited a fixed sleep(50) with nothing else
// synchronizing request/response, and (for writes) never looked at what
// came back at all. That meant: no check of the device's status byte
// (1.6/1.7), a blind timeout standing in for real request/response
// matching (1.8), and no protection against two HID transactions
// interleaving — e.g. the 60s battery poll firing mid-way through a
// user's "Apply" click (1.9).
//
// This replaces that pattern everywhere: every HID operation is now a
// send+receive pair that goes through one serialized queue (so only one
// transaction is ever in flight), checks the device's status byte against
// Razer's documented response codes, confirms the response actually
// echoes the command class/id we sent (catching any response that still
// slipped through out of order), and retries a bounded number of times on
// a transient/busy result rather than trusting a single fixed delay.
// ============================================================

const RAZER_STATUS = { BUSY: 0x01, SUCCESSFUL: 0x02, FAILURE: 0x03, TIMEOUT: 0x04, NOT_SUPPORTED: 0x05 };

function describeRazerStatus(status) {
    switch (status) {
        case RAZER_STATUS.BUSY: return 'the device was busy';
        case RAZER_STATUS.FAILURE: return 'the device rejected the command';
        case RAZER_STATUS.TIMEOUT: return 'the command timed out on the device';
        case RAZER_STATUS.NOT_SUPPORTED: return 'the device does not support this command';
        default: return `the device returned an unrecognised status (0x${status.toString(16).padStart(2, '0')})`;
    }
}

// Every HID transaction passes through this single promise chain so two
// transactions can never be in flight on the same feature-report channel
// at once (issue 1.9).
let hidQueue = Promise.resolve();

function serialized(task) {
    const result = hidQueue.then(task, task);
    hidQueue = result.then(() => {}, () => {}); // keep the queue alive even if `task` rejects
    return result;
}

/**
 * Builds and sends a Razer feature report, then reads back and validates
 * the response (status byte + echoed class/id), retrying on a BUSY or
 * malformed response up to `retries` times. Returns the validated 90-byte
 * response as a Uint8Array, or null if the device never confirmed — in
 * which case a toast has already been shown, so callers can just bail out.
 *
 * @param {boolean} opts.expectResponse - if false, a BUSY/unreadable retry
 *   still happens, but a successful status byte alone is sufficient (used
 *   for pure "set" commands some callers don't otherwise need data from).
 */
// Fix (follow-up after getting razermouse_driver.h): the Naga V2 Pro is
// routed through OpenRazer's RAZER_NEW_MOUSE_RECEIVER_WAIT_US (31000us =
// 31ms), not the default RAZER_MOUSE_WAIT_US (600us) — confirmed from the
// header; a guessed ~30ms wait was used before. RAZER_RETRY_BACKOFF_MS
// mirrors razer_send_payload's separate fsleep(10000) between retries of
// the whole transaction (distinct from the per-attempt response wait).
const RAZER_RESPONSE_WAIT_MS = 31;
const RAZER_RETRY_BACKOFF_MS = 10;

function sendRazerCommand(commandClass, commandId, dataSize, args = [], opts = {}) {
    const { retries = 5, context = 'Command' } = opts;
    if (!mouseDevice) return Promise.resolve(null);
    const report = buildRazerReport(commandClass, commandId, dataSize, args);

    return serialized(async () => {
        let lastReason = 'no response was received';
        for (let attempt = 0; attempt < retries; attempt++) {
            if (attempt > 0) await sleep(RAZER_RETRY_BACKOFF_MS);
            try {
                await mouseDevice.sendFeatureReport(0x00, report);
                await sleep(RAZER_RESPONSE_WAIT_MS);
                const resp = await mouseDevice.receiveFeatureReport(0x00);
                if (!resp || !resp.buffer) { lastReason = 'no response was received'; continue; }

                const r = new Uint8Array(resp.buffer);
                if (r.length < 8) { lastReason = 'the response was too short to be valid'; continue; }

                const status = r[0];
                const echoedClass = r[6];
                const echoedId = r[7];

                if (echoedClass !== commandClass || echoedId !== commandId) {
                    lastReason = 'the response did not match the command that was sent';
                    continue;
                }
                if (status === RAZER_STATUS.SUCCESSFUL) return r;

                // Fix: previously treated failure/timeout/not-supported as an
                // immediate hard stop. OpenRazer's own razer_send_payload
                // retries on *every* non-successful status (not just BUSY),
                // only reporting a specific error once every attempt is
                // exhausted — matched here.
                lastReason = describeRazerStatus(status);
            } catch (e) {
                lastReason = e.message || String(e);
            }
        }
        console.error(`${context} gave up after ${retries} attempts: ${lastReason}`);
        showToast(`${context} failed: ${lastReason}`, true);
        return null;
    });
}

// ============================================================
// Connection
// ============================================================

let usingNativeBridge = false;

function assertWebHidAvailable() {
    if (window.location.protocol === 'file:') {
        throw new Error('Open WebSynapse through http://localhost:8000. The local server starts the Windows HID bridge required for this mouse.');
    }
    if (!window.isSecureContext) {
        throw new Error('WebHID requires a secure page. Open WebSynapse through HTTPS or a local web server, not directly as a file.');
    }
    if (!navigator.hid) {
        throw new Error('This browser does not support WebHID. Use Chrome or Edge.');
    }
}

function isRazerCommandInterface(device) {
    const collections = Array.isArray(device.collections) ? device.collections : [];
    const isMouseCollection = collections.some(collection =>
        Number(collection.usagePage) === MOUSE_USAGE_PAGE &&
        Number(collection.usage) === MOUSE_USAGE
    );
    const exposesFeatureReport = collections.some(collectionHasFeatureReport);
    return isMouseCollection || exposesFeatureReport;
}

function collectionHasFeatureReport(collection) {
    return (Array.isArray(collection.featureReports) && collection.featureReports.length > 0) ||
        (Array.isArray(collection.children) && collection.children.some(collectionHasFeatureReport));
}

function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function nativeBridgeRequest(path, body) {
    // Fix (issue 9): every request now carries the per-session token the
    // server injected into this page on load, so a request from some other
    // origin/tab (which has no way to read window.__WEBSYNAPSE_TOKEN__)
    // gets rejected by the server before it reaches the HID bridge.
    const authHeaders = { 'X-WebSynapse-Token': window.__WEBSYNAPSE_TOKEN__ || '' };
    let response;
    try {
        response = await fetch(path, body === undefined
            ? { headers: authHeaders }
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(body)
            });
    } catch {
        const error = new Error('The local Windows HID bridge could not be reached. Run node server.js and open http://localhost:8000.');
        error.nativeBridgeUnavailable = true;
        throw error;
    }

    const result = await response.json().catch(() => null);
    if (response.status === 404 || response.status === 405) {
        const error = new Error('This page is not being served by the WebSynapse Windows bridge. Run node server.js and open http://localhost:8000.');
        error.nativeBridgeUnavailable = true;
        throw error;
    }
    if (!response.ok && !result) {
        throw new Error(`The local Windows HID bridge returned HTTP ${response.status}.`);
    }
    return result || { ok: false, error: 'The local Windows HID bridge returned no data.' };
}

function createNativeDevice(device) {
    const nativeDevice = {
        productName: device?.ProductName || 'Razer Naga V2 Pro',
        // Fix (issue 1.11 prerequisite): the WebHID path already exposes
        // productId on the native HIDDevice object; the native-bridge path
        // didn't surface it at all, which made PID-based gating impossible
        // regardless of connection method. Mirror it here so both paths
        // expose the same shape.
        productId: device?.ProductId,
        opened: true,
        async sendFeatureReport(reportId, data) {
            if (reportId !== 0) throw new Error('The Naga command interface only accepts feature report 0.');
            const result = await nativeBridgeRequest('/api/hid/set', {
                report: bytesToBase64(new Uint8Array(data))
            });
            if (!result.ok) throw new Error(result.error || 'Windows rejected the Razer feature report.');
        },
        async receiveFeatureReport(reportId) {
            if (reportId !== 0) throw new Error('The Naga command interface only returns feature report 0.');
            const result = await nativeBridgeRequest('/api/hid/get', {});
            if (!result.ok) throw new Error(result.error || 'Windows could not read the Razer feature report.');
            return new DataView(base64ToBytes(result.data).buffer);
        },
        async close() {
            const result = await nativeBridgeRequest('/api/hid/disconnect', {});
            if (!result.ok) throw new Error(result.error || 'Windows could not close the Razer feature interface.');
            nativeDevice.opened = false;
        }
    };
    return nativeDevice;
}

async function closeDevice(device) {
    if (device && device.opened) {
        try { await device.close(); } catch (e) { /* already closed */ }
    }
}

// Fix (issue 1.11): charging LED effect/colour are wireless-only commands
// (OpenRazer only registers charge_effect/charge_colour sysfs files for the
// WIRELESS PID). Previously WebSynapse sent these unconditionally on both
// variants. Gate both the UI and the actual command on the connected PID.
function isWirelessConnected() {
    return !!mouseDevice && mouseDevice.productId === WIRELESS_PID;
}

function updateChargingControlsVisibility() {
    const wireless = isWirelessConnected();
    chargeEffectRow.style.display = wireless ? 'flex' : 'none';
    if (!wireless) {
        chargeColorRow.style.display = 'none';
    } else {
        // Restore normal effect-driven visibility for the colour row.
        chargeEffectSelect.dispatchEvent(new Event('change'));
    }
}

// Fix (item 7): no firmware-version detection existed anywhere in the app.
// Command 0x00/0x81 per OpenRazer's razer_chroma_standard_get_firmware_version.
async function fetchFirmwareVersion() {
    const r = await sendRazerCommand(0x00, 0x81, 0x02, [0x00, 0x00], { context: 'Get firmware version' });
    const el = document.getElementById('firmware-info');
    if (r) el.innerText = `Firmware v${r[8]}.${r[9]}`;
    else el.innerText = '';
}

async function finishConnection(connectionMethod) {
    statusText.innerText = `Connected to ${mouseDevice.productName} (${connectionMethod})`;
    statusText.className = 'status-connected';
    controlsPanel.style.display = 'flex';
    connectBtn.style.display = 'none';
    reconnectBtn.style.display = 'block';
    profileSection.style.display = 'block';

    updateChargingControlsVisibility();
    if (!isWirelessConnected()) {
        showToast('Connected by cable — charging LED controls aren\u2019t available on the wired connection.');
    } else {
        showToast('Connected successfully!');
    }
    await fetchFirmwareVersion();
    await refreshValues();
    startBatteryPolling();
}

async function tryNativeBridgeConnection() {
    if (window.location.protocol === 'file:') return false;

    let result;
    try {
        result = await nativeBridgeRequest('/api/hid/connect', {});
    } catch (error) {
        if (error.nativeBridgeUnavailable) return false;
        throw error;
    }
    if (!result.ok) throw new Error(result.error || 'The local Windows HID bridge could not connect to the mouse.');

    mouseDevice = createNativeDevice(result.device);
    usingNativeBridge = true;
    await finishConnection('Windows HID bridge');
    return true;
}

async function connectToDevice(devices) {
    if (devices.length === 0) {
        throw new Error('No HID device was selected. Choose the Razer Naga V2 Pro in the browser permission dialog.');
    }

    const supportedDevices = devices.filter(device =>
        device.vendorId === VENDOR_ID && PRODUCT_IDS.has(device.productId)
    );
    if (supportedDevices.length === 0) {
        throw new Error('No supported Naga V2 Pro HID interface was selected.');
    }

    const likelyCommandInterfaces = supportedDevices.filter(isRazerCommandInterface);
    const otherInterfaces = supportedDevices.filter(device => !isRazerCommandInterface(device));
    const candidates = [...likelyCommandInterfaces, ...otherInterfaces];
    const errors = [];

    console.log('Razer HID interfaces:', supportedDevices.map((dev, index) => ({
        index,
        productId: `0x${dev.productId.toString(16).padStart(4, '0')}`,
        productName: dev.productName,
        commandInterface: isRazerCommandInterface(dev),
        collections: dev.collections
    })));

    mouseDevice = null;
    for (const dev of candidates) {
        try {
            if (!dev.opened) await dev.open();
            const probeReport = buildRazerReport(0x00, 0x85, 0x01, [0x00]);
            await dev.sendFeatureReport(0x00, probeReport);

            // Fix (issue 5): previously committed to the first interface that
            // merely accepted the write, without ever checking whether it
            // actually answered like a real Razer command interface. A
            // feature-report write can succeed on the wrong HID collection
            // and still go nowhere, so read back and require a response that
            // echoes this exact command's class/id before trusting it.
            await sleep(RAZER_RESPONSE_WAIT_MS);
            const resp = await dev.receiveFeatureReport(0x00);
            const r = resp && resp.buffer ? new Uint8Array(resp.buffer) : null;
            const looksLikeRazerResponse = r && r.length >= 8 && r[6] === 0x00 && r[7] === 0x85;
            if (!looksLikeRazerResponse) {
                throw new Error('interface accepted the write but did not return a valid Razer response');
            }

            mouseDevice = dev;
            break;
        } catch (e) {
            errors.push(`${dev.productName || 'Razer interface'}: ${e.message || e.name || 'open failed'}`);
            await closeDevice(dev);
        }
    }

    if (!mouseDevice) {
        if (errors.some(error => error.includes('NotAllowedError'))) {
            throw new Error('Edge blocked the Razer feature report because the Naga exposes it inside a protected mouse HID collection. Run node server.js and use the Windows HID bridge instead.');
        }
        throw new Error(`Unable to write to the Naga V2 Pro command interface (${errors.join(', ')}).`);
    }

    usingNativeBridge = false;
    await finishConnection('WebHID');
}

async function connectWithBestTransport(requestBrowserPermission) {
    if (await tryNativeBridgeConnection()) return;

    assertWebHidAvailable();
    let devices;
    if (requestBrowserPermission) {
        const selectedDevices = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
        const permittedDevices = await navigator.hid.getDevices();
        devices = [...new Set([...selectedDevices, ...permittedDevices])]
            .filter(device => device.vendorId === VENDOR_ID);
    } else {
        devices = await navigator.hid.getDevices();
    }
    await connectToDevice(devices);
}

connectBtn.addEventListener('click', async () => {
    try {
        await connectWithBestTransport(true);
    } catch (e) {
        console.error('Connection failed:', e);
        statusText.innerText = 'Connection failed. ' + e.message;
        statusText.className = 'status-error';
        showToast('Connection failed', true);
    }
});

reconnectBtn.addEventListener('click', async () => {
    try {
        await connectWithBestTransport(false);
    } catch (e) {
        showToast('Reconnection failed: ' + e.message, true);
    }
});

// --- WebHID Disconnect Detection ---
if (navigator.hid) {
    navigator.hid.addEventListener('disconnect', (event) => {
        if (!usingNativeBridge && mouseDevice && event.device === mouseDevice) {
            mouseDevice = null;
            if (window._battInterval) clearInterval(window._battInterval);
            statusText.innerText = 'Mouse disconnected!';
            statusText.className = 'status-disconnected';
            document.getElementById('firmware-info').innerText = '';
            controlsPanel.style.display = 'none';
            connectBtn.style.display = 'block';
            reconnectBtn.style.display = 'block';
            showToast('Mouse disconnected — click Reconnect when ready', true);
        }
    });
}

// ============================================================
// Auto Battery Polling (every 60s)
// ============================================================

function startBatteryPolling() {
    if (window._battInterval) clearInterval(window._battInterval);
    window._battInterval = setInterval(async () => {
        if (!mouseDevice) return;
        try {
            await fetchBattery();
        } catch (e) { /* silently ignore */ }
    }, 60000);
}

async function fetchBattery() {
    // Fix (issues 1.6/1.7): previously parsed r[9] from whatever came back
    // with no check that the device actually succeeded or that the
    // response was even for this request. Now goes through
    // sendRazerCommand, which validates the status byte and the
    // echoed class/id before we trust any of the returned bytes.
    const r = await sendRazerCommand(0x07, 0x80, 0x02, [0x00, 0x00], { context: 'Get battery level' });
    if (!r) return;
    const level = Math.round((r[9] / 255) * 100);
    batteryLevelEl.innerText = `${level}%`;
    batteryStatusDiv.className = level <= parseInt(lowBattSlider.value)
        ? 'battery-status battery-low'
        : 'battery-status';
}

// ============================================================
// Refresh All Values (robust — each section in its own try/catch)
// ============================================================

async function refreshValues() {
    if (!mouseDevice) return;

    // 1. GET DPI
    // Fix (issues 1.6/1.7): every block below now goes through
    // sendRazerCommand, which checks the device's status byte and the
    // echoed command class/id before any bytes are trusted, instead of
    // parsing whatever came back unconditionally.
    try {
        const r = await sendRazerCommand(0x04, 0x85, 0x07, [VARSTORE, 0,0,0,0,0,0], { context: 'Get DPI' });
        if (r) {
            const dpiX = (r[9] << 8) | r[10];
            document.getElementById('current-dpi').innerText = `${dpiX} DPI`;
            dpiSlider.value = dpiX;
            dpiInput.value = dpiX;
        }
    } catch (e) { console.error('GET DPI failed:', e); }

    // 1b. GET DPI Stages
    try {
        const r = await sendRazerCommand(0x04, 0x86, 0x26, [VARSTORE], { context: 'Get DPI stages' });
        if (r) {
            // Fix (issue 1.3, read side): OpenRazer documents this field as
            // 1-based ("02" in the response literally means "stage 2 is
            // active"), but this used to compare it directly against a
            // 0-based loop index and then add 1 again when displaying it —
            // an off-by-one that highlighted the wrong badge and showed
            // the wrong stage number.
            const activeStage = r[9]; // arg[1] = active stage, 1-based
            const count = r[10];      // arg[2] = number of stages
            selectedActiveStage = activeStage >= 1 ? activeStage : 1;
            for (let i = 0; i < Math.min(count, 5); i++) {
                const offset = 11 + (i * 7); // arg[3 + i*7]
                const dpiX = (r[offset + 1] << 8) | r[offset + 2];
                const el = document.getElementById(`dpi-stage-${i + 1}`);
                if (el) el.value = dpiX;
                const badge = document.getElementById(`stage-badge-${i + 1}`);
                if (badge) {
                    badge.classList.toggle('active-stage', (i + 1) === activeStage);
                }
            }
            document.getElementById('active-stage-label').innerText = `Active: Stage ${activeStage}`;
        }
    } catch (e) { console.error('GET DPI Stages failed:', e); }

    // 2. GET Polling Rate
    try {
        const r = await sendRazerCommand(0x00, 0x85, 0x01, [0x00], { context: 'Get polling rate' });
        if (r) {
            const code = r[8];
            // Fix (issue 1.5): an unrecognised code used to silently display
            // "1000 Hz" as if that were a confirmed reading. Now shows the
            // raw code instead of asserting a value we don't actually know.
            const knownRates = { 0x01: 1000, 0x02: 500, 0x08: 125 };
            const pr = knownRates[code];
            if (pr !== undefined) {
                document.getElementById('current-poll').innerText = `${pr} Hz`;
                pollSelect.value = pr.toString();
            } else {
                console.warn(`Unknown polling-rate code 0x${code.toString(16)}`);
                document.getElementById('current-poll').innerText = `Unknown (0x${code.toString(16).padStart(2, '0')})`;
            }
        }
    } catch (e) { console.error('GET Poll Rate failed:', e); }

    // 3. GET Battery Level
    try { await fetchBattery(); } catch (e) { console.error('GET Battery failed:', e); }

    // 4. GET Charging Status
    try {
        const r = await sendRazerCommand(0x07, 0x84, 0x02, [0x00, 0x00], { context: 'Get charging status' });
        if (r) {
            if (r[9] === 1) {
                batteryStatusDiv.className = 'battery-status battery-charging';
                document.getElementById('battery-icon').innerText = '\u26A1';
            } else {
                document.getElementById('battery-icon').innerText = '\uD83D\uDD0B';
            }
        }
    } catch (e) { console.error('GET Charge Status failed:', e); }

    // 5. GET Low Battery Threshold
    try {
        const r = await sendRazerCommand(0x07, 0x81, 0x01, [0x00], { context: 'Get low-battery threshold' });
        if (r) {
            const pct = Math.round(r[8] / 2.55);
            document.getElementById('current-low-batt').innerText = `${pct}%`;
            lowBattSlider.value = pct;
            lowBattInput.value = pct;
        }
    } catch (e) { console.error('GET Low Batt failed:', e); }

    // 6. GET Idle Time
    try {
        const r = await sendRazerCommand(0x07, 0x83, 0x02, [0x00, 0x00], { context: 'Get idle time' });
        if (r) {
            const secs = (r[8] << 8) | r[9];
            const mins = Math.round(secs / 60);
            document.getElementById('current-idle').innerText = `${mins} Min`;
            idleSlider.value = mins;
            idleInput.value = mins;
        }
    } catch (e) { console.error('GET Idle Time failed:', e); }

    // 7. GET Brightness (Logo LED)
    try {
        const r = await sendRazerCommand(0x0F, 0x84, 0x03, [VARSTORE, 0x04, 0x00], { context: 'Get brightness' });
        if (r) {
            const pct = Math.round((r[10] / 255) * 100);
            document.getElementById('current-bright').innerText = `${pct}%`;
            brightSlider.value = pct;
            brightInput.value = pct;
        }
    } catch (e) { console.error('GET Brightness failed:', e); }
}

refreshBtn.addEventListener('click', refreshValues);

// ============================================================
// Apply: Performance (DPI + DPI Stages + Polling Rate)
// ============================================================

applyPerfBtn.addEventListener('click', async () => {
    if (!mouseDevice) return;

    try {
        // SET DPI
        // Fix (issues 1.6/1.9): goes through sendRazerCommand now, so a
        // rejected/timed-out SET is caught (and surfaced via toast) instead
        // of being silently treated as applied, and can't interleave with
        // a concurrent battery poll.
        const dpi = Math.min(Math.max(parseInt(dpiInput.value), 100), 30000);
        const dH = (dpi >> 8) & 0xFF, dL = dpi & 0xFF;
        if (!(await sendRazerCommand(0x04, 0x05, 0x07, [VARSTORE, dH, dL, dH, dL, 0, 0], { context: 'Set DPI' }))) return;

        // SET DPI Stages (5 stages)
        // Fix (issue 1.3, write side): the active-stage argument used to be
        // hardcoded to 0, discarding whatever the user picked (and OpenRazer
        // explicitly rejects an active stage < 1). Uses the badge selection
        // from selectedActiveStage instead, clamped into the valid [1, 5]
        // range the device expects.
        const activeStage = Math.min(Math.max(selectedActiveStage, 1), 5);
        const stageArgs = [VARSTORE, activeStage, 0x05]; // varstore, active stage (1-based), count=5
        for (let i = 1; i <= 5; i++) {
            let s = Math.min(Math.max(parseInt(document.getElementById(`dpi-stage-${i}`).value), 100), 30000);
            stageArgs.push(i - 1); // stage index into the array below is 0-based (matches OpenRazer's write loop)
            stageArgs.push((s >> 8) & 0xFF, s & 0xFF); // X
            stageArgs.push((s >> 8) & 0xFF, s & 0xFF); // Y
            stageArgs.push(0x00, 0x00); // reserved
        }
        if (!(await sendRazerCommand(0x04, 0x06, 0x26, stageArgs, { context: 'Set DPI stages' }))) return;

        // SET Polling Rate
        const prStr = pollSelect.value;
        const prCode = prStr === '125' ? 0x08 : prStr === '500' ? 0x02 : 0x01;
        if (!(await sendRazerCommand(0x00, 0x05, 0x01, [prCode], { context: 'Set polling rate' }))) return;

        document.getElementById('current-dpi').innerText = `${dpi} DPI`;
        document.getElementById('current-poll').innerText = `${prStr} Hz`;
        document.getElementById('active-stage-label').innerText = `Active: Stage ${activeStage}`;
        flashSuccess(applyPerfBtn);
        showToast('Performance settings applied');
    } catch (e) {
        console.error('SET Performance failed:', e);
        showToast(`Failed: ${e.message}`, true);
    }
});

// ============================================================
// Apply: Power (Low Battery Threshold + Idle Time)
// ============================================================

applyPowerBtn.addEventListener('click', async () => {
    if (!mouseDevice) return;

    try {
        // SET Low Battery Threshold
        let pct = Math.min(Math.max(parseInt(lowBattInput.value), 5), 25);
        const raw = Math.round(pct * 2.55);
        if (!(await sendRazerCommand(0x07, 0x01, 0x01, [raw], { context: 'Set low-battery threshold' }))) return;

        // SET Idle Time
        let mins = Math.min(Math.max(parseInt(idleInput.value), 1), 15);
        const secs = mins * 60;
        if (!(await sendRazerCommand(0x07, 0x03, 0x02, [(secs >> 8) & 0xFF, secs & 0xFF], { context: 'Set idle time' }))) return;

        // Fix (issue 1.11): charge_effect/charge_colour are wireless-only in
        // OpenRazer's driver for this device — skip entirely on a wired
        // connection rather than sending commands the mouse doesn't support.
        if (isWirelessConnected()) {
            // SET Charge Effect (0x03, 0x10, 0x01) — 0x00=default, 0x01=static
            const chargeType = parseInt(chargeEffectSelect.value);
            if (!(await sendRazerCommand(0x03, 0x10, 0x01, [chargeType], { context: 'Set charge effect' }))) return;

            // SET Charge Colour if static mode (uses standard LED RGB: class 0x03, cmd 0x01)
            // Fix (issue 1.10): this previously sent 0x04 labeled "BATTERY_LED" —
            // 0x04 is actually LOGO_LED. OpenRazer's charge-colour function uses
            // the BATTERY_LED constant, confirmed exactly as 0x03 against
            // razercommon.h. NOSTORE = 0x00.
            if (chargeType === 1) {
                const [cr, cg, cb] = hexToRgb(chargeColorPicker.value);
                const BATTERY_LED = 0x03;
                if (!(await sendRazerCommand(0x03, 0x01, 0x05, [0x00, BATTERY_LED, cr, cg, cb], { context: 'Set charge colour' }))) return;
            }
        }

        document.getElementById('current-low-batt').innerText = `${pct}%`;
        document.getElementById('current-idle').innerText = `${mins} Min`;
        flashSuccess(applyPowerBtn);
        showToast('Power settings applied');
    } catch (e) {
        console.error('SET Power failed:', e);
        showToast(`Failed: ${e.message}`, true);
    }
});

// ============================================================
// Apply: Lighting (Brightness + Effect per Zone)
// ============================================================

applyLightBtn.addEventListener('click', async () => {
    if (!mouseDevice) return;

    const zone = lightZoneSelect.value;
    // Fix (item 3): "Scroll Wheel" (previously LED id 0x01) was never
    // actually backed by OpenRazer for this device — its probe() function
    // registers zero scroll_matrix_effect_* files for the Naga V2 Pro,
    // unlike e.g. the Lancehead where that mechanism is real. Replaced with
    // "Main / Thumbgrid" (ZERO_LED), which IS what OpenRazer's own
    // matrix_brightness/matrix_effect_* calls use for this exact device
    // (razer_chroma_extended_matrix_brightness(VARSTORE, ZERO_LED, ...)).
    // ZERO_LED=0x00 and LOGO_LED=0x04 are both confirmed exactly against
    // razercommon.h's LED id defines.
    const ZERO_LED = 0x00;
    const LOGO_LED = 0x04;
    const zones = zone === 'all' ? [LOGO_LED, ZERO_LED] :
                  zone === 'main' ? [ZERO_LED] : [LOGO_LED];

    const brightness = parseInt(brightInput.value);
    const bRaw = Math.round((brightness / 100) * 255);
    const effect = lightEffectSelect.value;
    const [r, g, b] = hexToRgb(lightColorPicker.value);

    try {
        for (const led of zones) {
            // Brightness
            // Fix (issues 1.6/1.9): goes through sendRazerCommand so a
            // rejected brightness/effect write is caught instead of assumed
            // successful, and can't interleave with battery polling.
            if (!(await sendRazerCommand(0x0F, 0x04, 0x03, [VARSTORE, led, bRaw], { context: 'Set brightness' }))) return;

            // Effect
            let effectArgs;
            switch (effect) {
                case 'none':
                    effectArgs = [VARSTORE, led, 0x00, 0,0,0]; break;
                case 'static':
                    effectArgs = [VARSTORE, led, 0x01, 0,0, 0x01, r,g,b]; break;
                case 'breathing':
                    effectArgs = [VARSTORE, led, 0x02, 0x01,0, 0x01, r,g,b]; break;
                case 'spectrum':
                    effectArgs = [VARSTORE, led, 0x03, 0,0,0]; break;
                case 'reactive':
                    effectArgs = [VARSTORE, led, 0x05, 0, 0x03, 0x01, r,g,b]; break;
                case 'wave':
                    effectArgs = [VARSTORE, led, 0x04, 0x01, 0x28, 0]; break;
            }
            if (effectArgs) {
                const dataSize = effectArgs.length === 9 ? 0x09 : 0x06;
                if (!(await sendRazerCommand(0x0F, 0x02, dataSize, effectArgs, { context: 'Set lighting effect' }))) return;
            }
        }

        document.getElementById('current-bright').innerText = `${brightness}%`;
        flashSuccess(applyLightBtn);
        showToast('Lighting applied');
    } catch (e) {
        console.error('SET Lighting failed:', e);
        showToast(`Failed: ${e.message}`, true);
    }
});

// ============================================================
// Profiles (Save / Load / Export / Import)
// ============================================================

function gatherProfileData() {
    return {
        dpi: dpiInput.value,
        stages: [1,2,3,4,5].map(i => document.getElementById(`dpi-stage-${i}`).value),
        poll: pollSelect.value,
        lowBatt: lowBattInput.value,
        idle: idleInput.value,
        chargeEffect: chargeEffectSelect.value,
        chargeColor: chargeColorPicker.value,
        zone: lightZoneSelect.value,
        bright: brightInput.value,
        effect: lightEffectSelect.value,
        color: lightColorPicker.value
    };
}

function applyProfileData(data) {
    dpiInput.value = data.dpi; dpiSlider.value = data.dpi;
    if (data.stages) {
        data.stages.forEach((v, i) => {
            const el = document.getElementById(`dpi-stage-${i + 1}`);
            if (el) el.value = v;
        });
    }
    pollSelect.value = data.poll;
    lowBattInput.value = data.lowBatt; lowBattSlider.value = data.lowBatt;
    idleInput.value = data.idle; idleSlider.value = data.idle;
    if (data.chargeEffect !== undefined) chargeEffectSelect.value = data.chargeEffect;
    if (data.chargeColor !== undefined) chargeColorPicker.value = data.chargeColor;
    chargeEffectSelect.dispatchEvent(new Event('change'));
    lightZoneSelect.value = data.zone;
    brightInput.value = data.bright; brightSlider.value = data.bright;
    lightEffectSelect.value = data.effect;
    lightColorPicker.value = data.color;
    lightEffectSelect.dispatchEvent(new Event('change'));
}

document.getElementById('save-profile-btn').addEventListener('click', () => {
    const name = document.getElementById('profile-select').value;
    localStorage.setItem('websynapse_profile_' + name, JSON.stringify(gatherProfileData()));
    showToast(`Saved profile "${name}" in this browser (not on the mouse)`);
});

document.getElementById('load-profile-btn').addEventListener('click', () => {
    const name = document.getElementById('profile-select').value;
    const raw = localStorage.getItem('websynapse_profile_' + name);
    if (!raw) { showToast(`No saved data for: ${name}`, true); return; }
    try {
        applyProfileData(JSON.parse(raw));
        showToast(`Loaded "${name}". Click Apply to send to mouse.`);
    } catch (e) {
        showToast('Error loading profile', true);
    }
});

// --- Export Profile as JSON File ---
document.getElementById('export-profile-btn').addEventListener('click', () => {
    const name = document.getElementById('profile-select').value;
    const data = gatherProfileData();
    data._profileName = name;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `websynapse_${name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported profile: ${name}`);
});

// --- Import Profile from JSON File ---
const importFileInput = document.getElementById('import-file-input');

document.getElementById('import-profile-btn').addEventListener('click', () => {
    importFileInput.click();
});

importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        try {
            const data = JSON.parse(evt.target.result);
            applyProfileData(data);
            const name = data._profileName || 'imported';
            showToast(`Imported "${name}". Click Apply to send to mouse.`);
        } catch (err) {
            showToast('Invalid profile file', true);
        }
    };
    reader.readAsText(file);
    // Reset so the same file can be imported again
    importFileInput.value = '';
});
