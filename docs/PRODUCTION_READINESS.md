# BooMBox Production Readiness

## Product principle
A feature is not considered shipped because it has a button or polished UI. It must complete its promised workflow, handle expected failure states, and be covered by repeatable validation.

## Current stabilization priorities

### P0 — correctness
- TypeScript must pass with no errors.
- Production Vite build must pass.
- Playback must stop cleanly and not leave orphaned voices or timers.
- AudioContext initialization and resume paths must be deterministic.
- Recording permissions and MediaRecorder failures must surface actionable errors.
- Export UI must only advertise formats that are actually produced.
- Save/load must validate project data and recover gracefully from corrupt local state.

### P1 — professional workflow
- Autosave with explicit recovery state.
- Undo/redo for all destructive editing operations.
- Stable project schema with a version field and migrations.
- Keyboard shortcuts must not interfere with focused text inputs.
- Sample loading must report unsupported or failed files.
- Long projects must derive render length from the arrangement rather than a hard-coded bar count.

### P2 — desktop readiness
- Add a Tauri shell after the web core is stable.
- Native open/save dialogs.
- Recent projects and autosave recovery.
- Windows installer and Linux packages.
- Explicit permissions and CSP review.
- Cross-platform filesystem abstraction rather than direct browser-only assumptions.

## Architecture direction

Split the current large application surfaces into focused modules:

- `audio/core`: AudioContext lifecycle, transport and scheduling.
- `audio/mixer`: routing, effects and meters.
- `audio/render`: offline rendering and encoders.
- `audio/midi`: device discovery and message normalization.
- `project`: schema, migrations, serialization and persistence.
- `state`: UI/project commands and undo history.
- `features`: piano roll, playlist, channel rack, mixer and recording.

The goal is to make the audio engine independently testable and prevent UI state from becoming the source of truth for audio timing.

## Definition of done for every feature

A feature is complete only when:

1. The promised action works end-to-end.
2. Failure states are visible to the user.
3. The feature does not silently corrupt project state.
4. It passes TypeScript and production build validation.
5. It has manual test steps documented until automated coverage exists.
6. Unsupported platforms or formats are explicitly identified instead of simulated.
