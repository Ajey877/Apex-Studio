# Full-pattern Playlist clips: decision and audit

## Baseline
Remote `main` verified at `84ac3ff29d11446f92e664ac6c7f90bb6be99567`.
Work is isolated on the Arena session branch, based directly on that squash commit,
not PR #243's old session history.

PR #205 is an experimental AudioWorklet/WASM spike under `experiments/` with its
own workflow; it does not change the production scheduler. PR #237 adds only
`docs/automated-change-validation-checklist.md`. Neither is required or changed.

## Actual implementation and smallest safe extension
PR #243 already owns independent steps/notes per pattern. Selected content lives
on channels; non-selected content lives in `Pattern.channelContent`. Atomic
selection swaps and `selectPatternInHistory` preserve history. Instrument settings,
custom samples, channel mute/solo, pan, volume and mixer insert identity are global
channel state, not pattern content. Keep that model.

Existing Song clips resolve `patternId`, but trigger only `channelId` and loop
that channel's onset-derived, meter-rounded content extent. WAV shares the live
`triggerCurrentStep`; stems filter clips per channel, and MIDI mirrors scheduling.
Playlist lanes are placement rows, not instrument or mixer identities. Lane mute
is a trigger gate. Lane `solo` is currently inert (not newly implemented here);
Channel Rack solo uses `isRackChannelAudible`. Audio clips use their buffer and
channel route (or lane-derived insert), and automation evaluates before notes on
isolated channel/mixer snapshots. Project saves/history clone and normalize clips;
audio assets use the existing buffer publication/hydration boundary.

Add **`patternScope: 'all'`** only to new full-pattern clips. Absence always means
the historical channel clip, even when `channelId` is absent. No legacy migration,
no inference from a missing channel, and no changes to demo clips. Full clips need
a real pattern reference; an unknown/deleted pattern is silent and shown as missing,
not substituted with the selected pattern. A shared channel resolver and loop policy
feed live scheduling, offline rendering, dry/wet stems and MIDI. Channel instrument
and mixer identity are never replaced by the Playlist lane.

## Timing contract
- New Draw placements retain the established **four-bar clip window** (timeline
  clamped). Moving never changes content or source phase.
- Only full-pattern clips use the referenced pattern's **declared** length as one
  shared loop. It uses the existing Pattern Mode resolver: legacy 4/4 rounds to
  whole bars; supported non-4/4 meters keep absolute declared steps. Hidden content
  beyond that boundary remains stored but does not sound. Empty short channels
  do not independently repeat early. Note tails do not lengthen a loop.
- Right resize changes the playback window, repeating the loop as needed, not
  stretching notes. Left trim and split advance the shared `offsetSteps` by the
  project bar size. Left extension reveals only previously trimmed source, as
  before. Duplicate keeps reference, scope, length and phase. Retarget changes
  only the pattern reference; position, lane, window and offset are preserved.
- Legacy per-channel clips retain content-extent loops, offsets and timing.
- Clip/lane mute gates the whole block; channel mute/solo gates individual voices.
  Already-triggered note tails follow existing lane mute rules (not hard-cut).
- Overlapping clips are additive, including two whole-pattern clips. No implicit
  deduplication or conversion of legacy per-channel arrangements.

## UI
Draw uses the selected pattern, independent of row/channel order. Whole-pattern
clips show the pattern's current name and an “All instruments” badge, and preview
the union of real channel onsets in the first 16 steps. Legacy clips retain their
channel identity. The inspector retargets either kind without changing its scope.

## Bounce-In-Place and audio compatibility
A lane containing a full-pattern clip bounces its **actual arrangement window**,
including every instrument, other material on that lane, offsets, distinct pattern
references and applicable automation. Scheduling retains absolute timeline phase;
only the resulting PCM is cropped. Legacy-only lanes retain their existing earliest
channel/content bounce behavior. The bounce is additive, not a destructive freeze:
source clips remain, and the status message tells the user to mute the source to
audition the bounce alone. As before, the result ends at the lane window, not an
extra post-window FX tail.

The new lane bounce is pre-master: channel/insert/bus/aux processing is baked, while
master strip FX, mastering, master gate and master automation remain on playback.
The resulting unassociated audio clip explicitly routes to Master (`audioMixerTrackId:
0`) rather than passing through the lane's insert a second time. All old audio clips
keep channel/lane routing. Normal exports keep the default complete master stage.
Audio clips retain their established 2ms outer-edge safety fade, so the very first
attack of a bounced buffer can differ slightly; later onsets retain their mix.
If arrangement/instrument inputs change or the view is replaced while a new lane
bounce is pending, its result is discarded instead of publishing stale clips.
Existing audio persistence/publication stores its real PCM before project references.

## Compatibility boundaries / limitations
- Old versions do not understand `patternScope: 'all'`; backward *loading into the
  new version* is supported, not playback of new full clips in old releases.
- Lane solo, per-note mute, arpeggiator-to-MIDI expansion, audio-to-MIDI and mixer
  DSP in MIDI remain outside this milestone. Standard MIDI exports the arrangement's
  note events/tempo, not audio, insert processing or automation curves. Those are
  existing format/product limitations, not claimed parity of timbre.
- Lane mute prevents new note triggers but does not cut already sounding note tails,
  matching existing behavior. Channel mute/solo still cancels channel voices.
- Full clips with missing pattern references are silent, visibly marked, and not
  silently pinned to a different pattern on a subsequent selection.

## Regression approach
Five newly added full-pattern engine/export regressions failed before fan-out was
implemented; all pass after it. The live transport tests drive `play()` through
`AudioClockTransport`, while browser tests also exercise real instrument DSP,
OfflineAudioContext, a live AudioContext take, insert/bus/aux routing, pre-master
bounce, WAV decode, MIDI decode and IndexedDB PCM hydration. New state tests cover
clip operations, distinct patterns, selection-neutral replacement protection,
save/reload and undo/redo. Existing per-channel, audio, automation and integrity
suites remain in the validation matrix. One pre-existing mismatch is repaired:
Song pattern clips now honor their `mute` flag (MIDI/stems already did).

Exact final-head validation results are recorded in the pull request, including
whether Windows packaged runtime validation completed. No physical audio-device
or representative Windows laptop testing is claimed by the sandbox runs.
