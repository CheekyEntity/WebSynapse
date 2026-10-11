# WebSynapse Changelog

Newest pass first. The second pass fixes problems found in a follow-up review of
the first pass's code; it is untested on real hardware, like the first.

# Second fix pass

Each item says what was wrong, what changed, and which file(s) it touches.

## Reliability

**A1 — one unanswered bridge request could freeze the whole app.** When a bridge
command threw inside PowerShell, the error response was sent with `id = $null`, so
`server.js` never matched it to its pending request. There was no timeout either,
and because every HID call is chained through one queue, a single hung request
blocked all later ones until the page was reloaded. Now the error response carries
the request's id, and every bridge request has a 10-second timeout that rejects the
request and restarts the bridge process. A request whose JSON can't even be parsed
has no id to echo, which is what the timeout covers. *(native-bridge.ps1,
server.js)*

**A2 — a stuck bridge made a failing command take ~50 seconds to report.** The page
retried a failed call 5 times, even when the failure was the bridge being
stuck/restarted/unavailable (HTTP 503), where retrying cannot help. Those failures
are now tagged non-retryable, so the toast appears immediately. *(app.js)*

**A3 — the UI kept saying "Connected" after the device or bridge went away.**
The only disconnect handling was the WebHID `disconnect` event, deliberately skipped
on the Windows-bridge path. A single `handleDeviceLost()` now resets the UI, stops
battery polling and releases the handle. It runs from the WebHID event and from a
failed command, but only after `/api/hid/status` confirms the device is really gone
or the bridge lost its handle — a sleeping wireless mouse, where the dongle is
still present, is not treated as disconnected. Commands queued before the loss bail
out instead of running against a null device. *(app.js)*

**A4 — battery polling toasted an error every 60 seconds once the device was gone.**
Background polls are now silent on failure; they still feed the device-lost check,
and polling stops when the device is lost. *(app.js)*

## Input handling

**B1 — empty or non-numeric fields were sent to the mouse as 0.** `parseInt('')`
is `NaN`, which passed through `Math.min/Math.max` unchanged and became `0` in the
report (DPI 0, idle 0, and so on). A strict `readIntField()` now throws on
empty/non-numeric input and clamps valid numbers; every Apply handler reads and
validates all of its fields before sending the first command, so a bad stage-4
value can't leave DPI already applied. *(app.js)*

**B2 — an unrecognised polling-rate value silently became 1000 Hz.** Apply now uses
an explicit `POLL_CODES` map and throws on anything else. *(app.js)*

**B3 — a bad profile import could half-apply.** Fields were assigned one by one, so
a malformed file could change some inputs and then fail. Profiles are now fully
validated first (numbers and ranges, five stages, option values, `#rrggbb` colours)
and nothing is touched unless every field passes. `stages`, `activeStage`,
`chargeEffect` and `chargeColor` stay optional so older profiles still load. Load
and import toasts now say which field was wrong. *(app.js)*

## Security

**C1 — no `Host`/`Origin` check (DNS rebinding).** The session token only stops
cross-origin pages from reading `index.html` — a rebound hostname makes the
attacker's page same-origin, so it could read the token. The server now rejects any
request, static files included, whose `Host` isn't `localhost:<port>` or
`127.0.0.1:<port>`, or whose `Origin` (when present) isn't one of the same two.
Reaching the app through a LAN IP or another hostname no longer works; it never
did, since the server binds to `127.0.0.1`. *(server.js)*

## Interface

**D1 — the title had no styling.** `index.html` used `<div class="logo">`, which no
CSS targeted, while the stylesheet styled `h1`. The header is now an `h1` (which
also gives the page a proper heading), and the unused `.beta` selector is gone.
*(index.html, styles.css)*

**D2 — profiles didn't remember the active DPI stage.** `activeStage` is now saved,
exported, validated and restored. Loading it marks the stage "unsaved — click
Apply", like clicking a badge. *(app.js)*

**D3 — a failed multi-step Apply only named the failing step.** Apply handlers now
run through a shared `runSteps()` helper; if earlier steps succeeded, the toast
says "Partly applied. Done: …. Stopped at: …." *(app.js)*

## Code hygiene

**E1 — lighting `dataSize` was inferred from the argument array's length.** The
values were correct, but fragile. Each effect now declares its own size, and an
unknown effect throws instead of being silently skipped. The byte layouts are
unchanged. *(app.js)*

## Reviewed, deliberately not changed

- **`pwsh.exe` requirement.** It works as documented. A fallback to Windows
  PowerShell 5.1 might work (no C# newer than version 5 was found in the embedded
  source) but is untested, so it was left alone.
- **Brightness readback.** It reads the Logo LED only, while the slider can apply to
  several zones. Reading both would add a HID round trip to every refresh, so it was
  skipped.

## Still needs a physical Naga V2 Pro

Everything under "What still can't be fixed from source" in the first pass below
still applies. In addition, none of this pass's changes have been run against real
hardware: in particular the device-lost detection (unplug, sleep, bridge restart)
and the 10-second bridge timeout should be tried with an actual mouse.

