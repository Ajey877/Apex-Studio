# Independent Patterns — Verification Report

Base: `main` @ `5b2e5683cd0c300bdf1b1a412b459209a98508a6` (PR #242 merge).
Branch: `arena/61681038-apex-studio`.

## Defect

Patterns did not own content. `Pattern` was only `{ id, name, color, lengthSteps }`;
every pattern displayed and played the single `Channel.steps` / `Channel.notes` set, and
the Song Mode scheduler never read `PlaylistClip.patternId` (a pattern clip looped its
channel's shared content). The core FL Studio workflow — build Pattern 1 and Pattern 2,
then arrange them — was therefore impossible, and the UI actively misled:

| Pre-fix reproduction (real Chromium, shipped demo "Midnight Trap Heat") | Result |
|---|---|
| Demo patterns "Main Groove", "Melody & Pluck", "Hi-Hat Rolls" | identical content |
| Click **Add pattern** → "Pattern 4" | already contained the whole beat (`NEW PATTERN WAS EMPTY: false`) |
| Toggle kick step 0 in "Pattern 4", switch to "Main Groove" | the kick hit was gone from Main Groove (`PATTERN 1 UNCHANGED: false`) |
| Playlist | no way to choose which pattern a clip plays |

Phase 9D (`docs/PHASE_9D_PATTERN_LENGTH_AUDIT.md`) documented the shared storage as a
deliberate constraint of the length work; this milestone lifts it.

## Ownership model

`src/state/patternContent.ts` is the single owner.

- The **selected** pattern's content is the live `Channel.steps` / `Channel.notes`. Every
  existing editor and player of "the pattern" (Channel Rack, Piano Roll, MIDI import, Audio
  Slicer mapping, Pattern Mode, Pattern-loop export) is unchanged and correct by construction.
- Every **other** pattern stores its content in `Pattern.channelContent`
  (`{ channelId, steps, notes }[]`; a channel without an entry is empty there).
- A pattern **without** `channelContent` plays the live content. That is the selected
  pattern — and, in documents saved before this change, every pattern (they shared it).
- `selectPatternInProjectState` swaps content atomically (outgoing pattern stores an exact
  copy; incoming stored content becomes live). Every selection change goes through it.
- `ensureIndependentPatterns` runs before every pattern operation (select / add / clone):
  each legacy pattern gets its own copy of the live content and legacy clips that name no
  pattern are pinned to the selected pattern — the content they were playing.
- `resolvePatternChannelContent(pattern, channel)` needs no selection id, so the live
  scheduler, offline renderer, stems, MIDI export and bounce resolve content identically.
- `normalizeProjectState` (every save and history snapshot) is **lossless**: it never
  migrates a legacy document (persistence round-trips it byte-for-byte in pattern terms),
  sanitizes stored entries (drops entries for deleted channels, coerces malformed cells) and
  repairs a selection written without the swap.

## Acceptance criteria → evidence

| # | Criterion | Evidence |
|---|---|---|
| AC1 | A new pattern starts empty; the previous pattern keeps its content | `patternContent.test.ts` AC1; Playwright "a new pattern is empty…" |
| AC2 | Editing the selected pattern never changes another pattern | `patternContent.test.ts` AC2; Playwright (same test) |
| AC3 | Clone copies a pattern exactly (steps, notes, length) and is independent | `patternContent.test.ts` AC3; Playwright (same test) |
| AC4 | Selecting a pattern never changes what any placed clip plays | `patternContent.test.ts` AC4; engine "selecting another pattern mid-song changes nothing" |
| AC5 | Legacy documents load and round-trip unchanged; first pattern operation migrates without audible change | `patternContent.test.ts` AC5 (incl. shipped demos) |
| AC6 | Save/reload, undo/redo and channel deletion keep every pattern exact | `patternContent.test.ts` AC6; Playwright reload + undo tests |
| AC7 | A MIDI take lands in the pattern it started in | `patternContent.test.ts` AC7 |
| AC8 | Song Mode, WAV, stems and MIDI play each clip's own pattern | `independentPatternsPlayback.test.ts`; Playwright production-renderer test |
| AC9 | Playlist: pick the pattern for new clips, see and change a clip's pattern | Playwright "drawn clips play the selected pattern…" |
| AC10 | Selecting a pattern is never an undo step; Undo/Redo of an edit keep the pattern it was made in and restore its exact content | `patternContent.test.ts` AC10; `projectHistory.test.ts` "replacePresent…"; Playwright "Pattern selection is not an undo step" (4 specs) — see *Review follow-up* |

### Regression tests fail on the pre-fix code

`src/audio/independentPatternsPlayback.test.ts` run against `HEAD`'s `audioEngine.ts` and
`exportUtils.ts`: **9 of 15 fail** (every behavioural assertion: Verse|Chorus|Verse live,
selection-independence, empty-pattern silence, mid-song swap, stored-pattern edit, legacy clip,
offline song render, stems, MIDI song export). The 6 that pass on both are the back-compat and
invariant tests (no-pattern-model callers, Pattern Mode, render isolation, Pattern Loop MIDI).

The unchanged pre-fix Chromium reproduction script now reports
`NEW PATTERN WAS EMPTY: true` and `PATTERN 1 UNCHANGED BY PATTERN 2 EDIT: true`.

### Measured audio (real Chromium `OfflineAudioContext`, production `renderTimelineOffline`)

One minisynth channel (sine), arrangement Verse (C4) | Chorus (C5) | Empty, 120 BPM:

| Bar | With pattern model | Without pattern model (pre-fix behaviour) |
|---|---|---|
| 1 — Verse | RMS 0.109, f0 262.5 Hz | RMS 0.109, f0 262.5 Hz |
| 2 — Chorus | RMS 0.283, **f0 525.0 Hz** | RMS 0.109, f0 262.5 Hz |
| 3 — Empty | **RMS 0 (silent)** | RMS 0.109, f0 262.5 Hz |

(f0 by autocorrelation over an 8192-sample window starting 0.25 s into each bar.)

## Consumers updated

| Consumer | Change |
|---|---|
| `audioEngine.triggerCurrentStep` (live + offline) | Song Mode pattern clips resolve content per clip; `activePatterns` set by `play`, `synchronizePlaybackState`, `renderTimelineOffline` (restored after a render) |
| `renderProjectStems`, `renderProjectToWav` | forward `patterns` to every render |
| `buildStandardMidiFile` | Song scope writes each clip from its pattern (`options.patterns`) |
| Bounce-In-Place | renders the pattern the lane's earliest clip plays |
| App | pattern selection uses the swap, and history's present takes the same swap without an undo step (`selectPatternInHistory`); Clone pattern; patterns published to the engine on play, live sync, undo/redo and post-render resync; MIDI take targets its pattern |
| Channel Rack | Add pattern = empty pattern; **Clone pattern** button; `aria-pressed` on pattern tabs |
| Playlist | **Pattern** picker for new clips; pattern name badge and a first-bar preview of the real content on each pattern clip; pattern selector in the selected-clip inspector |
| Channel deletion | removes the channel's stored content from every pattern |
| Project fingerprint (replacement guard) | compares pattern content in a selection-neutral form, so clicking a pattern tab is not "work" |
| Statistics / project bundle | Total Notes counts every pattern; each `patterns/*.json` file carries its own pattern's content |

## Review follow-up — pattern selection and undo/redo

**Suspected issue (independent review):** `handleSelectPattern` updated `projectStateRef`
and React state but not project history's present, so later edits were committed against
the pre-selection snapshot.

**Reproduced — yes.** `ProjectHistory.commit` pushes its own stored present onto `past`, and
selection never touched it. Real Chromium, shipped demo, PR head `7e53c86`. Kick steps are
0-based; the content column is the autosaved document, resolved per pattern:

| Step | PR head `7e53c86` — shown | Document (every pattern) | With fix — shown |
|---|---|---|---|
| Select Pattern 2 (Melody & Pluck), toggle kick step 0 off | Melody & Pluck · `6 10` | P1 `0 6 10` · P2 `6 10` · P3 `0 6 10` | Melody & Pluck · `6 10` |
| **Undo** | **Main Groove** · `0 6 10` | P2 restored to `0 6 10` — correct | **Melody & Pluck** · `0 6 10` |
| **Redo** | Melody & Pluck · `6 10` | P2 `6 10` — correct | Melody & Pluck · `6 10` |
| Edit P2, select Main Groove, toggle kick step 2 on, **Undo** | **Melody & Pluck** · `6 10` — the undo is hidden | Main Groove restored to `0 6 10` — correct | **Main Groove** · `0 6 10` |
| Select Pattern 2, then click a playlist clip without moving it | Undo **enabled** | unchanged | Undo disabled |
| …then **Ctrl+Z** | selection reverts to **Main Groove** (a selection-only undo step) | unchanged | Melody & Pluck stays |

- **Data integrity was never broken.** In every trace, before and after the fix, every
  pattern's stored steps and notes were exact after every Undo and Redo: commits store full
  snapshots, and each restored snapshot is a state that really existed.
- **The defect is what Undo shows and records.**
  - Undo restored the selection from *before* the last pattern switch. With independent
    content, the jump lands on a different pattern, which hides the undone edit, so a user
    is invited to press Undo again.
  - A no-op commit after a switch (pointer-up on a playlist clip) recorded a selection-only
    undo step. That contradicts the documented intent: "selection is a view change, outside
    history".
- **Pre-existing on `main`.** The same trace against `5b2e568` reproduces both symptoms,
  because the old bare `selectedPatternId` write also bypassed history. There, the shared
  content made the jump visually harmless; independent patterns made it misleading.

**Intended behaviour (now pinned by tests):**

1. Selecting a pattern never records an undo step, directly or through a later no-op commit.
2. Undo returns the project to exactly how it was just before the undone change (an edit, or
   a Redo). That includes the pattern selected at that moment, never a selection that
   predates it. For an edit, that is the pattern it was made in.
3. Redo is the exact inverse of that Undo. A selection made between them keeps the redo
   stack: Redo shows the redone edit's own pattern, and undoing it again returns to the
   pattern selected before the Redo.
4. Every pattern's content is exact throughout.

**Fix — narrow; the history architecture is unchanged:**

- `ProjectHistory.replacePresent(state)`: re-expresses the present without pushing an entry.
  Past and future are kept; a semantically equal state is a no-op.
- `selectPatternInHistory(history, id)` in `patternContent.ts`: applies the *same* swap to the
  history's present. The swap is applied to the present rather than copied from the live
  state, so a change still awaiting its own commit (an open playlist drag) keeps its own
  undo step.
- `handleSelectPattern`:
  - flushes a pending continuous edit first, which belongs to the outgoing pattern;
  - then swaps the live state and history's present together.
- `commit`, `undo`, `redo`, labels, the 50-entry limit and every other caller are untouched.
- **Cost:** a pattern-tab click now re-snapshots history the way one edit commit already does.
  - Median of 15, demo project, full 50-entry history, this 2-CPU sandbox: 67.7 ms per
    selection versus 69.2 ms per commit.
  - Both were measured while a browser suite was running, so the absolute values are
    inflated; the point is that the two costs match.
  - The cost is the history module's existing per-operation snapshotting, which is left
    unchanged here.

**Regression evidence:**

| Test | On `7e53c86` | With fix |
|---|---|---|
| Playwright "Pattern selection is not an undo step" (4 specs: steps, Piano Roll notes, switch-then-undo, selection-only step) | 4 / 4 fail | 4 / 4 pass |
| `patternContent.test.ts` AC10 (8 tests, incl. a contrast test pinning the defect mechanism and an App wiring check) | cannot load (`selectPatternInHistory` missing) | 8 / 8 pass |
| `projectHistory.test.ts` "replacePresent re-expresses the present without recording an undo step" | fails (`replacePresent` missing) | passes |

## Limitations (not addressed here)

- Pattern clips are per channel lane; there is no single clip that plays every channel of a
  pattern (FL's default pattern clip).
- Patterns cannot be deleted or renamed yet.
- Song Mode clips still loop their content's own length, not the declared pattern length
  (unchanged; the declared length governs Pattern Mode and the Pattern Loop export).
- The factory demo's three patterns still hold identical content (now as independent copies);
  curating distinct demo content is product work outside this milestone.
