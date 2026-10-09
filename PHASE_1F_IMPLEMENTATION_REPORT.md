# PHASE 1F — TRUTHFUL 3/4 TIME SIGNATURE RUNTIME: IMPLEMENTATION REPORT

## Summary

```text
Phase 1F:      Truthful 3/4 meter — stepsPerBar(project.meta.timeSignature) is the runtime bar size
Base SHA:      863c0109c867631c77c8830be6ee53692d7d3c3e (origin/main, Phase 1E merge PR #196)
Head:          uncommitted working tree on arena/9a04526b-apex-studio (no commit per instructions)
Files changed: 25 modified, 2 added, 0 deleted
Resolver:      resolveProjectTimeSignature / isRuntimeSupportedMeter (src/music/musicalTime.ts)
RED tests:     45 failing before implementation (14 runtime assertions + all 31 resolver/MIDI/recording tests via module-level RED); 4 regression anchors green by design
GREEN tests:   50 new Phase 1F tests pass (18 runtime + 31 resolver/MIDI/recording + 1 resync publication)
Full suite:    test:all 2091/2091, test:audio 1371/1371, test:history 610/610, test:timing 115/115
TypeScript:    tsc --noEmit exit 0
Build:         vite build exit 0
Discovery:     192/192 test files covered, 0 orphaned (no package.json change needed)
```

## Baseline (verified before implementation)

- `origin/main` = HEAD = `863c0109c867631c77c8830be6ee53692d7d3c3e` ("Merge pull request #196" — the Phase 1E merge).
- Working tree clean, no unrelated local changes.
- Baseline suites green: test:all 2041/2041, test:audio 1321/1321, test:history 610/610, lint exit 0.

## The audited problem

`meta.timeSignature` was persisted and editable through `updateProjectMetadataInProjectState`, but every
runtime path derived its bar size from `LEGACY_TIME_SIGNATURE = [4,4]`: a 3/4 project played, rendered,
bounced, exported and displayed as 4/4 (16 steps / 2.0 s per bar at 120 BPM instead of 12 steps / 1.5 s).

The pure math in `src/music/musicalTime.ts` was already correct (`stepsPerBar([3,4]) === 12`) and was NOT
rewritten — Phase 1F wires the resolved project meter through the runtime.

## The meter resolution authority

`src/music/musicalTime.ts` (the mathematical authority) gains:

- `isRuntimeSupportedMeter(candidate)` — original Phase 1F support set: `[4,4]`, `[3,4]`, and mechanically
  `[6,8]` (documented below). Phase 1I adds `[7,8]`; other meters remain deferred.
- `resolveProjectTimeSignature(meta)` — returns the stored meter when supported, otherwise the frozen
  `LEGACY_TIME_SIGNATURE` `[4,4]`. Pure: never mutates its input, never touches pattern data.

Support-set rationale:
- `[3,4]` is the Phase 1F target (12 sixteenth steps per bar, 3 quarter-note beats).
- `[6,8]` resolves mechanically to the same 12-step bar. This is explicitly documented as
  **mechanical-only** support: no dotted-quarter beat grouping, no 2+3/3+2 subdivision, no compound beat
  display. True compound-meter behaviour is deferred.
- Phase 1I adds `[7,8]` as a 14-sixteenth-step bar (3.5 quarter-note beats), with seven eighth-note beats
  in TransportBar and 1,680 MIDI ticks per bar at 480 PPQ. Its affected MIDI fingerprints are updated;
  unrelated 4/4, 3/4, 6/8 and piano-MIDI golden bytes stay unchanged.
- Other meters such as `[5,4]` and `[2,4]` remain deferred and resolve to documented 4/4 behaviour.

## Backward-compatibility rule (tested)

- Missing `timeSignature` metadata → `[4,4]` (TEST N). `normalizeProjectState` already defaults the field,
  and the resolver covers every raw shape (undefined/null/malformed/unsupported).
- Projects that persist `[4,4]` keep `[4,4]` byte-for-byte; no migration system was invented because the
  existing persistence layer (`serializeProjectState`/`normalizeProjectState`) already round-trips the field.
