# Phase 1.1 — External MIDI Hardware Acceptance

> **Acceptance status: software regressions are covered; physical-device acceptance remains pending.** This sandbox exposes no physical MIDI/audio/USB devices. No synth, DIN wire, OS loopback, real browser permission prompt, or OS-level MIDI permission grant was tested in this sandbox. A human engineer must complete the bench procedure and attach its exported evidence before marking hardware acceptance complete.

## 1. Baseline, scope, and validation evidence classes

The Phase 1.1 review started from the verified `origin/main` baseline:

- Commit: `c860afaf9b64d37eb5cb1d993cf576a3df05371a`
- Protected tag: `v1.2.2` → `88d5889331be89a29b775e6773885b6531c7e802` (must not be moved or modified)
- Initial worktree was clean. Phase 1.1 implementation is isolated to reconnect safety, its tests, this procedure, and a standalone diagnostic page.

Keep these validation classes separate in every report:

| Class | What it proves | What it does **not** prove |
| :--- | :--- | :--- |
| **Deterministic simulation** (`tsx --test`, fake `MIDIOutput`, receiver-state model) | Scheduler math, bytes, routing, cleanup decisions, permission state transitions, and local state-machine behavior | Real device enumeration, OS permissions, electrical/MIDI wire delivery, sound, hardware latency, or a synthesizer's firmware behavior |
| **Chromium-instrumented E2E** (mocked `navigator.requestMIDIAccess`, `MIDIOutput`, and loopback input) | The app/diagnostic page invokes Web MIDI APIs, renders states, and sends the expected values through the browser-facing code | A physical browser permission decision, a genuine loopback, a real synth, or physical timing |
| **Genuine interface loopback** (MIDI interface OUT connected by MIDI cable to MIDI interface IN; or a specifically identified OS/driver loopback) | Captured output bytes and timing at that loopback point. Report whether the path is physical or software/OS loopback. | Audible synthesis, patch behavior, or audio output latency |
| **Actual synthesizer test** (Apex output → powered hardware synth MIDI IN, with audio monitored/recorded) | MIDI reception, note/pedal release behavior, route/channel behavior, and audible instrument response | Other models, firmware, interfaces, hosts, or OS versions not tested |

A JavaScript `MIDIOutput` mock is **never** physical hardware evidence. An IAC Driver, loopMIDI, or ALSA virtual port is a software/OS loopback, not a cable-level loopback.

## 2. Environment record required for a physical run

Copy this section into the test report and fill every applicable field:

- Date/time and tester:
- Apex Studio commit, branch, and build type (web/Desktop):
- OS/distribution and version; kernel/build:
- Browser/Electron version and whether the page is HTTPS or localhost:
- MIDI permission state before and after the test; how denial/re-grant was performed:
- MIDI interface/controller make, model, firmware, driver, and **stable output/input IDs**:
- Output name/manufacturer and input name/manufacturer as reported by Web MIDI:
- Topology: USB direct / USB-to-DIN / physical OUT-to-IN loopback / OS virtual loopback:
- Synth make/model/firmware, patch/program, receive channel, Omni/local settings, and audio output path:
- Audio interface make/model, driver, sample rate, buffer size, and monitor/recording path:
- USB hub/cable/DIN cable details, power state, and any MIDI thru/merge/router in the path:
- Test project, tempo/meter, note range, and route/channel selections:
- Exported JSON/CSV log path and any audio/wire capture path:
- Outcome per case (Pass / Fail / Blocked), observed anomalies, and reviewer:

### Environment actually available to this implementation run

The checked-out Linux sandbox (`e2b.local`, kernel `6.1.158+`, x86_64) had no `/dev/snd`, `/dev/snd/seq`, `/dev/midi*`, `/proc/asound`, `/sys/class/sound`, or `/sys/bus/usb/devices`. `aconnect`, `amidi`, `aseqdump`, `aplay`, `arecord`, `lsusb`, `pw-cli`, `pactl`, and `jack_lsp` were absent. **No physical device, real OS MIDI port, or real synth was available.** An actual headless Chromium 153.0.8010.0 permission-descriptor query on secure `http://localhost` reported `navigator.requestMIDIAccess` available and the MIDI permission state `prompt`. The probe did not call `requestMIDIAccess`, so it did not display or exercise a native permission prompt or enumerate a physical port. Playwright permission/device tests use injected fake ports. Desktop permission policy was reviewed in code: app content (`file://` or the localhost dev origin) may request/check `midi` and `midiSysex`; external origins may not. This does not establish an OS-level grant on a user's machine.

## 3. Bench setup and standalone diagnostic harness

