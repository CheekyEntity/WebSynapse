// ============================================================
// WebSynapse — Driverless Razer Naga V2 Pro Controller
// ============================================================

const VENDOR_ID = 0x1532;
const PRODUCT_ID = 0x00A7;
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
 * transaction_id = 0x1F for extended matrix commands (class 0x0F),
 * 0xFF for everything else.
 */
function buildRazerReport(commandClass, commandId, dataSize, args = []) {
    const report = new Uint8Array(90);
    report[0] = 0x00; // status
    report[1] = (commandClass === 0x0F) ? 0x1F : 0xFF; // transaction_id
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
// Connection
// ============================================================

async function connectToDevice(devices) {
    if (devices.length === 0) throw new Error("No devices found.");

    let success = false;
    for (const dev of devices) {
        try {
            if (!dev.opened) await dev.open();
            const testReport = buildRazerReport(0x00, 0x85, 0x01, [0x00]);
            await dev.sendFeatureReport(0x00, testReport);
            mouseDevice = dev;
            success = true;
            break;
        } catch (e) {
            console.log(`Skipping interface (threw ${e.name})`);
            if (dev.opened) await dev.close();
        }
    }

    if (!success) throw new Error("All interfaces blocked. Ensure Synapse is closed.");

    statusText.innerText = `Connected to ${mouseDevice.productName}`;
    statusText.className = 'status-connected';
    controlsPanel.style.display = 'flex';
    connectBtn.style.display = 'none';
    reconnectBtn.style.display = 'block';
    profileSection.style.display = 'block';

    showToast('Connected successfully!');
    await refreshValues();
    startBatteryPolling();
}

connectBtn.addEventListener('click', async () => {
    try {
        const devices = await navigator.hid.requestDevice({
            filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]
        });
        await connectToDevice(devices);
    } catch (e) {
        console.error('Connection failed:', e);
        statusText.innerText = 'Connection failed. ' + e.message;
        statusText.className = 'status-error';
        showToast('Connection failed', true);
    }
});

reconnectBtn.addEventListener('click', async () => {
    try {
        const devices = await navigator.hid.getDevices();
        const razer = devices.filter(d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
        await connectToDevice(razer);
    } catch (e) {
        showToast('Reconnection failed: ' + e.message, true);
    }
});

// --- HID Disconnect Detection ---
navigator.hid.addEventListener('disconnect', (event) => {
    if (mouseDevice && event.device === mouseDevice) {
        mouseDevice = null;
        if (window._battInterval) clearInterval(window._battInterval);
        statusText.innerText = 'Mouse disconnected!';
        statusText.className = 'status-disconnected';
        controlsPanel.style.display = 'none';
        connectBtn.style.display = 'block';
        reconnectBtn.style.display = 'block';
        showToast('Mouse disconnected — click Reconnect when ready', true);
    }
});

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
    const report = buildRazerReport(0x07, 0x80, 0x02, [0x00, 0x00]);
    await mouseDevice.sendFeatureReport(0x00, report);
    await sleep(50);
    const resp = await mouseDevice.receiveFeatureReport(0x00);
    if (resp && resp.buffer) {
        const r = new Uint8Array(resp.buffer);
        const level = Math.round((r[9] / 255) * 100);
        batteryLevelEl.innerText = `${level}%`;
        batteryStatusDiv.className = level <= parseInt(lowBattSlider.value)
            ? 'battery-status battery-low'
            : 'battery-status';
    }
}

// ============================================================
// Refresh All Values (robust — each section in its own try/catch)
// ============================================================

