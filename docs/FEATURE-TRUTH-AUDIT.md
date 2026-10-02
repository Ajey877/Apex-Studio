# Apex Studio — Feature Truth & Audio Architecture Audit

**Repository:** `Ajey877/Apex-Studio`
**Audited commit (verified current `main`):** `463ba95df16752ed69a48377396867e2d8d49035`
**(Merge of PR #167 — "UI Milestone 1C Step 4" — confirmed merged; `cea1e33` is its head commit.)**
**Audit date:** 2026-10-02
**Scope:** READ-ONLY. No production code, test, branch, PR or merge was created or modified.

---

## Audit method

Every feature was traced with a **consumer trace**:

```
UI parameter
  → where it is stored (React state | ProjectState | AudioEngine field)
    → who reads it (grep for the identifier across src/, excluding *.test.*)
      → does AudioEngine consume it?
        → does it change the live graph?
          → does it change the offline/export graph?
            → does a non-shell test assert audible/DSP behaviour?
```

**Disqualifiers applied** (per the audit rule): a parameter is *not* counted as implemented
merely because it is rendered, held in React state, serialized, has an audition button, or is
covered only by `src/state/modalDialogShell.test.tsx` / `src/state/transportShell.test.tsx`
(those two files render every modal to static markup and assert the dialog shell contract only —
focus, Escape, `aria-*`, DOM ids. They prove rendering, never audio).

**Master-bus topology was established independently** of the old Phase-45 metering audit, by
reading the graph construction code, then separating *measurement* from *processing*.

---

## 1. Executive summary

Apex Studio at `463ba95` has **two clearly distinct tiers of code**, and they are not
distinguishable from the UI alone.

**Tier 1 — engineered, tested, wired to audio.** The core DAW loop (transport, playlist, mixer
routing, insert FX, instruments, recording, persistence, export, undo/redo) plus five of the
twelve audited advanced features are genuinely real: **Multi-zone Sampler, MIDI Learn, Master
Macro Rack, Audio Slicer (panel surface), and master-bus metering**. These have real consumers in
`AudioEngine`, real persistence, and behavioural tests.

**Tier 2 — demo surfaces wearing production UI.** Six of the twelve audited features ship a
complete, confident, professional-looking control surface whose parameters terminate in React
state or in a `ProjectState` field that nothing reads: **Mastering Suite processing, Warp Audio
Processor, Vocal Tuner, Polyphonic/ARA Editor, Take Comping, Wavetable Synth**.

**The single most important structural finding:** the codebase *already knows* this and has a
proven, high-quality pattern for saying so. `MasteringSuiteModal` is the exemplar — every
inert panel carries a hard-coded banner reading `NOT APPLIED — NO PROCESSING IN SIGNAL PATH`,
the header badge reads `MASTER CHAIN: NOT APPLIED`, and gain-reduction meters read
`NOT MEASURED - NO LOW BAND COMPRESSOR IN PATH`. Phase 48 did the same for Take Comping by
*refusing* to promote a fabricated clip. Phase 51 and the MIDI-mapping fix did the same thing in
the other direction: they took two features that were save/load-only and **built the missing
runtime bridge**.

So the problem is not that Apex Studio lacks capability. The problem is **inconsistent
application of a standard the project already owns.** Five surfaces did not get that treatment.

**Headline numbers:**

| Classification | Count | Features |
|---|---|---|
| REAL | 3 | Multi-zone Sampler · MIDI Learn · Master Macro Rack |
| PARTIAL | 4 | Mastering Suite · Gross Beat · Sidechain · Audio Slicer |
| STATE-ONLY | 1 | Vocal Tuner |
| UI/PROTOTYPE | 4 | Warp Processor · Polyphonic/ARA Editor · Take Comping · Wavetable Synth |
| UNSUPPORTED | 0 | — |
| FALSE CLAIM | 0 | (no feature is *wholly* fictitious — but see §5, six individual claims are) |

**Three findings outrank the rest:**

1. **A shipped UI fabricates a waveform and presents it as the user's audio.**
   `AudioSlicerModal` synthesizes a fake drum break into a buffer when the target channel has no
   sample, and draws it as the channel's audio with no label saying so.
2. **A shipped UI fabricates a *measurement*.** `VocalTunerModal` renders a `REAL-TIME PITCH
   QUANTIZER` whose detected note/Hz/cent readout is `Math.sin(phase)` — a synthetic animation,
   not pitch detection. No microphone is ever opened. This is the exact class of defect the
   Phase-45 metering work set out to eliminate.
3. **Third-party product and technology names are used for capabilities that do not exist**
   (`Élastique 3.4.1 Resampling Kernel`, `Melodyne / ARA2`, `DirectWave`, `Edison`). See §5.

**The README is materially accurate about the product's posture** — "Features that are not
production-ready are not presented as finished just for the sake of a bigger feature list" — but
contains one verifiably false technical claim ("dual wavetable oscillators"), and the in-app
Tools menu contains several that contradict it.

---

## 2. Verified-real systems

These satisfy the full chain: UI → state → `AudioEngine`/runtime consumer → live playback →
offline export → persistence → behavioural test.

### 2.1 Multi-zone Sampler — **REAL**

| | |
|---|---|
| **Files** | `src/components/MultiZoneSamplerModal.tsx`, `src/audio/instruments/sampler.ts`, `src/audio/sampleZones.ts`, `src/state/projectPersistence.ts:86` |
| **UI params** | per-zone `lowNote`, `highNote`, `rootNote`, `lowVelocity`, `highVelocity`, `tuneSemitones`, `trimStart`, `trimEnd`, `reverse`, `loop`, `loopStart`, `loopEnd`, `sampleId` |
| **Stored in** | `Channel.sampleZones` → `ProjectState.channels` (`src/types/daw.ts:272`) |
| **Consumed by** | `renderSamplerVoice` (`sampler.ts:4`) via `findSampleZone()` (`sampleZones.ts:3`) + `getSamplePlaybackRate()` + `clampSampleRange()` |
| **AudioEngine reads it** | Yes — `playSingleVoice` (`audioEngine.ts:987`) selects the `sampler` renderer when `channel.customSample?.id` exists, or when `instrumentType === 'sampler'` (registry, `audioEngine.ts:406`) |
| **Live playback** | Yes |
| **Offline export** | Yes — `renderTimelineOffline` receives the same `channels` array |
| **Persists** | Yes — `getAudioIdsForProject` registers every `zone.sampleId` for audio hydration (`projectPersistence.ts:86`) |
| **Tests** | `src/audio/sampleZones.test.ts`, `src/audio/instruments/sampler.test.ts`, `src/state/projectPersistence.test.ts`, `src/audio/audioEngine.voiceLifecycle.test.ts:97` — behavioural (zone selection, playback rate, trim clamping), not shell-only |

**Evidence:** `renderSamplerVoice` reads every zone field the UI exposes and applies it to a real
`AudioBufferSourceNode` (`source.playbackRate`, `source.loop`, `source.loopStart/End`, trim
offset/duration, reverse via negative rate). The audition button plays the **actual sample**
through the real channel (`MultiZoneSamplerModal.tsx:118`: `audioEngine.playNote(targetChannel,
{pitch: zone.rootNote, ...})`) — it is a genuine audition, not a synth stand-in.

**Residual overclaims (cosmetic):** badge says `SFZ / MULTI-ZONE` — no SFZ import or export
exists anywhere in the codebase. Copy says "velocity **crossfades**" — `findSampleZone` does
first-match-wins hard zone selection with no crossfade blending.

**Severity:** S4 (cosmetic). **Contract risk:** Low.

---

### 2.2 MIDI Learn — **REAL**

| | |
|---|---|
| **Files** | `src/components/MidiLearnModal.tsx`, `src/components/MidiControllerModal.tsx`, `src/audio/midiMappingRuntime.ts`, `src/audio/parameterScaling.ts`, `src/App.tsx:647-670` |
| **UI params** | CC number, `targetType` (`channel_vol`/`channel_pan`/`mixer_vol`/`mixer_pan`/`fx_param`/`master_vol`), `targetId`, `paramName` |
| **Stored in** | `ProjectState.midiMappings` (`types/daw.ts:565`) |
| **Consumed by** | `MidiCcMappingRuntime.handleMidiEvent` → `resolveMidiCcTarget` → pure `ProjectState` transitions |
| **AudioEngine reads it** | Yes — `audioEngine.addMidiListener` (`audioEngine.ts:1733`) ← Web MIDI `onmidimessage` (`audioEngine.ts:1694`) |
| **Live playback** | Yes — CC → `mutateProjectState` → `synchronizePlaybackState`; `master_vol` → `applyAutomationValue` → `masterGain.gain` (`audioEngine.ts:1353`) |
| **Offline export** | Yes — targets are project state, so the resolved value is in the exported render |
| **Persists** | Yes — `projectState.ts:196` validates and `:239` clones `midiMappings` |
| **Tests** | `src/audio/midiMappingRuntime.test.ts` (555 lines) — resolution, learn capture, unsupported targets, range agreement with automation |

**Evidence:** the module header (`midiMappingRuntime.ts:1-27`) documents exactly the gap it was
built to close ("`ProjectState.midiMappings` was save/load state that nothing consumed at
runtime"). `App.tsx:649` constructs the runtime, `:669` registers it on the engine's existing MIDI
listener. Targets with no runtime setter are explicitly reported `unsupported` and change
nothing rather than guessing.

**Severity:** none. **Contract risk:** none. This is the reference implementation for how to
close a state-only feature.

---

### 2.3 Master Macro Rack — **REAL**

| | |
|---|---|
| **Files** | `src/components/MasterMacroRackModal.tsx`, `src/state/macroMappings.ts` (660 lines), `src/state/projectMutations.ts:145` |
| **UI params** | knob `value` 0–1, per-mapping `targetType`, `targetId`, `min`, `max`, `curve` |
| **Stored in** | `ProjectState.macroKnobs` (`types/daw.ts:627`) |
| **Consumed by** | `applyMacroRackUpdate` → `resolveMacroRack` → `applyMacroResolution` → atomic `ProjectState` transition |
| **AudioEngine reads it** | Indirectly and correctly — resolved values are written into `channels` / `mixerTracks`, which the engine already reads live and receives for offline render |
| **Live playback** | Yes (via `synchronizeActivePlayback`) |
| **Offline export** | Yes — `renderTimelineOffline` is handed the same `channels`/`mixerTracks` |
| **Persists** | Yes; `reapplyMacroRackOnHydration` restores resolved values on project load |
| **Tests** | `src/audio/phase51.macroRuntime.test.ts` (573), `src/state/macroMappings.test.ts` (561), `src/state/macroBaselineDefect.test.ts` |

**Evidence:** shipped as `d608550 Phase 51 — make Master Macro Rack mappings affect runtime
parameters`. Supported targets: `channel_volume`, `channel_pan`, `mixer_volume`, `mixer_pan`,
`filter_cutoff`, `reverb_wet`, `delay_feedback`. Resolution is pure, idempotent-by-identity, and
order-deterministic; unresolved targets are reported, never invented.

**Residual:** UI hint reads `Macro Automation Dispatcher Active`; the modal does not surface the
`unresolved` count that `summarizeMacroRack()` already computes, so a mapping to a deleted
channel fails silently in the UI.

**Severity:** S4. **Contract risk:** Low.

---

### 2.4 Master-bus **metering** — REAL (subsystem of the Mastering Suite)

Verified fresh, not inherited from the Phase-45 audit.

| | |
|---|---|
| **Files** | `src/audio/loudnessMeasurement.ts`, `src/audio/truePeak.ts`, `src/audio/stereoMeasurement.ts`, `src/audio/masterMeasurementStream.ts`, `audioEngine.ts:3255-3520` |
| **Tap** | `createMasterMeasurementTap` (`audioEngine.ts:3394`): `grossBeatNode → ChannelSplitter(2) → AnalyserNode L / R`, both leaves, `fftSize 4096`, `smoothingTimeConstant = 0` |
| **Pump** | `setInterval(..., 20)` (`audioEngine.ts:3448`) reads only the samples that arrived since the last read |
| **Values** | ITU-R BS.1770-4 K-weighted gated loudness (momentary / short-term / integrated), 4× oversampled 12-tap inter-sample true peak, L/R correlation, Mid/Side powers |
| **Tests** | `loudnessMeasurement.test.ts`, `truePeak.test.ts`, `stereoMeasurement.test.ts`, `masterMeasurementStream.test.ts`, `meteringTruthfulness.test.ts`, `components/masteringMeteringUi.test.ts` |

**Evidence of correctness:** `getMasterLoudnessMetrics()` (`audioEngine.ts:3265`) returns
`availability: 'offline-render'` and all-null fields while a bounce owns the graph, so a
non-real-time render can never be presented as a live meter. Fields are `null` until real audio
exists. `isClipping` is derived from the reconstructed peak, not the sample peak. Every readout
in the UI renders `—` / `NOT MEASURED` when its value is null.

**This is the standard the rest of the audit measures against.**

---

## 3. Partial systems

### 3.1 Mastering Suite — **PARTIAL**
*(metering = REAL, processing = STATE-ONLY)*

| | |
|---|---|
| **Files** | `src/components/MasteringSuiteModal.tsx` (996 lines), `src/audio/masterBus.ts`, `src/audio/mixerMasterGraph.ts`, `src/App.tsx:220` |
| **UI params** | `lowCrossFreq`, `highCrossFreq`; `lowBand`/`midBand`/`highBand` `{enabled, gain, threshold, ratio, attack, release, knee, solo, mute}`; `monoSubFreq`, `stereoSpread`; `maximizerThreshold`, `maximizerCeiling`, `maximizerRelease`, `maximizerLookahead`; `lufsTarget`; `enabled` |
| **Stored in** | `useState<MasteringSuiteState>` in `App.tsx:220` — **React state only** |
| **In `ProjectState`?** | **No.** `MasteringSuiteState` (`types/daw.ts:377`) is not a field of `ProjectState` (`types/daw.ts:649`). It is never serialized, never autosaved, never restored, and never in undo/redo. Closing and reopening the app discards it. |
| **Consumed by** | **Nothing.** Grep for `masteringSuite` / `MasteringSuiteState` across `src/` returns only: the type definition, `App.tsx:220` (declaration) and `App.tsx:1812` (prop pass), and the modal itself. `audioEngine.ts` contains no occurrence. |
| **AudioEngine reads it** | **No** |
| **Live playback** | **No effect** |
| **Offline export** | **No effect** (trivially "parity", because both are silent on it) |
| **Persists** | **No** |
| **Tests** | `meteringTruthfulness.test.ts`, `masteringMeteringUi.test.ts`, `modalDialogShell.test.tsx`, `transportShell.test.tsx` — all cover the **metering** surface or the shell. **No test asserts any mastering processing.** |

#### Does EQ → multiband → stereo → sub-mono → limiter exist in the master graph? — **No.**

Three independent confirmations:

1. **`MasterBus`** (`src/audio/masterBus.ts:14-63`) is exactly four nodes:
   `input → gain → meter(AnalyserNode) → output → destination`. Its only DSP is
   `setGainDb()`, a clamped scalar gain. **No EQ, no crossover, no compressor, no imager,
   no limiter.**
2. **`MixerMasterGraph`** (`mixerMasterGraph.ts`) composes channel strips into that `MasterBus`
   and adds solo logic. Nothing else. (It is also not wired into production — see §7.4.)
3. **The engine's actual live master path** (`audioEngine.ts:443-452`):
   ```
   mixer channel outputs → masterGain(GainNode) → grossBeatNode(GainNode) → masterAnalyser → destination
   ```
   Offline (`audioEngine.ts:1897-1904`) rebuilds the identical chain. **Two gain stages and two
   analysers. That is the entire master signal path.**

`createDynamicsCompressor` appears in the codebase only inside `createFxNode` /
`liveFxChainHardening.createEffect` — i.e. as a **per-mixer-insert FX slot**, never on the master
bus.

**Honesty assessment — this feature is a model citizen.** The modal carries:
- header: *"Master bus measurement… Processing controls below are **stored intent only** - the
  master chain is not wired yet."* (`MasteringSuiteModal.tsx:354-356`)
- badge: `MASTER CHAIN: NOT APPLIED` with the tooltip *"Phase 46 owns the master processing
  chain. Until it exists there is nothing to enable or bypass, so this reads as a fact rather
  than a switch."* (`:357`)
- `NotAppliedBanner` on every processing tab: `3-BAND MULTIBAND COMPRESSOR: NOT APPLIED —
  NO PROCESSING IN SIGNAL PATH` / `STORED AS INTENT · PHASE 46` (`:41-51`)
- per-band meters: `NOT MEASURED - NO LOW BAND COMPRESSOR IN PATH` (`:691`)
- presets: *"Selecting a preset stores values only. No processor reads them yet, so the sound of
  the project does not change."* (`:950`)

**Severity:** **S2 — not for the modal, but for the entry point.** The in-app modal is honest;
the Tools-menu tooltip is not: *"Mastering suite — **LUFS metering, multiband processing and
limiter**"* (`TransportToolsMenu.tsx:180-186`). That is the claim a user reads *before* opening
the modal. **Contract risk:** Medium — an external product claim contradicting the in-app
disclosure.

**Recommended future phase:** the master chain itself is genuinely **Phase 46**, already
scheduled by the project's own code comments. Do not pre-empt it. Fix only the menu tooltip now.

---

### 3.2 Gross Beat (Time FX) — **PARTIAL**

| | |
|---|---|
| **Files** | `src/components/GrossBeatModal.tsx`, `src/audio/audioEngine.ts:339-348, 1200-1228, 2969-2976, 1897-1904` |
| **UI params** | `enabled`, `preset` (8), `mix`, `speed`, `tapeStopActive`, `tapeStopDurationMs`, `gateSteps[16]`, `pitchShiftSemitones` |
| **Stored in** | **`AudioEngine` private field** `grossBeatState` (`audioEngine.ts:339`) |
| **In `ProjectState`?** | **No.** `GrossBeatState` is declared in `types/daw.ts:65` but is not a `ProjectState` field. |
| **Consumed by** | `triggerCurrentStep` (`audioEngine.ts:2969-2976`) — **reads `enabled`, `gateSteps`, `mix` only** |
| **AudioEngine reads it** | Yes (partially — 3 of 8 fields) |
| **Live playback** | **Yes** — master-chain `grossBeatNode.gain` is gated per 16th step |
| **Offline export** | **Yes** — `renderTimelineOffline` reuses `triggerCurrentStep`, so the same gate is scheduled into the WAV |
| **Persists** | **No** — engine-held only. Lost on reload; absent from save/undo/redo. |
| **Tests** | Only `phase50.offlineRenderIsolation.test.ts:234` and `phase51.macroRuntime.test.ts` touch `grossBeatState`, and only to assert it is *restored unchanged* after an offline render. **No test asserts gating behaviour.** |

**Consumer trace:**

| Parameter | Reaches engine | Affects audio | Notes |
|---|---|---|---|
| `enabled` | ✅ | ✅ live + offline | gate bypass |
| `gateSteps[16]` | ✅ | ✅ live + offline | the actual effect |
| `mix` | ✅ | ✅ live + offline | `targetGain = stepVal ? 1.0 : max(0.01, 1 - mix*0.95)` |
| `speed` (0.5/1.0/2.0) | ✅ stored | ❌ **never read** | `Half-Time (1/2x Speed)` and `1/32 Micro Stutter` presets set it; nothing consumes it |
| `pitchShiftSemitones` | ✅ stored | ❌ **never read** | half-time pitch drop does not happen |
| `tapeStopDurationMs` | via arg | ✅ (manual only) | `triggerTapeStop(brakeDuration)` — a **global gain ramp on the master**, not a pitch/tape deceleration, despite the copy "Turntable motor stop **pitch drop** curve" |
| `tapeStopActive` | ❌ | ❌ | dead field |
| `preset` | ✅ stored | ❌ | only used to load `gateSteps` + `speed`; `speed` is inert, so **all 6 presets are functionally just step patterns** |

**Severity:** **S3.** The core gate works and has live/offline parity — this is a genuinely
useful effect. But 5 of 8 state fields are inert, "Half-Time" does not halve time, and the state
is not persisted (a user's edit vanishes on reload, while the modal repopulates from
`audioEngine.getGrossBeatState()`, so it *looks* persistent).

**Contract risk:** Medium. Header badge says `STUDIO DSP`; copy promises half-time, tape-stop and
turntable behaviour.

---

### 3.3 Sidechain — **PARTIAL**

| | |
|---|---|
| **Files** | `src/components/SidechainRoutingModal.tsx`, `src/audio/audioEngine.ts:1179-1197`, `audioEngine.ts:631-640, 711, 966` |
| **UI params** | `enabled`, `sourceTrackId`, `threshold`, `amount`, `attackMs`, `releaseMs`, `lowFreqOnly`, `highPassFilterHz`, `gainReductionDb` |
| **Stored in** | `MixerTrack.sidechain` → `ProjectState.mixerTracks` |
| **Consumed by** | `triggerSidechainDucking(sourceTrackId, time)` (`audioEngine.ts:1179`) — **reads `enabled`, `sourceTrackId`, `amount`, `attackMs`, `releaseMs` only** |
| **AudioEngine reads it** | Yes (5 of 9 fields) |
| **Live playback** | Yes — `duckingGain` on each mixer channel (`input → panner → duckingGain → output → analyser`) |
| **Offline export** | **Yes** — `playSingleVoice` calls `triggerSidechainDucking` at `audioEngine.ts:966`, and the offline render runs the same `triggerCurrentStep` |
| **Persists** | Yes |
| **Tests** | `src/state/undoRedo.test.ts:858-922` — asserts **state round-trip only** (`sidechain.amount === 0.8` after redo). **No test asserts ducking occurs.** |

**Consumer trace — inert fields:**

| Parameter | Status | Evidence |
|---|---|---|
| `threshold` | ❌ **inert** | written at `SidechainRoutingModal.tsx:71`, stored, never read by `triggerSidechainDucking` |
| `lowFreqOnly` | ❌ **inert** | written `:73`, never read. No filter is created in the duck path |
| `highPassFilterHz` | ❌ **inert** | written `:74`, never read |
| `gainReductionDb` | ❌ **inert** | declared in the type, never written or read |

**Architectural characterisation:** this is **not** sidechain compression. There is no detector,
no sidechain input, no level sensing. `triggerSidechainDucking` fires a fixed envelope on the
destination track **every time any note is triggered on the source track**, at constant depth,
independent of the source's actual level:

```ts
// audioEngine.ts:1183-1196
if (targetChannel.sidechain?.enabled && targetChannel.sidechain.sourceTrackId === sourceTrackId) {
  const minGain = Math.max(0.02, 1.0 - duckAmount);
  duckParam.linearRampToValueAtTime(minGain, time + attackSec);
  duckParam.exponentialRampToValueAtTime(1.0, time + attackSec + releaseSec);
}
```

Consequences: `threshold` cannot gate the effect; a melody on the kick track pumps the bass just
as hard as a kick; and `lowFreqOnly` cannot restrict it.

**Severity:** **S3.** **Contract risk:** Medium-High — footer reads *"Real-time **lookahead**
sidechain dynamic envelope active"* (`SidechainRoutingModal.tsx:321`); there is no lookahead and
no detector. Tools menu: *"Dynamic sidechain ducking and modulation routing"* — no modulation
routing exists.

---

### 3.4 Audio Slicer — **PARTIAL**
*(two different surfaces with opposite verdicts)*

#### 3.4a `SampleSlicerPanel` (inside the sampler view) — **REAL**

| | |
|---|---|
| **File** | `src/components/SampleSlicerPanel.tsx` (114 lines) |
| **UI params** | sample select, slice count (4/8/12/16), DETECT (transient), EVEN SPLIT |
| **Stored in** | `Channel.drumPads` → `ProjectState.channels` |
| **Consumed by** | `renderDrumPadVoice` (`src/audio/instruments/drumPad.ts:51-52` reads `pad.trimStart` / `pad.trimEnd`) |
| **Live playback** | **Yes** — each slice becomes a pad with real `trimStart`/`trimEnd` |
| **Offline export** | **Yes** (same channel data) |
| **Persists** | Yes |
| **Tests** | `src/audio/sampleSlicer.test.ts` |

**Evidence:** `mapToPads()` builds `DrumPad[]` carrying `trimStart: slice.start, trimEnd:
slice.end, note: 36 + index` and commits via `onUpdateChannel`. `renderDrumPadVoice` applies
those trims to a real `AudioBufferSourceNode`. The preview button plays the real trimmed slice
through the real channel. **End-to-end and correct.**

#### 3.4b `AudioSlicerModal` (Tools → "Transient slicer") — **UI/PROTOTYPE**

| | |
|---|---|
| **File** | `src/components/AudioSlicerModal.tsx` (431 lines) |
| **UI params** | target channel, mode (`transient`/`beat_8`/`beat_16`/`beat_32`), sensitivity, per-slice audition, "Map Chops to Piano Roll", "Map to 16 Steps" |
| **Stored in** | local `useState` (`slices`, `sensitivity`, `sliceMode`) |
| **Consumed by** | **Nothing that preserves the slice.** Both export actions discard the slice regions entirely. |

**The detection DSP is real** (`src/utils/audioSlicer.ts`: 15 ms short-time energy windows, 50%
hop, positive first-difference flux, percentile threshold from `sensitivity`, 75 ms minimum
inter-onset distance). The **output** is not:

```ts
// AudioSlicerModal.tsx:211-237
const handleMapToPianoRoll = () => {
  const notes = slices.map((slice, idx) => ({
    pitch: 60 + idx, start: idx * 1, duration: 1, velocity: 0.85   // ← slice timing DISCARDED
  }));
  onUpdateChannel(activeChannel.id, { notes });
};
const handleMapToStepSequencer = () => {
  const steps = new Array(16).fill(false);
  slices.forEach((_, idx) => { if (idx < 16) steps[idx] = true; }); // ← slice timing DISCARDED
  onUpdateChannel(activeChannel.id, { steps });
};
```

The result: "chops" are chromatic notes / step triggers played by the channel's **existing
instrument**. No sample region is ever used. The trimmed-audio path that `SampleSlicerPanel`
already implements correctly is not reused here.

**🔴 Fabricated audio (highest-severity defect in this audit).** When the target channel has no
loaded sample, the modal **synthesizes a breakbeat and displays it as that channel's audio**,
with no label stating it is synthetic:

```ts
// AudioSlicerModal.tsx:52-100
if (activeChannel?.customSample?.id && audioEngine.getSampleBuffer(...)) { /* real audio */ }
else {
  // "Create a rich synthetic vintage breakbeat buffer (Kick, Snare, Hihats, Percussion)"
  const buf = ctx.createBuffer(2, sampleRate * 2.0, sampleRate);
  /* writes Math.sin kick sweeps + Math.random() noise snare/hats into the buffer */
  setAudioBuffer(buf);          // ← drawn as the channel's waveform
  computeSlices(buf, ...);
}
```

A user with no sample loaded sees a waveform, sees "N slices detected", and sees
`Successfully mapped N chops sequentially to Piano Roll!` — all derived from audio that does not
exist in their project. This directly violates the truthfulness standard the project applies
elsewhere (missing audio is surfaced as `audioUnavailable` everywhere else in the app).

**Severity:** **S1** (fabricated audio asset presented as user content). **Contract risk:**
**High** — this is the precise class of misleading product claim the README disclaims.
**Minimum fix (not a feature build):** refuse to open without a real sample, or label the
synthetic buffer as a demo and disable both mapping actions.

---

## 4. Prototype / UI-only systems

### 4.1 Warp Audio Processor — **UI/PROTOTYPE**

| | |
|---|---|
| **File** | `src/components/WarpAudioProcessorModal.tsx` (326 lines) |
| **UI params** | `warpMode` (5 modes), `transientGranularity`, `grainSizeMs`, `formantPreservation`, `envelopeDecay`, `pitchSemitones`, `stretchRate` |
| **Stored in** | `pitchSemitones` / `stretchRate` / `warpMode` → `PlaylistClip` (project state). The other four: **local `useState` only.** |
| **Tests** | `modalDialogShell.test.tsx`, `transportShell.test.tsx` — **shell only** |

**Consumer trace — the special check requested:**

```
stretchRate (UI slider, 0.25–3.0)
  → useState (WarpAudioProcessorModal.tsx:40)
    → handleApplyWarp → clip.timeStretchRate                        ✅ persisted
      → AudioEngine.playAudioClipWithFades (audioEngine.ts:3086, 3101)
        source.playbackRate.setValueAtTime(clip.timeStretchRate)    ✅ live
      → offline: SAME function (renderTimelineOffline reuses triggerCurrentStep)  ✅ export
        ✅ → REAL. But: playbackRate changes speed AND pitch together.
            This is sampler repitch, not time-stretching. It is the mode the UI
            calls "Re-Pitch (Tape Speed)" — applied to all five modes identically.
```

```
warpMode (UI: beats | tones | texture | complex_pro | repitch)
  → useState (:34) → handleApplyWarp → clip.warpMode               ✅ persisted
    → consumers: grep across src/ returns ONLY
        types/daw.ts:353 (declaration)
        WarpAudioProcessorModal.tsx (write + display)
      audioEngine.ts: ZERO occurrences. offlineProjectRenderer.ts: ZERO.
    ❌ → INERT. Choosing "Complex Pro" vs "Beats" changes nothing.
```

```
formantPreservation (:36)  → useState only  → ❌ never leaves the component
grainSizeMs        (:37)  → useState only  → ❌ never leaves the component
envelopeDecay      (:38)  → useState only  → ❌ never leaves the component
transientGranularity (:35) → useState only → ❌ never leaves the component
pitchSemitones     (:39)  → clip.pitchShiftSemitones → source.detune  ✅ REAL
```

**Score: 2 of 7 parameters reach audio; 1 of those 2 does what its label says.**

**🔴 The audition button produces silence.** `handleAuditionWarp` (`:45-69`) calls
`audioEngine.playNote()` with a synthetic channel `{instrumentType: 'sampler', ...}` that has
**no `customSample` and no `sampleZones`**. In `playSingleVoice` (`audioEngine.ts:987`) that
resolves to the `sampler` renderer; `renderSamplerVoice` computes
`sampleId = zone?.sampleId || sample?.id` → `undefined` → `getSampleBuffer(undefined)` →
`undefined` → `if (!buffer) return;`. **No node is created. Nothing is played.** The UI then
displays `Auditioning COMPLEX_PRO Warp DSP Algorithm`.

**Severity:** **S2.** **Contract risk:** **High** — see §5 for the `Élastique` claim, and §8 for
the `selectedClip` bug.

---

### 4.2 Vocal Tuner (Auto-Pitch) — **STATE-ONLY**

| | |
|---|---|
| **File** | `src/components/VocalTunerModal.tsx` (481 lines) |
| **UI params** | `enabled`, `scale` (15 scales), `rootKey` (12), `retuneSpeedMs`, `formantShift`, `vibratoDepth`, `humanize` |
| **Stored in** | `ProjectState.vocalTuner` (`types/daw.ts:334`) — **persisted, validated, hydrated, undoable** (`projectState.ts:208, 243`) |
| **Consumed by** | **NOTHING.** `grep -rn "vocalTuner\|retuneSpeed\|formantShift\|humanize" src/audio/*.ts` (excluding tests) → **zero results.** `audioEngine.ts` contains no occurrence of any vocal-tuner identifier. |
| **AudioEngine reads it** | **No** |
| **Live playback** | **No effect** |
| **Offline export** | **No effect** |
| **Persists** | Yes — which makes this the textbook "serialized therefore real" trap |
| **Tests** | `modalDialogShell.test.tsx`, `transportShell.test.tsx`, `projectRecovery.test.ts` (persistence round-trip). **No test asserts any audio effect — none can.** |

**🔴 The pitch display is fabricated.** There is no pitch detection anywhere in `src/`. The
`REAL-TIME PITCH QUANTIZER` panel (`:343`) is driven by a `requestAnimationFrame` sine:

```ts
// VocalTunerModal.tsx:120-142
const baseHz  = 220 * Math.pow(2, (rootOffset + Math.sin(phase) * 1.5) / 12);
const cents   = Math.round(Math.sin(phase * 1.3) * (retuneSpeedMs > 10 ? 35 : 5));
setDetectedPitch({ note: noteName, cents, hz: Math.round(baseHz) });
setTargetSnapNote(...);
```

`audioEngine` is imported at `:19` and **never used**. `isLiveMicActive` (`:102`) is declared and
**never set or read** — no microphone is ever opened. Yet the UI renders
`Detected: A#4 (466Hz)` / `Snapped: D4` as live measurement, and a header badge that reads
**`ACTIVE`** (green) or `BYPASSED`, implying a processor in the signal path.

**Severity:** **S1** (fabricated real-time measurement). **Contract risk:** **High** — this is the
exact defect class Phase 45 eliminated from the metering surfaces; it survives here.

---

### 4.3 Polyphonic / ARA / Melodyne-style Editor — **UI/PROTOTYPE**

| | |
|---|---|
| **File** | `src/components/PolyphonicEditorModal.tsx` (356 lines) |
| **UI params** | 6 blobs × `{originalPitch, targetPitch, startStep, durationSteps, amplitude, formantShift, pitchDriftAmount, vibratoDepth}`, `pitchQuantizeAmount`, `pitchDriftCorrection`, `globalFormantShift`, split / quantize actions |
| **Stored in** | `useState` seeded from the module-level constant `INITIAL_BLOBS` (`:26-33`) |
| **In `ProjectState`?** | No. `PolyphonicBlob` is declared at `types/daw.ts:109` and used **nowhere else in the codebase** but this file. |
| **Consumed by** | Nothing |
| **Tests** | `modalDialogShell.test.tsx` — shell only |

**Evidence:**
- There is **no audio input of any kind.** The modal takes no props but `isOpen`/`onClose`. It
  cannot load, import or analyze a recording. The six blobs are **hard-coded literals**, and the
  panel reports `6 Harmonics Detected` (`:178`) — a count of literals.
- `handleAuditionBlob` (`:61-76`) plays a **`vox_choir` synthesizer note** at
  `Math.round(blob.targetPitch)`. It does not audition audio; it plays a synth approximation of
  the number the user typed.
- `handleQuantizeAllPitch` (`:78`) rewrites the literal array in React state and shows
  `100% Perfect Pitch Correction & Drift Alignment Applied!`.
- **"Apply ARA Audio Edits" (`:347-352`) calls `onClose()` and nothing else.**

**Severity:** **S2.** **Contract risk:** **High** — uses Celemony's `Melodyne` and `ARA2`
trademarks in the title, plus `POLYPHONIC DNA ALGORITHM` and footer
`Direct ARA2 Phase-Locked Resampling Active`. See §5.

---

### 4.4 Take Comping — **UI/PROTOTYPE** (honestly gated)

| | |
|---|---|
| **File** | `src/components/TakeCompingModal.tsx` (403 lines) |
| **UI params** | 4 take lanes with ratings + hard-coded `waveform` peak arrays, comp slice selection, `crossfadeLengthMs`, Auto-Comp, Audition Composite, Promote |
| **Stored in** | `useState` seeded from `DEFAULT_TAKES` (`:35-73`) and `INITIAL_COMP_SELECTIONS` (`:75-79`) |
| **In `ProjectState`?** | No. `TakeLane` / `TakeRegion` (`types/daw.ts:88-107`) appear only in this file. |
| **Consumed by** | Nothing |
| **Tests** | `modalDialogShell.test.tsx`, `transportShell.test.tsx`, `playlistClipIntegrity.test.ts:360` (asserts App *gates* promotion) |

**This surface was already repaired (Phase 48, `2ed751c`) and is now honest.** `handlePromoteToPlaylist`
(`:115-131`) **refuses** to create a clip, with an explanatory message:

> *"This comp has no recorded audio asset behind it, so there is nothing to promote. Capture a
> take with the Audio Recorder and place it on the playlist, or drop an audio file onto a lane."*

The code comment documents why: the previous version fabricated an audio playlist clip with a
decorative waveform and no `audioBufferId`, which "played nothing, was never flagged by the
missing-audio surfaces, and hard-blocked WAV and stem export for the whole project."
`playlistClipIntegrity.test.ts:360` locks that gate in.

**Residual issues (all cosmetic/labelling):**
- `handleAuditionComposite` (`:99-113`) plays a `vox_choir` synth note — not the takes.
- `handleSmartAutoComp` (`:86-96`) claims **"AI Smart Comp generated optimal vocal phrase
  alignment!"** but is a fixed alternating pattern (`idx % 2 === 0 ? 1 : …`). This **contradicts
  the README's explicit "Apex Studio currently does not include active AI generation"**.
- Footer: `Equal-Power Crossfade Algorithm Active` with a crossfade-length slider — no crossfade
  is computed anywhere.

**Severity:** **S3** (was S1 before Phase 48). **Contract risk:** Low-Medium (the "AI" string is
the live issue).

---

### 4.5 Wavetable Instrument — **UI/PROTOTYPE**

| | |
|---|---|
| **Files** | `src/components/WavetableSynthModal.tsx` (345 lines), `src/audio/instruments/subtractiveSynth.ts`, `src/audio/audioEngine.ts:405` |
| **UI params** | `morphPosition` (WT pos), `warpMode` (none/sync/pwm/fm/bend/mirror), `warpAmount`, `unisonVoices` (1–16), `unisonDetune`, `unisonSpread`, 8 additive harmonic sliders, 5 presets |
| **Stored in** | **local `useState` only** (`:40-46`) |
| **Consumed by** | **Nothing.** The `onUpdateChannel` prop is destructured at `:39` and **never called.** |
| **Tests** | `modalDialogShell.test.tsx`, `transportShell.test.tsx` — shell only. (`audioEngine.render.test.ts:124` / `voiceLifecycle.test.ts:97` merely list `'wavetable'` among `InstrumentType`s in a registry loop.) |

**Evidence — there is no wavetable oscillator in the codebase:**
- `grep -rn "createPeriodicWave\|PeriodicWave" src/audio/` → **zero results.** No wavetable is
  ever constructed.
- `SynthParameters` (`types/daw.ts:275-320`) has **no wavetable field** — no table id, no frame
  index, no morph position, no harmonic series. The modal's `morphPosition` has nowhere to go.
- `audioEngine.ts:405`: `wavetable: renderSubtractiveSynthVoice` — the `wavetable`
  `InstrumentType` is an **alias of the plain subtractive synth** (two standard
  `OscillatorNode`s: `sawtooth`/`square`/`sine`/`triangle` only).
- That alias is **unreachable from any UI**: `'wavetable'` does not appear in
  `STUDIO_BROWSER_INSTRUMENTS` (`StudioBrowser.tsx:57-81`), `ChannelRack.tsx`, or
  `presets.ts`. The only way in is the modal — which writes nothing.
- `unisonVoices` is capped at 7 in the renderer (`subtractiveSynth.ts:44`) while the UI offers
  **16**; `unisonSpread` is declared in the type (`types/daw.ts:306`) and **never read**.
- The 3D waterfall is a canvas drawing of `harmonics.forEach(h => Math.sin(...))` (`:90-107`).
  The warp modes apply to the **drawing** (`wave = wave > warpAmount ? 1 : -1`), not to audio.
- `handleAudition` (`:127-133`) plays the target channel's **existing** voice with none of the
  modal's parameters.
- **"Apply Wavetable to Track" (`:337-341`) calls `onClose()` only.**

**Severity:** **S2.** **Contract risk:** **High** — the README's feature table claims *"Synth |
Shape sounds with **dual wavetable oscillators**, filters, ADSR and modulation controls."* That
is false: there is no wavetable oscillator in the product.

---

## 5. Misleading claims

Ranked by contract risk. **Internal** = contradicts the app's own contracts/README;
**External** = a claim a user/reader relies on; **Legal** = third-party name used for absent
functionality.

| # | Claim | Where | Reality | Risk | Severity |
|---|---|---|---|---|---|
| **M1** | `"Élastique 3.4.1 Resampling Kernel Ready"` | `WarpAudioProcessorModal.tsx:306` | No time-stretch engine exists. Only `AudioBufferSourceNode.playbackRate` (repitch). No third-party or first-party resampler in the repo. | **Legal + External** — `Élastique` is a zplane development product name; also a version-specific performance claim. | **S2** |
| **M2** | Title `"MELODYNE / ARA2 POLYPHONIC AUDIO BLOB EDITOR"`; footer `"Direct ARA2 Phase-Locked Resampling Active"` | `PolyphonicEditorModal.tsx:124, 344` | Hard-coded blobs, no audio input, no pitch detection, "Apply" closes the modal. | **Legal + External** — `Melodyne` and `ARA2` are Celemony trademarks; ARA2 is also a specific host-plugin API that is not implemented. | **S2** |
| **M3** | README: *"Shape sounds with **dual wavetable oscillators**"* | `README.md` feature table | No `createPeriodicWave` anywhere; the `wavetable` type is the subtractive synth with two standard oscillators. | **External** — verifiably false product claim. | **S2** |
| **M4** | `"Real-time lookahead sidechain dynamic envelope active"` | `SidechainRoutingModal.tsx:321` | Fixed envelope triggered by note events; no detector, no lookahead, `threshold`/`lowFreqOnly`/`highPassFilterHz` inert. | **External** | **S3** |
| **M5** | Tools tooltip *"Mastering suite — LUFS metering, **multiband processing and limiter**"* | `TransportToolsMenu.tsx:180-186` | No multiband, no limiter, no EQ on the master bus. Master path = 2 gain nodes + 2 analysers. **Contradicts the modal's own honest disclosure.** | **Internal + External** | **S2** |
| **M6** | `"AI Smart Comp generated optimal vocal phrase alignment!"` | `TakeCompingModal.tsx:93` | Fixed alternating index pattern. **Contradicts README: "Apex Studio currently does not include active AI generation."** | **Internal** | **S3** |
| M7 | Vocal Tuner header *"Real-time vocal scale snapping, robotic retune & formant shifting"* + `ACTIVE` badge + `REAL-TIME PITCH QUANTIZER` readout | `VocalTunerModal.tsx:225, 243, 343` | Zero audio consumers; pitch readout is `Math.sin(phase)`; no microphone is opened. | **External** | **S1** |
| M8 | Fabricated breakbeat drawn as the channel's audio | `AudioSlicerModal.tsx:52-100` | Synthetic `Math.sin`/`Math.random()` buffer substituted when no sample is loaded, unlabelled. | **External** | **S1** |
| M9 | `"256-FRAME 3D MORPHING"` / `"16-voice hypersaw"` / `"Real-time Wavetable Osc Routing active for active Channel synthesizer"` | `WavetableSynthModal.tsx:161, 269, 334` | 16-frame canvas demo; unison hard-capped at 7; no routing code path. | **External** | **S3** |
| M10 | `"SFZ / MULTI-ZONE"` · `"velocity crossfades"` | `MultiZoneSamplerModal.tsx:139, 144` | No SFZ import/export exists. Velocity ranges are hard first-match selection, no crossfade. | External | **S4** |
| M11 | `"DirectWave Sampler"`, `"DirectWave Sample Loader & Waveform Slicer"`, `"EDISON TRANSIENT SLICER"`, `"Edison / Simpler Style"` | `StudioBrowser.tsx:81`, `ChannelRack.tsx:433,438,563`, `AudioSlicerModal.tsx:266`, `utils/audioSlicer.ts:1` | Product names from Image-Line's FL Studio. | **Legal** — trademark exposure on a shipped UI, independent of the DSP question. | **S3** |
| M12 | Tools tooltip *"Warp modes — Advanced time-stretch and transient warp modes"* · *"Vocal tuner — Real-time auto-pitch and pitch correction"* · *"Wavetable synth — 3D wavetable morphing synthesizer"* | `TransportToolsMenu.tsx:139-146, 152-159, 113-119` | All three describe absent capability. | External | **S3** |

**What is *not* misleading:** the README's posture statements are accurate and the in-app
Mastering Suite modal is exemplary. The problem is localised to ~12 strings, not systemic.

---

## 6. Parameter-consumer trace findings

The special check requested, applied to every advanced DSP parameter that reaches audio at all.
**"Terminates at" is the last hop in the chain that actually does something.**

| Parameter | → State | → Clip/Project | → AudioEngine | → Live | → Export | Verdict |
|---|---|---|---|---|---|---|
| `clip.timeStretchRate` | ✅ `PlaylistClip` | ✅ | ✅ `audioEngine.ts:3086,3101` `source.playbackRate` | ✅ | ✅ (same fn) | **REAL — but repitch, not time-stretch** |
| `clip.pitchShiftSemitones` | ✅ | ✅ | ✅ `:3098` `source.detune` | ✅ | ✅ | **REAL** |
| `clip.warpMode` | ✅ | ✅ serialized | ❌ **zero consumers** | ❌ | ❌ | **INERT** |
| `clip.fadeInBars` / `fadeOutBars` | ✅ | ✅ | ✅ `:3110` | ✅ | ✅ | REAL |
| `clip.spatialAudio` | ✅ | ✅ copied in `playlistClipOperations.ts:32` | ❌ zero consumers | ❌ | ❌ | **INERT** |
| `mixerTrack.sidechain.enabled` | ✅ | ✅ | ✅ `:1184` | ✅ | ✅ | REAL |
| `…sidechain.sourceTrackId` | ✅ | ✅ | ✅ `:1184` | ✅ | ✅ | REAL |
| `…sidechain.amount` | ✅ | ✅ | ✅ `:1185` | ✅ | ✅ | REAL |
| `…sidechain.attackMs` / `releaseMs` | ✅ | ✅ | ✅ `:1186-1187` | ✅ | ✅ | REAL |
| `…sidechain.threshold` | ✅ | ✅ | ❌ never read | ❌ | ❌ | **INERT** |
| `…sidechain.lowFreqOnly` | ✅ | ✅ | ❌ never read | ❌ | ❌ | **INERT** |
| `…sidechain.highPassFilterHz` | ✅ | ✅ | ❌ never read | ❌ | ❌ | **INERT** |
| `…sidechain.gainReductionDb` | ❌ never written | ❌ | ❌ | ❌ | ❌ | **DEAD FIELD** |
| `grossBeat.enabled` | ✅ engine field | ❌ not in `ProjectState` | ✅ `:2971` | ✅ | ✅ | REAL — **not persisted** |
| `grossBeat.gateSteps` | ✅ engine field | ❌ | ✅ `:2972` | ✅ | ✅ | REAL — **not persisted** |
| `grossBeat.mix` | ✅ engine field | ❌ | ✅ `:2973` | ✅ | ✅ | REAL — **not persisted** |
| `grossBeat.speed` | ✅ stored | ❌ | ❌ **never read** | ❌ | ❌ | **INERT** |
| `grossBeat.pitchShiftSemitones` | ✅ stored | ❌ | ❌ **never read** | ❌ | ❌ | **INERT** |
| `grossBeat.tapeStopActive` | ❌ | ❌ | ❌ | ❌ | ❌ | **DEAD FIELD** |
| `grossBeat.preset` | ✅ stored | ❌ | ❌ (only seeds `gateSteps`) | ❌ | ❌ | **INDIRECT ONLY** |
| `grossBeat.tapeStopDurationMs` | ✅ | ❌ | ⚠️ via `triggerTapeStop()` | ✅ manual | ❌ | **PARTIAL** — master gain ramp, not tape pitch |
| `channel.sampleZones[*]` (all 13 fields) | ✅ | ✅ | ✅ `sampler.ts` + `sampleZones.ts` | ✅ | ✅ | **REAL** |
| `channel.drumPads[*].trimStart/End` | ✅ | ✅ | ✅ `drumPad.ts:51-52` | ✅ | ✅ | **REAL** |
| `midiMappings[*]` | ✅ | ✅ | ✅ `midiMappingRuntime.ts:301` | ✅ | ✅ | **REAL** |
| `macroKnobs[*].value` + mappings | ✅ | ✅ | ✅ via resolved state | ✅ | ✅ | **REAL** |
| `vocalTuner.*` (7 fields) | ✅ | ✅ persisted | ❌ **zero consumers in `src/audio/`** | ❌ | ❌ | **STATE-ONLY** |
| `masteringSuite.*` (~25 fields) | ⚠️ **React state only** | ❌ **not in `ProjectState`** | ❌ | ❌ | ❌ | **STATE-ONLY, NOT PERSISTED** |
| `mixerTrack.stereoWidth` | ✅ | ✅ | ❌ never read | ❌ | ❌ | **STATE-ONLY** |
| `meta.masterVolume` | ✅ | ✅ | ❌ never applied to `masterGain`; only the `master_vol` engine parameter moves master gain (`midiMappingRuntime.ts:19` documents this) | ❌ | ❌ | **STATE-ONLY** |
| `synthParams.unisonSpread` | ✅ type exists | ✅ | ❌ never read (`subtractiveSynth.ts` uses `unisonVoices`/`unisonDetune` only) | ❌ | ❌ | **STATE-ONLY** |
| Warp `formantPreservation` / `grainSizeMs` / `envelopeDecay` / `transientGranularity` | ⚠️ local `useState` | ❌ | ❌ | ❌ | ❌ | **UI-ONLY** |
| Wavetable `morphPosition` / `warpMode` / `warpAmount` / `unison*` / `harmonics` | ⚠️ local `useState` | ❌ | ❌ | ❌ | ❌ | **UI-ONLY** |
| Polyphonic `blobs` / quantize / drift / formant | ⚠️ local `useState` | ❌ | ❌ | ❌ | ❌ | **UI-ONLY** |
| Take-comp `takes` / `compSlices` / `crossfadeLengthMs` | ⚠️ local `useState` | ❌ | ❌ | ❌ | ❌ | **UI-ONLY** |
| Parametric EQ `bands` | ⚠️ local `useState` | ❌ (`onUpdateTrack` never called) | ❌ | ❌ | ❌ | **UI-ONLY** |

### Summary counts

| Terminus | Count |
|---|---|
| Reaches live **and** offline audio | 22 |
| Reaches live only | 1 (`tapeStopDurationMs`, manual trigger) |
| Persisted, zero consumers | 12 (`vocalTuner` ×7, `stereoWidth`, `masterVolume`, `unisonSpread`, `spatialAudio`, `warpMode`) |
| Serialized but structurally inert (inside partially-consumed objects) | 4 (`sidechain` ×3, `grossBeat.speed`+`pitchShift` = 5) |
| React-state only, never persisted | ~40 |
| Dead type fields never written or read | 2 |

### The three patterns behind every failure

1. **"Persisted, therefore real."** `vocalTuner` is validated by `projectState.ts:208`, cloned
   at `:243`, and covered by `projectRecovery.test.ts`. It is still inert. Serialization is not
   implementation. Phase 51's own header says this verbatim about `macroKnobs`.
2. **"Shell test, therefore tested."** Warp, Vocal Tuner, Polyphonic, Take Comping and Wavetable
   are each covered **only** by `modalDialogShell.test.tsx` / `transportShell.test.tsx`, which
   render to static markup and assert the dialog contract. Exactly the failure mode the audit
   brief warns about.
3. **"Audition button, therefore audible."** Three auditions prove nothing about their feature:
   Warp's is **silent** (sampler with no sample); Take Comping's and Polyphonic's play a
   `vox_choir`/synth note instead of the audio they claim to preview.

---

## 7. Live / offline parity findings

Export path confirmed: `ExportModal.handleStartExport` (`:203`) →
`audioEngine.renderTimelineOffline(...)` → rebuilds an `OfflineAudioContext` and drives it with
**`triggerCurrentStep`** — the *same* scheduler function live playback uses
(`audioEngine.ts:1978`). This is a strong architectural choice and gives parity by construction
for everything scheduled through it.

| Feature | Live | Offline | Parity | Notes |
|---|---|---|---|---|
| Instrument voices | ✅ registry renderers | ✅ same registry | ✅ | |
| Pattern clips | ✅ | ✅ | ✅ | |
| Audio clips (rate/detune/fades) | ✅ `playAudioClipWithFades` | ✅ same function | ✅ | `timeStretchRate` clamped only to `> 0` in **both** |
| Automation | ✅ | ✅ | ✅ | |
| **Gross Beat gate** | ✅ | ✅ | ✅ | shared `triggerCurrentStep`; `grossBeatNode` rebuilt in the offline graph (`:1898`) |
| **Sidechain duck** | ✅ | ✅ | ✅ | `playSingleVoice → triggerSidechainDucking` runs in both |
| **Multi-zone sampler** | ✅ | ✅ | ✅ | same `channels` array |
| **Macro rack** | ✅ | ✅ | ✅ | resolved into project state before render |
| **MIDI-learn targets** | ✅ | ✅ | ✅ | targets *are* project state |
| **Mixer insert FX** | ✅ always | ⚠️ **only if `includeMixerFx === true`** | ❌ **NO — default off** | see 7.1 |
| **Mixer volume / pan / mute / routing** | ✅ | ✅ | ✅ | `updateMixerTrack` runs for every track (`:1975`) |
| **Mastering processing** | ❌ | ❌ | ✅ trivially | absent in both |
| **Master metering** | ✅ | intentionally disabled | n/a | `availability: 'offline-render'` (`:3268`) — correct |

### 7.1 🔴 Default browser export silently omits all mixer FX

`renderTimelineOffline` (`audioEngine.ts:1969-1971`):

```ts
const renderTracks = includeMixerFx ? tracks : tracks.map(track => ({ ...track, fxSlots: [] }));
```

`includeMixerFx` defaults to `false`; `ExportModal`'s prop defaults to `false`
(`ExportModal.tsx:66`); and **`App.tsx:1796` does not pass it at all.** So:

> **A user who adds EQ, reverb, delay, compression or a limiter, plays their song, hears the
> effect, clicks Export → START EXPORT, and gets a WAV with none of it.**

The UI does expose an escape hatch (*Mixer FX in Export: Project Default / Include FX / Bypass
FX*), and it correctly reports `Currently: Off`. This is therefore **an intentional, documented,
tested performance decision** (`exportParity.test.ts:923`), **not a bug** — but the default is
the wrong way round for a DAW: a silent difference between what you hear and what you ship is the
single most damaging failure mode a DAW can have, and it is the default.

**Severity:** **S2** (product decision, damaging default). **Contract risk:** Medium.

### 7.2 🟠 A second, divergent offline renderer exists and is wired to nothing

`src/audio/offlineProjectRenderer.ts` exports `renderProjectTimelineOffline` — a complete
alternate renderer. Its only callers are
`exportStemIntegrity.test.ts` and `offlineProjectRenderer.test.ts`. **No production export path
uses it.**

It diverges from the real renderer in ways that would silently change exports if it were ever
wired up:

| Behaviour | Real renderer (`renderTimelineOffline`) | Dead renderer (`renderProjectTimelineOffline`) |
|---|---|---|
| Gross Beat gate | ✅ applied | ❌ none |
| Mixer FX / inserts / routing | ✅ (opt-in) | ❌ none |
| Sidechain duck | ✅ | ❌ none |
| Pattern clips | real instrument voices | **raw `OscillatorNode`** — ignores filter, ADSR, unison, LFO, osc2 |
| `timeStretchRate` | any finite `> 0` | **clamped to 0.5–2.0** (`:150`) |
| Audio clip gain | live path | simplified |

**Severity:** **S3** (latent trap, not an active bug). **Recommendation:** delete it, or fold its
plan helper (`getOfflineRenderPlan`, used by `undoRedo.test.ts`) out and remove the renderer.

### 7.3 Parity is asserted for the wrong things

`exportParity.test.ts` (955 lines) covers lane mutes, missing buffers, seeded-impulse
determinism, and `includeMixerFx` state preservation. It contains **no test that asserts the
exported WAV matches what live playback produced** for any effect, instrument or processor. The
name promises parity; the suite verifies export safety.

### 7.4 `MasterBus` / `MixerMasterGraph` are not in the production graph

`grep -rn "new MasterBus\|MixerMasterGraph" src/ --include=*.ts --include=*.tsx` (excluding tests)
returns **only the definitions**. The production master path is the engine's own
`masterGain → grossBeatNode → masterAnalyser → destination`. Any future master-chain work must
target the engine's chain (or wire `MasterBus` in first) — building on `MasterBus` alone would
change nothing audible.

### 7.5 Engine-held state is invisible to the offline/export contract

`grossBeatState` lives on the engine instance, so it is correct for export (same process) but
**invisible to** `ProjectState`, persistence, undo/redo, project bundles (.zip) and stem
packages. A collaborator opening an exported bundle gets no Gross Beat settings.

---

## 8. Priority findings

Ordered by (severity × contract risk). **"Genuine bug" / "unfinished feature" / "intentionally
limited prototype" / "misleading claim" / "future enhancement"** labels per the brief.

| # | Finding | Class | Sev | Risk | Fix shape |
|---|---|---|---|---|---|
| **P1** | `AudioSlicerModal` fabricates a breakbeat and renders it as the user's channel audio, unlabelled; the resulting "chops" discard slice timing and only write notes/steps | **Misleading claim** + genuine bug | **S1** | **High** | Refuse to open without a real sample (or label the demo buffer and disable mapping). Reuse `SampleSlicerPanel`'s already-correct `drumPads` + trim path for real chopping |
| **P2** | `VocalTunerModal` renders a fabricated `REAL-TIME PITCH QUANTIZER` (`Math.sin(phase)`) and an `ACTIVE` badge for a processor with zero audio consumers | **Misleading claim** | **S1** | **High** | Apply the Mastering Suite pattern: relabel as stored-intent, replace the simulated needle with a real detector or an explicit "no detection" state |
| **P3** | `WarpAudioProcessorModal` audition button produces **silence** (sampler voice with no sample, `renderSamplerVoice` early-returns); `warpMode` is inert; 4 of 7 params are local-only; footer claims a third-party kernel | **Misleading claim** + genuine bug | **S2** | **High** | Fix the audition to play the clip's real buffer; label `warpMode` as stored intent; remove the `Élastique` string |
| **P4** | Third-party product/technology names on absent functionality: `Élastique 3.4.1`, `Melodyne`, `ARA2`, `DirectWave`, `Edison` | **Legal / trademark** | **S2** | **High** | Rename the surfaces. Independent of whether the DSP is ever built |
| **P5** | README claims "dual wavetable oscillators"; no `createPeriodicWave` exists anywhere; the `wavetable` type is an alias of the subtractive synth and is unreachable from any UI | **Misleading claim** | **S2** | **High** | Correct the README line; relabel the modal |
| **P6** | Default export omits all mixer FX (`includeMixerFx` false; `App.tsx:1796` never passes it) — the WAV does not match what the user heard | **Intentionally limited, wrong default** | **S2** | Medium | Flip the default to `true`, or add a pre-export warning banner when FX slots are non-empty and the toggle is Off |
| **P7** | `WarpAudioProcessorModal` always operates on `playlistClips[0]`, never the user's selected clip (`App.tsx:1830`) | **Genuine bug** | **S2** | Medium | Pass the selected clip; disable the tool when no clip is selected |
| **P8** | `MasteringSuite` Tools-menu tooltip promises "multiband processing and limiter"; the modal itself says `NOT APPLIED` | **Misleading claim** (contradicts own UI) | **S2** | Medium | One-line tooltip fix |
| **P9** | `SidechainRoutingModal` footer claims "Real-time lookahead"; `threshold`/`lowFreqOnly`/`highPassFilterHz` are inert; ducking is note-triggered, not level-detected | **Unfinished feature** + misleading claim | **S3** | Med-High | Remove inert controls (or mark them), fix the footer, document the trigger model |
| **P10** | `GrossBeat`: `speed` and `pitchShiftSemitones` inert, so "Half-Time" and "1/32 Micro Stutter" are step patterns only; state is engine-held and **not persisted** | **Unfinished feature** | **S3** | Medium | Move `grossBeatState` into `ProjectState` (Phase-51 bridge pattern); drop or implement `speed` |
| **P11** | `AudioSlicerModal` "AI Smart Comp…" — actually `TakeCompingModal.tsx:93`; contradicts the README's explicit no-AI statement | **Misleading claim** | **S3** | Medium | Rename to "Auto-Comp" |
| **P12** | `ParametricEqModal` (Tools → "7-band EQ") keeps bands in local state; `onUpdateTrack` is destructured and **never called** | **Unfinished feature** | **S3** | Medium | Wire it to an FX slot, or relabel as an analyser |
| **P13** | Dead divergent renderer `offlineProjectRenderer.renderProjectTimelineOffline` | **Latent trap** | **S3** | Medium | Delete, or keep only `getOfflineRenderPlan` |
| **P14** | `exportParity.test.ts` asserts no live-vs-export audio equivalence | **Test-coverage gap** | **S3** | Medium | Add one parity assertion for a representative FX + instrument |
| **P15** | `stereoWidth`, `meta.masterVolume`, `spatialAudio`, `unisonSpread`, `sidechain.gainReductionDb`, `grossBeat.tapeStopActive` — persisted or declared, never read | **Unfinished feature** | **S4** | Low | Remove or wire |
| **P16** | No behavioural tests for Gross Beat gating, Sidechain ducking, or any mastering processing | **Test-coverage gap** | **S3** | Medium | Add with P10/P9 |

### Deliberately **not** recommended

Per the brief — *do not recommend implementing every missing feature.*

- **Melodyne/ARA polyphonic editing, élastique-grade time-stretching, a wavetable engine, wavetable
  morphing, real take comping with spliced audio, or a full mastering chain.** Each is a
  multi-month DSP programme. None is required for the product's stated mission
  (*"trustworthy core DAW workflows before adding more headline features"*). The correct action
  for all of them is **de-scope the UI to what is true**, not build the DSP.
- **Re-auditing Phase-45 metering.** It is real, correct, and its honesty contract holds.
- **Re-opening lifecycle / persistence / project-recovery issues.** No new evidence was found;
  hydration, ownership and `audioUnavailable` handling are consistent.
- **Re-doing UI Milestone 1C.** `StudioBrowser.tsx` and `ModalFrame.tsx` carry explicit
  truthfulness and presentational contracts and honour them (`StudioBrowser.tsx:27-30`: *"no
  fabricated waveform, no fabricated telemetry"*).

---

## 9. Recommended next engineering phase — exactly one

## Phase 52 — "Say what the engine does": close the advanced-feature truth gap

**One phase, three workstreams, no new DSP.** Its goal is not to add capability. It is to make
every advanced surface assert **exactly** what the engine does — by applying, uniformly, the two
patterns the codebase already contains and already trusts.

> **Rationale.** The audit found no architectural crisis. The core DAW is real, the export path
> is sound, and the project has already demonstrated — three separate times — that it knows how
> to handle a state-only feature: **relabel it honestly** (Mastering Suite, Take Comping) or
> **build the missing bridge** (MIDI mappings, Macro Rack). The remaining damage is concentrated
> in ~12 strings and 4 surfaces that skipped both patterns. Closing that gap is days of work,
> not months, and it removes the entire S1/S2 tier before any new capability is added. Shipping
> more DSP on top of a UI that fabricates waveforms and measurements would compound the problem.

### Workstream A — Remove every fabricated signal *(P1, P2, P3; kills the S1 tier)*

1. `AudioSlicerModal`: if no real sample is loaded, show an explicit empty state and disable
   DETECT / Map actions. Delete the synthetic-breakbeat generator, or label it `DEMO BUFFER — NOT
   YOUR AUDIO` and keep it strictly non-exportable.
2. `VocalTunerModal`: replace the `Math.sin(phase)` needle with an honest state. Either wire a
   real detector (an `AnalyserNode` autocorrelation already exists in spirit in
   `loudnessMeasurement.ts`) or render `NOT DETECTED — NO PITCH ANALYSIS IN SIGNAL PATH`, exactly
   as the mastering GR meters do today.
3. `WarpAudioProcessorModal`: point the audition at the clip's real `AudioBuffer` through the
   real mixer channel. Remove the `Élastique 3.4.1 Resampling Kernel Ready` footer.

**Exit test:** no shipped component can render a waveform, a measurement or a "detected" value
that did not come from real audio. Asserted by a test that renders each advanced modal and
greps its output for measurement-labelled strings while no audio exists.

### Workstream B — Apply the stored-intent contract to the four unlabelled surfaces *(P4, P5, P8, P11, P12)*

Add the `NotAppliedBanner` treatment — already written and shipped in `MasteringSuiteModal.tsx:41`
— to:

| Surface | Banner / change |
|---|---|
| Warp "algorithm" grid + granular sliders | `WARP ALGORITHM: NOT APPLIED — CLIP PLAYS AT PLAYBACKRATE (REPITCH)` |
| Wavetable synth | `WAVETABLE ENGINE: NOT AVAILABLE — CHANNEL USES THE STANDARD 2-OSC SUBTRACTIVE SYNTH` (and cap the unison slider at the engine's real 7) |
| Polyphonic / ARA editor | `NOT APPLIED — DEMO BLOBS, NO AUDIO ANALYSIS IN THIS BUILD` |
| Vocal tuner processing | `NOT APPLIED — SETTINGS ARE STORED INTENT` |

Then correct the claim surfaces: the Tools-menu tooltips (P8), the README's
"dual wavetable oscillators" (P5), `AI Smart Comp` → `Auto-Comp` (P11), the sidechain "lookahead"
footer (P9), and `ParametricEqModal` — either wire `onUpdateTrack` to a real EQ FX slot or
relabel it as an analyser (P12).

**Naming/trademark pass (P4):** rename `Élastique`, `Melodyne`, `ARA2`, `DirectWave`, `Edison` to
generic names. This is independent of DSP status and should not wait for a feature decision.

### Workstream C — Fix the two genuine wiring bugs and the export default *(P6, P7, P10, P16)*

Small, real, and user-visible:

1. **P7** — `WarpAudioProcessorModal` must receive the **selected** clip, not
   `playlistClips[0]` (`App.tsx:1830`). One-line change; disable the tool with no selection.
2. **P6** — flip the export default: pass `includeMixerFx` from `App.tsx:1796`, or show a
   blocking warning when FX slots are non-empty and the toggle is Off. A DAW must not ship a
   master that differs from what was monitored.
3. **P10** — move `grossBeatState` into `ProjectState` using the Phase-51 bridge pattern
   (pure resolution → atomic state transition → persistence + hydration), and either implement or
   remove `speed` / `pitchShiftSemitones`.
4. **P16** — add the first behavioural tests for Gross Beat gating and Sidechain ducking, plus
   one true live-vs-export parity assertion (P14).

### Explicitly out of scope for Phase 52

- Building time-stretch, polyphonic pitch editing, a wavetable engine, real take comping, or the
  Phase-46 mastering chain.
- Rewriting the mixer, the transport, or the export pipeline.
- Any change to the Phase-45 metering implementation.

### Definition of done

1. Zero S1 findings remain open.
2. Every advanced surface that does not touch audio displays an in-app `NOT APPLIED` state.
3. No third-party product or technology name appears on absent functionality.
4. `README.md` contains no technically false claim.
5. Default export includes mixer FX, or warns before excluding them.
6. Full test suite green; the new truthfulness tests fail if any of these regress.

---

## Appendix A — Evidence index

| Claim in this report | File : line |
|---|---|
| Mastering state is React-only | `src/App.tsx:220`, `:1812` |
| `MasteringSuiteState` absent from `ProjectState` | `src/types/daw.ts:377` vs `:649` |
| `MasterBus` = gain + analyser only | `src/audio/masterBus.ts:14-63` |
| `MasterBus` not used in production | grep → definitions only |
| Live master chain | `src/audio/audioEngine.ts:443-452` |
| Offline master chain | `src/audio/audioEngine.ts:1897-1904` |
| Mastering "not applied" disclosures | `MasteringSuiteModal.tsx:41, 354-357, 691, 950` |
| Metering tap | `audioEngine.ts:3394-3430`; pump `:3446-3456` |
| Metering guarded during offline render | `audioEngine.ts:3268-3271` |
| Gross Beat gate (live + offline) | `audioEngine.ts:2969-2976` |
| Gross Beat inert fields | `types/daw.ts:68-72` vs `audioEngine.ts:2969-2976` |
| Tape stop = master gain ramp | `audioEngine.ts:1200-1213` |
| Sidechain duck envelope | `audioEngine.ts:1179-1197` |
| Sidechain inert fields | `SidechainRoutingModal.tsx:71-74` vs `audioEngine.ts:1184-1187` |
| Sampler zone consumption | `src/audio/instruments/sampler.ts:15-24` |
| Zone lookup | `src/audio/sampleZones.ts:3-11` |
| Drum-pad trim consumption | `src/audio/instruments/drumPad.ts:51-52` |
| Slicer → pads (real path) | `SampleSlicerPanel.tsx:39-52` |
| Slicer → notes (discards timing) | `AudioSlicerModal.tsx:211-237` |
| Fabricated breakbeat | `AudioSlicerModal.tsx:52-100` |
| Warp audition (silent) | `WarpAudioProcessorModal.tsx:45-69` + `sampler.ts:15-17` |
| `warpMode` has no consumer | grep: `types/daw.ts:353`, modal only |
| `timeStretchRate` = `playbackRate` | `audioEngine.ts:3086, 3101` |
| Vocal tuner simulated pitch | `VocalTunerModal.tsx:120-142` |
| Vocal tuner has no audio consumer | grep of `src/audio/*.ts` → none |
| Polyphonic hardcoded blobs | `PolyphonicEditorModal.tsx:26-33` |
| Polyphonic "Apply" = `onClose` | `PolyphonicEditorModal.tsx:347-352` |
| Take comping promotion refused | `TakeCompingModal.tsx:115-131` |
| Take comping "AI" string | `TakeCompingModal.tsx:93` |
| No `createPeriodicWave` in codebase | grep `src/audio/` → zero |
| `wavetable` → subtractive alias | `audioEngine.ts:405` |
| `wavetable` unreachable in UI | `StudioBrowser.tsx:57-81`, `ChannelRack.tsx`, `presets.ts` |
| Unison capped at 7 | `subtractiveSynth.ts:44` |
| Wavetable "Apply" = `onClose` | `WavetableSynthModal.tsx:337-341` |
| Macro rack runtime bridge | `src/state/macroMappings.ts:1-36`, `src/App.tsx:1837` |
| MIDI CC runtime bridge | `src/App.tsx:647-670`, `midiMappingRuntime.ts:282-318` |
| Export FX stripped by default | `audioEngine.ts:1969-1971`; `ExportModal.tsx:66`; `App.tsx:1796` |
| Dead alternate renderer | `offlineProjectRenderer.ts:121`; callers = tests only |
| `meta.masterVolume` never applied | `midiMappingRuntime.ts:19` (documented); grep → presets/state/types only |
| Shell-only tests | `src/state/modalDialogShell.test.tsx`, `src/state/transportShell.test.tsx` |

## Appendix B — Classification roll-up

| # | Feature | Classification |
|---|---|---|
| 1 | Mastering Suite | **PARTIAL** (metering REAL · processing STATE-ONLY, honestly labelled) |
| 2 | Warp Audio Processor | **UI/PROTOTYPE** |
| 3 | Vocal Tuner | **STATE-ONLY** |
| 4 | Polyphonic / ARA / Melodyne Editor | **UI/PROTOTYPE** |
| 5 | Take Comping | **UI/PROTOTYPE** (honestly gated by Phase 48) |
| 6 | Wavetable Instrument | **UI/PROTOTYPE** |
| 7 | Multi-zone Sampler | **REAL** |
| 8 | MIDI Learn | **REAL** |
| 9 | Gross Beat | **PARTIAL** |
| 10 | Macro Rack | **REAL** |
| 11 | Sidechain | **PARTIAL** |
| 12 | Audio Slicer | **PARTIAL** (panel REAL · modal UI/PROTOTYPE) |

---

*Audit performed read-only against `463ba95df16752ed69a48377396867e2d8d49035`. No production
code, test, branch, PR or merge was created or modified.*