1. Use a current Web MIDI-capable Chrome/Chromium/Edge browser or a packaged Apex Studio Desktop build. Web MIDI requires a secure context: use the deployed HTTPS origin or `http://localhost`, not `file://` for the web build.
2. Power and connect the target interface/synth before opening the application. On macOS/Windows/Linux, approve any browser, desktop, device, or driver permission prompt shown by that OS. If permission is denied, use the browser/site or OS settings to grant it, then click **Rescan Hardware** in the app or request access again in the diagnostic page.
3. Start with synth monitoring volume low and use a patch with a short, audible release. Disable Omni receive when checking wrong-channel isolation. Do not enable SysEx for this procedure.
4. Open the separate tool at **`/midi-hardware-diagnostic.html`** on the same HTTPS/localhost host as Apex Studio. It sends only the messages requested by its buttons; it does not call the production transport, mutate a project, or start DAW playback.
5. Click **Request / refresh MIDI access**. Select the output by stable ID, manufacturer, and name. Optionally select an input connected to the output for loopback capture. Select a MIDI channel explicitly.
6. Use **Send timestamped Note On + Note Off**, the CC controls (especially **CC64 sustain down/up**), and the log downloads. The JSON log captures user-agent/platform, permission result, device name/stable ID/state/connection, selected route, raw bytes, requested `DOMHighResTimeStamp`, observed loopback time, and disconnect/reconnect/recovery actions. The CSV is an event-oriented view.
7. The **Panic selected route** button requires confirmation and sends tracked Note Offs plus CC64=0 and CC123=0 to the selected output/channel only. CC123 can silence all voices on that synth channel; it is not used for automatic reconnect recovery.
8. For a **genuine MIDI loopback**, patch the interface's MIDI OUT to its MIDI IN with a physical cable and select that input. Record the interface/driver timestamps and wiring. If using IAC/loopMIDI/ALSA virtual routing instead, label the result **software/OS loopback**.

## 4. Exact byte and channel checks

MIDI channel `n` is one-based in the UI. For a pitch of 60 and velocity 100, the expected three-byte messages are:

| UI channel | Note On | Note Off | CC64 down | CC64 up |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `[0x90, 0x3C, 0x64]` | `[0x80, 0x3C, 0x00]` | `[0xB0, 0x40, 0x7F]` | `[0xB0, 0x40, 0x00]` |
| 2 | `[0x91, 0x3C, 0x64]` | `[0x81, 0x3C, 0x00]` | `[0xB1, 0x40, 0x7F]` | `[0xB1, 0x40, 0x00]` |
| 4 | `[0x93, 0x3C, 0x64]` | `[0x83, 0x3C, 0x00]` | `[0xB3, 0x40, 0x7F]` | `[0xB3, 0x40, 0x00]` |
| 10 | `[0x99, 0x3C, 0x64]` | `[0x89, 0x3C, 0x00]` | `[0xB9, 0x40, 0x7F]` | `[0xB9, 0x40, 0x00]` |
| 16 | `[0x9F, 0x3C, 0x64]` | `[0x8F, 0x3C, 0x00]` | `[0xBF, 0x40, 0x7F]` | `[0xBF, 0x40, 0x00]` |

Status formulae: Note On `0x90 + (n - 1)`, Note Off `0x80 + (n - 1)`, Control Change `0xB0 + (n - 1)`. Pitch 60 is `0x3C`; velocity 100 is `0x64`; CC64 is `0x40`; pedal down is `0x7F`; pedal up is `0x00`. Apex sends explicit Note Off status (`0x8n`); a Note On with velocity zero is also a MIDI Note Off by convention but is not the expected encoding for these checks. CC123 (`0x7B`) is not automatic reconnect cleanup.

**Physical channel sweep:** with the diagnostic output looped back to the selected input, select channels 1–16 in turn and send one test note, then compare exact bytes. Use a distinct pitch per channel if helpful. A single-channel synth cannot validate all receive channels acoustically; it can still validate its configured receive channel, while a multichannel loopback captures the full sweep. In the app, repeat the target synth's actual receive channel in External Only and Mirror modes.

## 5. Timing measurement and criteria

At 120 BPM, a sixteenth-note step is exactly `60,000 / 120 / 4 = 125 ms`; a half-step offset is `62.5 ms`. The scheduler maps audio event time to `performance.now()` using `AudioContext.getOutputTimestamp()` where valid and falls back to `(audioTime - context.currentTime) * 1000 + performance.now()`.

Software assertions are intentionally deterministic: scheduler clock-mapping and step-duration checks use `<1e-6 ms` computed timestamp error; AudioEngine/fake-transport integration checks use `<1e-3 ms` to cover floating-point accumulation at that integration boundary. These are **numeric assertions on requested Web MIDI timestamps**, not a claim that an operating system, USB driver, MIDI interface, cable, or synth physically delivers within a microsecond.

For physical measurement:

