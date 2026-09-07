# Apex Studio Repository Audit — 2026-09-07

## Overall assessment

Apex Studio has a solid DAW foundation and is past the prototype stage, but the production path is not yet finished. The immediate priorities are release-critical audio parity, Playlist Undo/Redo integration, and regression coverage. No broad architecture rewrite is recommended.

## Current branch model

Keep `main`, `phase-7-audio-playback-parity`, `phase-8b-playlist-history`, and `phase-6d-recording-roundtrip` temporarily. Historical branches were already cleaned up.

## Strengths

- Browser DAW and Windows Electron packaging are established.
- Recording persistence and reload hydration are implemented.
- Project state and binary audio assets are separated in persistence.
- Playlist editing has a reusable operation layer for move, resize, split, duplicate, and delete.
- Offline project rendering exists.
- Phase 8A provides in-memory snapshot history with a 50-entry cap and no-op suppression.
- CI, audio validation, and desktop validation workflows exist.

## Release blockers / high-priority gaps

1. PR #63 is still open and not merged. It contains the live/offline audio clip playback parity work and should be the next release-critical integration.
2. Phase 8B PR #64 contains the playlist history foundation, but the actual PlaylistArranger/App integration is not yet complete.
3. `audioEngine.ts` remains a large monolith. Defer architectural extraction until functional parity and regression coverage are complete.
4. `audioPlaybackLifecycle.ts` still relies on prototype patching and private engine access on `main`; PR #63 addresses this path and should remain isolated until validated.
5. `tsconfig.json` does not enable `strict`; do not enable it globally as an opportunistic change because the repository is not currently prepared for a safe strict-mode migration.
6. README advertises Ctrl+Z/Ctrl+Y even though keyboard Undo/Redo is intentionally deferred to Phase 8D. Documentation should be corrected when the release train reaches the appropriate phase.
7. Offline render fidelity is improved but not fully equivalent to the live mixer/effect graph; this is a later parity task, not a reason to rewrite the renderer now.

## Recommended execution order

1. Finish and manually accept PR #63, then merge and revalidate `main`.
2. Finish Phase 8B Playlist Undo/Redo integration and validate it independently.
3. Proceed to Phase 8C only after 8B is green.
4. Perform a release-oriented regression/hardening pass after the Phase 8 history sequence.

## Scope discipline

Do not add AI, cloud/auth, collaboration, new instruments, new effects, advanced warp, or an audio-engine architecture rewrite during this sequence.
