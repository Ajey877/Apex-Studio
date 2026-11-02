# External MIDI Output — Physical Hardware Validation Procedure (Phase 1)

> **Validation Truthfulness Note:** Automated CI suites (`src/audio/midiOutputScheduler.test.ts`, `src/audio/externalMidiOutputEngine.test.ts`, `src/components/externalMidiOutputUiAndPersistence.test.tsx`, and `browser-tests/externalMidiOutput.spec.ts`) validate scheduling mathematics, Web MIDI `DOMHighResTimeStamp` mapping, byte encoding, port-usability gating, cleanup isolation, hot-plug state machines, persistence, undo/redo, and Chromium `MIDIOutput.send` execution using deterministic virtual and browser-instrumented `MIDIOutput` ports. **Physical DIN/USB hardware bench validation requires connected external MIDI hardware and must be executed manually by a human engineer using the procedure below before claiming physical-device sign-off.**

---

## 1. Supported Bench Topologies

Run this procedure against at least one physical hardware target (and optionally an OS loopback monitor in parallel to log raw wire timestamps):

1. **Class-Compliant USB-MIDI Synthesizer / Drum Machine** (e.g., Sequential Prophet-6, Moog Sub 37, Elektron Digitakt, Korg Minilogue XD, Roland TR-8S) connected via USB.
2. **USB-to-5-Pin DIN MIDI Interface + Hardware Synth** (e.g., MOTU micro lite, Focusrite Clarett MIDI Out, Roland UM-ONE mk2 -> 5-pin DIN MIDI In on hardware tone module), with hardware audio outputs patched into stereo inputs `1/2` of the audio interface for monitoring and return recording.
3. **Optional Protocol Analyzer / Loopback Inspection** (macOS Audio MIDI Setup **IAC Driver**, Windows **loopMIDI** + MIDI-OX, or Linux `aseqdump` on ALSA `snd-virmidi`) to inspect raw `[status, data1, data2]` bytes and inter-onset jitter alongside audible listening.

---

## 2. Pre-Flight & Device Discovery Checks

1. Launch **Apex Studio** in Chromium/Chrome/Edge or **Apex Studio Desktop** with the external MIDI device powered on and connected.
2. Open **Hardware MIDI & Controller Hub** (`#fl-midi-hub-btn`).
3. Verify on the **Connected Devices** tab:
   - Input controllers appear exclusively under **MIDI Input Devices**.
   - External synths / DIN interfaces appear exclusively under **MIDI Output Devices**.
   - Connected, openable output ports show **`Ready`** (never `Port Unavailable` or `Disconnected`).
   - If testing on an unsupported browser (e.g., Web MIDI disabled), confirm the banner honestly reports **`Web MIDI Unavailable in This Browser`** or **`Web MIDI Permission Denied`**.

---

## 3. Channel Routing, MIDI Channels 1–16, & Mode Verification

1. On **Channel 1**, set:
   - **Mode:** `External Only`
   - **Output Device:** Your target hardware synth / DIN output port
   - **MIDI Channel:** Match your hardware synth's receive channel (test both **`Ch 1`** and a non-default channel such as **`Ch 4`** or **`Ch 10`**; set synth out of Omni mode so wrong-channel traffic stays silent).
2. Program a 1-bar Piano Roll phrase with varied velocities (`25%`, `60%`, `100%`) and note lengths (`1/16`, `1/8`, `1/2`).
3. Press **Play** in **Pattern Mode**:
   - Confirm the hardware synth triggers with audible velocity dynamics and accurate gate lengths.
   - Confirm Apex Studio's internal synth voice for Channel 1 is **completely silent** (`External Only`).
   - Switch hardware synth receive channel +/- 1 channel temporarily and confirm silence (proving exact `0x9n` / `0x8n` channel nibble encoding).
4. Switch Channel 1 Mode to **`Mirror (Internal + MIDI)`**:
   - Confirm both Apex Studio's internal instrument and the external hardware synth sound tightly aligned together.
5. Switch Channel 1 Mode to **`Off (Internal Only)`**:
   - Confirm external MIDI transmission stops cleanly with zero hanging notes while internal synthesis continues.

---

## 4. Musical Timing, Song Mode, & Live Tempo Sweep

1. Place multiple Pattern clips across Bars 1–8 in the **Playlist** (including a sustained 1-bar chord and a 16th-note bassline) and switch transport to **Song Mode**.
2. Start playback and listen / measure via loopback monitor:
   - Verify steady 16th-note timing without flamming or drift across bar boundaries.
   - Enable **Swing** (e.g., `35%`) and confirm odd 16th steps groove identically on external hardware and internal percussion.
