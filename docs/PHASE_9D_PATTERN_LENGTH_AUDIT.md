# Phase 9D — Pattern Length + Export Consistency Audit

Canonical base: `254e3866e5e94132ef0345f0f7e010e7ac148f60` (`origin/phase-5-5-song-mode-verification`, fetched 2026-09-19).

- Phase 9B is present through merge commit `aaa7bb8` / implementation `4fb4d07` (PR #98).
- Phase 9C is present through merge commit `254e386` / implementation `5df22ae` (PR #99).
- The canonical worktree was clean before this phase began.

## Pre-change deterministic reproductions

1. **Channel Rack length control:** `ChannelRack` owned `useState<16 | 32>(16)`. The buttons called only `setStepLength`; no pattern mutation existed. Driving its real CLR path at “32 STEPS” changed `Channel.steps.length` to 32 while `Pattern.lengthSteps` remained 16.
2. **32-step content:** a project with events at 0/15/16/20/31 and `Pattern.lengthSteps = 32` played and persisted all events through the Phase 9B path, but a newly mounted Channel Rack rendered only its local 16 cells and mapped the step-20 playhead to column 4.
3. **Declared 32 with empty tail:** live Pattern Mode was 32 steps because App passed the declaration to `audioEngine.play`; Pattern export was 16 because `ExportModal` had no Pattern and `renderTimelineOffline` called `resolvePatternLoopLengthSteps(channels)` without the declaration.
4. **64 steps:** the model (`number`), persistence, Phase 9B playback, and content-derived export supported 64. A declared 64 with only first-bar content exported with a 16-step loop inside the four-bar render window. The Channel Rack intentionally offered only 16/32.
5. **Padded stale array:** a 16-step declaration with a 32-slot `Channel.steps` array resolved to 32, so channel storage could override the Pattern declaration even if its later slots were empty.

The pre-change reproduction scripts were run from a temporary directory outside the repository and were not committed.

## Ownership decision

`Pattern.lengthSteps` is the single authoritative Pattern Mode/edit/export loop length.

`Channel.steps` and `Channel.notes` remain Channel-scoped storage. Changing one Pattern must not rewrite shared Channel data:

- **16 -> 32:** do not pad channel arrays. The rack grows an array only when a later cell is written.
- **32 -> 16:** preserve all later cells and notes internally, including active events. Pattern Mode and Pattern export ignore them while the declaration is 16; extending or undoing reveals them again.
- Rack FILL/CLR edits only the visible declared range and preserves hidden later events.
- Song Mode and Bounce-In-Place keep their established channel-content semantics.

This avoids silent musical-data loss and prevents one Pattern edit from destructively changing Channel-scoped data another Pattern can use.

## Occurrence classification

The search covered `lengthSteps`, `stepLength`, `steps.length`, `Array(16)`, `Array(32)`, `% 16`, `% 32`, `< 16`, `< 32`, `<= 15`, `<= 31`, and `stepsPerBar`.

### A — Pattern-length state

- `Pattern.lengthSteps` in `src/types/daw.ts`.
- Default pattern and preset declarations in `projectState.ts`, `presets.ts`, and App's pattern creation path.
- `selectedPatternId` and selected-pattern lookup in App/Channel Rack.
- Project bundle pattern JSON (`ProjectBundleZipModal`) already includes `lengthSteps`.
- Phase 9D centralizes declaration reading/writing in `src/state/patternLength.ts`.

### B — Legitimate 16-step defaults

- Blank/default channels use 16 slots (`projectState.ts`, App channel creation, sample channel creation).
- Audio Slicer emits a 16-pad/step slice pattern.
- Gross Beat's `gateSteps` is explicitly a 16-step effect pattern.
- Presets and newly created Patterns remain 16 by default.

These are defaults or separate fixed-grid features, not competing Pattern length state.

### C — UI-only state

- Pre-change `ChannelRack.stepLength` was the defect and was removed.
- Piano Roll's historical 32-column editor was UI width, not Pattern state. It remains a 32-step minimum and expands for a declared 64+ pattern; no note data is removed when a Pattern is shorter.
- Polyphonic editor, Take Comping, Transport time display, and video-scoring grid constants are their own UI domains.

### D — Playback logic

- `AudioClockTransport.stepsPerBar` remains 16 because bars are four beats at four steps/beat.
- `setPatternLoopSteps` is the Pattern Mode override; Song Mode stays on the bar grid.
- `resolvePlayableContentLengthSteps` remains channel-content resolution for Song Mode and Bounce-In-Place.
- `resolvePatternLoopLengthSteps` is the only Pattern Mode/export loop resolver. A supplied declaration is authoritative; content-derived resolution is a compatibility fallback only when no Pattern model is available.
- `% 16` in Gross Beat and bar-relative Song Mode scheduling is legitimate and unchanged.

### E — Export logic

- `ExportModal` now receives the selected declaration from App and passes it to the existing offline render API.
- `renderTimelineOffline` passes it to the existing `resolvePatternLoopLengthSteps`; it does not duplicate resolution.
- `getProjectRenderBars` retains the documented four-bar Pattern window for 16/32/64, and expands for declarations above 64 so they cannot be truncated.
- Standard MIDI event-channel `% 16` is the MIDI channel count, unrelated to Pattern length.

### F — Unrelated

- Playlist `STEPS_PER_BAR = 16`, clip offsets/resizing/splitting, automation positions, Transport bar arithmetic, audio clip scheduling, effect-gate indexing, MIDI's 16 channels, slicer pad modulo, and UI percentage grids are unrelated to Pattern loop ownership and were not changed.

## Persistence/history architecture

No schema migration is required: `Pattern.lengthSteps` already serializes as ordinary project data, project normalization preserves it, project bundles include it, and history snapshots use the same serialization boundary. Phase 9D adds one pure `updatePatternInProjectState` mutation and routes the Channel Rack click through App's existing `mutateProjectState`/`ProjectHistory` path.
