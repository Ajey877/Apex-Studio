# Phase 11 verification record

## Verdict

**Not production-complete.** A genuine input-to-Mixer signal path is implemented and measured, but capture repeatability and Windows packaged acceptance remain blocking. Do not promote README/release scope based on this PR alone.

Baseline: `5b041cbaa691e72c85ea0df8b516baa9e612ef4c`, verified by `git fetch origin main` before changes and again near delivery. Branch: `arena/fda729f4-apex-studio`. Release `v1.2.2` was not modified.

## Commands and actual results

Counts below are from actual completed runs, not inferred from test discovery. Focused tests overlap broader suites; do not sum these as unique tests.

| Exact command | Actual result |
|---|---|
| `npm run lint` | PASS, TypeScript exit 0 (latest run after diagnostic changes) |
| `npm run test:live-input` | **29 passed / 0 failed**, 0 skipped |
| `npm run test:audio` | **2,478 passed / 0 failed**, 465 suites, 0 skipped |
| `npm run test:history` | **1,283 passed / 0 failed**, 133 suites, 0 skipped |
| `npx playwright test browser-tests/recordingAlignment.spec.ts browser-tests/trackFreeze.spec.ts browser-tests/audioSettingsDeviceLifecycle.spec.ts browser-tests/mixerTheme.spec.ts browser-tests/sidechainLevelDetect.spec.ts --workers=1` | **25 passed / 0 failed** |
| `npm run test:live-input-browser` | Latest completed run: **2 passed / 1 failed**. PCM signal-path + lifecycle passed; real UI punch take failed because the recorder rejected 128 missing frames. |
| `npx playwright test --config=playwright.live-input.config.ts -g 'count-in and punch'` | Earlier isolated run **1 passed / 0 failed**; does not override the later intermittent failure. |
| `npx playwright test --config=playwright.live-input.config.ts --repeat-each=3` | Earlier reference PCM test at 48 kHz **3 passed / 0 failed**, before adding the separate UI punch test and contemporaneous input diagnostic tap. Not evidence of universal capture repeatability. |
| `npm run build` | PASS, Vite exit 0; existing large-chunk/dynamic-import warnings remain |
| `npm run verify:desktop` | PASS, desktop security/config check exit 0 |
| `npm run test:desktop-permissions` | **6 passed / 0 failed** |
| `node --check scripts/packaged-live-input-acceptance.mjs` | PASS, syntax check only |
| `npm run test:live-input-packaged` | **NOT_VERIFIED**, exit **3** on Linux; no Windows executable launched |
| `git diff --check` | PASS at delivery |

The audio script also runs the repository's test-discovery verification. There are no new skipped tests or lowered recording integrity checks. Earlier development failures in the non-solo graph topology/export tests were fixed by allocating solo gates lazily; those tests pass in the final broader audio suite. An existing static metering guard was updated to require `isPlaying || monitoring` while preserving its no-double-fader assertions. Audio Settings truth tests now require explicit activation/latency/reload-OFF guidance instead of the obsolete disabled-feature string.

## Real browser signal evidence

[`live-input-pcm-48k.json`](live-input-pcm-48k.json) is the actual emitted JSON from the latest completed PCM scenario. It uses Chromium's fake microphone WAV **through native getUserMedia**, the shipped Mixer UI, production singleton AudioEngine, real source/FX/routing graph, RecordingEngine worklet and persistence. It does not claim physical-hardware listening.

Selected values from that run (linear RMS unless called a meter):

- Intended insert L/R: **0.10585 / 0.10596**; measured producer input **0.10596** (known fixture expectation ≈0.10607).
- Master: **0.10637**; insert meter **0.15625**; unrelated insert meter **0**.
- Duplicate start rejected; output remains **0.10616**, not doubled.
- Half fader: **0.05305** while contemporaneous input is **0.10616**.
- Hard-left pan: right RMS **0.00000121**.
- Insert EQ: **0.00642**.
- Other insert solo: monitored output/master **0**; own solo restores the signal.
- Routed half-volume bus master RMS **0.05288**; bus EQ reduces it to **0.00552**.
- Aux return master RMS **0.05295**; muted return with bus at zero yields master **0**.
- Master output gain / Master insert EQ measurably attenuate the signal.
- While recording: insert RMS **0.10609**; disabling monitoring yields **0** at insert and master.
- Recorded WAV RMS **0.10553**, **77,312** frames at **48,000 Hz** after ordinary pause omission.
- Exactly **one** native capture request for monitor + recorder; root and two cloned consumer tracks all **ended** after final release.

