# Sidechain ducking — implementation notes

_Audience: maintainers. Describes the behaviour shipped in Phase 9A. The historical audit in
[`FEATURE-TRUTH-AUDIT.md`](./FEATURE-TRUTH-AUDIT.md) is kept as written; its §3.3 carries a
current-state note that points here._

## Two modes, one settings object

`MixerTrack.sidechain` (`src/types/daw.ts`) holds:

| Field | Range / values | Meaning |
|---|---|---|
| `enabled` | boolean | Route active |
| `sourceTrackId` | mixer track id | Track whose signal (level mode) or notes (legacy mode) drive the duck |
| `mode` | `'level-detected' \| 'note-trigger'` | Which DSP runs |
| `amount` | 0 … 1 | Maximum duck depth. `maxReductionDb = 20·log10(1 / max(0.02, 1 − amount))`, i.e. 0.75 → 12 dB, 0.9 → 20 dB. Shared by both modes so the ceiling does not move when a route changes mode. |
| `thresholdDb` | −60 … 0 dBFS | Level mode: signals below this cause no ducking |
| `ratio` | 1 … 20 | Level mode: reduction slope above the threshold |
| `attackMs` | 1 … 50 | One-pole time constant of the gain closing (63 %, not 90 % settle) |
| `releaseMs` | 20 … 500 | One-pole time constant of the gain returning to unity |

`mode` is optional in the type only for pre-9A documents and for callers that build a legacy
payload. `normalizeProjectState()` (called on load, recovery and save) writes it explicitly and
clamps every number into the ranges above, so a hand-edited document can never push an
out-of-range parameter into an AudioParam. A document without `mode` resolves to
**`note-trigger`** — the Phase 9A migration is deliberately silent about audio: an old project
sounds exactly as it did.

## Level-detected mode

`src/audio/sidechainDetectorWorklet.ts` contains an `AudioWorkletProcessor`
(`apex-sidechain-detector`) plus its parameter descriptors.

* **Detector tap point** — `MixerChannel.output` of the *source* track (`output → worklet`).
  The channel graph is `input → panner → duckingGain → output → analyser → (bus/master)`, so the
  tap is post-pan and post-fader: moving the source fader changes how hard the destination ducks,
  and muting the source removes the duck. Instrument voices, sustained notes and audio clips all
  pass this point.
* **Gain stage** — the worklet's single mono output *is* the computed gain. It is wired through a
  unity `GainNode` into the destination channel's `duckingGain.gain` AudioParam, whose intrinsic
  value is set to 0 while the detector is attached (an AudioParam sums its inputs). The control
  signal is not audible — it is connected to a parameter, not to an input — and it cannot feed
  back into the source.
* **Curve** — per sample: peak of |x| across the source channels → peak follower
  (`attackMs` rising, `releaseMs` falling) → `levelDb = 20·log10(envelope)` →
  `overDb = levelDb − thresholdDb` → `targetDb = min(maxReductionDb, overDb·(1 − 1/ratio))`
  when `overDb > 0`, else 0 → `targetGain = 10^(−targetDb/20)` → gain smoothing with the same
  attack/release constants. Below the threshold the output is exactly 1.
* **Metering** — every ~30 ms the processor posts `{ reductionDb, gain }` to the main thread. That
  message *is* the measurement; the routing modal subscribes to it through
  `audioEngine.onSidechainReduction()` and draws the value it receives. There is no timer, no
  simulated pulse and no main-thread polling in the detector path.
* **Feedback protection** — a route is refused (no detector, unity gain) when the destination's
  audio can reach the source through mixer routing or a post-fader aux send, because the control
  edge would close a loop. Self-routing and missing sources are refused the same way.
* **Failure mode** — if `AudioWorklet` is unavailable or `addModule` fails, the engine logs once
  and leaves the destination at unity gain. It never substitutes a fake envelope.

## Note-triggered mode (legacy)

`audioEngine.triggerSidechainDucking(sourceTrackId, time)` schedules
`linearRamp(minGain, attack)` + `exponentialRamp(1, release)` on the destination's
`duckingGain.gain` whenever a note is triggered on the source track, where
`minGain = max(0.02, 1 − amount)`. It is skipped for destinations whose stored mode is
`level-detected`, so the two mechanisms never fight over the same AudioParam.

## Integration matrix

| Path | Level-detected ducking |
|---|---|
| Live playback (instrument voices, sustained notes, MIDI) | Yes — detector attached after the mixer graph exists; first frames can precede the module load |
| Live playback of audio clips | Yes — clips feed the same channel output |
| Song/master WAV export (`renderTimelineOffline`, used by the Export modal) | Yes — the detector module is loaded into the render's own `OfflineAudioContext` and attached before `startRendering()` |
| Deterministic re-render | Yes — identical project + settings produce identical samples |
| Per-track stems (`renderProjectStems`) | **No** — a stem renders one track in isolation, so the source track has no signal inside that render. The master mix does carry the duck |
| Bounce-in-place / channel bounce (`bounceChannelToAudioClip`) | **No** — only the bounced channel is rendered |
| Lane bounce (`bouncePlaylistLaneToAudioClip`) | Only when the sidechain source's content is on the bounced lane |

The matrix is also asserted in `browser-tests/sidechainLevelDetect.spec.ts`, which renders real
`OfflineAudioContext` audio and measures the destination's own band.

## Tests

| File | Covers |
|---|---|
| `src/audio/sidechainDetectorWorklet.test.ts` | Executes the exact worklet source in Node: below/above threshold, ratio, depth ceiling, attack/release envelope, sustained input, release to unity, determinism, bounds, meter messages |
| `src/audio/sidechainLevelDetect.engine.test.ts` | Detector attach/detach rules, tap ownership, feedback/self/missing-source refusal, idempotent syncs, metering subscribers, missing-AudioWorklet fallback |
| `src/audio/sidechainCompression.test.ts` | Depth mapping, normalization/clamping, legacy-mode migration, cycle detection |
| `src/state/phase9a.sidechainPersistence.test.ts` | Normalization on load, save/load round-trip, undo/redo of a mode switch |
| `browser-tests/sidechainLevelDetect.spec.ts` | Real Web Audio: source level changes the destination render, below-threshold silence, quieter source ducks less, audio-clip trigger with no notes, self-route safety, determinism, live detector measurement, live/offline agreement |
