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

### Blocker C — Windows packaged acceptance: CI now passing on `361dfb7`; artifact contents not read here

Desktop Validation run `44743629670` / job `136313240572` on `361dfb7` passes **5/5**
(`verify`, `audio-tests`, `Native DSP` ubuntu + windows, `windows-package`). Within the
Windows job, steps 16 (packaged runtime smoke), 17 (packaged live input PCM and recording
acceptance, fake microphone), 18 (upload live input evidence), 19 (native VST3 editor
acceptance) and 20 (packaged acceptance verdict) all report `success`, and artifact
`apex-packaged-live-input-evidence` (id 14632263159) was uploaded — none of which happened
on the previous failure.

**Not preclaimed:** the contents of `packaged-windows.json` were NOT read. Artifact and
job-log downloads redirect to `productionresultssa18.blob.core.windows.net`, outside this
sandbox's network allowlist, so both fail with EOF. Step conclusions and the artifact's
existence are confirmed via `api.github.com`; the monitor PCM, recording coexistence,
resource release, shutdown and reload-OFF fields inside the JSON are unverified here.
Step 17 is explicitly labelled "(fake microphone)", so it is not physical hardware evidence.
One passing run also does not by itself prove the smoke step is stable, given runs
44506905887 and 44692385347 failed there previously.

### Blocker C — previous Windows packaged failure (retained)

Desktop Validation failed on PR #307 at step 16 (packaged runtime smoke); the packaged
live-input step was skipped, so no `packaged-windows.json` exists. Annotation:
`Nonzero-latency dynamic live bypass changed alignment at input frame 24000: expected
1545952, onsets 0:1545952, 1:1546080, 2:1545952, masterSum comparedSamples 4096,
rmsDifference 3.3338905037320935e-10`. Baseline run 44724732627 passed, but runs 44506905887
and 44692385347 also failed at the smoke/verdict steps, so this step has a pre-existing
instability history. Local run remains `exit 3 / NOT_VERIFIED` (Linux).

No physical microphone, interface, or Windows machine is available here; physical round-trip
latency and real native plugin processing remain untested.

## Packaged native VST3 + live-input coexistence acceptance (post-`9d977b0`)

### The gap this closes

Renderer tests and simulated bridges cannot prove that a **real** native VST3 session —
already prepared and processing audio through the real Windows helper process while the
transport plays — survives live-input monitoring initialization on the same insert.
Everything verified so far ran either in a browser (no helper process) or against a
JavaScript stand-in for the plugin.

### New scenario

`scripts/packaged-native-monitoring-acceptance.mjs` (`npm run test:native-monitoring-packaged`),
wired into Desktop Validation as **Packaged native VST3 + live input coexistence
acceptance**, uploading `apex-packaged-native-monitoring-evidence`.

Real, not simulated:

- packaged Electron executable from `dist-electron/win-unpacked`;
- real `apex-vst3-host.exe` helper, read from the Windows process table (`tasklist`, with a
  `Get-CimInstance` fallback) rather than from the application's own claims;
- real native plugin from the MDA VST3 bundle (`mda RezFilter` preferred, `mda Delay` fallback),
  discovered through the packaged preload bridge;
- native insert created through the **real Mixer UI** (Mixer → insert 1 → Add Effect Plugin →
  Native VST3 Effect → plugin row);
- transport started through the **real transport control** `#fl-play-btn`, whose `aria-label`
  flipping to `Pause` is the playing indicator — so production code prepares the native session
  *before* monitoring, never after;
- monitoring enabled and disabled through the **real Mixer buttons**;
- native processing measured from production diagnostics that already existed: the main
  process's per-block `processAudio` timings (real native input/output RMS, per-block errors,
  `nativeServiceSessionCount`) and the renderer's native Mixer smoke events (worklet block
  submissions, `pending-deadline-miss`).

Ordering is the point of the test: the insert is prepared by `play()` and demonstrably
processing (`processedBlocks > 0`, non-silent `nativeOutputRmsMean`) **before** monitoring is
enabled. Session identity is the `runtimeId` prefix of `requestId` (minted per prepared native
session), plus the processing-node identity held in a `WeakMap`, so a re-prepare or a replaced
node is detected rather than assumed away.

Runs 5 times by default (`APEX_NATIVE_MONITORING_RUNS`). A failing run fails the acceptance and
stops the loop — no retry converts a failure into a pass.

### Instrumentation change (final implementation)

`APEX_SMOKE_TIMING_ONLY=1` turns on the same renderer native-processing measurements as
`APEX_SMOKE_TEST=1` through a **distinct** capability flag, so the built-in smoke sequence never
runs:

- `electron.cjs` appends `--apex-smoke-timing-only` for `APEX_SMOKE_TIMING_ONLY`, and appends
  `--apex-smoke-test` **only** for `APEX_SMOKE_TEST` (the reopen flag stays tied to that path).
- `preload.cjs` exposes `desktopApp.smokeTimings` from that argument and enables the `processAudio`
  measurements and `smokeTimingSnapshot`/`smokeTimingReset` for either capability.
- `src/audio/nativeVst3EffectRuntime.ts` records the Mixer effect timing events when
  `smokeTest === true || smokeTimings === true`.
- `src/audio/liveInputAcceptance.ts` reads the timing snapshot for either capability.
- `desktop-vst3.cjs` accepts either env flag for `smokeTimingEnabled`.
- `src/main.tsx` is unchanged in behaviour and still gated on `smokeTest` **alone**, so a
  timing-only session never launches `runDesktopVst3Smoke()`.

`APEX_SMOKE_TIMING_ONLY=1` therefore does **not** set `desktopApp.smokeTest`. The existing
`APEX_SMOKE_TEST=1` behaviour — `smokeTest`, the built-in sequence, and its `app.exit()` entry —
is unchanged. No production DSP or native lifecycle behaviour changes for either flag. The
acceptance asserts `smokeTimings === true` **and** `smokeTest === false`, so a regression that
re-enabled the built-in sequence would fail immediately rather than corrupt the measurement.

> **Superseded:** an earlier revision of this section stated that `electron.cjs` added
> `--apex-smoke-test` for either flag. That was the broken implementation and is the root cause
> documented below; it is retained only as history.

### Warmup: a mandatory precondition

After the transport starts, preparing the native session is asynchronous — the plugin is opened in
the helper process. The script therefore waits, up to 60 s, for the insert to be **prepared** and
for its **processed-block count to advance between two samples**, which together are what "already
prepared and actively processing" means.

That precondition is **mandatory**: the loop's outcome is recorded as `run.warmup.succeeded` and
asserted immediately. If the timeout expires without both conditions being met, the run fails at
the warmup with elapsed time, `prepared`, processed-block count, the prior count, runtime IDs,
deadline misses, native failure count and messages, the production native Mixer diagnostics, and
the renderer console errors. Monitoring is never enabled on an insert that was not proven prepared
and processing, and no retry is attempted.

### Probe measurement surface

`src/audio/liveInputAcceptance.ts` gained `armNativeVst3MonitoringCoexistenceProbe`,
`measureNativeVst3MonitoringCoexistence` and `disarmNativeVst3MonitoringCoexistenceProbe`,
exposed on `__apexAcceptance`. The probe installs a spy recording which Mixer tracks
`updateMixerTrack` is asked to rebuild, attaches read-only analyser taps to the insert's own
input and output, and feeds a deterministic buffer so native processing is provably non-silent.

The deterministic signal is **311 Hz / 659 Hz**, deliberately not 440 Hz: the fake capture
fixture is a 440 Hz sine, and two correlated tones sum phase-dependently, which would make
"monitored input is present" an unsound comparison. At 311/659 Hz the sources are uncorrelated,
so RMS combines in quadrature and the monitored contribution is a deterministic increase.

### Verification status — read this before trusting any of it

| check | result | where |
|---|---|---|
| `npm run lint` (tsc) | pass | this host |
| `npm run test:audio` | **2480 pass, 0 fail** (2478 before + 2 new) | this host |
| `npm run test:history` | **1283 pass, 0 fail** (unchanged) | this host |
| `npm run test:desktop-permissions` | **6 pass** (unchanged) | this host |
| `npm run verify:desktop` | pass | this host |
| `npm run build` | pass | this host |
| script syntax + Linux `NOT_VERIFIED` guard | pass, exit 3 | this host |
| **packaged Windows native coexistence run** | **PASS, 5 of 5 runs** | CI (windows-latest) |
| browser probe spec | pass (runs inside `verify` and `audio-tests`) | CI |

### Verified result

> **Read this with the intermittency section below.** `03ba06b` is the last commit on which the
> acceptance passed 5 of 5. The same code failed on `c0cd9a5`, `bb17b95` and `db1e4fa` — about
> 3 attempts in 8 — on a real-time deadline miss inside the helper's cold-start window. The
> scenario is therefore intermittent on shared CI hardware and is not a deterministic pass.

Commit `03ba06b`, Desktop Validation job `137201427772`, step **Packaged native VST3 + live
input coexistence acceptance** = `success`, **5 of 5 repetitions passed** with no retry (the loop
stops on the first failure), and all five checks on that commit are green. Evidence for run 1:

| measured | value |
| --- | --- |
| plugin fixture | `mda RezFilter`, class ID `5653546D6461466D64612072657A6669`, `D:\a\Apex-Studio\Apex-Studio\build\native-vst3\VST3\Release\mda-vst3.vst3` |
| native session runtime ids | `["944a1be4-f9ac-4dd9-b779-71d2821f50cb"]` — asserted identical before, during and after |
| native processing node | `vst3-fx-8c69cbcf-…-node-1` — asserted identical across all three stages |
| native processed blocks | 23 before → +79 during monitoring → +78 after disable |
| worklet submissions delta | 79 |
| transport position | 0.4393 s → 2.1273 s → 3.7860 s, playing at every stage |
| Mixer tracks rebuilt by monitoring init | `[]` |
| native deadline misses / block failures | 0 / 0 |
| helper processes leaked after shutdown | `[]`, application closed cleanly |
| physical hardware | `NOT_VERIFIED` — Chromium fake capture device, not a physical input |