- `Pattern.lengthSteps` is an ABSOLUTE step quantity and is never reinterpreted:
  - `normalizePatternLengthSteps` is unchanged (still quantizes onto the legacy 16-step grid at write time —
    the Channel Rack's [16,32] choices stay valid and untouched).
  - `resolvePatternLoopLengthSteps(channels, 16, [3,4]) === 16` — a stored 16-step pattern loops at 16 in a
    3/4 project (TEST O), never silently 12 or 24. Legacy 4/4 keeps its historic whole-bar rounding
    (`40 → 48`), so Phase 1E behaviour is untouched.
  - Declared lengths in non-legacy meters are treated as absolute steps (a declared 12 loops at 12, TEST E).
- `PlaylistClip.offsetSteps` remains absolute steps; only the bar↔step conversion in split/left-resize uses
  the project bar size (12 steps/bar in 3/4, 16 in 4/4). Existing clips are never shifted by a meter change.

## 3/4 behaviour before/after (at 120 BPM)

| Quantity                          | Before 1F | After 1F |
| --------------------------------- | --------- | -------- |
| Steps per bar                     | 16        | 12       |
| Beats per bar (transport/UI)      | 4         | 3        |
| Seconds per bar                   | 2.0 s     | 1.5 s    |
| Bar boundaries                    | steps 16/32/48 | steps 12/24/36 |
| Clip at `startBar: 1`             | step 16 (2.0 s) | step 12 (1.5 s) |
| 1-bar song end                    | step 16   | step 12  |
| Offline render of 2 bars          | 4.0 s     | 3.0 s    |
| Bounce of one bar of content      | 2.0 s     | 1.5 s    |
| Recording take of 6.0 s           | 3 bars    | 4 bars   |
| MIDI clip at `startBar: 1`        | tick 1920 | tick 1440 |
| MIDI ticks per bar                | 1920      | 1440 (matches the declared 3/4 meta event) |
| Transport beat display            | could show beat 4 | 1..3 only |

## What changed (production)

1. `src/music/musicalTime.ts` — resolver + support predicate + documentation (the single meter authority).
2. `src/audio/audioEngine.ts`
   - New `meter` state, `setTimeSignature()` / `getTimeSignature()`, `currentStepsPerBar`, `secondsPerBarAt()`.
   - Removed the module-level fixed `STEPS_PER_BAR` runtime constant; every runtime consumer now derives the
     bar size from the resolved meter: `play()`, song/pattern scheduling in `triggerCurrentStep`,
     `resolveSongEndSteps`, seek/retrigger/rebase automation paths, `renderTimelineOffline` (window duration,
     song grid, bar counter), `bounceChannelToAudioClip`, clip duration + fades in `playAudioClipWithFades`,
     `synchronizePlaybackState` loop re-resolution.
   - `resolvePlayableContentLengthSteps` / `resolvePatternLoopLengthSteps` take an optional `meter`
     (default `[4,4]`): content extent rounds onto the project bar size; declared pattern lengths stay
     absolute in non-legacy meters. **Phase 1E's onset-only extent rule is unchanged** — meter sets BAR SIZE,
     Phase 1E still owns CONTENT EXTENT.
3. `src/audio/transport.ts` — `setTimeSignature()` remaps the bar grid in place; bar numbers, beat count and
   song-mode loop length use `stepsPerBar(meter)`.
4. `src/audio/recordingPipeline.ts` — `getRecordingLengthBars` / `createRecordingPlaylistClip` accept the
   meter (default legacy), so recorded takes are sized in real bars (1.5 s/bar in 3/4).
5. `src/components/playlistClipOperations.ts` — `splitPlaylistClip` / `resizePlaylistClipLeft` accept an
   optional meter for bar↔step `offsetSteps` conversion (default legacy grid).
6. `src/utils/exportUtils.ts` — MIDI export: the note grid, the clip start/end steps and the render window
   (ticks per bar) all follow the resolved meter. `getProjectRenderBars` pattern-scope window grows so a
   legacy 16-step pattern in 3/4 still fits. `MidiExportMeta.timeSignature` already fed the 0x58 meta event;
   the layout now agrees with it.
7. `src/components/ExportModal.tsx` — passes `meta.timeSignature` into `getProjectRenderBars`.
8. `src/components/PlaylistArranger.tsx` — new optional `timeSignature` prop; split/left-resize and
   imported-audio bar sizing use it (legacy default preserved).
9. `src/App.tsx` — publishes the meter to the engine (`useEffect`, mirroring BPM/swing), meter-aware bar
   seek, passes `timeSignature` to the arranger, passes it into `createRecordingPlaylistClip`.
10. `src/state/liveEngineResynchronization.ts` — the post-render-lease publication re-publishes the meter.
11. `src/components/TransportBar.tsx` — Phase 1F keeps the existing quarter-note beat display for 4/4,
    3/4 and mechanical 6/8. Phase 1I displays seven eighth-note beats in 7/8, with two sixteenth-step
    subdivisions per beat and no phantom eighth-note beat.

## Tests

New files (both auto-discovered by existing `src/**/*.test.ts` globs — no package.json change):

- `src/audio/phase1f.truthfulMeter.test.ts` (18 tests) — TEST A/M (4/4 regression), TEST B (12-step runtime
  bar), TEST C (1.5 s bar), TEST D (bar boundaries 0/11/12/23/24), TEST E (12-step pattern loop), TEST F
  (song scheduling), TEST G (offline parity incl. scheduled-step grid), TEST H (bounce parity), TEST I
  (startBar 1 = 12 steps), TEST P (Phase 1E tail invariant in both meters), plus behavioural mutation guards.
- `src/music/phase1f.meterResolution.test.ts` — original Phase 1F coverage for resolver fallbacks, no
  mutation, legacy persistence, pattern-length preservation, recording timing, MIDI layout and playlist
  arithmetic; Phase 1I extends it with 7/8 resolution/normalization, 14-step content and playlist bars,
  1.75-second recording timing, 1,680-tick MIDI bars, and unchanged 6/8 behavior.

RED capture (before any production change):
- Runtime file: 14/18 failing (`engine.setTimeSignature is not a function` + fixed-grid assertion failures);
  only the four 4/4 regression anchors passed by design.
- Resolver file: module-level RED (missing `resolveProjectTimeSignature` export) — all 31 tests red.

Updated existing tests (all direct consequences of the new wiring, nothing unrelated):
- 11 fake-transport test doubles + `phase1b.gateArchitecture.test.ts` gained the new `setTimeSignature`
  transport method (one line each).
- `src/state/phase66.postRenderResync.test.ts` mock + one new assertion that the meter is re-published.
- `src/state/patternLength.test.ts` / `src/state/playlistTimeline.test.ts` source-anchor regexes updated to
  the new call shapes (the single-source wiring contract they guard is preserved).

## Mutation guards (behavioural, no source scanners)

| Regression someone could reintroduce                       | Guard that fails |
| ---------------------------------------------------------- | ---------------- |
| 1. `LEGACY_TIME_SIGNATURE` in the 3/4 runtime path         | TEST D/F/I/G/H + "fixed STEPS_PER_BAR" guard |
| 2. fixed `STEPS_PER_BAR = 16`                              | TEST D/I + song-end-at-1.5 s guard |
| 3. fixed 4-beat transport                                  | `beatsPerBar === 3` guard |
| 4. fixed 16-step playlist bars                             | split→12 offsetSteps, left-resize credit tests |
| 5. fixed 4/4 MIDI tick conversion                          | TEST K/L (1440-tick assertions) |
| 6. offline uses a different meter                          | TEST G + live/offline/bounce parity guard |
| 7. bounce uses a different meter                           | TEST H + parity guard |
| 8. `Pattern.lengthSteps` becomes meter-relative            | TEST O + "stays absolute" guard (16 in 3/4 loops at 16) |
| 9. missing timeSignature resolves to non-4/4               | TEST N + "must resolve to 4/4" guard |

## Scope audit

NOT changed (verified by diff): MIDI parser/import (`midiParser.ts`), the second offline renderer
(`offlineProjectRenderer.ts` — still fully legacy by design), automation data model, metering/mastering,
plugin/instrument architecture, persistence format, Piano Roll UX, pattern-length UX ([16,32] choices
untouched), meter-picker UI, true 6/8 compound grouping and generalized meter-grouping systems, package
manifest/dependency changes, and the unrelated TransportBar `totalSeconds` `/4` bug — that line was not
modified (separate hotfix; it is not required by meter wiring and stays documented as a known issue).
The existing `scripts/realOfflineRenderNode.mjs` probe was extended only to verify audible 7/8 render/bounce parity.

## Remaining known issues

1. TransportBar song-time `totalSeconds` still carries the audited spurious `/4` (P1, separate hotfix —
   deliberately NOT bundled into Phase 1F; meter wiring did not require touching that line).
2. 5/4, 2/4 and other unlisted meters remain deferred and resolve to the documented 4/4 runtime behavior.
   7/8 is now supported on its 14-step bar, with seven displayed eighth-note beats and 1,680 MIDI ticks at
   480 PPQ; no generalized meter-grouping system or meter-picker UI was added.
3. 6/8 remains a mechanical 12-step bar with its existing three-quarter-beat display and no compound grouping.
4. A non-bar-aligned legacy pattern length (e.g. 16 steps in 3/4) loops at its absolute length and therefore
   drifts across bar lines — this is the required backward-compatible behaviour, not a defect.
5. Browser-based geometry tests (`tests/playlistGeometry.test.mjs`) cannot run in this sandbox because
   Playwright browsers are not installed (`browserType.launch: Executable doesn't exist`) — environmental,
   unrelated to Phase 1F; the suite fails at the launch hook on baseline too.
6. Gross Beat's fixed 16-step master gate grid is unchanged (out of scope); in short loops it simply never
   reaches steps beyond the loop, as it already did for any non-16 pattern length.

## Validation counts (post-implementation)

| Check               | Result |
| ------------------- | ------ |
| `tsc --noEmit`      | exit 0 |
| `npm run test:all`  | 2091/2091 pass (baseline 2041 + 50 new) |
| `npm run test:audio`| 1371/1371 pass (baseline 1321 + 50 new) |
| `npm run test:history` | 610/610 pass |
| `npm run test:timing` | 115/115 pass |
| `npm run lint`      | exit 0 |
| `npm run build`     | exit 0 |
| discovery           | 192/192 files, 0 orphaned |
| Phase 1A MIDI fingerprints (Phase 1F baseline; 7/8 values later re-fingerprinted by Phase 1I) | 8/8 pass (`legacyTiming.test.ts`) |
| Phase 1E extent suite | passes inside test:audio/test:all |

Status: Phase 1F was complete at the time of this historical report. Current Phase 1I implementation and verification follow.

## Phase 1I addendum — 7/8 meter support (2026-10-09)

- Runtime resolution now admits 7/8 as a 14-sixteenth-step bar (3.5 quarter-note beats / 1.75 seconds at 120 BPM). TransportBar shows seven eighth-note beats with subdivisions 1–2; 4/4, 3/4 and mechanical 6/8 behavior remain unchanged.
- MIDI uses 1,680 ticks per 7/8 bar at 480 PPQ. Only the six affected 7/8 Standard MIDI fingerprints were regenerated; piano-MIDI and other meter expectations remain pinned.
- The real offline-render probe now checks 7/8 WAV scheduling and bounce through `web-audio-engine`, including finite, non-silent PCM. Incomplete AudioParam methods in two test-only fake contexts were completed after they caused swallowed instrument-renderer failures; no `createOscillator is not a function` warning remains.
- Verification: focused meter/TransportBar/MIDI tests 75/75; `npm run test:timing` 121/121; `npm run test:audio` 1395/1395; `npm run test:history` 647/647; `npm run lint` and `npm run build` pass; `npm run test:browser:node` 9/9, including audible 1.75-second 7/8 render and bounce. The build retains Vite's existing advisory for a minified chunk over 500 kB. The audio suite's only renderer-failure log is its intentional negative-path fixture.
- Work is on the Arena-pinned `arena/c11a1e89-apex-studio` branch, based on the verified `main` SHA `23a12d506a3871b4164d157426bd3794bf5c382f`. PR [#200](https://github.com/Ajey877/Apex-Studio/pull/200) is open against `main` and has not been merged.
