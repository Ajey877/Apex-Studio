# Mastering limiter (Phase 9B)

The master bus ends in a **real lookahead true-peak limiter**, implemented as an
`AudioWorkletProcessor`. This document describes what it does, what it costs, how it
is measured, and where it stops being true.

## Signal path

```
input ─┬─ bypassGain ───────────────────────────────────────────────→ output
       └─ 3-band compressor → imager → maximizer → limiter → wet ──→ output
```

* `maximizer` is a `DynamicsCompressorNode`: ratio 20:1, fixed **3 ms attack**, release
  = `maximizerRelease`, threshold = `maximizerThreshold`. It is the upstream
  drive/compressor stage, not the limiter.
* `limiter` is `AudioWorkletNode('apex-mastering-limiter')` (source in
  `src/audio/masteringLimiter.ts`). It is spliced in asynchronously once its module
  loads; until then the chain keeps the Phase 9A fallback.
* `wet`/`bypassGain` are the suite's own crossfade pair. Bypassing the suite is a
  literal dry path, not a silent setting.

The WaveShaper "ceiling" node that used to close the chain is **disconnected from the
master path whenever the limiter is installed**. A finite-curve WaveShaper quantises
everything it passes, which would undo the limiter's work; it stays in the graph only as
the fallback guard (see below).

## Controls and their real meaning

| Control | Field | Meaning |
|---|---|---|
| Maximizer Threshold | `maximizerThreshold` | Drive into the upstream compressor (−12…0 dB, default −3.5). |
| True Peak Ceiling | `maximizerCeiling` | The limiter's ceiling in dBFS (−1…0, default −0.2). |
| Release | `maximizerRelease` | Recovery after a peak, in ms (10…500, UI 20…300). Drives **both** the compressor and the limiter. |
| Lookahead | `maximizerLookaheadMs` | Lookahead delay of the limiter, in ms (0…20, default **5**). `0` = direct/causal. |

`maximizerLookahead` (boolean) is the legacy field. It is still written, for documents
that predate the millisecond field, and it is kept in step by the control writer
(`true` ⇔ `maximizerLookaheadMs > 0`). Loading a pre-9B project maps
`maximizerLookahead: true → 5 ms` and `false → 0 ms`; an explicit
`maximizerLookaheadMs` always wins. The old "1 ms / 5 ms compressor attack" mapping is
gone — the maximizer attack is a fixed 3 ms.

`lufsTarget` is **not applied** as automatic gain. It remains a metering reference.

## How the limiter works

1. **Inter-sample detection.** Each channel passes through the same Blackman-windowed
   polyphase interpolator used by `src/audio/truePeak.ts` (`designInterpolatingFilters(4, 12)`,
   i.e. 4× oversampling, 12 taps per phase). The maximum of the sample and all
   interpolated sub-samples is the *reconstructed peak* of that input sample.
2. **Required gain.** `required = ceiling / peak` when `peak > ceiling`, else `1`.
3. **Bounded delay buffer.** Samples and their required gains are written to a ring
   buffer of `lookahead` frames. The limiter therefore sees the upcoming `lookahead`
   samples before it emits anything.
4. **Sliding minimum.** A monotonic deque holds the minimum required gain over the
   window `[emit, emit + lookahead]`, so a peak anywhere in the window is known before
   the audio that causes it leaves the buffer.