So a real native VST3 insert, already prepared and processing through the real
`apex-vst3-host.exe` during playback, kept the same session and the same processing node,
kept processing more blocks, and kept the transport advancing while monitoring was enabled on
the same insert and then disabled — with no Mixer track rebuilt and no helper leaked.

Earlier commits carrying the same production code also passed 5 of 5: `bb330bb` (job
`137188089594`), `e43a6ae` (job `137171367296`) and `ff8e594` (job `137153027820`).

### An intermittent real-time deadline miss, caught by the mandatory warmup

The correction that makes the warmup mandatory was proven by CI to be load-bearing rather than
cosmetic — and it caught a genuine, recurring condition. It fired **twice**, on two different
commits whose code is identical to the passing ones.

**First occurrence, commit `c0cd9a5`** — repetition **1 of 5 passed**, repetition **2 failed at
stage `arm-probe`** with exactly the diagnostics the new assertion was written to produce:

```
Warmup timed out: waitedMs=60103 of 60000 prepared=false processedBlocks=2 priorBlocks=2
runtimeIds=["6a71bb16-4722-4114-91c0-994e37252459"] deadlineMisses=1 nativeFailures=0
failureMessages=[] nativeDiagnostics=[{"trackId":1,"slotId":"vst3-fx-7d4ef902-…",
"message":"Native effect missed its real-time processing deadline; playback stopped rather
than replaying stale PCM."}] rendererConsoleErrors=[]
```

This is the product's own fail-closed guard: the native effect missed its real-time processing
deadline, so playback stopped rather than replaying stale PCM. With playback stopped nothing can
advance, so the processed-block count stayed at 2 for the whole 60 s and the insert was correctly
reported as not prepared.

**Second occurrence, commit `bb17b95`** (job `137194720433`), same signature:
`waitedMs=60114 of 60000`, `prepared=false`, `processedBlocks=3`, `priorBlocks=3`,
`deadlineMisses=1`, `nativeFailures=0`, `failureMessages=[]`, same production diagnostic.

**Where the guard lives.** `src/audio/nativeVst3EffectRuntime.ts:218` fails closed when a
1024-frame block fills while the previous block's native result is still `pending`, so a single
slow `processAudio` round-trip through `apex-vst3-host.exe` stops playback. Both occurrences were
at `processedBlocks` 2 and 3, i.e. inside the first ~64 ms of playback while the helper is still
cold. The script clicks Play and arms the probe back to back (lines 354–366, no wait between
them), which is exactly that window. This is production real-time behaviour on a shared
`windows-latest` runner, not a defect introduced here, and the harness ordering was **not**
changed to dodge it.

**Third occurrence, commit `db1e4fa`** (job `137208328702`), same signature
again: `waitedMs=60000 of 60000`, `prepared=false`, `processedBlocks=2`, `priorBlocks=2`,
`deadlineMisses=1`, `nativeFailures=0`, `failureMessages=[]`, same production diagnostic.

**Observed rate, recorded honestly.** Since the launch-flag root-cause fix the acceptance has been
executed **8 times: 5 passed 5 of 5** (`ff8e594`, `5f77fde`, `e43a6ae`, `bb330bb`, `03ba06b`) and
**3 failed** on this early deadline miss (`c0cd9a5`, `bb17b95`, `db1e4fa`) — about **3 in 8**. One
further attempt (`7d480ba`) never reached the acceptance because step 16 flaked and skipped steps
19–22.

This means the honest verdict for the scenario is **not** a deterministic pass. A green 5 of 5 on a
given commit is real and was measured five times, but the acceptance fails roughly one time in
three on shared `windows-latest` hardware because the packaged application's own fail-closed guard
trips inside the helper's cold-start window. This document does not present the green runs as
proof of reliability, and no green run was selected by re-rolling until one appeared: every
failure is recorded here with its job id.

**The correction did not introduce this.** The script already asserted `deadlineMisses === 0`
(line 529) and `prepared === true` in the baseline assertions, so this condition failed the run
before the correction as well — it only surfaced much later, at the assertions stage, as the
opaque `not prepared … false !== true` that this document records as harness defect 6. The
correction moves the same failure to the warmup, with elapsed time, both block counts, the
runtime IDs, the deadline-miss count and the production diagnostic attached.

No assertion was weakened and no retry was added to absorb it: a repetition that misses a
real-time deadline is a failed repetition, and the acceptance stops there. The next CI run on the
identical tree passed 5 of 5, so this is an intermittent real-time scheduling sensitivity of the
packaged application on a shared `windows-latest` runner, not a deterministic defect. It is
recorded here as an observed intermittent failure rather than being hidden.

### Root cause of the intermittent failures

Three earlier commits passed 5 of 5 and then the **byte-identical** code failed
(`git diff 41e0924 608adaf`, `git diff 5dae1be e1b6f53` and `git diff 44bb180 c1fde0f` each touch
only docs). All of those failures had one cause, in the harness's launch configuration rather
than in the native lifecycle:

`src/main.tsx` runs the built-in native VST3 smoke sequence (`runDesktopVst3Smoke`) whenever
`desktopApp.smokeTest` is true. `APEX_SMOKE_TIMING_ONLY=1` was implemented by appending
`--apex-smoke-test`, which sets exactly that flag — so the built-in sequence ran concurrently
with this acceptance, creating its own Mixer inserts on track 1, driving the transport and
opening extra native sessions and helper processes.

The decisive evidence was a preparation failure reporting `transportPlaying=false` and
`positionSeconds=0` *after* the transport had been started, `deadlineMisses=1`, and native
diagnostics for slots this script never created: `smoke-delay`, `smoke-delay-bypass`,
`smoke-rezfilter`, `persisted-delay`, `persisted-rezfilter`, `latency-two-delay`,
`latency-two-filter`. That also accounts for the session gauge reading 3, 2 and 0, and the
helper PID list `[2428, 3880, 8580]`.

Fixed by giving the timing instrumentation its own capability flag
(`--apex-smoke-timing-only` → `desktopApp.smokeTimings`) in `electron.cjs`, `preload.cjs`,
`nativeVst3EffectRuntime.ts` and `liveInputAcceptance.ts`, leaving `src/main.tsx` gated on
`smokeTest` alone so a timing-only session never runs the sequence. The existing
`APEX_SMOKE_TEST=1` path and its `app.exit()` entry are untouched. The acceptance now asserts
`smokeTimings === true` **and** `smokeTest === false`, so this cannot silently regress. After the
fix, 5 of 5 runs passed with `deadlineMisses: 0`.

**Correction to an earlier claim in this document:** the unstable session gauge and helper PID
list were attributed to short-lived `inspectEffect` sessions from the picker. That attribution
was incomplete and is superseded by the root cause above. Two assertions were nevertheless
changed and remain changed, because exact equality on either collection is not a property this
scenario requires: the session gauge is now recorded with a no-leak check (the count after
monitoring must not exceed the baseline), and no helper PID may appear that was absent at
baseline with at least one required to remain alive. Neither can hide an unprepared or crashed
insert, which the `prepared`, node-present, processed-block, runtime-id and node-id assertions
independently require.

### Defects this scenario caught in its own harness

Seven were found and fixed while bringing it up; none of them were in the native lifecycle. The
first four were found on the way to the first 5-of-5 pass on `41e0924`; the last three were found
when the identical code then failed intermittently (proven identical: `git diff 41e0924 608adaf`
touches only two files under `docs/evidence/phase11/`). Items 6 and 7 record assertions this
harness had added for itself and then had to replace, because exact equality on either collection
is not a property the scenario requires — the properties that are required are asserted
independently and remain in force.

1. **Wrong Mixer track.** The harness clicked the `#mixer-strip-1` container. Its centre is the
   volume fader, whose `onClick` calls `stopPropagation`, so `onSelectTrack` never fired and
   `selectedTrackId` stayed at its default `0` (`// 0 = Master`). The insert was created on
   Master and insert 1 never gained a slot. Recorded proof: the FX panel header read
   `FX SLOTS (MASTER)` before and `FX SLOTS (KICK / 808)` after clicking the `INS 1` label.
   Selection now goes through the `INS 1` label and asserts the header changed.
2. **Discovery collision.** The harness pre-scanned before opening the picker. `Vst3Service`
   serializes discovery per owner (`native/vst3/service.mjs:59`) and rejects an overlap, so the
   picker reported `Scan failed: … A VST3 scan is already running` and listed nothing. The
   picker now owns the only pre-insert scan.
3. **Probe spec scoping.** `liveInputMonitoringCoexistenceProbe.spec.ts` called a module-scope
   helper inside `page.evaluate`, which Playwright cannot serialize; it failed in CI with
   `ReferenceError: surface is not defined`. The window access is now inlined.
4. **Baseline read too early.** A fixed 1500 ms delay preceded the baseline, but preparing a
   native session is asynchronous; one run in five measured `prepared === false`. It now waits
   until the insert is prepared *and* its processed-block count advances, bounded at 60 s. No
   assertion was relaxed and no retry was added.

5. **Identity read collided with an application scan.** The extra discovery made only to record
   the fixture's class ID and path failed intermittently with `A VST3 scan is already running`.
   That call now waits the scan out — bounded at 60 s, only for that exact error, with attempts
   and wait recorded. A transient of the discovery API, not an assertion about the scenario.
6. **Unstable session-count baseline.** Observed `before=3 during=1 afterDisable=1`, then
   `before=1 during=2`, then `before=2 during=1 afterDisable=1` — the last on code proven
   byte-identical to a 5-of-5 pass (`git diff 5dae1be e1b6f53` touches only docs). Short-lived
   sessions are counted in `sessionCount`, a live gauge of open + pending + closing sessions
   (`native/vst3/service.mjs:41`), so an early baseline measured teardown in progress rather than
   anything monitoring did. The dominant source turned out to be the concurrent built-in smoke
   sequence (see the root cause above); `inspectEffect` sessions were a secondary contributor.
   **Two remedies were tried and both superseded:** requiring the count to be unchanged between
   two consecutive samples, and pinning the baseline to exactly `1`. Neither held, because the
   gauge legitimately moves for reasons this scenario does not own.
   **Final implementation:** the gauge is *not* an equality invariant. All three readings are
   recorded, and the assertion is the directional no-leak property the scenario actually requires —
   the count after monitoring is disabled must not exceed the baseline. The harness identity read
   also no longer calls `inspectEffect` (discovery alone gives name, class ID and path and opens no
   session). The insert's own liveness is asserted separately and soundly: `prepared === true`, a
   processing node present, processed blocks advancing, one unchanged runtime ID and one unchanged
   node ID.