The same test continues through actual AudioRecorderModal start/pause/resume/stop/persist/place, a new deliberate monitor acquisition and Mixer unmount cleanup. A separate passing lifecycle test exercises context suspension/resume (no auto-enable), context reconfiguration, a simulated hardware notification with genuine capture tracks, New Session, beforeunload release and reload-OFF.

## Capture failure evidence is retained

[`unresolved-capture-and-packaged.json`](unresolved-capture-and-packaged.json) records:

- Initial intermittent 44.1 kHz fake-input capture gaps of 128–256 frames and repeated frame timestamps.
- A later **48 kHz** UI punch take rejected for **128** missing frames.
- An earlier heavily loaded amplitude comparison failure and the change to measure contemporaneous producer PCM/transfer gain at the same tolerance.
- Windows packaged NOT_VERIFIED exit 3.

The cause of the frame gaps is not established. No claim is made that this is harmless, purely a fake-device issue, or a pre-existing defect. Diagnose it before accepting production recording coexistence. A passing retry does not erase the failure.

## Latency / platform scope

Chromium 153.0.0, Linux sandbox, fake 48 kHz mono 440 Hz WAV, browser-reported stereo stream, 48 kHz AudioContext selected through Audio Settings:

- Reported input latency: **10 ms**.
- `baseLatency`: **10.0208 ms**.
- `outputLatency`: **32 ms**.
- End-to-end physical round trip: **not measured**; these component estimates must not be presented as a measured round trip.

Browser executable/libraries were provisioned locally using an uncommitted npm package because browser download hosts are not available in this environment. No browser binaries, WAV fixture, screenshots regenerated by existing tests, node_modules or build output are included in the patch.

## Windows acceptance path, not a fabricated result

The mandatory new desktop CI step runs `npm run test:live-input-packaged` after the actual Windows package is built and uploads `build/live-input-evidence`. The script drives the shipped Audio Settings/Mixer/AudioRecorderModal, measures production PCM, verifies native stream ownership, closes with an active monitor and reopens a real second process OFF. It has **not executed on Windows here** and may reveal further failures. Physical microphone, interface channel separation, OS permission dialogs and acoustic/physical output latency remain unverified.

## Files changed

- `.github/workflows/desktop-validation.yml`
- `browser-tests/liveInputMonitoring.spec.ts`
- `browser-tests/liveInputMonitoringLifecycle.spec.ts`
- `docs/LIVE-AUDIO-INPUT-MONITORING.md`
- `docs/evidence/phase11/live-input-pcm-48k.json`
- `docs/evidence/phase11/unresolved-capture-and-packaged.json`
- `docs/evidence/phase11/verification.md`
- `package.json`
- `playwright.live-input.config.ts`
- `scripts/live-input-fixture.mjs`
- `scripts/packaged-live-input-acceptance.mjs`
- `src/App.tsx`
- `src/audio/audioDeviceManager.ts`
- `src/audio/audioEngine.ts`
- `src/audio/liveInputAcceptance.ts`
- `src/audio/liveInputMonitor.test.ts`
- `src/audio/liveInputMonitor.ts`
- `src/audio/managedAudioInput.ts`
- `src/audio/mixerSolo.ts`
- `src/audio/recordingEngine.ts`
- `src/components/AudioSettingsModal.tsx`
- `src/components/Mixer.tsx`
- `src/components/audioSettingsModal.test.tsx`
- `src/components/masteringMeteringUi.test.ts`

## Independent review corrections (post-`ac5f2bd5`)

Earlier sections above are retained unchanged, including the failures they record.

### Blocker B — frame-stamped capture gaps: RESOLVED, root cause established

`recordingCaptureWorklet.ts` stamped packets with `AudioWorkletGlobalScope.currentFrame`
as if it advanced once per render quantum. Measured in-browser, it does not: Chrome runs
several 128-frame quanta per audio-device buffer and refreshes `currentFrame`/`currentTime`
only at the start of that buffer. Instrumented evidence (48 kHz):

