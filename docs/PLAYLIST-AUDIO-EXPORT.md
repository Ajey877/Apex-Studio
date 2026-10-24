# Playlist audio in production offline export

## Audit and scope

Phase 6C was audited against main `44b87e792df191554c51ddd57c9a600af045fe94`
(PR #287 merged). All five post-merge workflows succeeded: Audio 40101265170,
Native VST3 40101265166 (Linux and Windows), Desktop 40101265285, CI
40101265100, and deployment 40101265296. Stable `v1.2.2` remains
`88d5889331be89a29b775e6773885b6531c7e802`.

Issue #56's statement that offline export schedules only pattern clips is now
stale. Audio clips already use the production graph. The remaining reproduced
defect is **fractional-sixteenth audio onsets being silently omitted**. The live
and offline scheduler used `currentGlobalStep === clip.startBar * stepsPerBar`.
For a supported 7/8 project, a normal quarter-bar placement is step 3.5: no
integer scheduler tick can ever equal it. The buffer is present and validates,
yet the exported WAV is silent there. This is not an asset portability defect.

The fix schedules a clip once in its half-open step window `[step, step + 1)`
and adds its fractional onset in seconds to the scheduled audio time. Exact-step
onsets retain zero additional offset. This is the same shared `triggerCurrentStep`
used by live playback and offline export, not a new export scheduler. Existing
mute, take/comp, channel audibility and lane checks remain in place.

## Actual production path

1. Playlist clips reference `audioBufferId`. `audio/audioPersistence.ts` stores
   their audio blobs in IndexedDB. `state/projectPersistence.ts`'s
   `hydrateProjectAudio` restores blobs through `AudioEngine.loadAudioFile`, which
   decodes actual audio and registers it in the engine's sample-buffer cache.
   Failed hydration marks `audioUnavailable`; no substitute audio is created.
2. `ExportModal.tsx` resolves the project export range through `getProjectRenderBars`
   and calls `AudioEngine.renderTimelineOffline`. It is **not** routed through
   the legacy standalone `renderProjectTimelineOffline` utility renderer.
3. `renderTimelineOffline` validates assets, isolates the live state, builds the
   production mixer/master graph in an OfflineAudioContext, snapshots the loaded
   buffers and project data, and calls the shared `triggerCurrentStep`.
4. Audio clips reach `playAudioClipWithFades` / `scheduleClipSource`. The same path
   applies source trimming (`offsetSteps` is timeline time), playback rate,
   existing pitch/detune and fades, channel volume/pan and routing, take/comp
   segments, mixer processing, and the master. Source trim/seek time is multiplied
   by rate before indexing source content; rate was not reimplemented here.
5. The native VST3 offline producer and Playlist parameter timeline still flush
   through the existing PR #287 integration before `startRendering`. Existing
   mastering preroll, limiter latency compensation and bounded song-tail trimming
   still determine the output buffer.
6. `ExportModal` passes that buffer to `audioBufferToWav` for the final WAV bytes.
   Stems and bounce reuse the engine rather than introducing another renderer.

## Reproduction and PCM evidence

`browser-tests/playlistAudioExport.spec.ts` uses a real browser, IndexedDB, WAV
assets, actual decoding/hydration, production master export with mixer FX enabled,
and the actual WAV encoder. Its same-origin harness deliberately does not mount
App: App's unrelated live-project re-sync must not overwrite the fixture project's
meter/mastering settings between renders. No DSP, decoder or scheduler is mocked.
Mastering is explicitly bypassed as a supported project setting so that exact
PCM levels and silence have an independent analytical oracle.

At 105 BPM in 7/8 a bar lasts 2 seconds. Asset A is a distinguishable stereo PCM
fixture. Clip A starts at bar 0.25 (0.5 seconds), lasts 0.125 bars (0.25 seconds),
and trims 3.5 sixteenths (0.5 seconds of source). Its owner channel has gain 0.5.

- **Before:** at 0.6 seconds, exported L/R = `[0, 0]`, despite successful asset
  hydration. Baseline 4/4 and 3/4 controls already produced the correct signal.
- **After:** L/R = `[0.0625, 0.03125]`. At 44,100 Hz nonzero support is exactly
  frames **22,050–33,074** inclusive. Before 0.5 s and from 0.75 s onward both
  channels are exactly silent. Existing 2 ms click-guard fades remain intact.
- The complete float32 WAV SHA-256 is
  `47f4817e7219db13997ce77f763d030c4f0bca0be11a7ee545981a65d9be793b`
  on the measured 44,100 Hz Chromium fixture. Repeated unchanged renders match
  byte-for-byte. Corrected 7/8 now matches the already-working 4/4 and 3/4
  controls at the same absolute times. Tests compare repeat hashes, not a
  platform-specific hardcoded digest.
- Clip B starts at 0.625 s. At 0.7 s the overlap is exactly
  `[0.046875, 0.078125]`; after A ends, B alone gives
  `[-0.015625, 0.046875]`. Removing A leaves no signal before B's onset and only
  B's expected stereo signal in the overlap window. Muting A renders silence.
- Playback rate 2 retains the existing scaled source trim: samples at 0.55 s
  and 0.7 s are `[-0.0625, 0.0625]` and `[0.03125, -0.0625]`, respectively.
- A later clip at bar 1.25 is checked at 2.5–2.75 s, across global/bar-local
  scheduler coordinates. A sample-backed pattern-only project remains
  bit-identical before/after asset failures and adding a muted audio clip.
- Every float32 WAV sample is checked against the actual returned AudioBuffer.
  The standard four-second short-export floor is retained. Missing buffers,
  hydration-unavailable flags and corrupt decoder input reject explicitly, and
  subsequent exports still work. Input project data is unchanged by rendering.

During test development, demanding bit-identical float32 *MiniSynth filter tails*
exposed existing browser ended-callback variation: on untouched baseline, 3/5
repetitions differed by at most `1.6568635569438883e-12` over 256 channel samples.
This is not caused or fixed by the onset patch. The new strict hash regression
therefore uses a genuinely deterministic sample-backed pattern, retaining exact
PCM and WAV equality rather than relaxing the assertion. Existing synth/render
regressions and their tolerances are unchanged.

## Limits retained

This patch does not implement a new time-stretch algorithm, mixer effect, codec,
asset format or ZIP workflow. Playback-rate/detune behavior remains the existing
Web Audio behavior, not pitch-preserving stretching. Fade and comp behavior,
swing scheduling, render floors/tail policy and unsupported effects keep their
existing contracts. Explicit mastering/FX can intentionally change signal and
silence and need not be bit-identical across arbitrary DSP configurations.
Native VST3's existing scheduling-resolution limitations are unchanged; this is
not a new sample-accuracy or physical-device-listening claim. `.flmp` remains a
manifest backup; Portable ZIP already owns audio-containing interchange.

Focused command:

```sh
npx playwright test browser-tests/playlistAudioExport.spec.ts --workers=1
```