1. Record each output's requested timestamp and each loopback input `MIDIMessageEvent.timeStamp` from the exported log. Keep the output/input IDs, interface, driver, topology, and recording conditions with the data.
2. Send at least 100 timestamped Note On/Off pairs at the intended tempo and gate, including fractional-step onsets and sustained notes. For repeatable runs, use the same channel, pitch/velocity set, and interface path; do not compare a physical loop with a software virtual port as though they were the same path.
3. Report signed requested-to-observed deltas, median, p95, maximum, and any missing/duplicate/out-of-order/wrong-channel packets. The diagnostic page computes exact-byte counts and timing summaries; it deliberately does not impose a generic millisecond threshold.
4. For timing sign-off, compare the captured distribution with the interface/driver specification or an agreed, recorded baseline and target. If no approved limit exists, report the measurements and mark timing acceptance **Pending reviewer tolerance** rather than inventing a pass threshold. Audible synth/audio-interface latency is a separate measurement: record the synth audio return and state the audio buffer/sample-rate settings.
5. Strict byte acceptance is independent of latency: no missing/duplicate/wrong-channel packets in the selected loopback window, correct Note On/Off parity, and expected channel/status bytes. The loopback comparison's unmatched sends should be investigated; queued events explicitly cancelled by `MIDIOutput.clear()` are marked cancelled rather than treated as expected wire deliveries.

## 6. Physical acceptance matrix

Perform these on the actual selected device, with logs and outcomes for each case. Use a second output port where the case requires route-isolation proof.

| Case | Action | Expected evidence / pass condition |
| :--- | :--- | :--- |
| **Permission denied → grant → re-grant** | Deny Web MIDI once, verify the honest denial UI; grant in browser/OS settings and rescan; revoke and grant again. | Real browser/desktop status changes as expected; the same stable output ID returns Ready after grant; no fallback output is selected. Attach OS/browser/version and logs. The automated UI permission test is mocked and is not a substitute for this case. |
| **Channel sweep 1–16** | Send Note On, Note Off, CC64 down, and CC64 up from the diagnostic page on each channel. | Loopback captures exact bytes from §4, each once and in order. Confirm wrong-channel silence on a non-Omni synth. |
| **External Only / Mirror / Off** | Play a varied-velocity phrase with the synth on its selected receive channel; switch modes while notes are active. | External Only: hardware sounds and internal voice is silent. Mirror: both sound. Off: no new external MIDI; any active external note is released. No stale/future Note On escapes after Off. |
| **Scheduler timing and tempo** | Pattern and Song playback across several bars; vary BPM (e.g. 120→80→150) while notes are active; repeat with a loopback. | Report observed delta distribution using §5; no missing/duplicate/out-of-order or wrong-channel event; sustained Note Off follows the scheduler's retimed target, not an obsolete tempo target. Apply only a pre-agreed physical timing tolerance. |
| **Song end** | Use a one-bar arrangement with a long note starting on its final step and extending past the arrangement. | At the exact arrangement end, transport stops and the actual synth releases the note; no old queued Note On plays after the end. |
| **Same-pitch contributors** | Put same-pitch notes on two DAW channels sharing one physical output and MIDI channel, with different durations; remove/mute one contributor while the other survives. | The surviving contributor's release is preserved. MIDI cannot distinguish two sources with identical port/channel/pitch: the physical voice is shared, and a Note Off for that voice affects both contributors. Report this protocol limitation; do not claim per-DAW isolation for an identical physical voice. |
| **Solo, mute, routing mode/channel change** | Toggle solo/mute, change External/Mirror/Off, or change MIDI channel while notes sound. | Removed route's known notes release; surviving MIDI channels/ports remain audible and unmodified; changed/off route sends no stale future attacks. |
| **Stop, pause, seek, loop, project replace** | Execute each transport/project transition during active and future-queued notes; also test a sustained note and CC64. | Active notes close, CC64 releases where held, future queued Note Ons do not fire, and new project/position starts cleanly. Check that no unrelated route is silenced. |
| **Disconnect/reconnect with active notes + sustain** | On output A, hold a note and CC64 on one MIDI channel; have another note on a sibling channel and active traffic on output B. Unplug A mid-note, continue playback, reconnect A. | A remains the selected stable ID while disconnected; B receives zero substituted or cleanup traffic. On reconnect A is reopened, its stale queue is cleared if supported, CC64=0 is sent only on previously affected channels, and explicit Note Offs are sent only for captured `(A, channel, pitch)` voices. No automatic CC123/CC120 is sent. New playback resumes only after cleanup; no stale scheduler ownership remains. |
| **Application shutdown** | Close/reload the tab or quit Desktop during active notes. | Shutdown cleanup releases tracked notes/pedal on their configured routes. Capture whether the OS/browser delivers shutdown callbacks; a closed process cannot guarantee a hardware message. |
| **Export truthfulness** | Export WAV/stems with External Only routed to hardware, then export MIDI. | WAV/stems do not claim to contain hardware audio; MIDI export preserves notes/channel. This is not a live hardware render test. |

