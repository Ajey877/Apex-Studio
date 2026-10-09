# Phase 1M: Comping Lanes and Take Management — Implementation Report

## Summary

Phase 1M introduces take-lane comping: the ability to group multiple recording passes (takes) belonging to the same musical region, select which take is active and audible, and preserve every recorded take when switching selections. This is the foundation for non-destructive vocal/instrument comping workflows.

## Architecture

### Data Model

Extended `PlaylistClip` with three optional fields:

- `takeGroupId?: string` — Groups clips belonging to the same comping region
- `takeIndex?: number` — Which take within the group (0-based)
- `activeTakeIndex?: number` — Which take is currently selected/audible

Clips without `takeGroupId` are ordinary clips; take rules do not apply to them. This is fully backward-compatible with pre-Phase 1M projects.

### Core Module: `src/audio/takeLaneManager.ts`

Pure functions for take management:
- `resolveActiveTakeIndex()` — Determines which take is active (declared or latest by default)
- `isTakeAudible()` — Per-clip audibility check
- `resolveInaudibleTakeClipIds()` — Batch computation for playback scheduling
- `selectActiveTake()` — Changes the active take (non-destructive)
- `getTakeGroupClips()` / `getTakeGroupIds()` — Group introspection
- `validateTakeGroup()` — Validates geometry consistency and uniqueness
- `removeTakeFromGroup()` — Removes a take with fallback active selection
- `nextTakeIndexForGroup()` / `createTakeGroupId()` — New take creation

### Recording Pipeline: `src/audio/recordingPipeline.ts`

Added:
- `createTakeRecordingPlaylistClip()` — Creates a clip for a new recording take, auto-assigning it to a group
- `applyTakeSelectionToClips()` — Persistence-safe way to change take selection

### Audio Engine: `src/audio/audioEngine.ts`

- Added `inaudibleTakeClipIds` field (refreshed on every clip update)
- Added `isClipTakeInactive()` helper
- Integrated take-inactive check into:
  - Live playback step trigger
  - `retriggerAudioClipsAtPosition()`
  - `retriggerAudioClipsForChannelAtPosition()`
  - Offline render validation
  - Stem export clip filtering (4 paths)
- The `refreshInaudibleTakeClipIds()` is called after every `this.activeClips = ...` assignment

### Offline Renderer: `src/audio/offlineProjectRenderer.ts`

- `getOfflineRenderPlan()` now excludes inactive takes from the render plan
- Export validation skips inactive takes (like muted-lane clips)

## Persistence and Undo/Redo

- Take fields are plain JSON-serializable properties on `PlaylistClip`
- `normalizeProjectState()` preserves them unchanged (no stripping)
- `serializeProjectState()` round-trips them correctly
- Project history snapshots (full project state serialization) preserve take selection
- Undo/redo naturally works through the existing snapshot mechanism

## Changed Files

| File | Change |
|------|--------|
| `src/types/daw.ts` | Added `takeGroupId`, `takeIndex`, `activeTakeIndex` to `PlaylistClip` |
| `src/audio/takeLaneManager.ts` | **NEW** — Core take management logic (pure functions) |
| `src/audio/recordingPipeline.ts` | Added `createTakeRecordingPlaylistClip()` and `applyTakeSelectionToClips()` |
| `src/audio/audioEngine.ts` | Added take-inactive filtering to playback, seek, and export paths |
| `src/audio/offlineProjectRenderer.ts` | Added take-inactive filtering to render plan |
| `src/audio/phase1m.takeLanes.test.ts` | **NEW** — 34 acceptance tests for take management |
| `src/state/phase1m.takeLanePersistence.test.ts` | **NEW** — 5 persistence/integration tests |

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| Phase 1M take-lane tests | 34 | ✅ all pass |
| Phase 1M persistence tests | 5 | ✅ all pass |
| Audio regression (`test:audio`) | 1579 | ✅ all pass |
| History regression (`test:history`) | 699 | ✅ all pass |
| Test discovery | 213 files | ✅ 0 orphans |
| TypeScript lint | — | ✅ no errors |
| Build (`vite build`) | — | ✅ succeeds |

## Acceptance Criteria

1. **Take lanes**: Multiple recording passes can be grouped via `takeGroupId` ✅
2. **Take selection**: `selectActiveTake()` / `applyTakeSelectionToClips()` change which take is audible ✅
3. **Playback correctness**: `isClipTakeInactive()` prevents inactive takes from sounding in live playback, seek, and resume ✅
4. **Non-destructive editing**: All take audio buffer IDs are preserved when switching selections ✅
5. **Lifecycle and persistence**: Take fields survive normalize → serialize → parse → history snapshots ✅
6. **Export correctness**: Inactive takes excluded from render plan and stem export ✅
7. **Backward compatibility**: Pre-Phase 1M projects load without errors ✅

## Limitations and Remaining Risks

- **No UI for take selection yet**: The take management logic is complete but there is no UI control for selecting takes. This is expected — the UI will be part of a follow-up phase.
- **Recording integration is partial**: `createTakeRecordingPlaylistClip()` exists but is not yet wired into the recording engine's post-capture flow. The recording engine currently creates ordinary clips.
- **No crossfade between takes**: Comp transitions between takes are instantaneous; crossfade DSP is not implemented.
- **Waveform display**: The existing `TakeCompingModal.tsx` is a demo placeholder and is not connected to the real take data.

## Design Decisions

1. **Fields on PlaylistClip rather than a separate collection**: Simpler persistence, works with existing history/undo/redo without special casing.
2. **Default active = latest take**: Matches standard DAW convention.
3. **Set-based lookup for inaudibility**: O(1) per-clip check during scheduling, refreshed only when clips change.
4. **Optional fields**: Pre-Phase 1M projects load without migration.