---

# First fix pass

Every item below traces back to a numbered issue from the technical review and its
source-verification pass. Each entry says what was wrong, what changed, and which
file(s) it's in. Items that genuinely can't be resolved without a physical Naga V2
Pro are listed separately at the bottom rather than guessed at.

## Protocol correctness

**1.1 — A7/A8 PID mapping reversed, and `app.js`/`native-bridge.ps1` disagreed with
each other.** `app.js` already had the correct mapping in one spot but
`native-bridge.ps1` had it backwards. Both now agree: `0x00A7` = wired, `0x00A8` =
wireless. Named constants (`WIRED_PID`/`WIRELESS_PID`) added so this can't silently
drift apart again. *(app.js, native-bridge.ps1)*

**1.2 — a SET was treated as "applied" the instant the Windows API call returned,
with no check that the mouse actually accepted it.** `SetFeature` now reads back
the device's response after every write and checks its status byte (busy / success
/ failure / timeout / not-supported) and that the response echoes the same command
class/id that was sent, retrying up to 5 times on a transient/busy result before
reporting failure — mirroring OpenRazer's own `razer_send_payload` retry loop.
*(native-bridge.ps1)*

**1.3 — DPI-stage numbering, both directions.**
- *Write side:* the active-stage byte was hardcoded to `0` regardless of what the
  user wanted (and OpenRazer explicitly rejects `0` as invalid — stages are
  1-indexed). There was also no UI control to actually choose an active stage in
  the first place. Stage badges are now clickable; the selection is tracked and
  sent as a proper 1-based value, clamped to the valid range.
- *Read side:* the active-stage byte from the device is documented by OpenRazer as
  1-based, but was being compared against a 0-based loop index and then had `+1`
  added again when displayed — an off-by-one that both highlighted the wrong badge
  and showed the wrong stage number. Fixed to use the value directly.
*(app.js, index.html, styles.css)*

**1.4 — the transaction-ID rule (`class===0x0F ? 0x1F : 0xFF`) was wrong far more
broadly than just lighting commands.** Checked against OpenRazer across every
command class this device uses; the Naga V2 Pro uses `0x1F` for essentially
everything. The rule is now a flat `0x1F`. *(app.js)*

**1.5 — an unrecognised polling-rate code silently displayed as "1000 Hz."** Now
shows the raw code and logs a console warning instead of asserting a value that
was never actually confirmed. *(app.js)*

**1.6 / 1.7 — no validation of the device's response, anywhere.** Every read
site (battery, DPI, DPI stages, poll rate, charging status, low-battery
threshold, idle time, brightness) now goes through a single shared
`sendRazerCommand()` helper that checks the status byte and the echoed
command class/id before trusting any returned bytes. *(app.js)*

**1.8 / 1.9 — `sleep(50)` was the only synchronization mechanism, and nothing
prevented two HID transactions (e.g. the 60s battery poll and a user's Apply
click) from interleaving.** All HID I/O now goes through one serialized queue
(`sendRazerCommand`/`serialized()`), so only one transaction is ever in flight,
with bounded retries on a busy/invalid response rather than a single blind
delay. *(app.js)*

**1.10 — wrong LED id for the charging colour command.** Sent `0x04` labeled
"BATTERY_LED" in a comment — but this file's own lighting-zone code, a few
hundred lines away, correctly identifies `0x04` as the *Logo* LED. Changed to
`0x03` (`BATTERY_LED`), matching OpenRazer's charge-colour function. *(app.js)*

**1.11 — charging LED effect/colour were sent unconditionally, but OpenRazer only
registers those commands for the wireless variant.** Connection now tracks the
connected PID; the charging-effect UI section is hidden on a wired connection,
and the commands are skipped even if something forces the UI visible. A toast
tells the user why when connecting over cable. *(app.js, native-bridge.ps1,
index.html)*

## Interface selection

**5 — the WebHID probe committed to the first interface that accepted a write,
without checking whether it actually behaved like a Razer command interface.**
Now reads back the response to the probe write and requires it to echo the
expected command class/id before accepting that interface. *(app.js)*

**6 — the native bridge's interface selection was a pure static heuristic (HID
descriptor matching) with no live protocol probe at all.** Reworked to try every
plausible candidate in priority order with a real SET+GET probe (the same
standard as the WebHID fix above), only committing to one that actually responds
correctly. *(native-bridge.ps1 — the embedded C# was extracted and compiled
standalone with `mcs -warn:4 -warnaserror+`: 0 errors, 0 warnings.)*

## Lighting

**Item 3 — "Scroll Wheel" lighting was never backed by the reference driver for
this device** (OpenRazer registers zero `scroll_matrix_effect_*` files for the
Naga V2 Pro). Replaced with "Main / Thumbgrid," which uses the LED id
(`ZERO_LED`) that OpenRazer's own `matrix_brightness`/`matrix_effect_*` calls
actually use for this device — found while fixing this, not in the original
review. *(app.js, index.html)*