5. **Gain law.**
   * attack: a bounded linear descent of `1/lookahead` per sample — guaranteed to reach
     any target *within* the lookahead window, which is what makes the lookahead
     claim true rather than decorative;
   * release: one-pole toward the window requirement,
     `1 − exp(−1 / (releaseMs · 0.001 · fs))`;
   * a final exact cap (`gain = min(gain, required[emit])`, using the largest
     reconstructed peak in the emitted sample's neighbourhood) makes the ceiling a
     hard guarantee for the emitted sample, not an approximation;
   * gain is floored at `1e-4` (−80 dB) and ceilinged at 1, so it is always finite,
     never amplifies, and never goes to zero.
6. **Stereo link.** Both channels share one gain, computed from the larger of the two
   channels' reconstructed peaks. A loud left channel therefore ducks the right channel
   too: no channel can exceed the ceiling, and the stereo image is not skewed.
7. **Reporting.** Every `max(128, round(0.046 · fs))` samples the processor posts the
   gain it actually applied: `reductionDb` (dB in the last instant) and
   `peakReductionDb` (largest reduction in the reporting interval). The main thread
   turns those into `MasteringLimiterStatus`; the UI shows `NOT MEASURED` until the
   first report arrives.

## Latency

| Setting | Latency |
|---|---|
| `maximizerLookaheadMs = 5` (default) | 240 samples @ 48 kHz (221 @ 44.1 kHz) |
| `maximizerLookaheadMs = 0` | 0 samples (causal) |
| `maximizerLookaheadMs = 20` | 960 samples @ 48 kHz |
| Limiter unavailable (fallback) | 0 samples |

The limiter's latency is `round(ms / 1000 · sampleRate)` and is exposed as
`latencySamples` / `lookaheadMs` in the status object.

**Export.** `renderTimelineOffline` reserves the configured lookahead at the end of the
render (so the delay line is flushed), waits for the limiter module to install before
`startRendering()`, then trims the render by the *actual* installed latency
(`min(reserved, actual)`, never a hard-coded constant). A render therefore has the same
duration and start alignment with lookahead 0 ms or 20 ms. If the render runs short (a
fallback with less latency than reserved), it is padded with silence rather than
shortened.

**Live monitoring.** The same chain runs in the live context, so playback is delayed by
the lookahead while the suite is enabled. That is inherent to lookahead limiting; the
dry/bypass path is not delayed.

**What is not trimmed.** The master chain has its own small group delay from the
crossover filters and the maximizer compressor (measured ≈ 7 ms in Chromium with the
limiter installed). It exists in live monitoring *and* in exports, so trimming it in
exports only would desynchronise the two. The export path compensates exactly the
limiter's share, so changing the lookahead never moves the render.

## Fallback when the worklet is unavailable

If `AudioWorklet`, `addModule`, `Blob`/`URL` or `AudioWorkletNode` is missing, or the
module fails to load, the processor installs **no limiter** and says so:

* `getLimiterStatus().available === false`
* `fallbackReason: 'worklet-unavailable' | 'module-load-failed'`
* `latencySamples === 0`

The chain then runs the Phase 9A fallback: the maximizer compressor followed by a
4× oversampled WaveShaper hard clip at `maximizerCeiling`. That guard looks at **sample**
peaks only, adds no delay and is **not** a true-peak limiter. It is an emergency stop,
never the primary claim. The same fallback is used for a context that has no
`createChannelSplitter`/`createWaveShaper` (some test doubles).

## Measurement

All numbers below were produced by real browser tests in Chromium (Playwright) and by
deterministic unit tests. "True peak" is always the independent measurement from
`src/audio/truePeak.ts` (`TruePeakMeter`), never the limiter's own detector.

| Fixture | Setting | Result |
|---|---|---|
| fs/4 at 45°, amplitude 1.05 (sample peak −2.6 dBFS, true peak +0.4 dBFS) | ceiling −1 dBFS | output true peak ≤ −0.75 dBFS; a sample-peak clipper would not have touched this fixture at all |
| 220 Hz tone, amplitude 1.9 (sample +5.1 dBFS) | ceiling −1 dBFS, 5 ms | output true peak ≤ −0.75 dBFS; reported reduction ≈ applied reduction |
| 3 kHz burst over a quiet bed (true peak +7 dBFS) | ceiling −0.5 dBFS, 5 ms | output true peak ≤ −0.25 dBFS; gain already down at the burst's first emitted sample |
| abrupt full-scale 3 kHz burst (+7.6 dBFS) | 5 ms vs 0 ms | 5 ms: true peak −1.00 dBFS (ceiling held). 0 ms: sample peaks exactly at the ceiling but the reconstructed peak reaches −0.05 dBFS — ≈1 dB of documented overshoot, which is what lookahead buys |
| impulse, amplitude 0.5 | 5 ms vs 0 ms | the delayed render is the direct render moved by exactly 240 samples @ 48 kHz |
| hard-left / hard-right | 5 ms | both channels ≤ ceiling, right channel stays silent, L/R equivalence preserved |
| silence, 130-sample buffer, non-finite input | any | finite, bounded (≤ 1.0), deterministic |
| song export (production `renderTimelineOffline`) | ceiling −1 dBFS | WAV honours the ceiling, duration unchanged, start alignment identical at 0 ms and 5 ms lookahead |
| live playback (engine's own master graph) | ceiling −1 dBFS | limiter installed at 240 samples, measured gain reduction > 1 dB, audio present on the master analyser |

**What the lookahead setting really buys.** On stationary material both modes
hold the true-peak ceiling (the detector's window covers the emitted sample's
neighbourhood either way). The difference is at onsets: a causal detector cannot
duck a peak it has not seen, so direct mode overshoots by up to ≈1 dB on an abrupt
transient while the 5 ms mode does not overshoot at all. Direct mode is still a
limiter — every emitted sample is capped at the ceiling — it is simply not a
guaranteed inter-sample limiter.

**Tolerance.** Inter-sample assertions allow +0.25 dB, which covers the difference
between the limiter's 4×/12-tap detector and the meter's own reconstruction. The
sample-peak assertion is exact (±0.01 dB, i.e. float rounding).

## Limitations

* **Passband.** The detector is a 4× interpolator with 12 taps per phase. Near Nyquist
  its reconstruction is less accurate than a 8×/32-tap meter; the ceiling still holds by
  construction for the emitted sample because of the exact-cap step, but the detector is
  not a mastering-grade ISP meter.
* **No oversampled gain application.** Gain is applied at the base rate, so the process
  can add a small amount of distortion on very dense, very loud material. The unit and
  browser tests measure peaks and gain envelopes, not subjective quality; no listening
  test has been done, so no claim about sound quality is made here.
* **Per-band gain reduction is still not measured.** The multiband tab's GR rows say
  `NOT MEASURED`; only the limiter's reduction is real.
* **Chain group delay is not trimmed** (see above), and disabling the suite removes the
  delay, which is an audible jump of a few milliseconds — pre-existing behaviour of the
  wet/bypass pair.
* **Scope.** The limiter is part of the master stage only.
  * Song/pattern exports and stem exports go through `renderTimelineOffline` with
    `outputStage: 'master'`, so they include the limiter (and are aligned the same way).
  * Bounce-in-place (`bouncePlaylistLaneToAudioClip`) renders with
    `outputStage: 'pre-master'` on purpose: it bounces *before* the shared master stage so
    the bounced material can be re-mastered without being limited twice. It therefore
    contains no limiter, no multiband compression and no imager — the same as before
    Phase 9B.
  * A render in a context without `createChannelSplitter`/`createChannelMerger`/
    `createDynamicsCompressor`/`createWaveShaper` skips the mastering stage entirely and
    says so through the normal degradation contract.

## Tests

* `src/audio/masteringLimiter.test.ts` — 19 deterministic tests of the worklet core
  (coefficient parity with `designInterpolatingFilters`, ceiling for sample and
  inter-sample fixtures, exact delay, gain timing, release shape, stereo link,
  silence/short/malformed input, determinism, live mode change).
* `browser-tests/masteringLimiter.spec.ts` — 12 Playwright tests in real Chromium:
  the worklet alone in an `OfflineAudioContext`, `MasteringProcessor` in the graph, the
  production export path, and live playback through the engine's master bus.
* `src/state/phase9b.masteringLimiterPersistence.test.ts` — persistence, migration and
  clamping of `maximizerLookaheadMs`.
* `src/audio/masteringDspSignal.test.ts` — fallback behaviour in a context without
  `AudioWorklet` (the pure-JS `web-audio-engine` harness; its
  `DynamicsCompressorNode` is a documented pass-through and is never used to prove
  limiter behaviour).
