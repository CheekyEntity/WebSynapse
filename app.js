// ============================================================
// WebSynapse — Driverless Razer Naga V2 Pro Controller
// ============================================================

const VENDOR_ID = 0x1532;
// 0x00A7 = Naga V2 Pro WIRED, 0x00A8 = Naga V2 Pro WIRELESS (HyperSpeed receiver)
const WIRED_PID = 0x00A7;
const WIRELESS_PID = 0x00A8;
const PRODUCT_IDS = new Set([WIRED_PID, WIRELESS_PID]);
const MOUSE_USAGE_PAGE = 0x01;
const MOUSE_USAGE = 0x02;
const VARSTORE = 0x01;

// Polling-rate value -> device code. Used for both Apply and profile validation.
const POLL_CODES = { '125': 0x08, '500': 0x02, '1000': 0x01 };

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

// In-memory active DPI stage (1-based, matches the device). refreshValues()
// updates it from the mouse; clicking a badge or loading a profile updates it
// locally and it is sent on the next "Apply Performance Settings".
let selectedActiveStage = 1;

function setSelectedStage(n, unsaved = true) {
    selectedActiveStage = n;
    for (let i = 1; i <= 5; i++) {
        const b = document.getElementById(`stage-badge-${i}`);
        if (b) b.classList.toggle('active-stage', i === n);
    }
    document.getElementById('active-stage-label').innerText =
        `Active: Stage ${n}` + (unsaved ? ' (unsaved — click Apply)' : '');
}