## 7. Reconnect investigation and implemented recovery behavior

A downstream synth can retain an active voice or sustain state after a link disappears: disconnect is a port/device event, not a MIDI Note Off or CC64-up message delivered to the synth. The reviewed scheduler previously deleted local active-note, deferred-event, pending-CC, and sustain tracking on disconnect; reconnect only reopened the output. That meant the host no longer knew which known pitches/pedals needed release, so the receiver could remain stuck until another explicit cleanup/panic. This is a protocol-level failure mode reproduced by a simulated receiver state model; it was **not** observed on a physical synth in this environment.

The focused production fix stores recovery state by stable output ID and MIDI channel/pitch before discarding local playback state. On reconnect it:

1. Opens the same configured output; it never substitutes another output.
2. Clears the reconnected port's stale Web MIDI queue where `MIDIOutput.clear()` works.
3. Sends CC64=0 only for channels where sustain was held or a CC64 transition was pending, then sends one explicit Note Off per unique tracked channel/pitch.
4. Blocks new scheduler output on that port until recovery completes; port-usability queries also report reconnect cleanup as pending rather than Ready. If `clear()` is absent or throws, it waits until the latest known queued MIDI event (Note On, Note Off, or pending CC) plus the scheduler's 1 ms minimum Note Off delta before issuing the release and reopening that port to playback. This prevents an uncancellable future Note On from being left sounding and an old queued Note Off/CC from interfering with resumed notes.
5. Does **not** broadcast CC123/CC120. Other output ports are untouched; on the same port, inactive MIDI channels receive no recovery traffic. A known pitch on a channel can still be shared by multiple DAW contributors, because MIDI 1.0 has no per-DAW-source note identity.

The simulated regression asserts a retained note and pedal survive the simulated cable loss until recovery; then only the affected output/channel/pitches are released. It also asserts a future queued Note On does not fire after reconnect, a same-port/same-channel unison is released once, sibling channels are isolated, the separate output receives no cleanup, no CC123 is emitted, and playback resumes on the original port. This is strong software evidence, not proof of all synth firmware or driver behavior.

## 8. Automated coverage and results to report

The Phase 1.1 automated additions are eight new tests plus an expanded existing permission test:

- `src/audio/midiOutputScheduler.test.ts`: route-specific disconnect/reconnect recovery, active note + CC64 state, future queued attack cancellation, unison deduplication, separate-port and sibling-channel isolation, no CC123, and resumed output.
- `src/audio/externalMidiOutputEngine.test.ts`: song-end release with a long final-step note; solo/routing-mode transitions while notes are active; extended permission denied/granted/revoked/re-granted flow; reconnect test now asserts note/pedal recovery and no substitution.
- `browser-tests/externalMidiOutput.spec.ts`: mocked Chromium UI permission denial, grant, revocation, and re-grant.
- `browser-tests/midiHardwareDiagnostic.spec.ts`: diagnostic page byte/loopback comparison, route-specific reconnect recovery, and clear-less queued-event gating using injected fake ports.

Existing useful coverage remains in place: scheduler Note On/Off encoding across all 16 channels; fractional timestamps and mapping; shared-port same-pitch contributor ownership; stop/pause/seek/loop/project-replace cleanup; external/Mirror/Off behavior; output non-substitution; and UI persistence/undo/redo. Report exact test commands and pass counts from the current PR head. The all-16-channel and sub-microsecond scheduler assertions predate this Phase 1.1 addition; do not claim they are physical MIDI measurements.

## 9. Sandbox limits and acceptance recommendation

This implementation run cannot complete the physical cases above because it has no exposed audio, MIDI, USB, ALSA, JACK, PipeWire, or PulseAudio device path/tooling. No actual MIDI bytes were observed at an OS port; no physical loopback or synth was connected. A real headless Chromium query observed the MIDI permission descriptor as `prompt` on secure localhost and confirmed the Web MIDI API is exposed, but no access request or native browser permission prompt was triggered; no OS-level grant/prompt was inspected. The Chromium E2E states and loopback are injected fakes. Desktop permission policy tests/code inspection validate policy only, not a user's machine permission.

**Recommendation:** accept the software-side Phase 1.1 work for review if its CI/local suites pass, but keep **physical MIDI hardware acceptance pending**. Do not sign off Phase 1.1 hardware readiness until a human completes the channel sweep, a genuine loopback capture, an actual synth reconnect/sustain test, the timing report with an approved tolerance, and attaches the environment record plus downloaded JSON/CSV (and audio/wire evidence where applicable). Do not start Phase 2 or infer physical pass from the standalone diagnostic's simulated browser test.
