# Virtual MIDI Input Bridge (Touch / Pointer Recording)

**Baseline:** `41a00a7e367e820f0fa951854c89dde40954c534`
**Branch:** `arena/b6250712-apex-studio`
**Goal:** Let a user with **no physical MIDI hardware** record notes into the
Piano Roll using the existing on-screen virtual piano keys, by routing those
key presses through the **same normalized event path the hardware recorder
already consumes** — without synthesizing fake external hardware events and
without duplicating the MIDI recording engine.

---

## 1. Preflight — verified state

- `origin/main` HEAD == working tree HEAD == `41a00a7…` (fetched and confirmed).
- The capture boundary is `MidiPerformanceRecorder` (`src/audio/midiRecording.ts`).
  It consumes `MidiEventPayload` (`{ type:'noteOn'|'noteOff'|…, note, velocity,
  midiChannel }`) and stamps each event from the AudioContext transport via
  `audioEngine.getTransportMusicalPosition()`.
- The **live monitor** is `MidiNoteInputRuntime` (`src/audio/midiMappingRuntime.ts`):
  it consumes the same `MidiEventPayload` and drives `audioEngine.playNote` /
  `stopChannelNote` on the selected channel.
- `App.tsx` wires the engine's `addMidiListener` stream → `midiNoteRuntime`
  (audition) + `recorder` (capture, only when armed) + `midiMappingRuntime` (CC).
- The on-screen controls that *bypass* the recorder by calling
  `audioEngine.playNote(...)` directly were audited:

| Control | File | note-on | note-off? | Safely bridgeable? |
| --- | --- | --- | --- | --- |
| **Piano Roll virtual piano keys** | `PianoRoll.tsx` (`piano-key-${pitch}`) | `onMouseDown` / `onTouchStart` | **none** (fixed 1.5-step blip) | ✅ **Yes** — add pointer release |
| MIDI Controller / 16-pad MPC drum grid | `MidiControllerModal.tsx` | `onMouseDown` | none (1-step drum hit) | ❌ Documented limitation (see §5) |
| Channel Rack / Instrument Rack / Drum Sampler / Zone Sampler / Sample Mgr / Wavetable / Arp / Polyphonic / Sidechain audition buttons | various | button click | none (preview) | ❌ Documented limitation (see §5) |

Only the **Piano Roll virtual piano keys** have a natural note-on/note-off
semantics (a key sustains while held). That is the single control bridged.

---

## 2. Smallest safe shared abstraction

A new, framework-agnostic class **`VirtualMidiInputBridge`**
(`src/audio/virtualMidiInput.ts`). It does **not** re-implement recording or
audition; it is a thin, deterministic router:

```
virtual note-on / note-off
        │
        ▼
   VirtualMidiInputBridge.noteOn(pitch, {velocity, midiChannel})
   VirtualMidiInputBridge.noteOff(pitch, {midiChannel})
        │  (builds MidiEventPayload, identical shape to hardware)
        ├────────────► getLiveMonitor().handleMidiEvent(event)   // MidiNoteInputRuntime
        └────────────► getRecorder().handleMidiEvent(event, getClock())  // only if isRecording
```

- The payload is the **exact** `MidiEventPayload` the hardware path emits, so the
  recorder and live monitor treat virtual input identically to a real device.
- It never calls `audioEngine.addMidiListener` and never opens a Web MIDI system,
  so virtual events do **not** reach MIDI Learn / CC mapping or any other hardware
  listener, and physical MIDI behaviour is untouched.
- It holds **no project state** and performs **no mutation**; capture stays with
  `MidiPerformanceRecorder`, finalization/commit with the caller (unchanged).
- `getClock()` is `audioEngine.getTransportMusicalPosition()`, so captured timing
  uses the project tempo and the continuous transport — identical to hardware.

`App.tsx` owns one instance (created once) and supplies it to `PianoRoll` via an
optional `virtualMidiInput` prop (legacy fallback preserved for isolated tests).

---

## 3. Semantics preserved

- **Pitch** — passed straight through (`note`).
- **Velocity** — default `0.9` (the legacy audition level); clamped to `(1/127, 1]`.
- **Note duration** — not a fixed blip anymore: it is the real gate between the
  pointer down (note-on, transport-stamped) and the pointer up/cancel (note-off).
  This is exactly what makes recording useful and matches a held physical key.
- **Channel ownership** — virtual keys use `midiChannel = 1` by default; the
  recorder keys open notes by `midiChannel:pitch`, so repeated strikes and
  channels behave exactly as for hardware. The **capture target** (channel +
  pattern + tempo) is still the one chosen when the take is armed in `App.tsx`.
- **Recording gated by arming** — `bridge.isRecording` mirrors
  `recorder.isRecording`; note-offs are still forwarded to the live monitor for
  audition even when not armed, but **nothing reaches the recorder unless the
  MIDI Rec control is armed**.