7. **Helper PID list compared for exact equality.** A baseline snapshot legitimately holds
   short-lived `apex-vst3-host.exe` processes spawned by discovery and `inspectEffect`, which exit
   on their own (observed `[2428, 3880, 8580]` before monitoring and `[3880]` during, with the
   insert's own helper present throughout). **Final implementation:** no helper PID may appear that
   was absent at baseline — which is what a crash or restart would actually produce — and at least
   one helper must be alive during monitoring and after it is disabled. All three PID lists remain
   in the evidence. A dead helper would also stop the insert processing, which the processed-block
   and identity assertions already require.

**Product observation, deliberately not fixed here (out of scope):** a user who opens the VST3
picker while any discovery scan is in flight gets that same permanent `Scan failed` state with
no retry. Reported for the Lead Engineer.

This host is Linux, so the packaged run was never executed locally; the script still exits
`3 / NOT_VERIFIED` here. CI is its only execution, and the numbers above are CI's.

### Limits of this scenario even when it passes

- The microphone is Chromium's fake capture fixture. Not a physical microphone; proves nothing
  about physical round-trip latency.
- The audio reaching the insert is a deterministic buffer at the insert input, the same
  mechanism the packaged Mixer acceptance uses. The plugin session and its processing are real;
  the source is not a physical instrument performance.

## Native VST3 cold-start deadline: measured decomposition

This section is separate from the harness root cause above, which is resolved. What follows is a
**real production defect** in the packaged application, still open, and the timing evidence
gathered so far. Nothing here was inferred from the deadline counter alone.

### The budget

`src/audio/nativeVst3EffectRuntime.ts` uses `VST3_FX_BLOCK_FRAMES = 1024` and
`VST3_FX_PIPELINE_FRAMES = 2048`. Block *N* is submitted at input frame `(N+1)*1024` and is needed
at output frame `2048 + N*1024`, so the slack is exactly one block: **21.33 ms at 48 kHz**. The
guard at `:218` fails closed when a block fills while the previous block's result is still
`pending`. That guard is correct and has not been weakened.

### First complete decomposition — job `137623128829`, commit `68cdd20`

The 5-repetition gating acceptance passed 5/5 (tightest margin +4.33 ms). The 60-repetition
non-gating diagnostic then ran for the first time and **reproduced the miss: 36 PASS / 1 FAIL of
37 attempts**, stopping at the failure. A green gate therefore does *not* mean the defect is gone.

Failing block, repetition 37, helper pid 7060, `missedSequences [2]`, budget 21.33 ms:

| span | seq 0 | seq 1 | **seq 2 (miss)** |
|---|---|---|---|
| renderer → main | 0.68 | −0.73 | 0.52 |
| helper queue wait | 0.14 | 0.05 | 0.08 |
| request serialize | 0.09 | 0.02 | 0.03 |
| pipe + OS schedule | 2.36 | 2.80 | 2.92 |
| helper decode | 0.09 | 0.12 | 0.13 |
| helper `Instance::process()` | 2.19 | 2.17 | **14.15** |
| response frame parse | 0.89 | 0.41 | 0.48 |
| main → renderer | 3.97 | 5.25 | 5.87 |
| main event-loop lag in block | — | — | **8.44** |
| **total / margin** | 10 / +11.33 | 9 / +12.33 | **23 / −1.67** |

Ruled out by measurement, with numbers: helper spawn (spawn→protocol bind 0.02 ms), plug-in load
and init (first-request round trip 32.01 ms, constructed→open 35.10 ms, both inside preparation,
which transport start awaits before playback), IPC serialization (0.03 ms), JSON/base64 decode
(0.13 ms), serial-queue wait (0.08 ms), frame parse (0.48 ms), renderer→main (0.52 ms).

What remains is **two contributors that each fit the budget alone and exceed it together**: the
helper's per-block `Instance::process()` at roughly 6.5× its ~2.2 ms steady state, plus an 8.44 ms
main-thread stall that inflated main→renderer to 5.87 ms.

**Correction to the 14.15 ms figure.** At the time it was reported as
`helperPluginProcessMs`, which measured the *whole* of `Instance::process()`. That span is host
work — base64/PCM decode, parameter queues, output-buffer clearing, `ProcessContext` preparation,
input-buffer setup, then output validation and PCM extraction — wrapped around one call to
`processor->process(data)`. It must not be read as plug-in execution time. Commit `0de0280`
splits it into `helperHostPrepareMs`, `helperPluginCallbackMs` and `helperHostCollectMs`, which
partition `helperInstanceProcessMs`; the field was renamed rather than left under a misleading
name.

> **SUPERSEDED.** This paragraph originally ended "the split of that 14.15 ms between host and
> plug-in is not yet measured." It has since been measured — see *The host/plug-in split is now
> measured* below. The plug-in callback was 0.02–0.03 ms; the time was host work.

### A second, different signature

Job `137584706432` (commit `7850c3a`), repetition 4, failed at **sequence 117** — about 2.5 s into
playback, around where live-input monitoring is enabled — while all 24 recorded blocks were
healthy (worst margin +4.33 ms). This is not a cold-start failure. It has not recurred since, and
no decomposition exists for it. A fix aimed only at cold start would not address it. A failing
repetition now takes a fresh measurement before shutdown, so the next occurrence will be captured
with its own sequence instead of being described by healthy blocks 0–2.

### Still NOT VERIFIED

- The host/plug-in split of the ~14 ms block.
- Whether the mid-session (sequence 117) signature recurs, and its cause.
- Physical hardware: the microphone is Chromium's fake capture fixture and the insert input is a
  deterministic buffer. Neither is a physical instrument or microphone.
- Evidence-artifact contents: the zips redirect to blob storage outside this environment's
  allowlist, so only the annotations were read.

No production fix has been made. The pre-warm hypothesis is *supported* by the distribution —
blocks 0–2 carry the tail while blocks 3+ stay under 2.8 ms — but it is not proven, and it would
not address the mid-session signature.

### The host/plug-in split is now measured — the plug-in is not the cause

Job `137675627991`, commit `1803ac2`. The gating acceptance passed 5/5. The diagnostic attempted
**all 60** repetitions (48.5 min) and recorded **50 PASS / 10 FAIL**; `helperProcessesLeakedAfterShutdown`
was empty, so every helper was reclaimed.

**Read the failure rate carefully.** 10 of 60 repetitions failed the *complete acceptance
scenario*, which is about 1 in 6 — materially worse than the ~1-in-12 estimated from smaller
samples. But these are **not all cold-start failures**. Of the eight failures whose detail
survived, the guard-named sequences were 0, 2, 2, 2, 3, 3, 57 and 149: six in the cold window and
**two well past it** (sequence 57 ≈ 1.2 s, sequence 149 ≈ 3.2 s). One repetition also failed at
stage `disable-monitoring` on a Playwright click timeout, which is a consequence of playback having
already stopped rather than an independent defect. Quoting "10 cold-start failures in 60" would
overstate the cold-start rate and hide the mid-session population.

The missed block in each of the eight failures whose detail survived, in ms:

| run | missed seq | total | margin | inst | prep | **cb** | coll | pipe | mainToR | lag |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 57 | 22 | −0.67 | 13.48 | 13.26 | **0.03** | 0.18 | 5.49 | 0.23 | — |
| 11 | 2 | 25 | −3.67 | 6.93 | 6.73 | **0.02** | 0.18 | 14.28 | 2.03 | 4.30 |
| 14 | 3 | 22 | −0.67 | 4.52 | 4.33 | **0.02** | 0.17 | 5.54 | 2.26 | 5.60 |
| 16 | 3 | 22 | −0.67 | 2.19 | 2.09 | **0.02** | 0.08 | 2.27 | 2.65 | — |
| 21 | 149 | 20 | +1.33 | 2.37 | 2.17 | **0.03** | 0.17 | 8.36 | 4.63 | 10.48 |
| 22 | 2 | 21 | +0.33 | 12.69 | 12.59 | **0.02** | 0.08 | 4.00 | 5.50 | 9.26 |
| 23 | 0 | 27 | −5.67 | 9.43 | 1.73 | **0.02** | 7.68 | 2.34 | 9.71 | 4.08 |
| 47 | 2 | 20 | +1.33 | 1.36 | 1.19 | **0.02** | 0.15 | 15.85 | 0.22 | 8.62 |

`cb` is `helperPluginCallbackMs`, the exact `processor->process(data)` call. **It never exceeds
0.03 ms, in a failing block or in any neighbour.** The plug-in is exonerated. The 14.15 ms
previously reported as plug-in time was host work, exactly as the rename warned.

There is no single contributor. Across the eight: host preparation spikes to 13.26 and 12.59 ms;
host output collection spikes to 7.68 ms; pipe plus OS scheduling spikes to 15.85 and 14.28 ms;
main→renderer spikes to 9.71 ms; main-thread event-loop lag reaches 10.48 ms. The miss is a
scheduling/contention problem spread across the helper process and the main process, not one slow
component.

**Mid-session misses are common, not a one-off.** The missed sequences are 0, 2, 2, 2, 3, 3, 57
and 149. Two of the eight happened well after the cold window — sequence 57 (~1.2 s) and 149
(~3.2 s) — confirming that the sequence-117 signature seen earlier recurs. A cold-start-only fix
would not address them.

**The three positive-margin misses are UNVERIFIED — and were probably a measurement defect.**
Three of the eight named blocks showed a non-negative margin (+1.33, +0.33, +1.33 ms): the recorded
round trip appeared to finish *inside* the 21.33 ms budget while the guard still reported
`pending-deadline-miss` for that sequence.

That has since been explained as an artefact of the extractor, not a property of the audio path.
It stored a timestamp for every `worklet-result` event keyed by sequence alone and never checked
the `accepted` flag the worklet reports — and the worklet stamps `acceptedAtEpochMs` *before* it
computes `valid`. So a result the worklet had **rejected** (arriving after the fail-closed guard
fired) still supplied a timestamp, and therefore a round trip and a positive margin, for a block
that never completed in time. A positive margin on a missed block was never physically meaningful.

The correlation is now gated on `accepted === true` and joined on `requestId`, so a rejected result
can no longer produce a measurement. **These three margins must not be cited until they have been
re-measured under the corrected correlation**; their status is unverified, and a miss may only be
called a positive-margin miss if the result was genuinely accepted.

**One failure-path capture gap, recorded as designed.** Run 21 failed at stage `disable-monitoring`;
its failure-time capture reported `failureCaptureError: "page.evaluate: Error: Arm the native
coexistence probe before measuring."` because the probe had been disarmed. The original error was
preserved and the `afterMonitoring` snapshot was used instead, which is the intended fallback — but
a failure after the probe is disarmed still cannot take a fresh measurement.

### Corrected acceptance correlation, and wall time versus helper-thread CPU time

Two evidence-quality defects were found in the analysis above and corrected. Neither changes
production audio behaviour.

**1. Round-trip evidence was not gated on acceptance.** The extractor recorded a timestamp for
every `worklet-result` event, keyed by sequence number alone, and never read the `accepted` flag
the worklet already reports. Because the worklet stamps `acceptedAtEpochMs` *before* computing
`valid`, a result it had **rejected** still supplied a timestamp — and therefore a round trip and a
deadline margin. Sequence-only keying could also join two runtime generations, since the counter
restarts at zero when the worklet is recreated.

`src/audio/workletResultCorrelation.ts` now joins on `requestId` (`runtimeId:sequence`) and takes
acceptance only from `accepted === true`. Rejected, late, stale, duplicate, malformed and
unattributable results are preserved as separate evidence with their frame positions and can never
yield an accepted round trip or a margin. Every decomposed block carries `resultAccepted`,
`resultRejectionReasons`, `rejectedResults` and `runtimeGeneration`; `totalRoundTripMs` and
`marginMs` are null unless the worklet genuinely accepted that exact request. Every run also reports
`workletResultsAccepted`, `workletResultsRejected` and `workletResultsUnattributable`.

**2. Wall time was reported as though it were CPU time.** A 13 ms host-preparation span does not
prove 13 ms of executed code; it is equally consistent with the thread being descheduled. Every
helper span is now measured on two clocks: `*Ms` (steady_clock wall time, includes descheduling)
and `*CpuMs` (per-thread CPU — `GetThreadTimes` on Windows, `CLOCK_THREAD_CPUTIME_ID` on POSIX).
Their difference is contention rather than expensive code. The CPU figures cover the helper thread
only; a plug-in with its own worker threads would account their CPU elsewhere. An unsupported clock
reports `-1`, never `0`, so "not measured" cannot be read as "free".

The C++ unit test demonstrates the distinction directly: a 30 ms injected sleep reports
**wall prepare 30.22 ms against CPU prepare 0.07 ms**, while genuine arithmetic reports
**13.04 ms of each**. A sleep therefore cannot masquerade as CPU consumption, and real work cannot
hide.

**Both guards keep their own frame positions.** `pending-deadline-miss` now also reports
`pendingSequence`, `readySequences` and `drySequences`, matching the vocabulary of `deadline-miss`.
The two are normalised without being conflated, unreported fields stay null, and each miss is
labelled `cold` or `mid-session` using a boundary taken from measurement (the round-trip tail sits
in blocks 0–2, so sequence ≤ 3 counts as cold).

### What is still needed before any conclusion

The corrected correlation has **not yet been exercised by a packaged run**. Until it has:

- no miss may be described as a positive-margin miss;
- the three previously reported positive-margin cases remain unverified and are probably artefacts;
- the cold/mid-session split of 6 : 2 stands only for the eight failures whose detail survived, not
  for all ten.

The next diagnostic must report, per failure: the result acceptance status, the timing labelled
accepted or rejected, and the wall/CPU/wall-minus-CPU triple for each helper span.

### Corrected correlation measured on a packaged run — job `137787023086`, commit `d960d11`

Gating acceptance **5/5 PASS**. The diagnostic attempted **all 60** repetitions (41.8 min):
**59 PASS / 1 FAIL**. Every passing repetition reported `workletResultsAccepted: 181`,
`workletResultsRejected: 0`, `workletResultsUnattributable: 0`.

The single failure (repetition 51, helper pid 8576) is the clearest possible demonstration of the
defect that was corrected:

```
resultsAccepted = 1   resultsRejected = 1   resultsUnattributable = 0
guard  = pending-deadline-miss   sequence 1   phase cold
         currentOutputFrame 2944  dueOutputFrame 3072  nextSequence 2
         inputContextFrame 1735167  readySequences [0]  drySequences [0, 1]
block seq 1: accepted=FALSE  totalRoundTripMs=null  marginMs=null
             inst 1.71  prep 1.58  cb 0.02  coll 0.11  pipe 1.91  lagInBlock 2.42
             rejection: reason "after-failure"  receivedOutputFrame 3072
                        dueOutputFrame 3072  roundTripMs 19
block seq 0: accepted=TRUE   totalRoundTripMs 5  marginMs +16.33
```

Under the previous extractor this block carried `roundTripMs 19`, which against the 21.33 ms budget
reads as a **+2.33 ms margin on a block that missed its deadline**. The corrected extractor reports
`total=null, margin=null, accepted=false`, and keeps the 19 ms visible only as rejection evidence
with its frame positions. The run's `worstMarginMs` is +16.33 — a failing run whose every *accepted*
block was comfortable, which is the honest reading: it failed because a block was never accepted,
not because an accepted block was slow.

The plug-in callback remains ≤0.03 ms throughout, accepted and rejected alike.

### The CPU-time split does not resolve at this granularity on Windows

`helperCpuTimingSupported` was `true`, and every CPU span read **0**, against wall spans of 0.96–1.85
ms. The mechanism is correct — the C++ unit test on Linux measures a 30 ms injected sleep as
**0.07 ms of CPU** and genuine arithmetic as **13.04 ms wall / 13.04 ms CPU** — so the observable
fact is that Windows' per-thread CPU accounting is far coarser than the spans being measured.
`GetThreadTimes` advances at the system clock interrupt (nominally 15.625 ms), so a 1–2 ms span
usually accumulates no measurable tick at all.

Two consequences, stated plainly:

- **A CPU value of 0 here means "below the clock's resolution", not "no CPU was used."** That is
  exactly the fabrication the design tried to avoid, and `cpuTimingSupported: true` makes it worse by
  implying the number is meaningful.
- **The question this split was meant to answer — whether the 13 ms host-preparation spans were
  executing code or waiting to be scheduled — is still not answered.** Resolving it needs either an
  aggregate over many blocks, a higher-resolution CPU source, or measurement of the spans that are
  actually large enough to see.

This is recorded as a limitation of the instrumentation, not as a result.

## Independent review round 2 (post-`25442d66`)

Started from `25442d6611b784ddf74b4f54d3169078a0a7f534`; this section describes `d5155d2`. Nothing
above is restated as new: where a result belongs to an earlier commit it is named as such, and the
historical `d960d11` run stays separated from anything measured at this HEAD.

### 1. The correlation invariant is now complete

`src/audio/workletResultCorrelation.ts` previously checked the event type, `accepted`, and a
well-formed `requestId`. It did **not** check that `event.sequence` agreed with the sequence encoded
in that `requestId`, that `pendingSequence` equalled the sequence, or that the main-process record's
sequence agreed with its own `requestId`. An accepted measurement now has to satisfy every link:

| Link | Failure reason recorded |
|---|---|
| event is `worklet-result` | (not a result event: ignored) |
| `accepted === true` | `not-accepted` |
| `requestId` present and well formed (`runtimeId:sequence`) | `request-id-missing`, `request-id-malformed` |
| `event.sequence` present | `sequence-missing` |
| `event.sequence` equals the `requestId`'s sequence | `sequence-disagrees-with-request-id` |
| `pendingSequence === sequence` | `pending-sequence-mismatch` |
| the record's sequence equals its `requestId`'s | `sequence-disagrees-with-request-id` |
| not already accepted for this generation | `duplicate-accepted` |

Rejected and unattributable evidence is preserved with its reason and its timings; `totalRoundTripMs`
and `marginMs` stay `null` unless the chain held. `rejectionReasons` gives aggregate counts, and
`liveInputAcceptance.ts` surfaces `workletResultRejectionReasons` plus a per-rejection
`correlationReason`. Nothing infers acceptance from a timestamp, and sequence numbers are never
compared across runtime generations.

**The test the review called insufficient is gone.** The old "wrong pending sequence" case supplied an
event already carrying `accepted: false`, so the mismatch itself was never exercised — it tested the
`not-accepted` branch twice. It is replaced by an event with `accepted: true`, `sequence: 3` and
`pendingSequence: 7`, which now fails on the mismatch and is expected to yield
`correlationReason: 'pending-sequence-mismatch'` with no round trip or margin, while its round trip
is still preserved as rejection evidence. Added alongside it: a `requestId` encoding sequence 2
against `event.sequence` 5; a record whose sequence 9 disagrees with its `requestId`'s 2; five
malformed or absent identities, all unattributable; and a valid accepted event asserting the exact
`rejectionReasons` map.

### 2. The cold-start timing failure was a fixture defect

CI run `45204030419` ("Apex Studio CI", head `25442d6`), job `137794777635`, failed at step 7,
"Native helper cold-start timing attribution", on the assertion at
`tests/nativeHelperColdStartTimings.test.mjs:253` that the helper instance total cannot exceed the
round trip containing it. Its annotations carried only `Process completed with exit code 1`, so the
cause was established by reading the fixture and the client, not from CI detail.

The fake helper reported `helperInstanceProcessMs` by echoing the constant it had been told to sleep
for — `instanceMs = 60` — while `helperRoundTripMs` was genuinely measured as
`responseAtMs - writeAtMs`, with `writeAtMs` stamped before the write. The neighbouring assertion
only required the round trip to be at least 55 ms. So any run landing between 55 and 60 ms failed
line 253: a real measurement of the container was being compared against a fabricated measurement of
its contents. **A fixture defect** — not a measurement defect in the instrumentation, and not an
invalid test assumption: the invariant itself is correct and worth keeping.

It did not reproduce locally: 15 consecutive runs under six competing busy loops passed 15/15, which
is consistent with a boundary that only a slower runner crosses.

The fix measures instead of asserting. The helper now times its three stages with
`performance.now()` — prepare 20 ms, callback 35 ms, collect 5 ms — and the assertions require each
stage to be at least its injected duration, plus a distinctness check so a fixture that collapsed the
stages would fail. A failure now prints `helperInstanceProcessMs`, `helperRoundTripMs`, `writeAtMs`,
`responseAtMs`, `helperRequestLineReadAtMs` and `helperRepliedAtMs`. No timeout was raised, no
assertion was removed, and none was weakened: the container-contains-contents comparison at line 253
still runs, now against two measured values.

### 3. The 60-run diagnostic now runs after a gate failure

`.github/workflows/desktop-validation.yml` conditioned the diagnostic on `runner.os == 'Windows'`
alone. In GitHub Actions a step with no explicit `if` inherits `success()`, so when the five-run gate
failed the job ended and the diagnostic was skipped — it never ran in the one situation it exists
for. The condition is now
`!cancelled() && runner.os == 'Windows' && steps.windows-package-dir.outcome == 'success' && steps.native-helper-build.outcome == 'success'`,
which runs after a failed gate but not when there is nothing to measure or the run was cancelled.

Preserved: the gate stays fail-fast at 5 repetitions with no `continue-on-error`; the diagnostic
attempts all 60 with `APEX_NATIVE_MONITORING_CONTINUE_AFTER_FAILURE: '1'` and stays
`continue-on-error: true`; no repetition is retried, re-rolled or counted twice. A job's conclusion
reflects every step that ran without `continue-on-error`, so the gate alone can still fail the job and
the diagnostic cannot undo that — and the two verdicts are now printed by separate steps so they are
never conflated. `tests/ciDiagnosticWorkflow.test.mjs` evaluates the workflow's own condition
expression against six scenarios, including the gate-failed case; reverting the condition to the
OS-only form makes it fail, which is how the test was shown to be load-bearing.

Two evidence defects were found while doing this and are fixed. The acceptance script wrote its
evidence under the **packaged resources tree**, while the upload step read the repository's
`build/native-monitoring-evidence`, so the coexistence evidence the upload found was not the evidence
the run produced; the directory is now passed in explicitly and absolutely. And the gate's evidence
was uploaded *before* the diagnostic ran, so the diagnostic's 60-run evidence never reached an
artifact at all and would have overwritten the gate's. The diagnostic now writes
`build/native-diagnostic-evidence`, uploaded by its own step, `if: always()`, after it runs.

### 4. The CPU evidence now distinguishes what it actually saw

`helperCpuTimingSupported` alone could not separate "the platform has no per-thread CPU clock" from
"the clock exists but never advanced during this span". Two fields are added and plumbed from
`process-timings.hpp` through `host.cpp`, `client.mjs`, `desktop-vst3.cjs` and
`liveInputAcceptance.ts`:

- `helperCpuClockTickObserved` — true only when the per-thread CPU clock was seen to advance during
  the block. False with a supported clock means the span was shorter than one clock step: the CPU time
  is **unknown, below one step**, not zero.
- `helperCpuClockObservedStepMs` — the smallest advance measured by a one-time startup calibration,
  run before any plug-in instance exists and never inside `Instance::process()`, where a busy-wait
  would sit inside the span being measured.

The three states are counted separately in the aggregate annotation by
`scripts/lib/cpuObservation.mjs` (`clockUnavailable` / `noClockTick` / `positiveCpuDelta`, plus
`cpuFieldNull` for absent or sentinel readings), each block landing in exactly one. The observed step
is reported as an observation of how the clock steps and is explicitly **not** the clock's exact
resolution — nothing measures that. On Linux the calibration observes a step of about 0.0005–0.009 ms,
which is why the same code measures a 30 ms injected sleep as 0.07 ms of CPU there while Windows reads
0 for 1–2 ms spans.

Stated limits, carried in the evidence text itself: these are **helper-thread** CPU times, so a
plug-in running its own worker threads would account that CPU elsewhere; the helper-versus-scheduling
question remains **unanswered**; and no audio scheduling or production processing decision may use
these measurements.

**A build break introduced here, found by CI and fixed.** The calibration variable was first inserted
immediately before `Instance::process`, which put it inside the class body. `host.cpp` cannot be
compiled in this sandbox — it needs the VST3 SDK headers only the Windows job fetches — so the error
surfaced only there: MSVC `C2864` (a static data member with an in-class initializer) at
`native/vst3/host.cpp:556`, plus `C2065` undeclared identifier in `main()`. That is CI run
`45341794270`, job `138266934206`, step 10 `Validate Windows package`. The declaration now sits at file
scope, ahead of `class Instance`, and `tests/nativeHostFileScope.test.mjs` asserts that locally via a
brace-depth reader: re-inserting it into the class body fails two of its four tests. The reader is a
brace counter that skips `//` comments and string literals, not a C++ parser; it answers only the
scope question it is used for.

That run also exercised the diagnostic condition correctly: with step 10 failed, the diagnostic's
`steps.windows-package-dir.outcome == 'success'` was false, so it was skipped rather than running
against a package that does not exist, while the new verdict and evidence-upload steps still ran
(`if: always()`), and the job concluded `failure` on the gating step.

### Local results at `d5155d2`

| Command | Result |
|---|---|
| `npm run lint` | pass, no output |
| `npm run test:native-cold-start` | 44/44 pass, 0 fail |
| `npm run test:native-timings-cpp` | all checks passed |
| `npm run test:audio` | 2507/2507 pass, `Orphaned: 0` (344 files) |
| `npm run test:history` | 1283/1283 pass, `Orphaned: 0` |
| `npm run verify:desktop` | pass |
| `npm run build` | pass, built in 6.30 s |

Files changed: `.github/workflows/desktop-validation.yml`, `desktop-vst3.cjs`,
`native/vst3/client.mjs`, `native/vst3/host.cpp`, `native/vst3/process-timings.hpp`,
`native/vst3/tests/process-timings.test.cpp`, `package.json`,
`scripts/packaged-native-monitoring-acceptance.mjs`, `scripts/lib/cpuObservation.mjs` (new),
`scripts/lib/cppScopeDepth.mjs` (new),
`src/audio/liveInputAcceptance.ts`, `src/audio/workletResultCorrelation.ts`,
`src/audio/workletResultCorrelation.test.ts`, `tests/nativeHelperColdStartTimings.test.mjs`,
`tests/ciDiagnosticWorkflow.test.mjs` (new), `tests/cpuObservation.test.mjs` (new),
`tests/nativeHostFileScope.test.mjs` (new).

Not changed: the fail-closed guards (`pending-deadline-miss`, `deadline-miss`), block size, fixed
latency and buffering, bypass, queue, serialization and transport. No production audio behaviour was
modified, and the native processing path was not optimised.

### CI results

Two pushes were needed. At `d5155d2` the helper build broke on Windows and Ubuntu alike (the
file-scope defect above); that is CI run `45341794270` and run `45341794311`. At `7de4599`:

| Workflow | Run | Result |
|---|---|---|
| Apex Studio CI | `45343389633` | success |
| Audio Validation | `45343389611` | success |
| Native VST3 Validation | `45343389620` | success |
| P9 High-DPI Editor Acceptance | `45343389672` | success |
| Desktop Validation | `45343389595` | **failure** — job `138272088065` |

The previously failing step, "Native helper cold-start timing attribution", is **success** at both
`d5155d2` and `7de4599`, so the §3 fixture fix holds in CI and not only locally.

Inside Desktop Validation, steps 9–15 and 21, 22, 24, 26 all succeeded. **Step 16, "Run packaged
Windows runtime smoke test", failed** with the pre-existing defect already recorded above —
`Nonzero-latency dynamic live bypass changed alignment at input frame 24000` (`expected 1563232`,
onsets `1563232/1563360/1563232`, `rmsDifference 3.33e-10`). It is unrelated to this branch: no
bypass, latency or alignment behaviour was touched. Because a step without `continue-on-error`
failed, steps 17 and 19 were skipped, so **no gated five-run acceptance result exists at this HEAD**,
and the job concluded `failure`. That is the required behaviour: the diagnostic in step 21 completed
`success` and did not convert the failure into a pass.

That run also demonstrated the §4 fix in production, in a way the gate-failure case could not: the
diagnostic ran even though an *earlier* step had failed. Its condition depends only on the packaged
executable and the helper build, both of which succeeded, so it measured a real package while the
gate was skipped. Under the old OS-only condition it would have been skipped along with everything
else. Its evidence reached artifact `14899881430` `apex-packaged-native-diagnostic-evidence`,
534,210 B — the first time the diagnostic's own evidence has reached an artifact at all.

### The 60-repetition diagnostic at `7de4599` (run `45343389595`, job `138272088065`)

**59 PASS / 1 FAIL** of 60. `tightestMarginMs` 3.33, `slowestBlockMs` 18 ms against the 21.33 ms
budget. `deadlineMisses 0` outside the failing repetition, `helperProcessesLeakedAfterShutdown []`,
`physicalHardware NOT_VERIFIED`, plug-in `mda RezFilter` (`5653546D6461466D64612072657A6669`),
transport 0.4127 → 2.0953 → 3.7673 s.

The single failure is repetition **22**: warm-up timed out at `waitedMs 60405` of 60000 with
`prepared=false`, `processedBlocks 3` equal to `priorBlocks 3`, and `deadlineMisses 1`. The guard
that fired was `pending-deadline-miss`, sequence 2, phase **cold**:

```
currentOutputFrame 3968   dueOutputFrame 4096   nextSequence 3
readySequences [1]        drySequences [1, 2]   inputContextFrame 1740031
rejection: seq 2  reason "after-failure"  recvFrame 4096  dueFrame 4096  rtt 21
resultsAccepted 2   resultsRejected 1   resultsUnattributable 0
worstMarginMs 14.33 (the accepted blocks)   mainEventLoopLagMaxMs 65.4
```

The pattern matches run 51 at `d960d11`: the guard latched at output frame 3968 while the block was
due at 4096, and the result then arrived *at* 4096 on a 21 ms round trip — inside the 21.33 ms
budget — rejected only because failure had already latched. So this is **not** evidence of a late
result; it is the pending-state guard firing before the due frame, and the cause remains open. The
two failures now on record differ in sequence (2 vs 1) and in lag (65.4 vs 23 ms), so no single value
explains both.

**CPU observations, now classified rather than assumed.** Across 60 runs and 711 cold blocks:

| State | Blocks |
|---|---|
| `clockUnavailable` | 0 |
| `cpuFieldNull` | 0 |
| `noClockTick` (supported clock, never advanced) | **679** |
| `positiveCpuDelta` (measured CPU) | **32** |

`smallestObservedCpuClockStepMs` **15.625**, measured at helper startup. So 95.5% of blocks measured
no CPU at all, and that reading means *below one observed clock step*, not zero CPU. The 32 positive
deltas show the clock does work on this runner when a span is long enough. The helper-versus-
scheduling question is still unanswered, and no scheduling or production processing decision may use
these numbers.

**A remaining reporting defect, found in this run and fixed after it.** The aggregate annotation's
`runs[]` carried repetitions 1–30 only, because the size reducer halves arrays to fit GitHub's 4096
character cap, and nothing said so. The header (`passed 59`, `failed 1`, `repetitions 60`) was
authoritative; the per-run list was not complete. `buildCiAnnotation` now takes `keepCounts` and
writes `runsReducedFrom` / `runsKept` whenever it reduces a field whose length is itself the result,
and the aggregate carries `perRepetitionVerdicts` — one `P`/`F` per repetition, a string, so it
cannot be halved — plus `failingRepetitions`. Tested in `tests/ciAnnotation.test.mjs`. The complete
per-repetition detail is in the artifact either way.

### Final CI at `bbfbfa9` — all five workflows green

| Workflow | Run | Result |
|---|---|---|
| Apex Studio CI | `45350651245` | success |
| Audio Validation | `45350651247` | success |
| Native VST3 Validation | `45350651253` | success |
| P9 High-DPI Editor Acceptance | `45350652724` | success |
| Desktop Validation | `45350651392` | success — job `138295935775` |

Steps 7 and 8 of Apex Studio CI — the previously failing cold-start attribution test and
the C++ timing split — both pass. The pre-existing packaged runtime smoke flake did not
recur, so the gated acceptance ran this time.

**Gating five-run acceptance: PASS 5/5.** `tightestMarginMs` 6.33, `slowestBlockMs` 15 ms
against the 21.33 ms budget, `deadlineMisses 0`, `nativeFailures 0`,
`helperProcessesLeakedAfterShutdown []`, `physicalHardware NOT_VERIFIED`. CPU over its 60
blocks: 55 no-clock-tick, 5 positive delta, observed step 15.625 ms.

**A green gate is not evidence the defect is gone.** The diagnostic measured a 13.3%
failure rate on the same runner minutes later; at that rate a five-run gate has roughly a
50% chance of passing by luck.

### The 60-repetition diagnostic at `bbfbfa9`: 52 PASS / 8 FAIL

`tightestMarginMs` 2.33, `slowestBlockMs` 19 ms. Artifacts: `14904011404`
`apex-packaged-native-diagnostic-evidence` 1,005,426 B; `14903917779`
`apex-packaged-vst3-evidence` 461,499 B; `14903598264` `apex-studio-windows` 176,457,502 B;
`14900662861` `apex-packaged-native-monitoring-evidence` 40,219 B; `14900831197`
`apex-packaged-live-input-evidence` 1,385 B.

Every repetition's verdict, in run order:

```
FPPPFFPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPFPPPFPPPFPPPPFFPP
```

Failing repetitions 1, 5, 6, 44, 48, 52, 57, 58. All eight failed the same way, on the
`pending-deadline-miss` guard:

| run | seq | phase | currentOutputFrame | dueOutputFrame | result received at | round trip ms | lag max ms |
|---|---|---|---|---|---|---|---|
| 1  | 1   | cold | 2944   | 3072   | — (none accepted) | —  | 70.07 |
| 5  | 1   | cold | 2944   | 3072   | 3072   | 22 | 74.60 |
| 6  | 2   | cold | 3968   | 4096   | 4096   | 24 | 72.12 |
| 44 | 107 | mid-session | 111488 | 111616 | 111616 | 20 | 72.23 |
| 48 | 1   | cold | 2944   | 3072   | 3072   | 18 | 73.51 |
| 52 | 2   | cold | 3968   | 4096   | 4096   | 25 | 71.63 |
| 57 | 46  | mid-session | 49024  | 49152  | 49152  | 24 | 76.23 |
| 58 | 2   | cold | 3968   | 4096   | 4096   | 25 | 73.23 |

**`currentOutputFrame` is exactly 128 frames before `dueOutputFrame` in all eight.** In
seven of the eight the result then arrived *at* the due frame on a round trip of 18–25 ms —
mostly inside the 21.33 ms budget — and was rejected `"after-failure"`, because the guard
had already latched. Every rejection reason is `after-failure`; none is a late arrival. So
**none of these eight is evidence of a late result**: the pending-state guard fires 128
frames (2.67 ms at 48 kHz) before the block is due, and the block then lands on time.

Two secondary observations, consistent across all eight: main-event-loop lag was 70–76 ms in
every failing run against 48–53 ms in the passing ones at `7de4599`, and six of eight were
cold (sequences 1–2) while two were mid-session (46, 107). Neither is established as a cause.
CPU over the diagnostic's 663 blocks: 620 no-clock-tick, 43 positive delta, observed step
15.625 ms — unchanged in character from `7de4599`.

### Two reporting defects this run exposed, both fixed

**The diagnostic reported `success` while failing 8 of 60.** With `continue-on-error: true`,
GitHub reports a step's *outcome* as `success` whatever the command did, and the verdict step
read `steps.native-diagnostic.outcome`. It printed `success` for a run whose own evidence said
52 of 60. The step now writes `result=PASS`/`result=FAIL` to `$GITHUB_OUTPUT` while still
exiting with the real status, and the verdict step prints that result next to the outcome it is
compared against. Asserted in `tests/ciDiagnosticWorkflow.test.mjs`.

**`failingRepetitions` reported `[1]` for a run with eight failures.** It was computed from the
halved `aggregate` list, so only failures inside repetitions 1–30 could appear. It is now derived
from the full `perRepetitionVerdicts` string via `failingRepetitionIndices`, which also attributes
a failure whose row was dropped to its 1-based position rather than losing it. The test reproduces
this exact case and shows the old derivation finding `[1, 5, 6]` where the correct answer is eight
entries.

### Local results at `bbfbfa9`

`lint` clean; `test:native-cold-start` 49/49; `test:native-timings-cpp` all checks;
`test:audio` 2507/2507 with `Orphaned: 0`; `test:history` 1283/1283; `verify:desktop` pass;
`build` pass.

### `a75cb15` — the gate failed on the first repetition, and the diagnostic proved the verdict fix

| Workflow | Run | Result |
|---|---|---|
| Apex Studio CI | `45363852323` | success |
| Audio Validation | `45363852139` | success |
| Native VST3 Validation | `45363852096` | success |
| P9 High-DPI Editor Acceptance | `45363852063` | success |
| Desktop Validation | `45363852076` | **failure**, job `138340398318` |

**Gating five-run acceptance: FAILED on repetition 1.** Warm-up timed out at
`waitedMs 60344` of 60000 with `prepared=false`, `processedBlocks 2` equal to
`priorBlocks 2`, `deadlineMisses 1`. The guard was `pending-deadline-miss`, sequence 1,
phase cold, `currentOutputFrame 2944`, `dueOutputFrame 3072`, `readySequences [0]`,
`drySequences [0, 1]`. It failed fast — one repetition, no retry, no re-roll — and the job
concluded `failure`.

That is the clearest statement yet that **the deadline defect is real and still present**:
the production gate now fails on it, on the first attempt, at this HEAD.

**The diagnostic ran anyway and completed all 60 repetitions** (42.1 min), which is the §4
requirement demonstrated on the gate-failure path — the case the condition was written for.
It reported **59 PASS / 1 FAIL**, failing repetition 45 with the same signature (sequence 1,
cold, 2944 vs 3072, `lagMax 56.38`). Its evidence reached artifact `14909616404`, 534,357 B.

**The verdict fix is now proven, not just asserted.** The diagnostic exited non-zero because
one repetition failed, the new wrapper published `::error title=cold-start diagnostic exited
1` carrying the evidence directory, the node version and the last 40 lines — and GitHub
*still* reported the step's outcome as `success`, because `continue-on-error` forces it. So
`steps.native-diagnostic.outcome` is confirmed unusable as a result, and `outputs.result` is
what carries the truth.

### First CPU-clock tick in the evidence, and it shows why these numbers are not durations

Sequence 1 of the failing block in repetition 45 is the first block on record where the
per-thread CPU clock actually advanced:

```
helperDecodeMs                7.250     helperInstanceProcessMs     7.618
helperHostPrepareMs           1.919     helperInstanceProcessCpuMs 15.625
helperPluginCallbackMs        5.578     helperPluginCallbackCpuMs  15.625
helperHostCollectMs           0.121     helperHostCollectCpuMs      0
helperCpuTimingSupported      true      helperCpuClockTickObserved  true
helperCpuClockObservedStepMs  15.625    helperRoundTripMs          18.817
```

**The CPU total, 15.625 ms, exceeds the wall total that contains it, 7.618 ms.** That is not
a measurement error; it is the clock handing back one whole 15.625 ms tick for a span of
7.6 ms. The neighbouring block in the same run reads `cpuTimingSupported true`,
`cpuClockTickObserved false` and every `*CpuMs` 0 against a 1.009 ms wall span.

So both states the new fields exist to separate are now observed on Windows side by side, and
the conclusion is stronger than before: at this granularity the CPU numbers are **quantised to
15.625 ms and cannot be interpreted as durations at all** — not merely "too coarse to be
useful". No audio scheduling or production processing decision may use them, and the
helper-versus-scheduling question is still unanswered.

### The corrected correlation, working in production

The same rejected block shows the §2 invariant doing its job on real evidence:

```
resultAccepted false   resultRejectionReasons ["after-failure"]
resultCorrelationReasons ["not-accepted"]
totalRoundTripMs null  marginMs null
rejectedResults [{ reason "after-failure", pendingSequence 1,
                   receivedOutputFrame 3072, dueOutputFrame 3072, roundTripMs 23 }]
```

A rejected result yields no round trip and no margin, carries its specific reason, and keeps
its 23 ms visible only as rejection evidence. And again the result arrived *at* the due frame
— 3072 against 3072 — so this is not a late arrival.

### The one-second exit at `9c4e28a` was never explained

At `9c4e28a` the diagnostic step ran for one second, exited 1, created no evidence directory
and produced no artifact. At `a75cb15` it ran normally for 42 minutes. The only change between
them was the `run:` wrapper, so the earlier behaviour is **unexplained and recorded as such**
rather than attributed to a fix. Had the wrapper been in place then, its `::error` annotation
would have carried the reason.

### `2d4befd` — the five-run gate passed and the diagnostic measured 59/60

Desktop Validation run `45373174373`, job `138372361332`, conclusion **success**, all 27 steps
success. The other four workflows at the same commit are success too: Apex Studio CI
`45373175079`, Audio Validation `45373174436`, Native VST3 Validation `45373174397`, P9 High-DPI
Editor Acceptance `45373174420`.

- **Five-run production gate (step 19, `native-coexistence-gate`): PASS 5/5.**
  `{"status":"PASS","passedRuns":5,"requestedRuns":5}`, `perRepetitionVerdicts "PPPPP"`,
  `failingRepetitions []`, `worstMarginMs` 5.33 on the recorded run, transport
  0.4207 → 2.1300 → 3.8047 s, `blocksBefore 23 → during 79 → after 79`.
  CPU observation: 5 runs, 60 blocks, `clockUnavailable 0`, `cpuFieldNull 0`, `noClockTick 57`,
  `positiveCpuDelta 3`, `smallestObservedCpuClockStepMs 15.625`.
  Ran 10:24:28 → 10:27:55Z. **This is a different commit from `a75cb15`, where the gate FAILED; the
  two are separate measurements and are not combined into one rate.**
- **60-repetition diagnostic (step 21, non-gating): 59 PASS / 1 FAIL.**
  `{"status":"FAIL","passedRuns":59,"requestedRuns":60}`, `perRepetitionVerdicts` 58 P then F then P,
  `failingRepetitions [58]`. Ran 10:27:56 → 11:09:58Z (42.0 min). CPU observation: 60 runs,
  710 blocks, `clockUnavailable 0`, `cpuFieldNull 0`, `noClockTick 662`, `positiveCpuDelta 48`,
  `smallestObservedCpuClockStepMs 15.625`. The wrapper's `::error` annotation
  (`cold-start diagnostic exited 1`) is present, and the step's reported outcome is still `success`
  because the step is `continue-on-error: true` — which is exactly why the verdict comes from
  `$GITHUB_OUTPUT` and not from the step outcome.
- **Editor acceptance (step 23): 10 PASS / 0 FAIL / 1 NOT_VERIFIED** (`p9b-multi-monitor` needs two
  physical displays).
- Artifacts: `14914200944` diagnostic evidence 533,862 B; `14914976086` packaged VST3 evidence
  464,181 B; `14910798466` native monitoring evidence 40,482 B; `14910202884` live input evidence
  1,387 B; `14914071919` Windows package 176,457,503 B.

The one failure, run 58, is the same cold-start shape: guard `pending-deadline-miss`, sequence 1,
phase cold, `currentOutputFrame 2944`, `dueOutputFrame 3072`, `readySequences [0]`,
`drySequences [0,1]`, `mainEventLoopLagMaxMs 54.79`. Its sequence-1 block measured
`helperRoundTripMs 36.01`, of which `helperHostPrepareMs 21.49` and `helperInstanceProcessMs 21.59`,
against a `blockBudgetMs 21.33`. No result was recorded for it at all
(`resultsRejected 0`, `rejections []`), so this one is a **genuine overrun**, not a result rejected
at the boundary. Run 58 and `a75cb15` repetition 45 are two different failure modes; see below.

### The pending guard's frame evidence was wrong, and correcting it changed the diagnosis

The guard posted `currentOutputFrame: this.outputFrame` from inside the input loop at sample index
`i`, but `this.outputFrame` advances only at the end of `process`
(`this.outputFrame += out[0].length`). So it reported the frame the *quantum started at*, not the
frame being evaluated. Every recorded `currentOutputFrame` on the pending path understated the true
position by `i` — 127 for the canonical cold case — and that is why all the historical evidence read
as a guard firing **128 frames** before the block was due.

That reading was an instrumentation artifact. The block fills on the last sample of a quantum, so the
guard is really evaluated at output frame 3071 for a block due at 3072. **The guard fires exactly one
output frame early**, and that is arithmetic rather than timing:
`due(s) − guardFrame = (delay − 2·block) + 1 = 1` when the pipeline delay is exactly two blocks.
Verified against the shipped worklet source in `src/audio/nativeVst3PendingGuardBoundary.test.ts`,
which evaluates `VST3_FX_WORKLET_SOURCE` in a sandbox and drives real 128-frame quanta.

The event now carries the bookkeeping explicitly, with the old value preserved under its own name so
no reader loses it:

| field | meaning |
| --- | --- |
| `outputFrameAtQuantumStart` | `this.outputFrame` at quantum entry — the old `currentOutputFrame` value |
| `inputSampleIndex` | the input sample the guard was evaluated on (127 in the cold case) |
| `inputQuantumFrames` | the render quantum length (128) |
| `currentOutputFrame` | **changed**: the frame actually being evaluated, `outputFrameAtQuantumStart + inputSampleIndex` |
| `nextQuantumOutputFrame` | the first frame of the next quantum — where the pending block is first needed |
| `dueOutputFrame` | unchanged: `delayFrames + sequence · blockFrames` |

`describeDeadlineMiss` normalises all of them, adds `outputSampleIndex`/`outputQuantumFrames` for the
output-side guard, and derives `framesBeforeDue = dueOutputFrame − currentOutputFrame` only from
frames the event actually carried. It stays null when either is missing, so pre-change evidence keeps
reading correctly: a historical event yields `framesBeforeDue 128`, which is precisely the
overstatement this change corrects.

### What the deterministic reproduction settled

Four boundaries, all against the shipped worklet, all ordered by call sequence rather than by
timestamp:

1. **Before the due frame** — a result delivered while the block is still pending is accepted, and its
   samples come out at output frame 3072. Neither guard fires.
2. **Between the final sample of the preceding quantum and the next `process` call** — the guard has
   already latched at frame 3071. The result is rejected `after-failure` with
   `receivedOutputFrame 3072` and `dueOutputFrame 3072`. Every frame the preceding quantum rendered
   (2944–3071) needed only block 0, so not one rendered frame needed the block that was refused, and
   the quantum that *would* have needed it never ran.
3. **At the due-frame boundary** — the output-side guard, evaluated in the output loop, reports
   `currentOutputFrame 3072`, `dueOutputFrame 3072`, `outputSampleIndex 0`. It fires *at* the frame
   that needs the block and is never early.
4. **After the due frame** — same as (3); the output-side guard is the one that catches it.

With a result withheld for 40 quanta, only `pending-deadline-miss` ever fires: **the pending guard
always preempts the output-side guard by exactly one frame**, because it is evaluated one frame
earlier for the same block.

So, to the question this investigation was opened for: **yes — the pending guard fails a result that
the due frame could have accepted.** It requires the block in hand at frame `due − 1`; the block is
not needed until `due`. A result landing in that one-frame window is refused, and the recorded
evidence at `a75cb15` repetition 45 has exactly that shape — `receivedOutputFrame 3072`,
`dueOutputFrame 3072`, rejection `after-failure`.

One thing that evidence cannot settle, and must not be inferred from it: its `roundTripMs` was 23
against a 21.33 ms nominal budget, which reads as "late". The nominal budget is measured from the
submission stamp against a schedule the audio thread does not necessarily keep, so when the thread is
behind the true due instant moves later and a 23 ms round trip can still land before the quantum that
needs the block. **The frame evidence is the reliable one here; the wall-clock number is not.** This
rests on the AudioWorklet platform property that control-port messages are delivered on the audio
thread between rendering quanta and never during one — a documented property that this harness models
by delivering between `process` calls, not something it measures.

### The correlation invariant is now complete

`acceptedResultFor` read `if (recordSequence !== null && recordSequence !== parsed.sequence)`, so a
main-process record carrying **no** sequence was accepted on its request id alone — and so was any
non-finite or fractional one, because `int()` maps all three to null. Such a record says nothing about
which block it describes, so it could borrow the measurement of whichever block shared its request id.

Acceptance now requires all four conditions: the `requestId` parses; the record's own `sequence` is
present, finite and an integer; that sequence equals the one the `requestId` encodes; and an accepted
worklet result exists for that exact request id. Seven new test cases cover missing, null, undefined,
NaN, ±Infinity, a numeric string, a non-number, three fractional values and four mismatches, plus a
case proving that refusing the measurement does not discard the rejection evidence.

No production call site needed changing. The only caller is
`liveInputAcceptance.ts`'s `decompose`, and its records come through `desktop-vst3.cjs`'s
`readProfile`, which already rejects anything without `Number.isInteger(value.sequence)`. The desktop
smoke's `correlatedTimingSamples` does not call `acceptedResultFor` at all — it reads `event.accepted`
directly — so tightening could not null out its evidence.

### The smallest safe production correction — reported, deliberately not implemented

The guard latches on `this.fill === this.blockFrames`, which is true on the last sample of the quantum
*before* the pending block is needed. The minimal change is to make that check frame-based:

```js
const dueOutputFrame = this.delayFrames + this.pending * this.blockFrames;
if (this.outputFrame + i >= dueOutputFrame) { /* fail closed, unchanged */ }
```

That keeps both guards fail-closed and leaves the block size, fixed latency, buffering, bypass,
transport, serialization, queue and helper processing untouched; it adds no retry and permits no dry or
stale PCM. It grants exactly one additional frame — 20.8 µs at 48 kHz — and makes the two guards agree
about when a block is late.

**It is not a fix, and it must not be presented as one.** What the evidence does say is that the
correction addresses the shape every `3c3817d` failure had: the guard latched at frame 4095 for a
block due at 4096, and the result then arrived at 4096. Reading the code, the corrected comparison
would not latch at 4095, the quantum would complete, the result would be accepted before the next
`process` call, and the block would be present at the frame that needs it. That is a prediction from
the source and the recorded frames — **no production run has measured the corrected guard**, and this
commit deliberately does not contain it.

It also would not have helped `2d4befd` run 58, whose 36.01 ms round trip against a 21.33 ms budget
never produced a result at all. So the correction and the overrun are two separate problems, and only
the first has a candidate change. Why the cold block's helper round trip reaches 36 ms — or 19 ms —
is a separate question, and answering it is a separate change.

### `3c3817d` — the corrected instrumentation on Windows CI, and it confirms the one-frame finding

Desktop Validation run `45383087503`, job `138406885418`, conclusion **success**, all 27 steps
success. All five workflows at this commit are success: Apex Studio CI `45383087495`, Audio
Validation `45383087590`, Native VST3 Validation `45383087646`, P9 High-DPI Editor Acceptance
`45383087466`.

- **Five-run production gate (step 19): PASS 5/5.** `{"status":"PASS","passedRuns":5,"requestedRuns":5}`,
  `perRepetitionVerdicts "PPPPP"`, `failingRepetitions []`, `deadlineMisses 0`, `tightestMarginMs 4.33`,
  `slowestBlockMs 17`. CPU: 5 runs, 60 blocks, `noClockTick 54`, `positiveCpuDelta 6`,
  `smallestObservedCpuClockStepMs 15.625`. Ran 11:29:46 → 11:33:15Z.
- **60-repetition diagnostic (step 21, non-gating): 56 PASS / 4 FAIL.**
  `{"status":"FAIL","passedRuns":56,"requestedRuns":60}`, `perRepetitionVerdicts`
  `PPPFPPPPPPPPPFPPPPPPPPPPPPPPFPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPF`, `tightestMarginMs 3.33`,
  `slowestBlockMs 18`, `blockBudgetMs 21.33`. Ran 11:33:16 → 12:18:32Z (45.3 min). CPU: 60 runs,
  684 blocks, `clockUnavailable 0`, `cpuFieldNull 0`, `noClockTick 627`, `positiveCpuDelta 57`,
  `smallestObservedCpuClockStepMs 15.625`.
- **Failing repetitions: 4, 14, 29 and 60** — read off the 60-character verdict string. The
  annotation's own `failingRepetitions` field reported only `[4]`; see the reducer defect below.
- **Editor acceptance (step 23): 10 PASS / 0 FAIL / 1 NOT_VERIFIED** (`p9b-multi-monitor`).
- Artifacts: `14920025465` diagnostic evidence 735,116 B; `14918469562` packaged VST3 evidence
  463,126 B; `14916445395` native monitoring evidence 40,363 B; `14915851443` live input evidence
  1,393 B; `14919063350` Windows package 176,458,588 B.

**All four failures carry the corrected frame fields, and all four read the same way.** Every one is
guard `pending-deadline-miss`, sequence 2, phase cold:

| run | `outputFrameAtQuantumStart` | `inputSampleIndex` | `currentOutputFrame` | `dueOutputFrame` | `framesBeforeDue` | rejection |
| --- | --- | --- | --- | --- | --- | --- |
| 4  | 3968 | 127 | 4095 | 4096 | **1** | `after-failure`, `recvFrame 4096`, `dueFrame 4096`, rtt 23 |
| 14 | 3968 | 127 | 4095 | 4096 | **1** | `after-failure`, `recvFrame 4096`, `dueFrame 4096`, rtt 21 |
| 29 | 3968 | 127 | 4095 | 4096 | **1** | `after-failure`, `recvFrame 4096`, `dueFrame 4096`, rtt 21 |
| 60 | 3968 | 127 | 4095 | 4096 | **1** | `after-failure`, `recvFrame 4096`, `dueFrame 4096`, rtt 23 |

This is the production confirmation of the deterministic reproduction. The guard latched one output
frame before the block was due, and in every case the result was then delivered **at** the due frame
and refused as `after-failure`. Under the old instrumentation these four would have been recorded as
`currentOutputFrame 3968` against `dueOutputFrame 4096` — a 128-frame gap that does not exist.

The helper round trips for the failing blocks were 16.91, 16.64, 14.35 and 19.16 ms against a
21.33 ms budget, so **none of these four is a plain overrun**: the native work came back inside the
block period. The worklet's own `roundTripMs` reads 21–23 ms, nominally at or just over budget, but
that number is measured against a schedule the audio thread does not necessarily keep and
`Date.now()` resolves to whole milliseconds, so it is not the evidence to decide this on. The frame
evidence — delivery recorded at exactly the frame the block was due — is.

### The annotation reducer was halving the failure list, and that is now fixed

The diagnostic's aggregate annotation reported `failed: 4` next to `failingRepetitions: [4]`.
Reproduced locally against the real payload shape: `buildCiAnnotation`'s size reduction halves every
array field that is not `preserve`, and `failingRepetitions` was one of them, so `[4, 14, 29, 60]`
became `[4, 29]` and then `[4]`. A one-entry list still reads as "one repetition failed", so the field
stated something false rather than merely incomplete. `keepCounts` does not help: it records a
reduction, it does not prevent one.

`buildCiAnnotation` now takes an `exact` option for lists that *are* the result; they are held out of
the halving pass and their length is still recorded if the hard cap ever bites.
`packaged-native-monitoring-acceptance.mjs` passes `exact: ['failingRepetitions']`. Two tests pin both
the fix and the defect it replaces. The verbose `runs` list is still reduced as before
(`runsReducedFrom 60`, `runsKept 7` under the reproduction's cap), so the cap is still honoured.

### Still NOT VERIFIED

- **The cold-start real-time deadline defect is unfixed.** Nothing in the boundary investigation
  changed production behaviour, by design. At `a75cb15` the production gate FAILED on repetition 1 —
  warm-up timeout with `deadlineMisses 1` — and at `2d4befd` it passed 5/5, so the gate does not
  resolve the defect either way. The results across this branch's commits do not agree, and that
  disagreement is the honest summary: gate 5/5 at `bbfbfa9`, gate FAIL at `a75cb15`, gate 5/5 at
  `2d4befd`, gate 5/5 at `3c3817d`; diagnostics of 1/60 at `d960d11`, 1/60 at `7de4599`, 8/60 at
  `bbfbfa9`, 1/60 at `a75cb15`, 1/60 at `2d4befd`, 4/60 at `3c3817d`; and 0 of 5 during warm-up at
  `25442d66`. Each belongs to its own commit, and none is a pass for the defect.
- **Corrected by the boundary investigation above:** the "guard latched 128 frames before the due
  frame" reading in the `bbfbfa9` failures was an instrumentation artifact, not a measurement. The
  guard fires exactly **one** frame early, which follows from the pipeline delay being exactly two
  blocks, and the question "why does the pending-state guard fire early" is now answered. At
  `3c3817d`, with the corrected fields in production, **all four** diagnostic failures carry
  `framesBeforeDue: 1` and a result delivered at exactly the due frame, rejected `after-failure` —
  so on that run the single frame was the difference in every failure, and the helper round trips
  (14.35–19.16 ms) were inside the 21.33 ms budget. `2d4befd` run 58 is the other shape: a plain
  36.01 ms overrun with no result at all. The two failure modes are now distinguishable in the
  evidence, but only one run of each has been measured, so no rate is attributed to either. The
  70–76 ms event-loop lag in the `bbfbfa9` failures, against 48–53 ms in passing runs, remains
  correlated and unproven.
- Whether the first block's helper round trip overruns the budget because of descheduling or because
  of expensive work. `2d4befd` run 58 spent 21.49 ms of its 36.01 ms round trip in
  `helperHostPrepareMs` alone, but 662 of its 710 blocks measured no CPU tick, so the wall-clock
  figure cannot be attributed.
- Whether the host-preparation spikes are descheduling rather than expensive code. 668 of the 710
  blocks at `a75cb15` measured no CPU tick, and the one block that did tick reported 15.625 ms of CPU
  inside 7.618 ms of wall. The clock is quantised to 15.625 ms, so these numbers are not durations and
  cannot settle the question either way.
- The gate's 5/5 at `bbfbfa9` and the diagnostic's 52/8 at the same commit are both real and they
  disagree. That disagreement is the point: five repetitions cannot resolve a 13% failure rate, and
  the diagnostic is non-gating, so neither number stands in for the other.
- Whether control-port messages really are delivered only between rendering quanta. The conclusion
  that a result landing in the one-frame window was rejected although the block was still in time
  depends on it. It is a documented AudioWorklet platform property and the harness models it by
  delivering between `process` calls; nothing in this repository measures it, and `receivedOutputFrame`
  alone cannot distinguish "between quanta" from "during the quantum that starts at the due frame"
  because `this.outputFrame` advances only at the end of `process`.
- Physical hardware is `NOT_VERIFIED`, and artifact-zip contents have not been read — CI evidence was
  taken from annotations.
