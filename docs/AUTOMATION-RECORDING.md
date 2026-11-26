# Phase 12 — Automation Recording (Write / Touch / Latch)

This document is the architecture map Phase 12 was built on, plus the contract
the implementation keeps. It is written from the code as it exists on the base
commit, not from an earlier design.

## 1. Existing automation model (unchanged by this phase)

| Concern | Owner | Notes |
| --- | --- | --- |
| Lane storage | `PlaylistClip.automationPoints?: AutomationPoint[]` | `AutomationPoint = { x, y, tension?, lfoRateHz?, lfoDepth? }`; `x`/`y` are normalized `0..1` inside the clip. |
| Target addressing | `PlaylistClip.automationTarget` (`AutomationTargetType`) | `mixer_vol`/`mixer_pan`/`mixer_send*`: numeric track id. `fx_mix`: track id + slot id in `paramName`. `fx_param`: composite `"<trackId>/<slotId>"` + contract param. `vst3_param`: channel id + `native` identity. `channel_*`: channel id. |
| Curve evaluation | `src/audio/automation/curve.ts` (`interpolateCurve`) | Single evaluator shared by editing, live playback (`audioEngine.interpolateAutomationCurve`) and native automation. |
| Live application | `audioEngine.applyAutomationValue` | Converts normalized → model through `parameterScaling` / `fxParameterControl`, writes the isolated playback clones. |
| Live scheduling | `audioEngine.triggerCurrentStep` (Song Mode branch) + `rebaseAutomationAtPosition` | Evaluates every active automation clip per sixteenth step and on seek. |
| Offline export | `audioEngine.renderTimelineOffline` → same `triggerCurrentStep` | The production export shares the live scheduler, so a recorded lane is rendered by the same evaluator that played it. |
| Editing | `src/components/playlistClipOperations.ts` | `addPlaylistAutomationPoint`, `movePlaylistAutomationPoint`, `deletePlaylistAutomationPoint`; 6-decimal X quantization, `DEFAULT_GRID_BARS = 0.25`. |
| History | `createHistory` (`src/state/projectHistory.ts`), `mutateProjectState` (`App.tsx`), `ContinuousHistoryBatcher` | A pass must produce exactly one history entry. |
| Persistence | `serializeProjectState` / `normalizeProjectState` | `automationPoints` ride along in `playlistClips`; no schema change was needed. |

### Transport clock

`audioEngine.getTransportMusicalPosition()` returns the AudioContext-derived
`positionSeconds`, and `positionSteps = secondsToBeats(positionSeconds, bpm) * 16`.
It is continuous (unwrapped) while playing and is the same clock
`MidiPerformanceRecorder` stamps takes with. Phase 12 uses it and nothing else:
no `Date.now()`, no render timestamps, no frame counters.

## 2. What Phase 12 adds

### 2.1 Per-target automation mode (persisted)

`AutomationModeSettings` (in `src/types/daw.ts`) is stored on
`ProjectState.automationModes` as a map keyed by the deterministic
`automationTargetKey(target)`:

```
automationModes?: {
  [targetKey: string]: { mode: 'off' | 'read' | 'write' | 'touch' | 'latch' }
}
```

* Keying by the *target*, not by clip id, is what makes a mode survive editing,
  splitting, deleting and re-creating the lane clip: the mode belongs to
  "Mixer track 2 volume", not to one clip.
* `normalizeProjectState` drops unknown modes and unknown keys, so a
  hand-edited document cannot invent a mode. `READ` is the default and is
  never written to the document (absence = READ), which keeps old projects
  byte-identical when re-saved.
* Existing playback is untouched: `READ` and `OFF` both play the lane exactly
  as before. `OFF` refuses to *record*; it does not mute playback. That is
  stated in the UI so it cannot be mistaken for a playback mute.

### 2.2 Recorder

Two modules:

* `src/audio/automationRecording.ts` — every rule as pure functions
  (`transportSampleFromPosition`, `clipRelativeX`, `readAutomationTargetValue`,
  `automationTargetResolves`, `resolveAutomationMode`, `setAutomationMode`,
  `automationTargetKey`, `automationClipWithRecordedPass`) plus the
  `AutomationRecordingPasser` state machine. It owns no project state and
  performs no mutation; it returns an `AutomationRecordingPass` value.
* `src/audio/automationRecordingRuntime.ts` — the App-side wiring
  (`AutomationRecordingRuntime`): ports for the live document and the engine's
  transport clock, arming from the transport, gesture begin/end,
  `reconcileWithProject`, and boundary `finish`/`cancel`. The App supplies three
  ports and one-line boundary calls; the tests drive the same object.

Capture pipeline:

```
transport callback (existing subscription)
  → runtime.tick()
      → arms the lane whose clip covers the playhead, when its mode records
      → samples WRITE/LATCH (and held TOUCH/LATCH) on transport movement
UI control change (existing funnel: Mixer / ChannelRack / FX panel / VST3 apply)
  → runtime.reportValue(target, normalizedValue)   // only the armed target
pointer down / up
  → runtime.beginGesture() / runtime.endGesture()   // TOUCH closes on release
stop / pause / seek / Song end / mode switch
  → runtime.finish(reason) / runtime.cancel()
      → automationClipWithRecordedPass(clip, pass)  (pure lane surgery)
      → mutateProjectState(..., 'Record automation pass (<label>)')  // one undo step
```