[1, 2, 3, 4, 5].forEach(n => {
    const badge = document.getElementById(`stage-badge-${n}`);
    if (badge) badge.addEventListener('click', () => setSelectedStage(n));
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

/**
 * Strict numeric reader for form fields. Throws on empty / non-numeric input
 * (instead of letting NaN become 0 in a report), and clamps valid numbers
 * into [min, max].
 */
function readIntField(el, min, max, label) {
    const raw = String(el.value).trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return Math.min(Math.max(Math.round(n), min), max);
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
 * This device uses transaction_id 0x1F for essentially every command.
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
// Serialized, verified HID transactions
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
// transactions can never be in flight on the same feature-report channel.
let hidQueue = Promise.resolve();

function serialized(task) {
    const result = hidQueue.then(task, task);
    hidQueue = result.then(() => {}, () => {}); // keep the queue alive even if `task` rejects
    return result;
}

// OpenRazer routes the Naga V2 Pro through RAZER_NEW_MOUSE_RECEIVER_WAIT_US
// (31ms) between a command and its response; RAZER_RETRY_BACKOFF_MS mirrors
// razer_send_payload's fsleep(10000) between whole-transaction retries.
const RAZER_RESPONSE_WAIT_MS = 31;
const RAZER_RETRY_BACKOFF_MS = 10;

/**
 * Sends a Razer feature report, reads back and validates the response
 * (status byte + echoed class/id), retrying up to `retries` times.
 * Returns the validated 90-byte response, or null if the device never
 * confirmed. On final failure it first checks whether the device is gone
 * (and if so runs handleDeviceLost), otherwise shows a toast unless
 * `quiet` is set.
 */
function sendRazerCommand(commandClass, commandId, dataSize, args = [], opts = {}) {
    const { retries = 5, context = 'Command', quiet = false } = opts;
    if (!mouseDevice) return Promise.resolve(null);
    const report = buildRazerReport(commandClass, commandId, dataSize, args);

    return serialized(async () => {
        if (!mouseDevice) return null; // device was lost while this was queued
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

                // OpenRazer retries on every non-successful status.
                lastReason = describeRazerStatus(status);
            } catch (e) {
                lastReason = e.message || String(e);
                if (e.nonRetryable) break; // bridge stuck/restarted: retrying can't help
            }
        }
        console.error(`${context} gave up after ${retries} attempts: ${lastReason}`);
        if (!(await deviceStillPresent())) {
            handleDeviceLost(`Lost connection to the mouse (${context.toLowerCase()} failed). Click Reconnect when ready.`);
            return null;
        }
        if (!quiet) showToast(`${context} failed: ${lastReason}`, true);
        return null;
    });
}

/**
 * Runs HID steps in order and stops at the first failure. A failed step has
 * already toasted its own reason; if earlier steps succeeded, say so.
 */
async function runSteps(steps) {
    const done = [];
    for (const s of steps) {
        const r = await sendRazerCommand(s.cls, s.id, s.size, s.args, { context: `Set ${s.label}` });
        if (!r) {
            if (done.length > 0 && mouseDevice) {
                showToast(`Partly applied. Done: ${done.join(', ')}. Stopped at: ${s.label}.`, true);
            }
            return false;
        }
        done.push(s.label);
    }
    return true;
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
    // Every request carries the per-session token the server injected into this page.
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
    const parsed = result || { ok: false, error: 'The local Windows HID bridge returned no data.' };
    parsed.httpStatus = response.status;
    return parsed;
}

function createNativeDevice(device) {
    const nativeDevice = {
        productName: device?.ProductName || 'Razer Naga V2 Pro',
        productId: device?.ProductId,
        opened: true,
        async sendFeatureReport(reportId, data) {
            if (reportId !== 0) throw new Error('The Naga command interface only accepts feature report 0.');
            const result = await nativeBridgeRequest('/api/hid/set', {
                report: bytesToBase64(new Uint8Array(data))
            });
            if (!result.ok) {
                const err = new Error(result.error || 'Windows rejected the Razer feature report.');
                // 503 = bridge stuck, restarted or unavailable; retrying won't help.
                err.nonRetryable = result.httpStatus === 503;
                throw err;
            }
        },
        async receiveFeatureReport(reportId) {
            if (reportId !== 0) throw new Error('The Naga command interface only returns feature report 0.');
            const result = await nativeBridgeRequest('/api/hid/get', {});
            if (!result.ok) {
                const err = new Error(result.error || 'Windows could not read the Razer feature report.');
                err.nonRetryable = result.httpStatus === 503;
                throw err;
            }
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

// ------------------------------------------------------------
// Device-lost handling (shared by the WebHID event and command failures)
// ------------------------------------------------------------

function handleDeviceLost(message) {
    if (!mouseDevice) return;            // idempotent: only the first caller acts
    const lost = mouseDevice;
    mouseDevice = null;                  // queued tasks see this and bail out
    if (window._battInterval) { clearInterval(window._battInterval); window._battInterval = null; }
    closeDevice(lost);                   // best effort, deliberately not awaited

    statusText.innerText = 'Mouse disconnected!';
    statusText.className = 'status-disconnected';
    document.getElementById('firmware-info').innerText = '';
    controlsPanel.style.display = 'none';
    connectBtn.style.display = 'block';
    reconnectBtn.style.display = 'block';
    showToast(message, true);
}

// A failed command alone isn't proof the mouse is gone (e.g. a sleeping
// wireless mouse is rejected too), so confirm via the bridge's status endpoint.
async function deviceStillPresent() {
    if (!mouseDevice) return false;
    if (!usingNativeBridge) return mouseDevice.opened !== false;
    try {
        const s = await nativeBridgeRequest('/api/hid/status');
        const count = Array.isArray(s.devices) ? s.devices.length : (s.devices ? 1 : 0);
        return !!(s.ok && s.device && count > 0);
    } catch {
        return false;                    // bridge unreachable or stuck
    }
}

// Charging LED effect/colour are wireless-only commands in OpenRazer.
function isWirelessConnected() {
    return !!mouseDevice && mouseDevice.productId === WIRELESS_PID;
}

function updateChargingControlsVisibility() {
    const wireless = isWirelessConnected();
    chargeEffectRow.style.display = wireless ? 'flex' : 'none';
    if (!wireless) {
        chargeColorRow.style.display = 'none';
    } else {
        chargeEffectSelect.dispatchEvent(new Event('change'));
    }
}

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

            // Read back and require a response echoing this command's class/id
            // before trusting the interface.
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
            handleDeviceLost('Mouse disconnected. Click Reconnect when ready.');
        }
    });
}

// ============================================================
// Auto Battery Polling (every 60s, silent on failure)
// ============================================================

function startBatteryPolling() {
    if (window._battInterval) clearInterval(window._battInterval);
    window._battInterval = setInterval(async () => {
        if (!mouseDevice) return;
        try {
            await fetchBattery({ quiet: true });
        } catch (e) { /* silently ignore */ }
    }, 60000);
}

