# PHASE 1L — PUNCH-IN / PUNCH-OUT RECORDING: IMPLEMENTATION REPORT

## Summary

```text
Phase 1L:      Bar/beat punch-in and punch-out recording: capture starts at punch-in,
               stops at punch-out, optional pre-roll that is never captured, take placed
               at the punched window, everything outside it preserved
Base SHA:      69411080133d9e01bf5ab9f7cc4c7663421337a4 (origin/main, Phase 1K merge PR #202)
Commit SHA:    854d4cb9173c3ccac15a828dacf2fcf96be9effd (implementation commit; this
               report is a follow-up commit on the same branch)
Branch:        arena/9bfc3680-apex-studio (session branch, based on the verified baseline)
PR:            #203 — https://github.com/Ajey877/Apex-Studio/pull/203 (OPEN, not merged)
Diff:          18 files, +3222 / −49 (7 new files: 2 production, 5 test suites)
Schema:        persistenceVersion unchanged. One OPTIONAL meta field added
               (meta.punchRecording). No migration: missing/malformed → punch off.
TypeScript:    npm run lint (tsc --noEmit) exit 0
Build:         npm run build (vite build) exit 0, 1822 modules (pre-existing >500 kB
               chunk advisory only)
test:audio:    1545/1545   (61 of these are new)
test:timing:   188/188     (26 new)
test:history:  699/699     (18 new)
test:shell:    256/256     (19 new)
test:metering 78/78 · test:truth 83/83 · test:effects 27/27 · test:instruments 17/17
test:lifecycle 2/2 · test:pianoroll 111/111
New suites:    98/98 across 5 files (measured directly)
Total:         3006 tests passing, 0 failures
Discovery:     211 test files, 0 orphaned
Playwright (test:playlist-geometry): 0/6 — NOT RUN. Chromium is absent from the sandbox
               and `npx playwright install` is blocked by the outbound host allowlist.
               The suite fails in its before-hook, before any assertion executes.
               Environmental, not a code defect.
```

## What musicians can now do

Open the Audio Recorder, switch **Punch recording** ON, and set a **punch-in** and
**punch-out** as BAR/BEAT positions — the same notation the transport readout shows.
Press **PUNCH RECORD**. The pre-roll clicks run up to punch-in, capture opens exactly on
punch-in, and it closes exactly on punch-out without the musician pressing Stop. The take
lands on the playlist at the punched window, at its exact fractional geometry.

Everything outside the punched window — other clips, notes, the arrangement length — is
left exactly as it was. Punch OFF records exactly as Phase 1K did.

## What changed

### Punch policy (`src/music/punchRecording.ts`, new, 428 lines)

The single pure authority for what a punch window means. Positions are **bar/beat,
1-based**, on the transport's own displayed-pulse grid (4/4 → four quarter beats, 3/4 →
three, 6/8 → six eighth pulses, 7/8 → seven). It exposes:

- `resolvePunchRecording` / `isPunchRecordingSettings` — a missing or malformed stored
  window resolves to punch off instead of throwing.
- `barBeatToBeats` / `beatsToBarBeat` / `snapBeatsToPulseGrid` / `formatPunchPosition` —
  the same conversion and `BB.B` formatting the transport readout uses, so "at playhead"
  and the readout can never disagree.
- `validatePunchRecording` — field-level issues and warnings, resolved against the
  project's **own** meter, 7/8 grouping and arrangement length.
- `planPunchCapture` — the plan the runtime executes: pre-roll start, pre-roll length,
  capture start/end in beats and seconds, project-end truncation, and clip geometry.
  Throws `RangeError` for an invalid window rather than planning the wrong music.
- `describePunchWindow` / `punchRulerSegments` — display strings and per-bar overlay
  geometry, including fractional edges.

### Punch-out scheduling (`src/audio/punchCaptureWindow.ts`, new, 183 lines)

The only new runtime mechanism: a stop moment for one take. `arm()` resolves exactly at
`captureTime + the musical length at the active tempo`; `retime(bpm)` preserves the
**remaining beats** rather than the remaining wall-clock time; `cancel()` clears the timer
and rejects with `PunchCancelledError`. `RecordingEngine` was **not** forked or extended —
capture stays in the one existing recorder path.

### AudioEngine (`src/audio/audioEngine.ts`, +253/−7)

- `setPunchRecording` / `getPunchRecording` / `isPunchRecordingEnabled` /
  `isPunchTakeActive` / `getActivePunchPlan` / `planPunchTake` / `beginPunchRecording` /
  `cancelPunchRecording`.