*(No fix needed: all six lighting effect byte layouts were independently
re-verified argument-by-argument against OpenRazer's `razer_chroma_extended_
matrix_effect_*` functions and match exactly.)*

## Server & API

**9 — no auth token, no Content-Type enforcement, binds to localhost only (which
doesn't stop another local tab/page from hitting it directly).** The server now
generates a random per-session token at startup, injects it into `index.html` on
load, and rejects any `/api/hid/*` request that doesn't carry it. POST bodies
also now require `Content-Type: application/json`. *(server.js, app.js)*

**10 — `/api/hid/set` was pure base64-in passthrough with zero structural
validation.** This doesn't become a full semantic command API (that's a much
larger redesign, not a bounded fix), but the server now rejects anything that
isn't even a well-formed Razer report — wrong length, or a checksum that doesn't
match its own contents — before it reaches the bridge. *(server.js)*

Both of the above were exercised against a running instance of the modified
server (not just reviewed): valid token passes through to the bridge-spawn
stage, missing/wrong token gets 403, malformed/wrong-length/bad-checksum
reports get 400, and a genuinely valid report is not falsely rejected.

## Smaller items

**7 — no firmware-version detection.** Added (`0x00/0x81`, OpenRazer's
documented command); shown next to the connection status once connected.
*(app.js, index.html)*

**15 — profiles read as if they might be onboard hardware profiles.** Labels and
button text now make it explicit this is browser-local storage only, nothing is
written to the mouse until Apply is pressed. *(index.html, app.js)*

*(No fix needed: checksum implementation (13) and command-ID table (14) were
re-verified byte-for-byte against the reference driver and are correct as-is.)*

## Update — after getting razercommon.h, razerchromacommon.h, razermouse_driver.h

The three OpenRazer headers (previously missing — only the `.c` files were
available) let several things move from "best-effort inference" to
"independently confirmed," and surfaced one genuinely new, concrete fix:

**Confirmed exactly as used, no code changes needed:**
- `USB_DEVICE_ID_RAZER_NAGA_V2_PRO_WIRED/WIRELESS` = `0x00A7`/`0x00A8` (issue 1.1)
- `RAZER_CMD_BUSY/SUCCESSFUL/FAILURE/TIMEOUT/NOT_SUPPORTED` = `0x01`–`0x05` (issues 1.2/1.6/1.7)
- `BATTERY_LED=0x03`, `LOGO_LED=0x04`, `ZERO_LED=0x00`, `SCROLL_WHEEL_LED=0x01` (issue 1.10, item 3)
- The `razer_report` struct layout (`status`@0, `transaction_id`@1,
  `remaining_packets`@2–3 big-endian, `protocol_type`@4, `data_size`@5,
  `command_class`@6, `command_id`@7, `arguments`@8–87, `crc`@88, `reserved`@89)
  — matches `buildRazerReport()` exactly, including the fields it leaves at 0.

**New fix — response-wait timing.** `razermouse_driver.h` defines
`RAZER_NEW_MOUSE_RECEIVER_WAIT_US = 31000` (31ms); the Naga V2 Pro is in the
device list that's routed through this constant rather than the default
`RAZER_MOUSE_WAIT_US` (600us). This pass had used a guessed ~30ms wait with no
real backoff/retry structure behind it. Reworked to match OpenRazer's actual
two-tier timing: every attempt now resends the SET (not just a re-read of a
stale buffer), waits the confirmed 31ms before reading the response, and — if
that attempt wasn't successful — backs off 10ms (matching
`razer_send_payload`'s `fsleep(10000)`) before the next attempt. Also widened
retry behavior to match the reference: it retries on *every* non-successful
status (not just BUSY), only reporting a specific error after all 5 attempts
are exhausted. *(app.js, native-bridge.ps1 — recompiled clean with
`mcs -warn:4 -warnaserror+` after the change.)*

## What still can't be fixed from source — needs a physical Naga V2 Pro

These remain genuinely hardware-only; this pass deliberately did not guess at
them, since an unverified "fix" here could easily be worse than leaving the
TODO:

- Whether a static-colour mode-switch command is required before setting a
  static colour (OpenRazer's generic `device_mode` switch doesn't list the Naga
  V2 Pro, which neither confirms nor rules it out for this device).
- Whether `VARSTORE` writes actually persist across reconnect/power-cycle on
  this firmware.
- Whether the "Main / Thumbgrid" zone and every lighting effect do the
  visually-correct thing on this specific device (the LED id itself, `ZERO_LED
  = 0x00`, is now confirmed against the header — what's still unverified is
  only how it behaves on real hardware).
- The exact 31ms/10ms timing above is what the reference driver documents and
  uses, but hasn't been confirmed to be sufficient/necessary for WebSynapse's
  own send/receive path specifically (different OS, different HID stack).

Recommended next step for all of the above, same as the original review: capture
real Set/Get HID traffic against a physical device (Wireshark + USBPcap, or log
request/response pairs directly in `native-bridge.ps1`) and diff it against what's
here.
