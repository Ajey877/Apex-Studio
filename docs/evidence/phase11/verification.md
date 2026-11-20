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