- `beginPunchRecording` plans the pre-roll **backwards** from the punch-in
  (`countInStartBeat = inBeats − countInBeats`) and hands it to the **existing, unmodified
  `CountInScheduler`**. The scheduler's capture moment therefore *is* the punch-in, which
  is what keeps pre-roll audio out of the take. It parks the playhead at the pre-roll start
  before arming (because `seek()` cancels takes), then arms the punch window when the
  count-in resolves.
- Lifecycle wiring: `stop()`, `pause()`, `seek()` and `cancelPunchRecording()` abort both
  phases; `setTimeSignature()` cancels the take **before** the Phase 1K count-in restart;
  `setBpm()` retimes the window in place; the song-end handler cancels only a take still
  counting in (`cancelPunchPreRoll`), because an armed window already ends at the project
  end.
- A take that reaches punch-out, or is cancelled, clears `activePunchTake`, so
  `isPunchTakeActive()` never reports a finished take as armed.

### Recording pipeline (`src/audio/recordingPipeline.ts`, +121)

- `planPunchClipPlacement` — fractional `startBar` / `lengthBars` / `trimSeconds` straight
  from the executed plan.
- `trimAudioBufferToSeconds` — trims the decoded take to the window with an injected
  `createBuffer` factory; a buffer already inside the window is returned unchanged (never
  padded, never re-allocated).
- `createPunchRecordingPlaylistClip` — builds the clip through the same validation as an
  ordinary take, and holds it inside the arrangement length it is handed.

### Recorder UI (`src/components/AudioRecorderModal.tsx`, +329/−22)

A punch section rendered only when `onUpdatePunchRecording` is supplied (so existing modal
shell tests are unaffected): ON/OFF switch, bar/beat inputs for both endpoints with an "at
playhead" button, a per-bar range preview, a summary line (`Bars 5 – 9 · 4 bars · 8.00 s`),
the pre-roll line, field-level validation issues, and warnings for a punch-out past the
arrangement end. PAUSE is disabled during a punch take (its length is fixed) and the button
reads **PUNCH RECORD**. The window is a local draft that publishes only once valid.

### App wiring, arranger and state

- `src/App.tsx` (+104/−13): publishes the window to the engine like the count-in, validates
  through the mutation boundary, passes the punched geometry to the save path, and derives
  the ruler overlay from the same document.
- `src/audio/recordingPipeline` save path: a punch take trims the decoded buffer,
  re-registers it with `setSampleBuffer` and waits for persistence before the clip is
  built, so nothing past punch-out can play, export or survive a reload.
- `src/components/PlaylistArranger.tsx` (+33): draws the punched range on the ruler.
  Display only — it never moves a clip.
- `src/state/projectMutations.ts` (+58/−3): `setPunchRecordingInProjectState` validates
  against the project's own meter/grouping/timeline, returns the same object when nothing
  changed (no history entry), and throws `InvalidRecordingSettingError` otherwise.
- `src/types/daw.ts` (+17): the optional `meta.punchRecording` field.
- `src/state/liveEngineResynchronization.ts` (+5) and `projectStateAudioConsumers.ts` (+1):
  the window republishes on load, undo/redo and post-offline resync, and is declared in the
  audio-field registry.

## Defined take behaviour

| Situation | Behaviour |
|---|---|
| Punch-out past the arrangement end | **Truncates** at the project end; the timeline is never extended. Warned in the UI. |
| Punch-in at/after the arrangement end | **Refused** before anything is armed. |
| Punch-in closer to bar 1 than the pre-roll | Pre-roll starts from a virtual position before the arrangement; capture still begins exactly at punch-in. |
| Project ends mid-take | An armed window already ends at the project end, so the take completes. Only a still-counting-in take is abandoned. |
| Tempo change (pre-roll or capture) | Both are retimed in place; the musical lengths are preserved. Never cancels. |
| Meter change (pre-roll or capture) | **Cancels.** The window is bar-anchored, so "bar 9 beat 1" would mean different music. |
| Stop / Pause / Seek / close / project replacement / cancel | Take abandoned: clicks silenced, stop moment cleared, promises rejected, **no clip**. |
| Repeated Record | A stale take is cancelled first; a second count-in while one runs still throws, so two recorders or two stop moments are impossible. |
| Punch off | Byte-for-byte the Phase 1K path. |

## Verification

Executed in this sandbox (all commands run, results as returned):