3. While a sustained chord and 16th-note sequence are playing, drag **BPM** smoothly from `120 BPM` -> `80 BPM` -> `150 BPM`:
   - Confirm zero stuck notes, zero premature/stale Note Offs cutting sustained chords early, and smooth tempo tracking on upcoming steps.

---

## 5. Zero-Stuck-Note Torture Matrix

With a sustained pad patch (`Release` short enough on hardware to hear Note Off clearly) and a dense arpeggio/chord pattern running in `External Only` mode, execute each transition while notes are actively sounding:

| Step | Action During Active Note | Required Hardware Outcome |
| :--- | :--- | :--- |
| **5.1** | Click **Pause** mid-chord | Hardware synth silences immediately; zero hanging voices. |
| **5.2** | Resume, then click **Stop** mid-chord | Queued future notes are cancelled (`MIDIOutput.clear()`) and active notes release immediately. |
| **5.3** | Scrub / **Seek** playhead across bars during Song playback | Previous bar's sounding notes release cleanly; playback continues from the target bar without stuck pitches. |
| **5.4** | Place a note at Step 15 with duration `4 steps` overhanging a 16-step **Pattern Loop** wrap | Overhanging note closes cleanly at the loop boundary without cutting off Step 0 notes of the next cycle. |
| **5.5** | Program two overlapping notes of the same pitch (`C4`) on Channel 1 | Hardware synth retriggers cleanly and releases at the end of the longer note with 1:1 Note On/Off parity. |
| **5.6** | Route **Channel 1 -> Ch 1** and **Channel 2 -> Ch 2** on a multitimbral synth; **Mute** or change output channel on Channel 1 mid-note | Channel 1 silences immediately while Channel 2 continues sounding uninterrupted (channel-isolated cleanup). |
| **5.7** | Hold a physical **Sustain Pedal (`CC 64`)** via MIDI input while playing Channel 1, then press **Stop** or **All Notes Off (Panic)** | Hardware sustain releases (`CC 64 = 0`) and voices decay cleanly. |
| **5.8** | Load another project or choose **File -> New Session** while notes are sounding | All external MIDI voices release before the new session state activates. |
| **5.9** | Close / reload the browser tab or quit Desktop app during playback | `beforeunload` / `pagehide` shutdown hook silences sounding hardware voices. |

---

## 6. Hot-Unplug, Reconnect, & Persistence Honesty

1. With Channel 1 routed to Hardware Synth A (`Ch 4`, `External Only`) and a second MIDI output (Synth B or loopback port) also connected:
   - Physically unplug Hardware Synth A's USB cable during playback.
   - Verify **Hardware MIDI & Controller Hub** transitions Synth A and Channel 1's status badge to **`Device Disconnected`** / **`Unavailable`**.
   - Verify Synth B receives **zero** substituted MIDI notes and Channel 1's selected device remains pinned to Synth A.
2. Plug Hardware Synth A back in:
   - Verify the port re-opens automatically, transitions back to **`Ready · Ch 4`**, and resumes MIDI playback without restarting the app.
3. Save the project, unplug Synth A, and reopen the saved project:
   - Verify Channel 1 retains `Synth A` (`Unavailable (Disconnected)`), `Ch 4`, `External Only`.
   - Test **Undo / Redo** (`Ctrl+Z` / `Ctrl+Y`) across mode, device, and MIDI channel edits.

---

## 7. Export Truthfulness & Hardware Audio Return Workflow

1. With Channel 1 in `External Only` mode, open **Export** (`#fl-export-btn`):
   - Verify the modal displays the explicit notice that **external MIDI hardware audio is not included in offline WAV/stem exports**.
2. Export **Master WAV**, **Stems ZIP**, and **Standard MIDI (`.mid`)**:
   - Confirm **Master WAV** and **Stems** contain zero leaked internal synth audio from the `External Only` channel, and `project_info.txt` documents the external MIDI channels.
   - Import the exported **`.mid`** file into a MIDI inspector or DAW and confirm Channel 1's notes and configured MIDI channel (`Ch 4`) are preserved.
3. Patch the hardware synth's analog outputs into audio interface inputs `1/2`, record the live pass onto an **Audio Track** in Apex Studio while external MIDI drives the synth, and re-export **Master WAV** to confirm captured hardware audio bounces cleanly.
