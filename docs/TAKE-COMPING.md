# Phrase-level take comping (Phase 10A)

Current state as of 2026-10-23. This document describes what is implemented, how it is
represented, and what it deliberately refuses to do. It does not replace the feature audit in
[`FEATURE-TRUTH-AUDIT.md`](FEATURE-TRUTH-AUDIT.md), which is a historical record.

## What comping is here

Two or more recording passes over the same track and the same bars form a **take group**
(`takeGroupId`, `takeIndex`, `activeTakeIndex` — Phase 1M). Phase 10A adds a second, finer
selection on top of that group: an explicit list of **phrases**, each naming the take that
sounds inside it.

- Whole-take selection is unchanged and still first. A group with no phrases behaves exactly as
  it did in Phase 1M, and **Revert to whole take** returns to it.
- A comp is *not* a new kind of clip and *not* a render. It is a validated description of which
  existing take clip plays which window of the group's timeline.

## Representation: persisted regions, derived segments

Three shapes were possible: materialize one clip per phrase, add a separate "comp lane" object
to the project, or persist a region list on the take group and derive the audio from it.

**Chosen: persisted regions on the group, with segments derived per render.**

- `PlaylistClip.compRegions?: TakeCompRegion[]` — group state, replicated on every clip of the
  group because clips are the project's persistence unit (there is no group object to hang it
  on). `normalizeTakeCompRegionsInClips()` picks one canonical copy (the clip with the lowest
  `takeIndex`, ties broken by id) and writes it to every clip of the group, so a hand-edited or
  partially written document resolves deterministically instead of depending on array order.
- `TakeCompRegion = { id, startBar, lengthBars, takeIndex, crossfadeBars }` — bars relative to
  the group's start, the take choice explicit per region, and the trailing crossfade owned by
  the outgoing phrase.
- `resolveTakeCompPlan()` turns regions + real take clips + real material into
  `TakeCompSegment[]`: `{ takeClipId, takeIndex, startBar, endBar, fadeInBars, fadeOutBars }`.
  The engine schedules those segments; nothing else in the stack knows about phrases.

Why not materialized clips: a phrase boundary is not on the step grid once a crossfade is
centred on it, and the live scheduler triggers audio clips only at exact step boundaries. Derived
clips would also duplicate the truth and break "revert to whole take" and re-editing.
Why not a comp lane object: a new top-level project entity would need its own history,
persistence, migration and validation, and would still have to be resolved into the same
per-take windows at render time.

The trade-off is that a comp is a *reference* to take audio: it cannot survive the deletion of a
take it names (the phrase becomes silent and is reported), and it cannot repair missing assets.

## Audio path

Both live playback and offline render reach the same code:

```
playAudioClipWithFades(clip, startTime, elapsed)
  └─ resolveCompSegmentsForClip(clip)          → null = Phase 1M whole-take path
     └─ scheduleCompClipSegments(...)
        └─ scheduleClipSource(virtualClip, startTime, 0, { fadeInSec, fadeOutSec })
```

- Each segment becomes a **virtual clip**: the take clip with `offsetSteps` advanced by the
  phrase's position in the group, `lengthBars` set to the phrase length (plus crossfade
  overhang), and clip-level fades kept only on the assembled performance's outer edges. All of
  the engine's existing trim, rate, pitch, seek and buffer-bounds maths apply unchanged.
- `scheduleClipSource` grew one optional argument: explicit equal-power fade lengths per side.
  Without it, behaviour is byte-identical to before (exponential clip fades plus the 2 ms
  de-click).
- Live trigger, seek/resume and lane-unmute re-triggers all go through the same dispatch, so a
  seek into the middle of a comp starts the phrase under the playhead at the right offset.
- `renderTimelineOffline` (WAV export, stems, bounce-in-place) schedules the same segments, so
  preview and export cannot diverge. Audibility is shared too: `resolveInaudibleTakeClipIds()`
  now answers from the regions when a group has them.

## Crossfade law

Equal power, on both sides of the seam:

```
fade-in(t)  = sin(t·π/2)      fade-out(t) = cos(t·π/2)
```

scheduled with `AudioParam.setValueCurveAtTime` (33 points) on the segment's own gain node, so
both takes are real simultaneous sources and the summed power stays flat. Equal *amplitude*
fading would dip ~3 dB at the seam for uncorrelated takes; leaving both at unity would raise it
~3 dB.

Window placement is resolved per boundary, bounded by real material:

1. **Centred** — `[b − c/2, b + c/2]` when both neighbours can reach into each other (the normal
   case: two takes of the same phrase share a timeline, so the incoming take always has lead-in).
2. **Post-roll** — `[b, b + c]` when only the outgoing take has tail material.
3. **Pre-roll** — `[b − c, b]` when only the incoming take has lead-in material.
4. **Guarded cut** — a ~5 ms fade inside each phrase when neither side can overlap. No invented
   audio, no click.

`c` is clamped to the phrase's `crossfadeBars`, to half of either neighbouring phrase, to the
outgoing take's remaining buffer, to the incoming take's available lead-in (its `offsetSteps`
trim plus the distance from the group start), and to the distance to bar 0. Adjacent phrases that
name the same take are merged into one segment: their audio is sample-continuous, so a blend
there would only dip the level.

## Validation and deterministic behaviour

`normalizeCompRegions()` is the only entry point for region lists. It drops what cannot represent
audio (non-finite, non-positive, negative start, duplicate id, overlap — the later phrase loses)
and reports why. Then:

| Case | Behaviour |
|---|---|
| Gap between phrases | Silence. Reported as a gap; neighbouring phrases are never stretched. |
| Overlapping persisted phrases | The later one is dropped and reported. Two takes never claim one instant. |
| Phrase past the end of the group | Trimmed to the group end, reported. |
| Phrase naming a missing take | Silent, reported. The rest of the comp still plays and exports. |
| Phrase naming a take whose asset is unavailable | Silent and reported **and export refuses** (Phase 8B rule). |
| Phrase that needs material past a take's buffer | Segment trimmed to the material, crossfades rescaled, reported. |
| Group with no valid phrases | Falls back to Phase 1M whole-take behaviour. |

## Undo, persistence and the editor

- The editor never owns audio state. Edits are published to project state (`Audition`) so the
  shared engine plays them immediately; `Apply comp` commits one history entry
  (`Edit take comp` / `Revert take comp`); `Discard` and closing the window restore the
  persisted comp. Undo/redo therefore restore exact regions and boundaries, and redo re-applies
  them.
- Persistence needs no new storage: `serializeProjectState` writes the whole document, and
  `normalizeProjectState` canonicalizes the regions on the way in.

## Evidence

- `src/audio/phase10a.takeCompRegions.test.ts` — 47 pure-model tests: normalization, equal-power
  law, plan geometry (centred / pre-roll / guarded cut), material bounds, merging, gaps, missing
  takes/assets, audibility, editing helpers, persistence round-trip, undo/redo.
- `browser-tests/takeComping.spec.ts` — 8 real-browser tests (10 with the existing theme spec):
  220 Hz take A then 880 Hz take B in the exported WAV; the seam measured as a genuine
  equal-power blend (`seamRms / steadyRms` ≈ 1.0, both tones present at ≈0.71); `offsetSteps`
  trim mapping; 90 BPM and 3/4 timing; changing a phrase's take changing the PCM; live
  `AudioBufferSourceNode.start` calls matching the export plan; missing take/asset behaviour;
  and a save → cold page reload → re-render round-trip with real persisted WAV assets.