| Command | Result |
|---|---|
| `npm run lint` (`tsc --noEmit`) | exit 0, no diagnostics |
| `npm run test:audio` | 1545 tests, 1545 pass, 0 fail |
| `npm run test:timing` | 188 / 188 / 0 |
| `npm run test:history` | 699 / 699 / 0 |
| `npm run test:shell` | 256 / 256 / 0 |
| `npm run test:metering` | 78 / 78 / 0 |
| `npm run test:truth` | 83 / 83 / 0 |
| `npm run test:effects` | 27 / 27 / 0 |
| `npm run test:instruments` | 17 / 17 / 0 |
| `npm run test:lifecycle` | 2 / 2 / 0 |
| `npm run test:pianoroll` | 111 / 111 / 0 |
| `npm run verify:test-discovery` | 211 test files, 0 orphaned |
| `npm run build` | exit 0, 1822 modules transformed |

The five new suites were also run together in isolation: **98 tests, 98 pass**.

The recording path is exercised through the **real** pipeline, not UI mocks:
`audioEngine.beginPunchRecording` → the real `CountInScheduler` → the real
`RecordingEngine` over a fake `MediaRecorder` driven by a fake `AudioContext` clock →
`planPunchClipPlacement` → `createPunchRecordingPlaylistClip`. That harness asserts the
audio-clock instant capture opened, the instant it stopped, the captured duration, the
click schedule, transport seeks, and the resulting clip geometry.

### Defects found and fixed by these tests

1. The engine kept `activePunchTake` set after a take completed, so `isPunchTakeActive()`
   reported a finished take as armed. Fixed by clearing it on both settle paths.
2. `createPunchRecordingPlaylistClip` imported `clampClipToTimeline` from
   `src/state/playlistTimeline`, which the Phase 1G anchor forbids in runtime audio
   modules. Replaced with the geometric rule applied to the arrangement length passed in.
3. Three existing source-shape anchors needed updating for legitimately changed source:
   the duration-policy scan flagged the new window module's local (renamed to
   `windowBeats`, which is what it holds — a capture-window length, not a note duration);
   the metering lifecycle anchor's fixed-width windows needed the two abort comments
   condensed; and `recording.integration.test.ts` pins App.tsx's pipeline import and
   recording registration.

No test was weakened. The `recording.integration.test.ts` registration anchor necessarily
loosened from an inline object literal to a named variable, so it was strengthened with a
new assertion pinning the punch sequence `trimAudioBufferToSeconds` → `setSampleBuffer` →
`waitForSampleBufferPersistence` → `registration = {…trimmed…}`. Verified non-vacuous: it
fails if either the re-registration or the persistence gate is removed.

A `MUST_NOT_FLAG_FILES` entry added to the duration-policy audit during development was
reverted once the rename made it redundant — the final diff touches that file not at all.

## Known limitations

- **No comping lanes.** A punch take is added as a new clip; it does not mute, split or
  replace an existing take covering the same range. Overlapping takes play together.
- **Pre-roll is count-in clicks only.** There is no playback pre-roll of the existing
  arrangement before punch-in, so the musician cannot hear the music they are punching into.
- **The window is global, per project.** There is no per-track or per-region punch window,
  and no take history / take selection UI.
- **Meter change cancels rather than re-targets.** This is deliberate and tested, but it
  means a window set under one meter is abandoned (not converted) when the meter changes.
- **The tsx suite has no DOM**, so recorder interaction is pinned through
  `renderToStaticMarkup` plus the exported pure selectors; interaction behaviour is covered
  at the engine level instead.
- **`test:playlist-geometry` was not run** (environmental — see Summary). Every other suite
  in the repository's test scripts was executed.

## Recommended next phase

**Phase 1M — comping lanes and take management.**

Phase 1L produces the raw material for comping but stops short of the workflow musicians
expect from it: record several passes over the same punched window, then choose. The
natural next phase is

1. **Take lanes:** group takes that share a punch window, with one audible take per lane
   group and the rest muted, so repeated passes stop stacking audibly.
2. **Take selection and switching:** pick the active take per lane, with the choice
   persisted in project state and reproducible in offline export.
3. **Punch playback pre-roll:** play the existing arrangement for the pre-roll bars instead
   of (or alongside) count-in clicks, so the musician hears what they are punching into.

This keeps the recording pipeline and count-in scheduler as the single capture path — the
constraint Phase 1L was built around — and adds only presentation, selection and
persistence on top of the take geometry that now exists.