One lane arms at a time. A pass records exactly one target, so arming a second
target mid-pass would silently retarget the performance; the next lane arms on
the following tick once the first pass closes.

### 2.3 Mode semantics implemented

| Mode | Behaviour |
| --- | --- |
| `off` | Nothing is captured. The lane still plays (documented). |
| `read` | Nothing is captured; existing automation playback unchanged. |
| `write` | From arm to pass end, every step samples the live control value (including the value at the arm moment), replacing the lane inside the pass. Outside the pass the previous lane is preserved. |
| `touch` | Points are captured only between control grab and release. The pass *starts* at the grab (the arm moment does not record), and on release it closes there: the lane outside `[grab, release]` is preserved exactly, so the original curve resumes after the release point. |
| `latch` | The last touched value is written continuously from grab until the pass ends (stop/pause/seek), even after the control is released. Sampling is proportional to transport movement, not wall clock. |

### 2.4 Lane surgery (one pass = one edit)

`automationClipWithRecordedPass` replaces the lane **inside** the pass window
and keeps the lane outside it:

* only points in `[startX, endX]` are replaced; every point outside the window
  is preserved exactly, including its order and tension;
* a discontinuity the pass creates at a seam is rendered as a **step pair**:
  at the left seam the original value at `startX` remains and the recorded value
  starts at `startX + STEP_X` (`1e-4` of the lane width); at the right seam the
  recorded value ends at `endX - STEP_X` and the original value resumes at
  `endX`. Without this a TOUCH pass would drag the surrounding curve into the
  recorded value instead of resuming it;
* coincident points collapse, keeping the later one; interpolation nodes that
  are redundant *and* were introduced by this pass are dropped so a flat
  performance stays a two-point lane — a long WRITE pass of an untouched fader
  does not accumulate thousands of points;
* a pass that would leave fewer than two points (the lane contract) is
  completed with the edge values rather than producing an invalid clip;
* a pass that changes nothing returns the **same clip object**, so no history
  entry, autosave or engine resync is triggered;
* a pass whose target no longer resolves (deleted track / FX insert / channel),
  or whose lane changed to READ/OFF, is cancelled by
  `reconcileWithProject` — the lane is not touched.

### 2.5 Loop handling

The transport's Musical position is continuous while playing, but Song Mode
wraps the *musical* position at the arrangement end and `seek()` moves it. The
recorder therefore:

* never derives `x` by subtracting across a wrap; it computes
  `relX = (transportBar - clip.startBar) / clip.lengthBars` from the engine's
  own continuous position and clamps to `[0, 1]`, so a pass that crosses the
  clip end stops at `x = 1` instead of wrapping to a negative or `> 1` value;
* treats any position regression (seek backwards, loop restart, restart from
  the top) as a **transport discontinuity**: the running pass is closed at the
  pre-boundary position and a new pass starts, exactly like the MIDI take
  finalizer closes at pause/stop/seek.

### 2.6 Live/offline parity

Recorded points are plain `AutomationPoint`s written into the existing lane.
Live playback reads them through `interpolateAutomationCurve`; export reads the
same array through the same scheduler (`renderTimelineOffline` →
`triggerCurrentStep`). Phase 12 adds no evaluator, so parity is structural by
construction.

It is also *measured*, in `src/audio/phase81.recordedAutomationParity.test.ts`,
which records a real pass through the production runtime and then drives the two
production renderers over the same document:

* `mixer_vol` — the live take's insert fader AudioParam and the export graph's
  own fader AudioParam are captured and compared instant-by-instant (they agree
  to 1e-9), and both are compared against `interpolateCurve` on the recorded
  lane.
* `fx_param` — a compressor `threshold` sweep is captured from the live chain and
  from the export graph's chain; both are converted back to dB through the
  production contract range (`resolveFxParameterSpec`) and compared.
* `vst3_param` — the recorded lane is compiled by the production
  `NativeAutomationTimeline` and every emitted point is compared with the lane
  value at that instant.

The suite was verified to fail when either renderer is mutated to skip a target
family, and when the recorder's lane surgery is mutated to collapse the pass —
i.e. the parity assertions are not vacuous. It does not claim acoustic equality:
Node has no Web Audio, `startRendering()` returns silence, and what is asserted
is the AudioParam schedule both renderers produce.

## 3. What Phase 12 deliberately does not do

* No MIDI CC automation recording (the MIDI CC bridge still applies values
  live; recording CC to lanes is a later phase).
* No new LFO authoring, no tempo-relative redesign, no new evaluator, no second
  mixer parameter system.
* No VST3 *native* parameter capture from the plug-in's own editor window: the
  host never sees those parameter changes until Apply, so a `vst3_param` lane
  records committed values only (the `Vst3ParameterEditor` Apply path), never the
  intermediate knob positions of a draft.
* No master-output automation recording: `master_vol` is engine-owned and has no
  project-state value to read back, so `readAutomationTargetValue` returns `null`
  for it and `canRecordTarget` excludes it.
* No loop *region*: the app has no loop start/end, so a "loop" is Pattern Mode's
  wrap or a transport seek. A pass never spans either — both close it at the
  pre-boundary position.
