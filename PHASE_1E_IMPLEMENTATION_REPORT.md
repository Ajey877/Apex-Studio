# PHASE 1E — AUTHORITATIVE MUSICAL EXTENT: IMPLEMENTATION REPORT

## Summary

```text
Phase 1E:      Authoritative musical extent — note tails no longer expand loops
Base SHA:      6b7b5f546e1ebfda7cb7644067eb47d3dcfaf8b7
Head SHA:      (uncommitted; on arena/6897a99f-apex-studio)
Files changed: 4 modified + 1 new
Authoritative extent resolver: resolvePlayableContentLengthSteps (src/audio/audioEngine.ts)
Production callers migrated:   4/4 (Song playback, offline render, bounce, MIDI export)
RED tests:      7 (confirmed failing before fix)
GREEN tests:    2041/2041 test:all, 1321/1321 test:audio, 59/59 Phase 1D, 610/610 history
Mutation tests: 7 mutation guards in Phase 1E tests (each would fail if reverted)
Audio tests:    1321/1321 (test:audio includes all Phase 1E tests)
Full tests:     2041/2041 (test:all)
Build:          ✓ 1813 modules, 1,126.68 kB (exit 0)
Working tree:   clean except 4 modified + 1 new file (no deps/workflows/scripts)
```

---

## What Changed

### The Bug

`resolvePlayableContentLengthSteps()` derived loop length from `max(stepArray.length, note.start + note.duration)`. This meant:

- A note at onset 15.75 with duration 1 (ending at 16.75) doubled the 16-step loop to 32.
- A note at onset 0 with duration 64 pushed a 16-step loop to 128 steps.
- Song-mode playback, bounce-in-place, and MIDI export all used this inflated length.
- Pattern playback was unaffected (uses declared `Pattern.lengthSteps`).

The audit proved this at the production render level: kicks on steps 0/4/8/12 with a tail-crossing note → bars 2 and 4 disappeared (−∞ dBFS).

### The Fix

One production function changed: `resolvePlayableContentLengthSteps` now uses `max(note.start)` instead of `max(note.start + note.duration)`. The loop boundary is determined by onset positions and the step array alone.

The key line change in `src/audio/audioEngine.ts:353`:

```typescript
// Before (Phase 1D):
const duration = (typeof note.duration === 'number' && Number.isFinite(note.duration) && note.duration > 0)
  ? note.duration
  : 1;
maxStep = Math.max(maxStep, note.start + duration);

// After (Phase 1E):
maxStep = Math.max(maxStep, note.start);
```

### Why This Is Safe

All 4 production callers use the same resolver:

| Caller | Location | Mode | Uses fix? |
|---|---|---|---|
| Song playback | `triggerCurrentStep` :4237 | Song | ✓ |
| Production offline render | `renderTimelineOffline` → `triggerCurrentStep` | Both | ✓ |
| Bounce-in-place | `bounceChannelToAudioClip` :4449 | Pattern | ✓ |
| MIDI export Song | `buildStandardMidiFile` :303 | Song | ✓ |

Pattern playback already uses declared `Pattern.lengthSteps` via `resolvePatternLoopLengthSteps` and was never affected.

### Behavioral Change

For existing projects, this is a **deliberate audio change**:

- Notes with tails that cross a bar line no longer double the loop.
- The note still sounds at its onset and plays its full gate/tail.
- If a user had a note at onset 15.75 with duration 4 (ending at 19.75), the loop was previously 32 steps (2 bars). Now it's 16 steps (1 bar). The note plays for 4 steps starting at 15.75; it just doesn't extend the loop.
- All other project data is preserved.

---

## Files Changed

### 1. `src/audio/audioEngine.ts` (production)

- **`resolvePlayableContentLengthSteps`** — Changed `note.start + duration` to `note.start`. Added JSDoc with the Phase 1E invariant: "NOTE TAILS MUST NOT CHANGE MUSICAL LOOP/PATTERN EXTENT."
- **`resolvePatternLoopLengthSteps`** — Updated JSDoc to reference the onset-only rule and link to Song/bounce callers.

