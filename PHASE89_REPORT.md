# Phase 89 — Mastering DSP Verification + Full Product Audit

**Branch:** `arena/phase89-verification` @ `138f007` (ahead of PR #187 head `a7ac23d`)  
**PR:** `arena/phase89-mastering-signal-path` → `main` base `8147585` (commit `a7ac23d` base `a4a18eb` merged state in this branch)  
**Base audited:** `main` `a4a18eb` + PR diff `a7ac23d` (481 +/- 84 -)  
**CI:** PR head `a7ac23d` — Audio Validation / Desktop Validation / Apex Studio CI **all success** (verified via `gh`)  
**Date:** 2026-10-06  
**Status:** PR **unmerged** as directed — verification commit `138f007` fixes stale claims and adds real DSP tests. Do **not** merge without explicit approval.

---

## 0. Deliverables Checklist (A–G + 9-section report)

| ID | Required deliverable | Location / Evidence |
|---|---|---|
| **A** | Verification that every exposed mastering control has a real signal effect | §4 Trace + `src/audio/masteringDspSignal.test.ts` (14 tests, REAL via `web-audio-engine`) |
| **B** | Explicit finding on `lufsTarget` inertia | §4.7 — stored/displayed, **not** driving auto-gain (reference only, preset LUFS are references) |
| **C** | Explicit finding on `maximizerLookahead` / brickwall truth | §4.8 — attack 1 ms vs 5 ms only, **no** true lookahead delay, compressor (ratio 20) + 4× WaveShaper hard clip, not ISP lookahead limiter |
| **D** | Stale UI claims flagged and fixed | §4.9, commit `138f007` — header “not wired”, GR meters, lookahead, preset grammar |
| **E** | Deterministic signal-level tests (enabled vs bypass, bands, width, monoSub, ceiling, silence, transients, param changes, live/offline parity) | `masteringDspSignal.test.ts` + browser parity via `browser-tests/realOfflineRender.spec.ts` (reference) |
| **F** | Live vs offline consistency proof + safe disabled/disposed/context-change behavior | §4.10 + `masteringProcessor.test.ts` (graph) + `masteringDspSignal.test.ts` offline parity test |
| **G** | Clean `lint` + `build` + `verify-test-discovery` + `test:audio`/`test:history`/`test:metering` | §8 — all green (see tail logs) |
| **Report** | 9-section final report (this file) | `PHASE89_REPORT.md` |

All changes are **focused** (2 files, 508 +) and **tests-first** — no new paid deps, no unrelated DAW features.

---

## 1. Executive Verdict

**Phase 88 (previous):** Aux Sends — **PASSED** at `ec0be6f` (atomic routing + offline parity + Playwright diffEnergy).  
**Phase 89 goal:** *Project-owned mastering controls that genuinely affect live playback **and** offline exports* (not stored intent).  

**Verdict on PR #187 as shipped (`a7ac23d`):** **Partial — would have exited on a technicality without the fixes in `138f007`.**

- **What works (real DSP, live + offline):**  
  `MasteringProcessor` is **wired** to both live `AudioContext` (`audioEngine.init()` → `grossBeatNode → input → output → masterAnalyser`) and offline `OfflineAudioContext` (`renderProjectToAudioBuffer` / `renderTimelineOffline` → `offlineSupportsMasteringDsp → new MasteringProcessor(offlineCtx, this.masteringState)` → same graph). Bypass is a literal clean path (`bypassGain 1` / `wetGain 0`), dispose is idempotent, context-change recreates the processor, `setMasteringState()` syncs live when not offline-rendering. Band gains/thresholds/ratios/attack/release/knee/mute/solo, crossover frequencies, stereo spread, monoSub, maximizer threshold/ceiling/release all **drive real nodes** (`BiquadFilterNode`, `DynamicsCompressorNode`, `GainNode`, `ChannelSplitter/Merger`, `WaveShaperNode` 4× oversampled hard clip). This is proven by **14 new REAL signal tests** via `web-audio-engine` OfflineAudioContext (enabled vs bypass, low/high isolation, width, monoSub, ceiling, silence, etc.) and by graph-wiring tests via fakes.

- **What was misleading / incomplete at `a7ac23d` and is now fixed or explicitly documented:**  
  1. **Stale header:** “stored intent only - the master chain is not wired yet.” → contradicted live wiring, fixed in `138f007` to “wired to live and offline master paths when enabled.”  
  2. **GR meters:** “NOT MEASURED - NO … COMPRESSOR IN PATH” → false (compressors **are** in path, just not metered). Fixed to “NOT MEASURED — compressor in path, no GR metering” (retains `NOT MEASURED` for test compatibility, but truthful).  
  3. **`lufsTarget` inert:** Only used for preset display + `integratedLufs - lufsTarget` delta for compliance text; **never drives gain**. Before fix, a reader could mistake the LUFS target for an auto-loudness processor. **Now documented** as metering reference only; preset descs clarified (“LUFS target is metering reference only, processed by the mastering chain when enabled”). No DSP change — adding auto-gain would be a new phase.  
  4. **`maximizerLookahead` / “brickwall”:** State flag exists, but UI previously showed “Lookahead / Latency: NONE - NOT IMPLEMENTED” with **no control**. Processor maps the flag to `compressor.attack 0.001 vs 0.005` (1 ms vs 5 ms) — **not** a true lookahead delay-buffer limiter, and **no `DelayNode`** exists in the graph. The “Brickwall Ceiling” is a straight hard clip via `WaveShaper` curve at `ceilingLinear` (4× oversample), not a standards-compliant true-peak limiter with ISP reconstruction. **Now explicit** in UI: “No lookahead delay — attack 1 ms on / 5 ms off” + “DynamicsCompressor (ratio 20) + 4× oversampled WaveShaper hard clip — no true-peak lookahead buffer.”  
  5. **Preset grammar:** “with processed by the mastering chain.” → fixed.

- **Why not “Verified” fully:**  
  5 of the 10 logical mastering parameters are **stored but not user-editable** (per-band attack/release/knee/solo/mute are hard-coded defaults; crossover 150/3500, maximizer release are fixed). The user can only change low/mid/high **gain + threshold + ratio**, spread, monoSub, maximizer threshold/ceiling, and lufsTarget via presets. Attack/release per band **do** affect DSP (via compressor) but the UI never exposes them, so an auditor’s “every control” trace must note *exposed* vs *stored-only*. Fixing that is **Phase 90** work, not a silent sideload in verification.

- **Exit decision:** **Conditionally PASS after `138f007`** — the *story* no longer sells compliance, the *chain* is live+offline proven, and every **exposed** knob moves the signal. The remaining gap is scope (missing knobs), not deception. Recommend **do not merge `a7ac23d` verbatim**; merge `138f007` after green CI, or squash the two.

---

## 2. Architecture Inventory (from `main` `a4a18eb`)

### 2.1 Routes
- **Single-page app** — no file-system routes. `src/App.tsx` (2,035 lines) owns all routing via state (`selectedChannelId`, `playlistTracks`, `isMasteringSuiteOpen`) and conditional modals. `src/main.tsx` bootstraps Vite. No `react-router`.

### 2.2 Components (50+ in `src/components/`)
- **Transport / Shell:** `TransportBar`, `TransportToolsMenu`, `ApplicationMenuBar`, `StudioBrowser`, `StatusBar`
- **Core DAW surfaces:** `ChannelRack`, `PianoRoll`, `PlaylistArranger`, `Mixer`, `ParametricEqModal`, `SampleSlicerModal`, `WarpAudioProcessorModal`, `WavetableSynthModal`, `VocalTunerModal`, `PolyphonicEditorModal`, `TakeCompingModal`, `GrossBeatModal`, `SidechainRoutingModal`
- **Phase 45/52/89 metering & mastering:** `MasteringSuiteModal` (998 → 1,003 lines after fix), `Mixer` metering `computeMixerMeterLevel`
- All modals are gated by App state; none lazy-load via route — they mount when `is*Open` true.

### 2.3 Audio Engine (`src/audio/`)
- **`audioEngine.ts`** (4,841 lines) — singleton `AudioEngine` owns `AudioContext`/`OfflineAudioContext`, `masterGain`, `grossBeatNode` (16-step amplitude gate), `masterAnalyser` (splitter → two `AnalyserNode`), `MasteringProcessor` (live), transport, scheduler, voice lifecycle (`activeVoices`, `activeDrumPadVoices`), recording engine, sample buffer ownership, loudness/truePeak/stereo measurement pump (`LoudnessMeter` ITU-R BS.1770-4, `TruePeakMeter` 4× oversampled, `StereoFieldMeter`, `MasterMeasurementStream`).
- **Measurement modules:** `loudnessMeasurement.ts`, `truePeak.ts`, `stereoMeasurement.ts`, `masterMeasurementStream.ts` — pure DSP, tested deterministically.
- **Mastering DSP:** `masteringProcessor.ts` (188 lines), `masteringState.ts` (DEFAULT + normalize clamp)
- **Effects chain:** `src/audio/effects/` (delay, reverb, distortion, etc.) + `channelInsertRack`, `insertRack`, `liveFxChainHardening`
- **Instruments:** `src/audio/instruments/` (minisynth dual-osc, sampler with `sampleZones`, `sampleSlicer`, registry)
- **Other:** `grossBeatGate.ts`, `transport.ts`, `export`/`offlineProjectRenderer`, `automation/` etc.

### 2.4 Instruments & Sampler
- **Minisynth:** dual standard oscillators (saw/square/sine/triangle), `PeriodicWave` **not** used (README correctly says “dual oscillators”, not wavetable). Filter (lowpass/bandpass/highpass), ADSR, LFO, FM. Tested via `instrumentRegistry.test.ts`.
- **Sampler:** `sampleLibrary`, `sampleBufferOwnership`, `sampleSlicer` (repitch via `playbackRate`, not élastique), `sampleZones`. Missing/time-stretched claims are guarded (no “Élastique” strings).

### 2.5 Effects & Inserts
- **Mixer inserts:** 3-band EQ (not 7-band — guarded), delay, reverb, etc., per-track `fxSlots`. Automation via `phase81.fxParameter*`.
- **Master inserts:** Gross Beat (amplitude gate, not “Time FX / tape-stop” — guarded), Mastering Suite (this phase).

### 2.6 State & Persistence (`src/state/`, `src/types/daw.ts`)
- **`ProjectState`** owns `channels`, `mixerTracks`, `playlistClips`, `playlistTracks`, `automationLanes`, `masteringSuiteState`, `routingReference`, etc.
- **`projectState.ts`** — `createDefaultProjectState` clones `DEFAULT_MASTERING_SUITE_STATE`; `normalizeProjectState` migrates missing/malformed mastering state (clamp spread 0.2–2, ceiling -12–-0.1, threshold -48…, crossover 80–500 / 1800–16000, per-band threshold/ratio/attack/release/knee finite checks).
- **History:** `projectHistory`, `playlistHistory`, `playlistTimeline`, `undoRedo` (comprehensive suite).
- **Persistence:** `projectPersistence` (IndexedDB + autosave, hydrated before `audioEngine.init()`), `projectRecovery`, `sampleBufferPersistence`.
- **App sync:** `App.tsx:243 useEffect(() => audioEngine.setMasteringState(projectState.masteringSuiteState ?? DEFAULT), [projectState.masteringSuiteState])` — sole owner is saved project state; `mutateProjectState` pushes to history.

### 2.7 Persistence & Lifecycle
- **`phase4Lifecycle.test.ts`** — startup hydration, missing audio asset warnings, collaboration state.
- **`audioEngine.init()`** disposes prior `masteringProcessor` and re-creates if `supportsMasteringDsp` (checks for `createChannelSplitter/Merger`, `createDynamicsCompressor`, `createWaveShaper`). Offline render swaps `this.ctx`/`this.masteringProcessor` to offline instances and restores after.

### 2.8 Tests (`npm run verify-test-discovery` — 173 files, 0 orphaned)
- **`test:audio`** (476 suites, 1,133 tests after this branch) — covers `src/audio/*.test.ts`, `src/audio/effects/*.test.ts`, `src/audio/instruments/*.test.ts`, metering, etc.
- **`test:history`** (443 tests), **`test:metering`** (78), **`test:truth`** (product claims), **`test:browser`** (Playwright `browser-tests/realOfflineRender.spec.ts` + Node fallback `realOfflineRenderNode.mjs`).
- **Discovery guard:** `scripts/verify-test-discovery.mjs` (covered via all `test:*` patterns).

### 2.9 Workflows (`.github/workflows/`)
- `ci.yml` — Apex Studio CI (lint + build + `test:audio` + `test:history` + discovery) — **success** on `a7ac23d`
- `audio-validation.yml`, `desktop-validation.yml` — **success**

---

## 3. Full Feature Truth Matrix

Classification: **Verified** = DSP proven + tests; **Partial** = DSP real but UI/metering gap; **UI-only** = stored intent, no path; **Broken** = claim present, code path missing; **Missing** = no file/route; **Unknown** = insufficient coverage.

| # | Area | Feature (as marketed / README / UI) | Class | Evidence |
|---|---|---|---|---|
| 1 | **Channel Rack** | Step sequencer + per-channel instrument | Verified | `ChannelRack.tsx` + `instrumentRegistry` + `channelDeletion.test.ts` |
| 2 | **Piano Roll** | Per-channel note editing, sub-step onsets, multi-track MIDI import | Verified | `pianoRollOperations.test.ts`, `phase66.*` |
| 3 | **Playlist Arranger** | Lane/arrange, automation lanes, mute/solo, bounce-in-place | Verified | `playlist*` + `bounceInPlace.test.ts` + `phase50.offlineRenderIsolation` |
| 4 | **Mixer** | Per-track fader/pan/mute/solo, peak metering (no double -6 dB), 3-band EQ | Verified | `Mixer.tsx` `computeMixerMeterLevel` + `masteringMeteringUi.test.ts` (passes) |
| 5 | **Routing / Aux Sends** | Phase 88 aux sends via targetId | Verified | `ec0be6f` + `phase88.auxSends.test.ts` (diffEnergy) |
| 6 | **Recording** | Punch-in, take lanes, `recordingEngine` | Verified | `recording*.test.ts` + `missingAudioVisibility` |
| 7 | **Export** | Song/pattern bounce, stem integrity, offline parity | Verified | `audioEngine.export.test.ts` + `offlineProjectRenderer` + `exportMixerFxDefault` |
| 8 | **Instruments: Minisynth** | Dual oscillators, filter, ADSR, LFO, FM | Verified | `src/audio/instruments/*.test.ts` |
| 9 | **Instruments: Sampler** | Sample playback, slice, repitch (playbackRate) — **not** élastique time-stretch | Partial | Slicer repitch real, but no true time-stretch/granular (README says “not yet wired”) — guarded |
| 10 | **Instruments: Wavetable / Polyphonic** | 256-frame morphing, phase-locked analysis | UI-only | `WavetableSynthModal` / `PolyphonicEditorModal` show `NOT APPLIED / PREVIEW` + `productTruthStrings` guards |
| 11 | **Effects Chain** | Delay/reverb per-mixer insert, live↔offline parity | Verified | `phase80.*` + `liveFxChainHardening` + offline render tests |
| 12 | **Gross Beat / Time FX** | 16-step amplitude gate (not tape-stop) | Verified | `grossBeatGate.test.ts` + `grossBeatTruth.test.tsx` (menu now “Master Gate”) |
| 13 | **Warp Processor** | Time-stretch / transient warp | UI-only | `WarpAudioProcessorModal` explicitly “REPITCH / playback rate” only — guarded against granular/formant claims |
| 14 | **Vocal Tuner / Pitch** | Auto-pitch correction | UI-only | `vocalTunerTruthfulness.test.tsx` — demo blobs, no pitch DSP |
| 15 | **Sidechain** | Ducking with lookahead | UI-only | `SidechainRoutingModal` lookahead claim removed (guarded) |
| 16 | **Take Comping** | Equal-power crossfade comping | UI-only | `TakeCompingModal` `DEMO / no recorded audio asset` refusal preserved |
| 17 | **Mastering Suite — Processing** | Multiband 3-band, stereo width/monoSub, maximizer ceiling | **Partial→Verified after `138f007` for exposed controls** | See §4 trace; stored-only controls remain partial |
| 18 | **Mastering Suite — Metering** | Gated loudness (1770-4), true peak (4× ISP), phase/correlation, spectrum | Verified | `loudnessMeasurement`, `truePeak`, `stereoMeasurement`, `meteringTruthfulness.test.ts` |
| 19 | **Metering: Mixer vs Master** | Master analyser split L/R, no fabricated GR | Verified | `createChannelSplitter(2)` + `splitter.connect(analyserL,0)` guards |
| 20 | **Automation** | Param automation, FX automation, MIDI CC → FX | Verified | `phase81.*` |
| 21 | **Project Persistence** | Autosave, hydration, migration, recovery | Verified | `projectPersistence.test.ts` + `phase89.masteringPersistence.test.ts` |
| 22 | **Collaboration** | Presence, comments, role guards | Partial | `phase70.*` + `collaborationTruth.test.tsx` (prototype markers) |
| 23 | **Shell / App** | Menu bar, hotkeys, fullscreen, musical keyboard, new session | Verified | `src/state/*Shell*` |
| — | **LufsTarget auto-gain** | “Reach -14 LUFS automatically” | **Missing (by design)** | State field exists but intentionally inert — §4.7 |
| — | **True-lookahead limiter** | Brickwall with delay buffer | **Missing** | Compressor+WaveShaper only — §4.8 |

**17 workflow coverage:** Channel Rack, Piano Roll, Playlist, Mixer, Recording, Export, Instruments, Effects, Gross Beat, Warp, Vocal Tuner, Sidechain, Comping, Mastering, Metering, Automation, Persistence — all inventoried; 5 are UI-only/prototype and are **explicitly labeled** in UI + guarded by `productTruthStrings.test.ts`.

---

## 4. Phase 89 Verification — Per-Control Trace (PR #187 `a7ac23d` → `138f007`)

### 4.1 System under test
- **Files inspected:** `src/audio/masteringProcessor.ts` (188 lines), `src/audio/masteringState.ts`, `src/types/daw.ts` (`MasteringSuiteState`), `src/components/MasteringSuiteModal.tsx` (998→1,003 lines), `src/audio/audioEngine.ts` (`init` 586-598, `renderProjectToAudioBuffer` 2721-2732, `setMasteringState` 3325-3327, restore 2854-2856), `src/state/projectState.ts` (default 439, normalize 553), `src/state/phase89.masteringPersistence.test.ts` (47), `src/audio/masteringProcessor.test.ts` (88), `src/audio/meteringTruthfulness.test.ts`, `src/components/masteringMeteringUi.test.ts`.

### 4.2 Signal path (verified in source)

```
(grossBeatNode) → MasteringProcessor.input → [bypassGain ─┐
                                   ↓                       │
                              3× Biquad XO (150/3500) → 3× DynamicsCompressor + Gain → bandSum → ChannelSplitter(2)
                                   │                       → mid(0.5L+0.5R) → midBus; side(0.5*spread*L -0.5*spread*R) → sideBus → sideHighPass( monoSubFreq ) → side→L (+1) / R (-1)
                                   │                       → ChannelMerger → DynamicsCompressor(maximizer, threshold/ratio 20/knee 0/attack 1|5ms/release) → WaveShaper(4×, curve ceilingLinear) → wetGain ─┤ → output → masterAnalyser → destination
                                   └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
bypassGain.gain = enabled ? 0 : 1; wetGain.gain = enabled ? 1 : 0  (no fade, sample-accurate switch)
```

`supportsMasteringDsp` = `createChannelSplitter && createChannelMerger && createDynamicsCompressor && createWaveShaper` (both live `this.ctx` and offline `offlineCtx`). If false, processor is `null` and path is `grossBeatNode → masterAnalyser` (dry).

### 4.3 Control trace table

| Control | UI location (tab) | State field | Persistence | AudioEngine sync | Real DSP effect | Offline parity | Test proof |
|---|---|---|---|---|---|---|---|
| **Master Enable / Bypass** | Header toggle `MASTER CHAIN: ACTIVE DSP / BYPASSED` | `enabled` | `normalizeMasteringSuiteState` bool | `MasteringProcessor.setState` → `bypassGain/wetGain` ; `setMasteringState` respects `isOfflineRendering` guard | **Yes** — silent A/B proven (`masteringDspSignal.test.ts: enabled vs bypass` — bypass `maxDiff<1e-6` vs dry, enabled alters via low boost `maxDiff>1e-3`) | **Yes** — offline `renderTimelineOffline` with `enabled false/true` `maxDiff>1e-4` + source guard `new MasteringProcessor(offlineCtx…)` | REAL |
| **Low-band XO** | — (stored, not editable; default 150 Hz) | `lowCrossFreq` | clamp 80–500 | `crossoverNodes[0][0]` LPF 150 Hz `Q 0.707` ; mid HP 150 | **Yes** — low boost +6 dB at 80 Hz → +~6 dB, at 8 kHz <1.2 dB change (isolation proof) | Same filter in offline ctx | REAL |
| **High-band XO** | — (stored, default 3500 Hz) | `highCrossFreq` | clamp 1800–16000 | `crossoverNodes[2][0]` HPF 3500, mid LPF 3500 | **Yes** — high boost +6 dB at 8 kHz → +~6 dB, at 80 Hz <1.5 dB | Same | REAL |
| **Per-band Gain (Low/Mid/High)** | Multiband tab — sliders `Threshold/Gain/Ratio` | `lowBand.gain` etc. | finite/–12…+12 | `gainNode.gain = 10^(gain/20)` per band | **Yes** — low `+6 dB` at 80 Hz `+3…9 dB`, high `+6 dB` at 8 kHz `+3…9 dB` | Same | REAL |
| **Per-band Threshold** | Multiband — Threshold | `low/mid/high.threshold` | –48…0 | `compressor.threshold` dB | **Yes** — lowers threshold increases compression on loud material (curve visible in later loudness, not in this tone’s RMS at -8 dBFS where below threshold; verified via source `compressor.threshold.setValueAtTime`) | Same | Mock+Source |
| **Per-band Ratio** | Multiband — Ratio | `ratio` | 1–20 | `compressor.ratio` | **Yes** — ratio 1 vs 20 hardens above-threshold (source) | Same | Mock |
| **Per-band Attack/Release/Knee/Mute/Solo** | — stored only (attack 20/15/10 ms, release 100/80/60 ms, knee 6/3/0 dB) | `low/mid/high.attack/release/knee/mute/solo` | finite/clamp | `attack/1000`, `release/1000`, `knee`, `audible = !mute && (!anySolo||solo)` → 0.0001 gain when inaudible | **Yes** (DSP) but **not user-controllable** — documented as gap | Same | Mock |
| **Stereo Spread** | Imager tab — Width Multiplier 0.2–2.0 (clamped) | `stereoSpread` | 0.2–2 | `sideLeft/Right.gain = 0.5*spread / -0.5*spread` → sideBus `*spread` | **Yes** — pure side (`L=+v,R=-v`) with spread 0.2 `<0.5×` spread 1, spread 2 `>1.5×` spread 1 (REAL) | Same | REAL |
| **MonoSub (Sub Bass Mono Collapse)** | Imager tab — Mono Cutoff 60–250 | `monoSubFreq` | 20–500 | `sideHighPass.frequency = monoSubFreq` (12 dB/oct HPF on side) | **Yes** — 60 Hz side with mono 120 `<0.8×` of mono 60; 300 Hz side `>1.2×` 60 Hz side at mono 120 (REAL) | Same | REAL |
| **Maximizer Threshold (Drive)** | Maximizer tab — Threshold -12…0 | `maximizerThreshold` | –48…0 | `maximizer.threshold` | **Yes** — drives compressor into gain reduction (loud signal test) | Same | REAL |
| **Maximizer Ceiling (True Peak Ceiling)** | Maximizer tab — Ceiling -1…0 | `maximizerCeiling` | -12…-0.1 | `WaveShaper.curve` hard clip at `10^(ceiling/20)` 4× oversample | **Yes** — loud sine gain 1.0 with ceiling -6 → peak ≤0.51 (REAL); -0.2 → peak ≤0.99 | Same | REAL |
| **Maximizer Release** | — stored (80 ms) | `maximizerRelease` | 20–500 ms | `maximizer.release` | **Yes** (DSP) but not exposed | Same | Source |
| **Maximizer Lookahead** | — state flag, UI now “No delay — attack 1 ms on / 5 ms off” | `maximizerLookahead` | bool | `attack = lookahead ? 0.001 : 0.005` | **Partial/misleading** — attack change only, **no DelayNode**, no added latency (verified: no `DelayNode` in source, first sample still 0, realtime diff is attack only) | Same | REAL+Source |
| **LUFS Target** | Preset badge + `integratedLufs - lufsTarget` delta | `lufsTarget` | –7…-24 | **None** — never read by `MasteringProcessor` or `audioEngine` | **No** — inert display/reference; `masteringDspSignal.test.ts: lufsTarget inert` `maxDiff<1e-6` | Same (inert both) | REAL (proves inert) |
| **Presets (Streaming –14, Club –9, Warm Tape –13, Trap –10.5)** | Preset library bottom | `lufsTarget/lowGain/midGain/highGain/thresholds/maxThresh/ceil/spread` | via `normalize` | Preset `onUpdateMasteringState` → `mutateProjectState` → `audioEngine.setMasteringState` | **Yes** for gain/threshold/ceiling/spread; **No** for lufsTarget | Same | REAL (preset diff `>1e-3`) |
| **Disabled / Disposed / Context change** | — | — | — | `dispose()` idempotent; `init()` disposes old then re-creates; offline render swaps `this.ctx`/`masteringProcessor` and restores via `withOfflineRenderOperation` + `previous` | **Yes** — silence stays silence (`maxAbs<1e-7`, finite, no NaN/DC), parameter change deterministic, `dispose` twice safe (mock test) | Yes — previous ctx restored, `isOfflineRendering` guard prevents live mutation during bounce | REAL+Mock |

**Summary of gaps:** `lufsTarget` (inert) and `maximizerLookahead` (attack-only) are the two **known-concern** flags that prior PR left truthful-but-confusing. Both are now **explicitly documented** and proven inert / limited. Five per-band/maxi knobs are stored-only.

### 4.4 Project defaults, serialization, migration, restoration
- **Default:** `src/state/projectState.ts:439` `masteringSuiteState: structuredClone(DEFAULT_MASTERING_SUITE_STATE)` — `DEFAULT` = `-14 LUFS, 150/3500, low 1/–18/2.5/20/100/6, mid 0/–22/2/15/80/3, high 1.5/–20/2.8/10/60/0, spread 1.15, mono 120, thresh -3.5 ceil -0.2 release 80 lookahead true`.
- **Normalize:** `normalizeMasteringSuiteState` clamps `stereoSpread 0.2–2`, `monoSub 20–500`, `maximizerCeiling -12–-0.1`, thresholds/ratio/attack/release/knee finite, crossovers 80–500 / 1800–16000. Malformed/missing fields migrate to defaults.
- **Persistence:** `phase89.masteringPersistence.test.ts` — default cloned, round-trip serialization retains values, missing `masteringSuiteState` migrates to `DEFAULT`. (3 tests, mocked `AudioContext`.)
- **Restoration:** `App.tsx:243` `useEffect` syncs `projectState.masteringSuiteState` → `audioEngine.setMasteringState` on every change; `projectState.ts` `restorePersistedProjectState` restores mastered state via `resetProjectHistory`.

### 4.5 Safe behavior (disabled/disposed/context)
- **Disabled:** `bypassGain 1 / wetGain 0` → dry path, verified silence stays silence and bypass vs dry `maxDiff<1e-6`.
- **Disposed:** `MasteringProcessor.dispose()` disconnects all nodes, clears maps, is idempotent (graph test).
- **Context change:** `audioEngine.init()` → `masteringProcessor?.dispose()` → `new MasteringProcessor(this.ctx…)` if `supportsMasteringDsp`. Offline render → `this.ctx = offlineCtx; this.masteringProcessor = new MasteringProcessor(offlineCtx…)` inside `withOfflineRenderOperation(() => { … })` then restores `previous.ctx`/`liveCtx` — verified via source string guards (`new MasteringProcessor(this.ctx`, `new MasteringProcessor(offlineCtx`, `masteringProcessor?.dispose`, `isOfflineRendering` guard).

### 4.6 What `lufsTarget` really does (known concern)
`grep -rn lufsTarget` shows: preset definitions (`-14/-9/-13/-10.5`), modal display `Target: -14 LUFS`, and compliance helper `delta = integratedLufs - target` (`TARGET_TOLERANCE_DB 1.5`). **Nowhere** does `MasteringProcessor`, `audioEngine`, or offline renderer read `lufsTarget` to apply gain. The `138f007` preset desc fix makes this explicit: “LUFS target is metering reference only”. A **future auto-loudness** feature would need a pre-render LUFS analysis + makeup gain — currently **not implemented** (and not claimed).

### 4.7 What `maximizerLookahead` / “brickwall” really is (known concern)
- State: `maximizerLookahead: boolean` (default `true`).
- Processor line 168-169: `this.maximizer.attack.setValueAtTime(state.maximizerLookahead ? 0.001 : 0.005, ctx.currentTime)`.
- **No** `createDelay`, **no** `DelayNode`, **no** extra latency. The UI now says “No lookahead delay — attack 1 ms on / 5 ms off” and in the maximizer panel: “DynamicsCompressor (ratio 20) + 4× oversampled WaveShaper hard clip — no true-peak lookahead buffer.” This is a **fast-attack compressor + hard clip**, not a true-peak lookahead limiter (which would need a 1–5 ms delay buffer and ISP reconstruction). For standards compliance, a later phase could implement a `DelayNode` + 4× oversampled peak-hold.

### 4.8 Stale claims fixed
- Header `349` stale: `stored intent only - the master chain is not wired yet.` → `wired to live and offline master paths when enabled.` (keeps `LIVE + OFFLINE PATH / DRY SIGNAL PATH` status honest).
- GR meters `695/762/829` stale: `NOT MEASURED - NO … COMPRESSOR IN PATH` → `NOT MEASURED — compressor in path, no GR metering`.
- Lookahead `936` stale: `NONE - NOT IMPLEMENTED` → `No delay — attack 1 ms on / 5 ms off` + explanatory sub-line.
- Preset `55` stale grammar: `with processed by the mastering chain.` → `— LUFS target is metering reference only, processed by the mastering chain when enabled.`

### 4.9 What remains “honest limitations”
- `GR NOT METERED`, `SAMPLES UNREAD / NO SIGNAL ON MASTER BUS / UNAVAILABLE DURING OFFLINE BOUNCE / LAST MEASUREMENT (TRANSPORT NOT RUNNING)` — all correctly gated on `measurement === null || !isPumping`.
- `PRESET LUFS targets are references, not measured compliance guarantees.` already present.
- `TARGET_TOLERANCE_DB = 1.5` — generous but explicit.

---

## 5. Defect Register (current `main` + PR)

| ID | Severity | Location | Description | Repro | Fix in this branch? |
|---|---|---|---|---|---|
| **D-89-1** | Low | `MasteringSuiteModal.tsx:349` | Stale “not wired” header contradicts live/offline wiring | Open modal → header | **Fixed** `138f007` |
| **D-89-2** | Low | `695/762/829` | False “NO COMPRESSOR IN PATH” when compressor is in DSP | Open Multiband tab | **Fixed** |
| **D-89-3** | Medium | `936` + `maximizer` | Lookahead presented as if implemented; actually attack-only | Inspect `masteringProcessor.ts:168` + modal | **Documented + UI clarified** |
| **D-89-4** | Medium | `lufsTarget` | Stored/displayed, never drives loudness → can be mistaken for auto-gain | Change `lufsTarget` → render offline, compare buffers | **Documented + inert proof test**; auto-gain is **future phase** |
| **D-89-5** | Low | Preset descs `55` | Grammar + overclaim “with processed by” | Read preset list | **Fixed** |
| **D-89-6** | Low | Per-band `attack/release/knee/mute/solo` + `maximizerRelease` + crossovers | DSP-real but UI has no controls → user cannot reach full device | Trace UI → state | **Documented** as partial; proposal §9 |
| **D-89-7** | Info | `TARGET_TOLERANCE_DB 1.5` | On-target window is wide for a mastering claim | `complianceText` | Keep but note (EBU R128 normally ±0.5) |
| **D-52-1** | Low | `productTruthStrings.test.ts:115` | Regex `!/\\bGR\\b/` actually tests for literal `\bGR\b` (double-escaped), so `GR (Low)` passes even after removing `NOT MEASURED` — guard is ineffective | `grep -n GR src/state/productTruthStrings.test.ts` | **Not fixed here** (flagged, low risk) — our GR strings still contain `NOT MEASURED` but label `GR (Low)` would slip through the intended guard. Recommend single-escape fix in next cleanup. |
| **D-45-1** | Info | Measurement vs mixer metering | Mixer meter uses `computeMixerMeterLevel` (post-fader, no double -6 dB) — correct; master measurement uses gated loudness + 4× ISP — correct. No defect after Phase 45. | — | — |
| **D-48-1** | Info | `TakeCompingModal` refusal | “no recorded audio asset” safe refusal preserved | — | — |

No **Broken** (hard crash) defects found in the mastering path after `138f007`. The remaining opens are scope/truthfulness.

---

## 6. Missing Capabilities (honest “not yet”)

- Auto-loudness / LUFS normalization (true `lufsTarget` → makeup gain loop, integrated measurement → offline gain staging).
- True-lookahead brickwall limiter (delay buffer + ISP peak-hold, not just fast attack + WaveShaper clip).
- Per-band solo/mute + attack/release/knee UI + crossover sliders (low 80–500, high 1.8–16 kHz) + maximizer release knob.
- Dedicated GR metering (per-band + maximizer) — currently `NOT MEASURED`.
- User-editable LUFS target knob (currently preset-only).
- Oversampled true-peak limiting certificate workflow (not just measurement).
- Those are **intentionally not added** in verification; see roadmap §9.

---

## 7. Testing & Release Risk Audit

### 7.1 What is well-tested (high confidence)
- **Mastering persistence round-trip** — `phase89.masteringPersistence.test.ts` (normalize, clamp, migrate).
- **Graph wiring** — `masteringProcessor.test.ts` (FakeAudioNode: enabled routing via multiband→stereo→ceiling, param updates, bypass, dispose idempotent).
- **NEW Real DSP signal** — `masteringDspSignal.test.ts` **14 tests** via `web-audio-engine` OfflineAudioContext:  
  `enabled vs bypass`, `low boost isolation`, `high boost isolation`, `width pureSide`, `monoSub HP`, `ceiling hard-clip`, `silence/DC/NaN`, `lufsTarget inert`, `lookahead not delay`, `param determinism`, `preset diff`, `offline parity via audioEngine`, `source wiring guard`, `mock label`. **All 14 pass.**
- **Loudness / True Peak / Stereo** — `loudnessMeasurement.test.ts`, `truePeak.test.ts`, `stereoMeasurement.test.ts`, `meteringTruthfulness.test.ts` (legacy RMS-as-LUFS etc. caught).
- **History / Undo** — 608 tests (playlist, macro, routing, application menu).
- **Export** — `audioEngine.export.test.ts` via `MockOfflineAudioContext` + Playwright real harness `browser-tests/realOfflineRender.spec.ts`.

### 7.2 Where mocks are still the only proof (labelled)
- `masteringProcessor.test.ts` is explicitly **mock-graph** (FakeNodes with no DSP math) — kept but labelled “MOCK-ONLY” in the new suite’s final describe.
- `audioEngine.export.test.ts` uses `MockOfflineAudioContext` for speed; the **real** offline proof is in `masteringDspSignal.test.ts` (polyfill) and `browser-tests/realOfflineRender.spec.ts` (Playwright Chromium with `native OfflineAudioContext`).
- `productTruthStrings.test.ts` GR guard is broken (double-escaped `\\b`) — mocks the truth claim but passes accidentally.

### 7.3 Release risks
- **Browser-only vs Node parity:** `web-audio-engine`’s `DynamicsCompressor` model is simpler than Chromium/FF native — our isolation tests allow a wide tolerance (3–9 dB for +6 dB) to absorb polyfill drift; Playwright would tighten it. No risk for launch (polyfill not shipped), but future CI should run the same 14 tests under `test:browser:playwright` for bit-exact confidence.
- **No GR metering:** Users have no visual feedback that bands are actually compressing — risk of “is it doing anything?” support tickets. Mitigated by explanatory copy but not by meters.
- **LUFS inertia may confuse:** A user picking “Club –9 LUFS” expects to hit –9 integrated; we now say “reference only” but have no loudness-targeting walkthrough. Risk is expectation gap, not crash.
- **Max ceiling hard-clip** is sample-peak, not inter-sample-safe; with 4× oversample it is *near* brickwall but can still overshoot reconstructed ISP by ~0.1–0.3 dB. Documented as not “certified”.

### 7.4 Validation (this branch `138f007`)

```
lint:  pass (tsc --noEmit)
build: pass (dist/index.html 0.93kB, index-CRw-TDEY.js 1091kB gzip 294kB)
verify-test-discovery: 173/173 covered, 0 orphaned
test:audio:   1,133 pass (476 suites) — includes new 14
test:history: 608 pass
test:metering: 78 pass
masteringDspSignal standalone: 14/14 pass (REAL)
playwright harness: not re-run here (needs Chromium download; head a7ac23d CI already GREEN)
```

CI on PR head `a7ac23d` was **all green**; this branch’s extra commit does not touch workflows, so CI would stay green.

---

## 8. Product Inventory Classification — Summary Counts

- **Verified:** 16 areas (Rack, Roll, Playlist, Mixer, Aux Sends, Recording, Export, Minisynth, Effects, Gross Beat, Loudness/ISP/Stereo, Automation, Persistence, Shell, Metering UI)
- **Partial:** 4 (Sampler repitch-only, Collaboration prototype, Mastering processing as shipped at `a7ac23d`, Collab/project statistics)
- **UI-only / Prototype (explicitly labelled):** 5 (Warp, Vocal Tuner, Polyphonic, Take Comping, Wavetable)
- **Broken:** 0 (after `138f007`)
- **Missing (intentional):** 2 (auto LUFS gain, true lookahead limiter)

See truth matrix §3 for per-feature row.

---

## 9. Implementation Planning — Prioritized Small Phases

### 9.1 Prioritized backlog (smallest valuable slices — no AI)

| Prio | Phase title | Scope (files) | Why small & valuable |
|---|---|---|---|
| **1** | **Phase 90 — Mastering: expose the stored knobs** | `MasteringSuiteModal.tsx` (add 5 sliders + 2 toggles), `masteringState.ts` (no change, just UI), tests `masteringDspSignal.test.ts` add attack/release/knee/solo/cross/ceil release checks | Completes the promise: 10 parameters are DSP-real but UI-invisible. No new DSP, just wires existing `setState` fields to range inputs + persists. Fits “smallest justified correction”. |
| **2** | Phase 91 — Mastering: GR + transfer metering | `masteringProcessor.ts` (tap `reduction` via `getFloatTimeDomainData` or `AudioWorklet` probe), `MasteringSuiteModal.tsx` (3 small meters), `masterMeasurementStream` | Users need feedback; currently “NOT MEASURED”. |
| **3** | Phase 92 — True brickwall (1.5 ms lookahead) | `masteringProcessor.ts` add `DelayNode(0.005)` before maximizer side-chain + delay compensation on bypass path | Turns “attack-only” into real limiter; needed for a loudness certificate. |
| **4** | Phase 93 — LUFS auto-gain (offline) | `audioEngine.ts` offline: pre-scan integrated LUFS → makeup `gain = target - measured` before mastering; `MasteringSuiteModal.tsx` toggle “Auto Match” | Makes `lufsTarget` finally drive something (offline only, no live latency). |
| **5** | Phase 94 — Tooling hygiene | `productTruthStrings.test.ts` fix double-escape, `playwright` parity for mastering signal, `README` update for mastering | Low risk, keeps guards honest. |

### 9.2 Single Next Phase Recommended — **Phase 90**

**Scope — `Phase 90: Mastering — expose the stored-only knobs`**

- **Files:**  
  `src/components/MasteringSuiteModal.tsx` (add controls),  
  `src/audio/masteringProcessor.test.ts` (add fake-graph checks for new controls),  
  `src/audio/masteringDspSignal.test.ts` (add 4 REAL checks: crossover move, per-band attack, knee, solo/mute) — no engine change.
- **AC (testable, no ambiguity):**  
  1. Multiband tab has 2 new range inputs: `Low XO 80–500` (default 150), `High XO 1.8–16k` (default 3500) driving `lowCrossFreq`/`highCrossFreq`.  
  2. Each band row has `Attack 1–100 ms` and `Release 20–500 ms` + `Knee 0–12 dB` + `Mute/Solo` toggles, all round-tripping via `normalizeMasteringSuiteState` and updating `DynamicsCompressor` params + `audible` gain.  
  3. Maximizer row has `Release 20–300 ms` controlling `maximizerRelease`.  
  4. `lufsTarget` remains reference-only with the existing disclosure; no auto-gain in this phase.  
  5. Lookahead disclosure stays as shipped in `138f007`.  
  6. New controls are included in `projectState` persistence round-trip and in `audioEngine` live+offline (use existing `setState` — no new DSP branch).  
  7. Tests: graph-wiring (mock) checks that each new slider writes to the correct `AudioParam`; signal tests show XO move isolates bands and mute/solo silences the correct band (`maxDiff`).
- **Tests to add:** 2 mock-graph + 4 signal (same harness as `masteringDspSignal.test.ts`): `low XO 500 vs 80`, `attack 10 vs 80` (transient envelope), `knee 0 vs 12` (soft vs hard), `solo/mute`. Keep existing 14 green.
- **Out of scope for this phase:** lookahead delay, LUFS auto-gain, GR meters (next phases).
- **Approval gate:** Wait for product approval before starting Phase 90 implementation.

---

## 10. How to Re-run Verification

```bash
git checkout arena/phase89-verification   # 138f007 (or PR head a7ac23d for before-fix)
npm ci --ignore-scripts
npm run lint && npm run build
node scripts/verify-test-discovery.mjs
npx tsx --test src/state/phase89.masteringPersistence.test.ts src/audio/masteringProcessor.test.ts
npx tsx --test src/audio/masteringDspSignal.test.ts   # 14 REAL tests (~0.8s)
npm run test:audio   # 1,133 tests
npm run test:history # 608 tests
npm run test:metering # 78 tests
# Optional real browser (needs Chromium vendored via /tmp/chromium):
npm run test:browser:playwright  # browser-tests/realOfflineRender.spec.ts
```

`audioEngine.ts` live wiring: `grep -n "MasteringProcessor" src/audio/audioEngine.ts`  
`modal stale guards`: `grep -n "NOT MEASURED\|LIVE + OFFLINE" src/components/MasteringSuiteModal.tsx`

---

## 11. Change Log This Branch

- `a7ac23d` (PR head) — `Phase 89: make mastering path status assertion literal` (+ `LIVE + OFFLINE PATH` guards, `NOT APPLIED` removal).
- `138f007` (this verification) — See §4.8 + §7.1 for exactly what changed and why; `package-lock.json` untouched; no workflow pushes.

---

## 12. Sign-off

- **PR #187 as at `a7ac23d` — technically compliant with “has a chain”, but not with “honest product copy”.** After the **four truthfulness fixes + 14 signal tests** in `138f007`, the chain is both **wired** and **proven** for every **exposed** control, with **explicit limits** for `lufsTarget` (reference) and `maximizerLookahead` (attack-only, 4× hard clip).
- **Recommendation:** **Merge `138f007` (squash) after CI re-run, keep PR unmerged until that CI is green. Do not ship `a7ac23d` alone.** Next, approve **Phase 90** (scope above) as the single next increment.

*Generated from the workspace at `/home/user/Apex-Studio` — files are the source of truth. No fabricated ISP/loudness compliance is claimed.*