async function refreshValues() {
    if (!mouseDevice) return;

    // 1. GET DPI
    try {
        const rep = buildRazerReport(0x04, 0x85, 0x07, [VARSTORE, 0,0,0,0,0,0]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
            const dpiX = (r[9] << 8) | r[10];
            document.getElementById('current-dpi').innerText = `${dpiX} DPI`;
            dpiSlider.value = dpiX;
            dpiInput.value = dpiX;
        }
    } catch (e) { console.error('GET DPI failed:', e); }

    // 1b. GET DPI Stages
    try {
        const rep = buildRazerReport(0x04, 0x86, 0x26, [VARSTORE]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
            const activeStage = r[9]; // arg[1] = active stage index
            const count = r[10];      // arg[2] = number of stages
            for (let i = 0; i < Math.min(count, 5); i++) {
                const offset = 11 + (i * 7); // arg[3 + i*7]
                const dpiX = (r[offset + 1] << 8) | r[offset + 2];
                const el = document.getElementById(`dpi-stage-${i + 1}`);
                if (el) el.value = dpiX;
                // Update badge
                const badge = document.getElementById(`stage-badge-${i + 1}`);
                if (badge) {
                    badge.classList.toggle('active-stage', i === activeStage);
                }
            }
            document.getElementById('active-stage-label').innerText = `Active: Stage ${activeStage + 1}`;
        }
    } catch (e) { console.error('GET DPI Stages failed:', e); }

    // 2. GET Polling Rate
    try {
        const rep = buildRazerReport(0x00, 0x85, 0x01, [0x00]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
            const code = r[8];
            const pr = code === 0x02 ? 500 : code === 0x08 ? 125 : 1000;
            document.getElementById('current-poll').innerText = `${pr} Hz`;
            pollSelect.value = pr.toString();
        }
    } catch (e) { console.error('GET Poll Rate failed:', e); }

    // 3. GET Battery Level
    try { await fetchBattery(); } catch (e) { console.error('GET Battery failed:', e); }

    // 4. GET Charging Status
    try {
        const rep = buildRazerReport(0x07, 0x84, 0x02, [0x00, 0x00]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
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
        const rep = buildRazerReport(0x07, 0x81, 0x01, [0x00]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
            const pct = Math.round(r[8] / 2.55);
            document.getElementById('current-low-batt').innerText = `${pct}%`;
            lowBattSlider.value = pct;
            lowBattInput.value = pct;
        }
    } catch (e) { console.error('GET Low Batt failed:', e); }

    // 6. GET Idle Time
    try {
        const rep = buildRazerReport(0x07, 0x83, 0x02, [0x00, 0x00]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
            const secs = (r[8] << 8) | r[9];
            const mins = Math.round(secs / 60);
            document.getElementById('current-idle').innerText = `${mins} Min`;
            idleSlider.value = mins;
            idleInput.value = mins;
        }
    } catch (e) { console.error('GET Idle Time failed:', e); }

    // 7. GET Brightness (Logo LED)
    try {
        const rep = buildRazerReport(0x0F, 0x84, 0x03, [VARSTORE, 0x04, 0x00]);
        await mouseDevice.sendFeatureReport(0x00, rep);
        await sleep(50);
        const resp = await mouseDevice.receiveFeatureReport(0x00);
        if (resp && resp.buffer) {
            const r = new Uint8Array(resp.buffer);
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
        const dpi = Math.min(Math.max(parseInt(dpiInput.value), 100), 30000);
        const dH = (dpi >> 8) & 0xFF, dL = dpi & 0xFF;
        const dpiRep = buildRazerReport(0x04, 0x05, 0x07, [VARSTORE, dH, dL, dH, dL, 0, 0]);
        await mouseDevice.sendFeatureReport(0x00, dpiRep);
        await sleep(50);

        // SET DPI Stages (5 stages)
        const stageArgs = [VARSTORE, 0x00, 0x05]; // varstore, active=0, count=5
        for (let i = 1; i <= 5; i++) {
            let s = Math.min(Math.max(parseInt(document.getElementById(`dpi-stage-${i}`).value), 100), 30000);
            stageArgs.push(i - 1); // stage index
            stageArgs.push((s >> 8) & 0xFF, s & 0xFF); // X
            stageArgs.push((s >> 8) & 0xFF, s & 0xFF); // Y
            stageArgs.push(0x00, 0x00); // reserved
        }
        const stageRep = buildRazerReport(0x04, 0x06, 0x26, stageArgs);
        await mouseDevice.sendFeatureReport(0x00, stageRep);
        await sleep(50);

        // SET Polling Rate
        const prStr = pollSelect.value;
        const prCode = prStr === '125' ? 0x08 : prStr === '500' ? 0x02 : 0x01;
        const pollRep = buildRazerReport(0x00, 0x05, 0x01, [prCode]);
        await mouseDevice.sendFeatureReport(0x00, pollRep);

        document.getElementById('current-dpi').innerText = `${dpi} DPI`;
        document.getElementById('current-poll').innerText = `${prStr} Hz`;
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
        const lowRep = buildRazerReport(0x07, 0x01, 0x01, [raw]);
        await mouseDevice.sendFeatureReport(0x00, lowRep);
        await sleep(50);

        // SET Idle Time
        let mins = Math.min(Math.max(parseInt(idleInput.value), 1), 15);
        const secs = mins * 60;
        const idleRep = buildRazerReport(0x07, 0x03, 0x02, [(secs >> 8) & 0xFF, secs & 0xFF]);
        await mouseDevice.sendFeatureReport(0x00, idleRep);
        await sleep(50);

        // SET Charge Effect (0x03, 0x10, 0x01) — 0x00=default, 0x01=static
        const chargeType = parseInt(chargeEffectSelect.value);
        const chargeEffectRep = buildRazerReport(0x03, 0x10, 0x01, [chargeType]);
        await mouseDevice.sendFeatureReport(0x00, chargeEffectRep);
        await sleep(50);

        // SET Charge Colour if static mode (uses standard LED RGB: class 0x03, cmd 0x01)
        // BATTERY_LED = 0x04 based on Razer convention, NOSTORE = 0x00
        if (chargeType === 1) {
            const [cr, cg, cb] = hexToRgb(chargeColorPicker.value);
            const chargeColorRep = buildRazerReport(0x03, 0x01, 0x05, [0x00, 0x04, cr, cg, cb]);
            await mouseDevice.sendFeatureReport(0x00, chargeColorRep);
            await sleep(50);
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
    // LED IDs: 0x01 = Scroll, 0x04 = Logo, 0x05 = Backlight
    const zones = zone === 'all' ? [0x01, 0x04, 0x05] :
                  zone === 'scroll' ? [0x01] : [0x04];

    const brightness = parseInt(brightInput.value);
    const bRaw = Math.round((brightness / 100) * 255);
    const effect = lightEffectSelect.value;
    const [r, g, b] = hexToRgb(lightColorPicker.value);

    try {
        for (const led of zones) {
            // Brightness
            const bRep = buildRazerReport(0x0F, 0x04, 0x03, [VARSTORE, led, bRaw]);
            await mouseDevice.sendFeatureReport(0x00, bRep);
            await sleep(50);

            // Effect
            let eRep;
            switch (effect) {
                case 'none':
                    eRep = buildRazerReport(0x0F, 0x02, 0x06, [VARSTORE, led, 0x00, 0,0,0]); break;
                case 'static':
                    eRep = buildRazerReport(0x0F, 0x02, 0x09, [VARSTORE, led, 0x01, 0,0, 0x01, r,g,b]); break;
                case 'breathing':
                    eRep = buildRazerReport(0x0F, 0x02, 0x09, [VARSTORE, led, 0x02, 0x01,0, 0x01, r,g,b]); break;
                case 'spectrum':
                    eRep = buildRazerReport(0x0F, 0x02, 0x06, [VARSTORE, led, 0x03, 0,0,0]); break;
                case 'reactive':
                    eRep = buildRazerReport(0x0F, 0x02, 0x09, [VARSTORE, led, 0x05, 0, 0x03, 0x01, r,g,b]); break;
                case 'wave':
                    eRep = buildRazerReport(0x0F, 0x02, 0x06, [VARSTORE, led, 0x04, 0x01, 0x28, 0]); break;
            }
            if (eRep) {
                await mouseDevice.sendFeatureReport(0x00, eRep);
                await sleep(50);
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
    showToast(`Saved profile: ${name}`);
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