- **No stuck voices / stuck notes** — see §4.

---

## 4. Pointer lifecycle (release, cancellation, repeated, simultaneous)

`PianoRoll` tracks active pointers in a `Map<pointerId, {pitch, midiChannel}>`:

- `onPointerDown` → `noteOn(pitch)` and `setPointerCapture` (best-effort; wrapped
  in try/catch). Pointer Events unify mouse / touch / pen, removing the old
  double `onMouseDown`+`onTouchStart` path.
- `onPointerUp` / `onPointerCancel` → `noteOff(pitch)`.
- A **window `pointerup` / `pointercancel` safety net**, keyed by `pointerId`,
  releases keys whose release lands outside the element or when pointer capture
  is unavailable (synthetic events). Keyed by pointer id so a multi-touch release
  never cuts a sibling key that is still held.
- A `useEffect` cleanup releases every held key on unmount (editor closed
  mid-hold), so no voice or recorded note is left open.
- **Repeated note** (same key re-pressed while held) → retrigger handled by the
  underlying runtimes; the bridge keeps a single held entry.
- **Simultaneous notes** → distinct `pointerId`s → distinct held entries → both
  audition and both record, each released independently.

`noteOff` and `releaseAll` are idempotent (only release keys the bridge opened),
so the element handler and the window net firing together is harmless.

---

## 5. Limitations (documented, not worked around)

- **MIDI Controller / 16-pad MPC drum grid** (`MidiControllerModal.tsx`) is **not**
  bridged. The pads are momentary drum hits with no note-off semantics; forcing a
  note-off would mean inventing a gate length (the recorder would clamp a quick
  tap to `MIN_NOTE_DURATION_STEPS`) and changing the pad's audition channel
  (`activeChannel`) to the selected channel. Bridging it would also break the
  existing `midiControllerThemeUi.test.tsx` source assertion
  (`audioEngine.playNote(activeChannel, …)`). Left as a direct audition — a
  fragile workaround was deliberately avoided.
- **Single-shot audition buttons** (Channel Rack, Instrument Rack, Drum Sampler,
  Zone Sampler, Sample Manager, Wavetable, Arp, Polyphonic Editor, Sidechain)
  are preview triggers with a fixed duration and no release. They are not
  performance inputs and remain direct auditions.
- **Muted selected channel:** because virtual input now routes through the same
  live monitor as hardware, a muted channel will (correctly) not audition a
  virtual key press — consistent with how hardware MIDI is monitored. The previous
  direct `playNote` bypassed the mute check, which was the inconsistency; this
  unifies behaviour rather than regressing it.

---

## 6. Files changed

- **`src/audio/virtualMidiInput.ts`** (new) — `VirtualMidiInputBridge` + types.
- **`src/App.tsx`** — create the bridge once; expose the live monitor to it via
  `midiNoteRuntimeRef`; pass `virtualMidiInput` to `<PianoRoll>`.
- **`src/components/PianoRoll.tsx`** — optional `virtualMidiInput` prop; replace
  `handleAuditionKey` with pointer-aware `auditionNoteOn`/`auditionNoteOff`,
  pointer handlers + window safety net on the piano keys.

No project-schema, audio/DSP, transport, or unrelated-UI changes.

---

## 7. Tests

- **Unit (`src/audio/virtualMidiInput.test.ts`, run via `npm run test:audio`):**
  routing to live monitor vs recorder, velocity/channel preservation, clock
  stamping, simultaneous notes, retrigger, cancellation/`releaseAll`,
  ignored note-off, recorder-disabled gate, and null-port safety.
- **Playwright (`browser-tests/virtualMidiInput.spec.ts`, phone viewport
  390×844):** arm MIDI Rec, tap/release virtual keys, stop, assert the **correct
  pitches** appear (not just the count) plus structural timing; simultaneous
  chord test; and a "no recording unless armed" test.

### CI gates executed locally

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `npm run lint` (`tsc --noEmit`) | ✅ pass |
| Desktop config | `npm run verify:desktop` | ✅ pass |
| History | `npm run test:history` | ✅ 1104 pass |
| Audio | `npm run test:audio` | ✅ 1714 pass (incl. new suite) |
| MIDI recorder suite | `src/audio/midiRecording.test.ts` | ✅ 10 pass |
| Piano Roll theme | `src/components/pianoRollThemeUi.test.tsx` | ✅ 6 pass |
| MIDI Controller theme | `src/components/midiControllerThemeUi.test.tsx` | ✅ 8 pass |
| Production build | `npm run build` | ✅ pass |
| Playwright (browser) | `npx playwright test` | ⚠️ **not run locally** — the Playwright
  browser binary download is blocked by the sandbox network
  (`cdn.playwright.dev` ECONNRESET). The spec is added and runs in CI, which
  installs Chromium via `npx playwright install --with-deps chromium`. |

No flaky failures were observed in the locally-executed suites.
