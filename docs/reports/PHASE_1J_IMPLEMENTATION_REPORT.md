# PHASE 1J — METER EDITING AND METRONOME WORKFLOW: IMPLEMENTATION REPORT

## Summary

```text
Phase 1J:      Selectable 4/4 · 3/4 · 6/8 · 7/8 in Project Settings, meter-aware ruler,
               meter/tempo-driven metronome with configurable 7/8 accents
Base SHA:      dd1d5ee8024576c840523ce9c43e561aaa06325a (origin/main, Phase 1I merge PR #200)
Branch:        arena/75786821-apex-studio (session branch, fast-forwarded to main before work)
Schema:        persistenceVersion unchanged (1). One OPTIONAL meta field added
               (meta.sevenEightGrouping). No migration: missing → '2+2+3'.
TypeScript:    tsc --noEmit exit 0
Build:         vite build exit 0 (pre-existing >500 kB chunk advisory only)
test:all:      2219/2219
test:audio:    1430/1430 (baseline 1395)
test:history:  670/670   (baseline 647)
test:shell:    226/226   (baseline 225)
test:timing:   137/137
test:truth 83/83 · test:pianoroll 111/111 · test:metering 78/78 · discovery: 0 orphaned
Node real render (scripts/realOfflineRenderNode.mjs): 9/9
Playwright (test:playlist-geometry): 0/6. Chromium is not installed in the sandbox and cannot
               be downloaded. The baseline fails the same way. This is environmental.
```

## What changed

### Time-signature selection (Project → Project Settings (Time Signature)…, or click the transport **Meter** readout)
- `ProjectSettingsModal` offers exactly 4/4, 3/4, 6/8 and 7/8 (`SUPPORTED_TIME_SIGNATURES`).
- The active meter is shown large in the dialog and is always visible in the transport (`#fl-meter-readout`).
- Every selection is parsed again (`selectProjectTimeSignature` → `parseSupportedTimeSignature`). Unsupported values are rejected with a message.
- The mutation boundary also rejects them: `updateProjectMetadataInProjectState` / `setProjectTimeSignatureInProjectState` throw `UnsupportedMeterEditError`. No code path can store 5/4 and then have it silently play as 4/4.
- An older project that already stores an unsupported meter loads unchanged. The dialog reports it ("plays as 4/4") until the user picks a supported meter.

### State, persistence and history
- The meter is still `meta.timeSignature`, the existing authority. Edits go through `mutateProjectState`, which is the existing history, runtime-sync and autosave path.
- Each real change is one discrete undo step, labelled "Change time signature to 7/8". Re-selecting the active meter returns the same state object, so it creates no history entry.
- Save → reload, serialize → normalize, and project replacement all preserve the meter and grouping. Replacement publishes the incoming project's values to the engine. Each of these is covered by a test.

### Clip policy on meter change: bar-anchored (defined and tested)
- A meter change rewrites only `meta.timeSignature`. Clips (`startBar`/`lengthBars`), patterns, notes, markers and `totalBars` stay bit-identical, and the collection identities are preserved.
- A clip on bar 5 stays on bar 5. Its time in seconds follows the new bar length.
- Undo, or switching back, restores the exact previous timing. Pattern step data is never reinterpreted.

### Meter-aware ruler
- Bars keep their fixed pixel width, so clip columns never move.
- `PlaylistRulerTicks` draws the real subdivisions instead of the hardcoded `| : : :`:
  - 3/4: 3 quarter ticks
  - 6/8: 6 eighth ticks with a 3+3 group line
  - 7/8: 7 eighth ticks with group lines from the chosen grouping

### Metronome
- `src/music/meterPulse.ts` (pure) defines the pulse grid for each meter:
  - 4/4 and 3/4: quarter pulses
  - 6/8: eighth pulses, accented 3+3
  - 7/8: seven eighth pulses, accented 2+2+3 (default), 3+2+2 or 2+3+2
- The 7/8 grouping is chosen in Project Settings and stored as `meta.sevenEightGrouping` (undoable and persisted).
- `triggerCurrentStep` takes the click decision from the authoritative transport step and the resolved meter. The old hardcoded `step % 4` is gone. The step is folded onto the bar grid, so multi-bar patterns accent every bar line.
- `scheduleMetronomeClick` (`src/audio/metronomeClick.ts`) keeps the exact pre-1J downbeat and beat voices (1400 / 880 Hz, 0.3 peak, 40 ms decay). Group accents get a distinct 1100 Hz voice.
- **Stale clicks:** clicks are now tracked. Stop, pause, seek and metronome-off cancel the clicks already scheduled inside the 100 ms look-ahead (`stop(now)` + `disconnect()`). Before this, they still sounded, and a seek doubled them.
- **Tempo-change defect (narrow correction):** `AudioClockTransport.setBpm` kept elapsed seconds instead of musical position. A 120 → 60 BPM change at step 12 jumped back to step 6 and re-scheduled steps 6–11 (duplicate notes and clicks). Speeding up skipped steps instead. Phase 1A had pinned this as "deliberately NOT fixed". The transport now preserves the step position and re-anchors its clock.
  - Two existing assertions were updated to the corrected contract: `transport.test.ts` and `legacyTiming.test.ts`.
  - No MIDI fingerprint changed.
- **Meter/grouping changes while playing:** they take effect from the first step not yet scheduled. Clicks already scheduled inside the look-ahead are kept, so nothing is duplicated or dropped.

## Verification of the metronome (real, not UI-only)
- `src/audio/phase1j.metronome.test.ts` (15 tests) drives `audioEngine.play()` → transport → `triggerCurrentStep` with a fake clock. It records every click oscillator and applies the Web Audio rule that a node stopped before its start never sounds. It covers:
  - the click grid for each meter, 7/8 groupings and tempo
  - pattern loops
  - stop, pause, seek, tempo change, meter change and metronome-off
  - no drift over 40 bars
- **The same file against the pre-1J engine and transport: 12 of 15 fail.** The 4/4, 3/4 and long-run-drift tests pass there too, which proves 4/4 parity is preserved.
- Against the pre-1J transport alone (new engine), only the tempo-change test fails, which isolates the transport defect.
- `src/audio/phase1j.metronomeRender.test.ts` renders the production click path into a real Web Audio graph (the `web-audio-engine` OfflineAudioContext already in devDependencies) and analyses the PCM:
  - 7/8 gives 14 onsets in two bars at exact eighth-note sample positions (±1 sample)
  - pitches are downbeat 1400 / accent 1100 / pulse 880 Hz, following the grouping
  - 4/4 renders the legacy click unchanged
  - cancelled clicks are absent from the rendered audio

## Known limitations
- Meter changes are global. There are no mid-song meter changes.
- The 6/8 metronome and ruler use a 3+3 eighth grouping, but the runtime grid and the TransportBar beat readout are still mechanical 6/8 (three quarter beats, unchanged from Phase 1F).
- Clips are bar-anchored. An audio clip keeps its bar span when the meter changes, so in shorter bars it is trimmed at its bar end. It is not time-stretched. The source audio is untouched.
- Metronome on/off is still session UI state and is not saved with the project, as before.
- Offline export still never renders the click, as before.
- The tsx suite has no DOM, so selector clicks are tested through the exact handlers the radio inputs call, plus static render.
- Browser verification ran through the Node Web Audio implementation, not Chromium (environmental).