async function fetchBattery(opts = {}) {
    const r = await sendRazerCommand(0x07, 0x80, 0x02, [0x00, 0x00], { context: 'Get battery level', ...opts });
    if (!r) return;
    const level = Math.round((r[9] / 255) * 100);
    batteryLevelEl.innerText = `${level}%`;
    batteryStatusDiv.className = level <= parseInt(lowBattSlider.value)
        ? 'battery-status battery-low'
        : 'battery-status';
}

// ============================================================
// Refresh All Values (each section in its own try/catch)
// ============================================================

async function refreshValues() {
    if (!mouseDevice) return;

    // 1. GET DPI
    try {
        const r = await sendRazerCommand(0x04, 0x85, 0x07, [VARSTORE, 0,0,0,0,0,0], { context: 'Get DPI' });
        if (r) {
            const dpiX = (r[9] << 8) | r[10];
            document.getElementById('current-dpi').innerText = `${dpiX} DPI`;
            dpiSlider.value = dpiX;
            dpiInput.value = dpiX;
        }
    } catch (e) { console.error('GET DPI failed:', e); }

    // 1b. GET DPI Stages (active stage is 1-based)
    try {
        const r = await sendRazerCommand(0x04, 0x86, 0x26, [VARSTORE], { context: 'Get DPI stages' });
        if (r) {
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
        // Read and validate every field before sending anything.
        const dpi = readIntField(dpiInput, 100, 30000, 'DPI');
        const dH = (dpi >> 8) & 0xFF, dL = dpi & 0xFF;

        const activeStage = Math.min(Math.max(selectedActiveStage, 1), 5);
        const stageArgs = [VARSTORE, activeStage, 0x05]; // varstore, active stage (1-based), count=5
        for (let i = 1; i <= 5; i++) {
            const s = readIntField(document.getElementById(`dpi-stage-${i}`), 100, 30000, `DPI stage ${i}`);
            stageArgs.push(i - 1, (s >> 8) & 0xFF, s & 0xFF, (s >> 8) & 0xFF, s & 0xFF, 0x00, 0x00);
        }

        const prStr = pollSelect.value;
        const prCode = POLL_CODES[prStr];
        if (prCode === undefined) throw new Error('Unknown polling rate selected.');

        const ok = await runSteps([
            { label: 'DPI',          cls: 0x04, id: 0x05, size: 0x07, args: [VARSTORE, dH, dL, dH, dL, 0, 0] },
            { label: 'DPI stages',   cls: 0x04, id: 0x06, size: 0x26, args: stageArgs },
            { label: 'polling rate', cls: 0x00, id: 0x05, size: 0x01, args: [prCode] }
        ]);
        if (!ok) return;

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
// Apply: Power (Low Battery Threshold + Idle Time + Charge LED)
// ============================================================

applyPowerBtn.addEventListener('click', async () => {
    if (!mouseDevice) return;
    try {
        const pct  = readIntField(lowBattInput, 5, 25, 'Low-battery threshold');
        const mins = readIntField(idleInput, 1, 15, 'Idle time');
        const secs = mins * 60;

        const steps = [
            { label: 'low-battery threshold', cls: 0x07, id: 0x01, size: 0x01, args: [Math.round(pct * 2.55)] },
            { label: 'idle time',             cls: 0x07, id: 0x03, size: 0x02, args: [(secs >> 8) & 0xFF, secs & 0xFF] }
        ];

        // Charge effect/colour are wireless-only; skip entirely on a wired connection.
        if (isWirelessConnected()) {
            const chargeType = parseInt(chargeEffectSelect.value);
            steps.push({ label: 'charge effect', cls: 0x03, id: 0x10, size: 0x01, args: [chargeType] });
            if (chargeType === 1) {
                const [cr, cg, cb] = hexToRgb(chargeColorPicker.value);
                const BATTERY_LED = 0x03;
                steps.push({ label: 'charge colour', cls: 0x03, id: 0x01, size: 0x05, args: [0x00, BATTERY_LED, cr, cg, cb] });
            }
        }

        if (!(await runSteps(steps))) return;

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

    const ZERO_LED = 0x00, LOGO_LED = 0x04;
    const zone = lightZoneSelect.value;
    const leds = zone === 'all'  ? [{ id: LOGO_LED, name: 'Logo' }, { id: ZERO_LED, name: 'Main' }]
               : zone === 'main' ? [{ id: ZERO_LED, name: 'Main' }]
               :                   [{ id: LOGO_LED, name: 'Logo' }];

    try {
        const brightness = readIntField(brightInput, 0, 100, 'Brightness');
        const bRaw = Math.round((brightness / 100) * 255);
        const [r, g, b] = hexToRgb(lightColorPicker.value);

        const effectFor = led => ({
            none:      { size: 0x06, args: [VARSTORE, led, 0x00, 0, 0, 0] },
            static:    { size: 0x09, args: [VARSTORE, led, 0x01, 0, 0, 0x01, r, g, b] },
            breathing: { size: 0x09, args: [VARSTORE, led, 0x02, 0x01, 0, 0x01, r, g, b] },
            spectrum:  { size: 0x06, args: [VARSTORE, led, 0x03, 0, 0, 0] },
            reactive:  { size: 0x09, args: [VARSTORE, led, 0x05, 0, 0x03, 0x01, r, g, b] },
            wave:      { size: 0x06, args: [VARSTORE, led, 0x04, 0x01, 0x28, 0] }
        })[lightEffectSelect.value];

        const steps = [];
        for (const led of leds) {
            const fx = effectFor(led.id);
            if (!fx) throw new Error('Unknown lighting effect selected.');
            steps.push({ label: `${led.name} brightness`, cls: 0x0F, id: 0x04, size: 0x03, args: [VARSTORE, led.id, bRaw] });
            steps.push({ label: `${led.name} effect`,     cls: 0x0F, id: 0x02, size: fx.size, args: fx.args });
        }

        if (!(await runSteps(steps))) return;

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
        activeStage: selectedActiveStage,
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

/** Validates a whole profile up front; throws before anything is touched. */
function validateProfileData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Profile must be a JSON object.');
    }
    const num = (v, min, max, label) => {
        const raw = String(v ?? '').trim();
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) throw new Error(`${label} must be a number.`);
        return Math.min(Math.max(Math.round(n), min), max);
    };
    const option = (select, v, label) => {
        if (!Array.from(select.options).some(o => o.value === String(v))) {
            throw new Error(`${label} has an unknown value.`);
        }
        return String(v);
    };
    const color = (v, label) => {
        if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${label} must be a #rrggbb colour.`);
        return v;
    };

    const out = {
        dpi: num(data.dpi, 100, 30000, 'DPI'),
        poll: option(pollSelect, data.poll, 'Polling rate'),
        lowBatt: num(data.lowBatt, 5, 25, 'Low-battery threshold'),
        idle: num(data.idle, 1, 15, 'Idle time'),
        zone: option(lightZoneSelect, data.zone, 'Lighting zone'),
        bright: num(data.bright, 0, 100, 'Brightness'),
        effect: option(lightEffectSelect, data.effect, 'Lighting effect'),
        color: color(data.color, 'Lighting colour')
    };
    if (data.stages !== undefined) {
        if (!Array.isArray(data.stages) || data.stages.length !== 5) throw new Error('DPI stages must be a list of 5 values.');
        out.stages = data.stages.map((v, i) => num(v, 100, 30000, `DPI stage ${i + 1}`));
    }
    if (data.activeStage !== undefined) out.activeStage = num(data.activeStage, 1, 5, 'Active stage');
    if (data.chargeEffect !== undefined) out.chargeEffect = option(chargeEffectSelect, data.chargeEffect, 'Charge effect');
    if (data.chargeColor !== undefined) out.chargeColor = color(data.chargeColor, 'Charge colour');
    return out;
}

function applyProfileData(raw) {
    const data = validateProfileData(raw); // throws before anything is touched

    dpiInput.value = data.dpi; dpiSlider.value = data.dpi;
    if (data.stages) {
        data.stages.forEach((v, i) => {
            const el = document.getElementById(`dpi-stage-${i + 1}`);
            if (el) el.value = v;
        });
    }
    if (data.activeStage !== undefined) setSelectedStage(data.activeStage);
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
        showToast(`Error loading profile: ${e.message}`, true);
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
            const name = (data && data._profileName) || 'imported';
            showToast(`Imported "${name}". Click Apply to send to mouse.`);
        } catch (err) {
            showToast(`Invalid profile file: ${err.message}`, true);
        }
    };
    reader.readAsText(file);
    // Reset so the same file can be imported again
    importFileInput.value = '';
});
