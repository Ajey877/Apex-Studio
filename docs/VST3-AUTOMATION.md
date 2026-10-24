# Playlist automation of native VST3 instrument parameters

## Producer workflow

1. Load a genuine native instrument in the desktop Instruments panel. Choose a
   Playlist **Automation** clip with the existing placement tool.
2. In its existing automation drawer choose **Native VST3 Parameter**. Choose
   the channel and a genuine controller-provided parameter, then explicitly
   **Associate VST3 parameter**. The list excludes non-automatable, read-only,
   hidden, program-change, unavailable-current-value and unlabeled-list targets.
3. Edit nodes, tension, position, clip length, duplication and deletion with the
   existing Playlist tools. Curve Y is normalized 0–1, never invented physical
   units. Genuine stepped parameters quantize to the controller's step count.
4. Play in Song mode or use normal production song export. Automation is transient;
   the manual parameter editor continues to show controller/base settings.
   Save/reopen and Undo/Redo use the ordinary project and Playlist history paths.

An association pins channel ID, exact path/class ID, genuine ParamID and instrument
binding ID. New UI loads, resets and relinks get a fresh binding. They deliberately
make old lanes unavailable until explicitly reassociated. Manual base edits do not
invalidate a binding. Legacy instruments without a binding remain loadable and can
be associated with an explicit null legacy binding; a later UI replacement/relink
invalidates that association. No runtime handle, queue or PCM enters project data.
The drawer shows unavailable metadata/targets, preserves the saved identity and
requires explicit reassociation; unresolved identities also get a clip badge.
A missing native instrument still fails production export; no substitute synth.

## Architecture / concrete integration points

- `src/types/daw.ts`: existing `PlaylistClip.automationTarget` / `automationPoints`,
  augmented by the `vst3_param` target and serializable native identity.
- `PlaylistArranger` / `playlistClipOperations`: same creation, curve/node/tension
  editor, placement, split/move/resize and history callbacks; only a contextual
  controller-metadata picker is added. `automation/curve.ts` is the shared existing
  interpolation, also used by built-in automation and envelope editing/splitting.
- `AudioEngine.triggerCurrentStep`: supplies unswung audio-clock/musical-position
  anchors using the existing BPM and resolved meter. Note groove/swing remains
  unchanged. Native curves are musical-position curves, not a MIDI groove effect.
- `NativeVst3Runtime`: each existing channel instance's bounded PCM producer
  evaluates native targets immediately before processing. Parameter points and MIDI
  share the same serialized `process` call and retained polyphonic instance.
- `NativeVst3OfflineRender`: existing scheduler collects real channel MIDI; the
  same curve planner uses song time plus mastering preroll, before the production
  mixer renders. Automated channels use 1,024-frame native blocks; non-automated
  channels keep the prior 16,384-frame export batching. Stems retain channel targets.
- `Vst3Service` / `parameters.mjs` / native host: process-only offset-bearing points
  allow repeated IDs at strictly increasing in-block integer offsets. Entire
  batches are validated before native parameter writes. Manual/persisted edits
  retain their unique-ID validator. Authorization, concurrency rejection, request
  bounds, timeouts, generation cancellation and close/kill handling are unchanged.
  Native automation queues do not update controller base overrides or project state.

## Semantics and real timing limits

- Shared tension interpolation; 128-sample control grid plus clip starts, ends,
  curve vertices and clock discontinuities rounded to the nearest sample. Points
  are ordered per ParamID, repeated values coalesced within a block, actual offsets
  retained in the VST3 queue. The native timeline is bounded to 128 clips / 4,096
  curve nodes total, and 4,096 queue points/request; malformed/nonfinite,
  duplicate/unordered offsets, invalid IDs/flags/choices and oversized curves fail.
- Before the first clip, the saved controller/base value applies. Endpoints latch
  until a later clip, removal/mute/rebind or transport reset, following existing
  Playlist latch behavior. Native endpoints are evaluated explicitly rather than
  relying on the last sixteenth-note callback. Last active clip in Playlist order
  wins overlaps; the most recent completed clip supplies a held endpoint.
- A seek/restart clears native PCM, events and clock segments, asynchronously
  re-prepares the instance through the existing Play preparation path, then rebases
  automation at the new scheduled musical step. Existing step-grid note chasing is
  unchanged: seeking into a held MIDI note does not reconstruct that held voice.
- Song mode has the existing arrangement-end stop, not a newly invented loop mode.
  Pattern mode still loops patterns and does not consume Playlist automation.
  Repeated pattern clips in a Song do not reset the Song's automation time. Explicit
  seek/rewind discontinuities clear old-pass events; the planner also handles clock
  wraps inside processing blocks.
- Live IPC/PCM production retains the existing approximately 50 ms buffered lead.
  Playlist edits become visible at the next scheduler update plus buffered audio;
  no attempt is made to rewrite buffers already scheduled on the audio thread.
- **Not sample-accurate DSP automation:** MDA JX10 consumes the last parameter point
  in each processing block. Its effective resolution is therefore 1,024 frames
  (~21.33 ms at 48 kHz), despite genuine sub-block offsets reaching the queue.
  Other plugins may honor offsets differently. Live native processing starts at
  the first note; offline processing starts at song zero. Corresponding musical
  curves are evaluated in both paths, but arbitrary live/export PCM equality is
  not claimed for different block phases or plugin-internal time dependence.
- No hardware listening/device-driver validation is claimed. Native plugin code
  retains the existing desktop trust model; it is not a security sandbox.

## Reproducible acceptance evidence

`npm run native:vst3:build`, `test:native-vst3`, `test:vst3-daw` and
`test:vst3-browser` are native-required gates (missing fixtures fail, not skip).
Pinned real MDA JX10 / VCF Freq (ID 6) tests measure actual destination PCM and
production exports, independent native reference scheduling, constant/fixed
controls, repeatability, two simultaneous channel instances, seek/rewind/stop,
endpoint latch, muted clips, stale identity, undo/redo and serialized reopen.
Negative curve/offset/ownership/fault fixtures are not positive audio evidence.

Measured output is written under ignored `build/native-evidence/`, notably
`apex-vst3-automation-metrics.json`. The native browser gate exercises actual
Playlist creation/association/node Undo/Redo/IndexedDB reload and production PCM.
Windows packaged smoke also saves the curve through real preload IPC and verifies
its state, changed native export and exact PCM checksum after a separate app
process exits/restarts. CI must pass that step before claiming packaged proof.