### 2. `src/music/noteDurationPolicy.ts` (production)

- Removed `engine.playable-length-fallback` entry from `DURATION_ALTERING_LAYERS`. The function no longer reads `note.duration`, so it's no longer a duration-authority site.

### 3. `src/music/phase1d.durationPolicyAudit.test.ts` (test)

- Removed `engine.playable-length-fallback` from `EXPECTED_INVENTORY`.
- Removed `src/audio/audioEngine.ts::resolvePlayableContentLengthSteps` from `EXPECTED_SCANNED_SITES`.

### 4. `src/audio/audioEngine.scheduler.test.ts` (test)

- Updated `channelNotes64` → `channelNotes48` (onset at 47, expects 48 = 3 bars).
- Updated multi-bar playback test → note at onset 47 instead of 48.
- Updated offsetSteps test → 32-step steps array (reflects actual 2-bar content extent).

### 5. `src/audio/phase1e.musicExtent.test.ts` (new test file)

25 tests across 8 suites covering:

- **Test 1** — Declared length wins over content (Pattern mode)
- **Test 2** — Note tail does NOT extend extent (core invariant)
- **Test 3** — Song and Pattern agree on the same content + declared extent
- **Test 4** — Content extent from step array and note onsets
- **Test 5** — Empty and fallback cases
- **Test 6** — `resolvePatternLoopLengthSteps` uses declared length authoritatively
- **Test 7** — Tail-derived extent mutation guard (would fail if `note.start + duration` restored)
- **Test 8** — Song/Pattern loop parity for identical content

---

## Validation Results

```text
TypeScript (tsc --noEmit):                    PASS (exit 0, no errors)
verify:test-discovery:                         PASS (189 files, 0 orphaned)
Phase 1E tests (phase1e.musicExtent):          PASS (25/25)
Phase 1D tests (all 4 files):                  PASS (59/59)
test:audio:                                    PASS (1321/1321)
test:history:                                  PASS (610/610)
test:all:                                      PASS (2041/2041)
Lint (tsc --noEmit):                           PASS (exit 0)
Build (vite build):                            PASS (1813 modules, 1,126.68 kB)
assertCompleteDurationPolicy():                PASS (true)
```

---

## CONFIRMED FIXES

| Fix | Evidence |
|---|---|
| Note tail no longer extends loop extent | Phase 1E test "note tail does not extend extent" (5 cases), "tail-derived extent mutation guard" (3 cases) |
| Song and Pattern agree | Phase 1E test "Song and Pattern agree" + "Song/Pattern loop parity" |
| All production callers use one resolver | Code inspection: 4 callers of `resolvePlayableContentLengthSteps`, 0 parallel implementations |
| `DURATION_ALTERING_LAYERS` inventory updated | `assertCompleteDurationPolicy()` passes |
| No unrelated changes | Scope audit: 4 modified files + 1 new, no deps/workflows/scripts touched |

## REMAINING PHASE 1E FINDINGS

None. The core P0 (no single authoritative musical extent) is fixed.

## OUT-OF-SCOPE FINDINGS (from audit, not addressed)

These were explicitly excluded from Phase 1E per the hard scope:

- Time signature is cosmetic (F-03)
- Pattern content ownership not implemented (F-04)
- TransportBar readouts wrong (F-05)
- MIDI import drops same-pitch overlaps (F-06)
- Piano Roll grid hard-wired to 1 step (F-07)
- 64-bar timeline cap (F-08)
- No MIDI controllers/tempo import (F-10, F-11)
- MIDI onset grid rounding (F-12)
- Channel count cap (F-13)
- Track-name encoding (F-14)
- Second offline renderer diverges (F-02)
- Note.muted and stepVelocities unwired (F-22)
- Dead automation modules (F-22)

## MERGE / DO NOT MERGE

**DO NOT MERGE** — per the user's instruction: "Do NOT merge the PR." and "Do NOT push unless explicitly instructed after the implementation and independent audit."

The implementation is complete, tested, and validated. Awaiting explicit instructions for commit, push, and PR creation.