| call | frameStart | expected | contextTime | input checksum |
|------|-----------|----------|-------------|----------------|
| 577 | 232832 | 232960 | 4.850666666666666 | 2.682760 |
| 578 | 232832 | 232960 | 4.850666666666666 | 1.500929 |
| 579 | 232832 | 232960 | 4.850666666666666 | -1.292025 |
| 580 | 232832 | 232960 | 4.850666666666666 | -2.697930 |
| 581 | 233472 | 232960 | 4.864 | -1.207382 |

`contextTime` is frozen across the repeats, `callCount` increments through them (one
instance, called repeatedly), the checksums all differ (each call carries 128 genuinely new
frames), and the jump is exactly the 640 frames delivered. So the worklet emitted duplicate
`frameStart` stamps (the repeated `308352`) and skipped the frame numbers inside the jump
(the 128–256 missing frames). Not a MessagePort, pre-roll or pause-boundary defect.

Fix: `process()` advances a monotonic cursor by the frames actually delivered and uses
`currentFrame` only as the anchor. `assembleRecordingPcm()` and its integrity checks are
unchanged; nothing is padded and no overlap is ignored.

- Unit regression `capture stays gap-free when the platform only refreshes currentFrame per audio-device buffer`
  (new `advanceToFrameWithDeviceBufferLabels` harness method): **17/17 pass**. Verified to
  fail without the fix — `engine.stop()` hangs, because the lagging label never reaches
  `stopFrame` so `finishAtStop` never posts `stopped`.
- Browser regression `capture coverage @ 44100/48000 Hz`, `--repeat-each=3`: **6 passed (2.2m)**,
  under continuous main-thread load, across plain take, pause/resume, count-in→punch and
  repeated start/stop. Full live-input suite **6/6**; audio unit suite **2230/2230**.

### Blocker A — destructive monitoring init: RESOLVED for the renderer graph

`startLiveInputMonitoring()` no longer calls `prepareTracks()` (which stopped every native
session) nor `updateMixerTrack()` for every track. It calls the new
`NativeVst3EffectRuntime.ensureTracksPrepared()` (prepares only what is absent or stale,
unwinds only what it created on failure, never bypasses a failed insert) and rebuilds only
tracks whose graph state is genuinely absent or stale.

- Unit regression `ensureTracksPrepared preserves live native sessions…`: **15/15 pass**.
- Browser regression `preserves the running Mixer graph`, `--repeat-each=3`: **3/3 pass**.
  Transport position 0.357 s → 1.042 s → 5.101 s with `playing: true` throughout at 140 BPM;
  `tracksRebuiltDuringMonitoringInit: []`; monitored input RMS 0.1076; insert output after
  disable 4.7e-6; monitor snapshot `off`.

### Measured limitations that are NOT worked around

- **A browser cannot host a live native VST3 insert.** With a renderer-side stub, the worklet
  fails closed: `Native effect missed its real-time processing deadline; playback stopped
  rather than replaying stale PCM.` Bypass does not avoid it — the worklet submits every
  block regardless. Live native under active playback is verifiable only on packaged Windows.
- **Per-control transfer gain is not asserted during active playback.** The monitored
  producer and the project's instruments both enter the insert at `mixInput`, so the output
  tap is an unattributable mixture, and fake-device amplitude drifts between windows. Those
  checks remain asserted against a silent graph in `runLiveInputAcceptance`.
- **Insert leakage is not asserted during active playback.** `getMixerTrackPeak` reported
  0.21 for a bus carrying no audio before monitoring started, so it is not a trustworthy
  probe there; leakage remains asserted against a silent graph.

### Blocker C — Windows packaged acceptance: STILL UNRESOLVED

Desktop Validation failed on PR #307 at step 16 (packaged runtime smoke); the packaged
live-input step was skipped, so no `packaged-windows.json` exists. Annotation:
`Nonzero-latency dynamic live bypass changed alignment at input frame 24000: expected
1545952, onsets 0:1545952, 1:1546080, 2:1545952, masterSum comparedSamples 4096,
rmsDifference 3.3338905037320935e-10`. Baseline run 44724732627 passed, but runs 44506905887
and 44692385347 also failed at the smoke/verdict steps, so this step has a pre-existing
instability history. Local run remains `exit 3 / NOT_VERIFIED` (Linux).

No physical microphone, interface, or Windows machine is available here; physical round-trip
latency and real native plugin processing remain untested.
