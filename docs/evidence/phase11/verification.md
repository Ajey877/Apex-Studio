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
