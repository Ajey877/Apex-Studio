# Phase 1A — canonical musical-time foundation

## Scope and baseline

- Audited main: `5c22fe82462b685d90266eb3a5960f0ebdaaae40`.
- Implementation starts on `2cdc8446b797383436f948f1e58ddd9aa1f31b59`, preserving the Phase 0 README restoration. Runtime code was identical to main.
- Conversion-only refactor. No pattern ownership/schema/migration, event resolver, note-duration fix, tempo-continuity fix, runtime meter wiring, MIDI redesign, recording-engine change, or UI redesign.
- Stored note/clip units and all existing scheduling/rounding policies remain unchanged.

## Canonical API

`src/music/musicalTime.ts` is pure and has no project, audio, browser or UI dependencies.

One quarter note is one `MusicalBeats` unit; one sixteenth step is 0.25 beats.

- `stepsToBeats`, `beatsToSteps`
- `beatsToSeconds`, `secondsToBeats`
- `beatsToBars`, `barsToBeats`, `beatsPerBar`, `stepsPerBar` (explicit meter required)
- `beatsToMidiTicks`, `midiTicksToBeats` (explicit PPQ; no quantization)
- `millisecondsToSeconds`
- `bpmToMicrosecondsPerQuarter` (unrounded MIDI tempo metadata)

Meter arithmetic uses `numerator * (4 / denominator)`, not a hardcoded number of beats per bar. Numerator must be a positive safe integer; denominator must be a positive safe integer power of two. Invalid meters throw `RangeError`. Runtime consumers explicitly use the frozen `LEGACY_TIME_SIGNATURE` (4/4), never project meter metadata.

The numeric type aliases document units without changing persisted schemas or forcing unsafe casts at legacy boundaries. Arithmetic quantities may be signed. Numeric NaN/Infinity retain IEEE-754 behavior; conversion does not silently repair invalid input. BPM validation, fallback and clamping remain at existing entry points: in particular engine/offline 20–300 and standalone transport 20–999 are NOT consolidated by changing behavior in this phase. The parser's handling of malformed MIDI division is likewise unchanged.

`DEFAULT_MIDI_PPQ` is 480. The 120-tick step is derived from a quarter beat, not independently specified. MIDI tempo uses the original `60_000_000 / bpm` operation order rather than seconds multiplied by a million, to preserve rounding at the writer boundary.

## Conversion inventory and disposition

The tracked repository was searched for `60 / bpm`, `bpm / 60`, `240 / bpm`, step/BPM expressions, `* 16`, `* 120`, `* 480`, PPQ/tick declarations and equivalent variable-named conversions. Tests, docs, harnesses and unrelated DSP/UI numbers were reviewed separately from production musical timing.

| Family / consumer | Disposition |
|---|---|
| `AudioClockTransport`: quarter duration, initial grid | Uses canonical quarter duration, steps-per-quarter and legacy meter. Seconds-origin scheduling, floor/epsilon, lookahead, pause/seek and tempo-change behavior unchanged. |
| `AudioEngine`: live/offline step seconds, fractional onset displacement, audio-clip offset/fades, seek/retrigger, bounce window | Uses canonical seconds/step or quarter/bar rates. All event selection, scheduling and duration semantics unchanged. |
| `AudioEngine`: song global/local bar arithmetic, song end, automation bar position, offline bar counter | Reuses one module-derived `STEPS_PER_BAR`; no literal competing 16-step bar conversion remains in these paths. |
| `AudioEngine`: content/declared loop rounding | Existing algorithms retained; only the bar size comes from `stepsPerBar(LEGACY_TIME_SIGNATURE)`. No change to Pattern/Song length differences. |
| `offlineProjectRenderer`: production render-plan helpers and legacy minimal renderer | Same canonical quarter/bar rates. Legacy renderer remains nonproduction; existing note-length calculation/order preserved. |
| `exportUtils`: MIDI ticks/step, ticks/bar, header PPQ, tempo metadata | Canonical derived rates/PPQ. Existing onset rounding, groove ticks, clip rounding, windows, note-off and event ordering unchanged. |
| `midiParser`: writer PPQ/tempo and reader ticks/step | Canonical derived rates. Import overlap handling, metadata behavior, minimum duration, quarter-step quantizer and SMPTE fallback unchanged. |
| `playlistClipOperations`: trim/split source offsets | Existing multiplication/division by the canonically derived legacy bar size; clone/edit logic untouched. |
| `patternLength`: default length, bar count, normalization | Derived legacy bar size; existing whole-bar ceiling and invalid-length fallback retained. |
| `recordingPipeline.getRecordingLengthBars` | `240 / safeBpm` now comes from one legacy bar in canonical beats/seconds. Existing validation, ceil/minimum and clip publication unchanged. Recording capture itself is untouched. |
| `PlaylistArranger`: imported-audio sizing | Canonical legacy-bar seconds; retains **round**, not recording placement's **ceil**. |
| `App`: seek to bar | Canonical legacy-bar seconds; same one-based UI → zero-based bar offset. |
| `TransportBar`: tempo-dependent display factor | Uses canonical quarter seconds; surrounding known-defective display arithmetic is deliberately unchanged. |
| `parameterScaling.arpStrumSecondsForVoice` | Canonical milliseconds conversion, with original index multiplication before division and original clamps. Swing algorithm unchanged. |

### Remaining formulas/constants and why

1. **Derived scale multiplication/division is intentional.** Consumers still multiply bars by a `STEPS_PER_BAR` derived from the module, or steps by derived seconds/ticks per step. These are cached conversion ratios, not competing definitions. Keeping operation order, rounding, modulo and validation in their existing locations avoids fractional-boundary changes. This includes transport's `beatsPerBar * stepsPerBeat`, MIDI import's quantizer, and pattern-length ceiling algorithms.
2. **Instrument note-duration multipliers** in `subtractiveSynth`, `legacySynth`, `legacyAcoustic`, `independentPluck`, and unreferenced `AudioEngine.renderNoteOffline` are untouched. Replacing them would fix/change note gates and instrument behavior (later phase).
3. **Arp division/gate policy** (`/2`, `/8`, triplet `2/3`, sequence lengths) remains in `playArpSequence`. Its quarter-second source and sixteenth subdivision constant are canonical; its seconds-in-Note.duration defect is not fixed.
4. **Piano Roll strum** (`strumMs/1000*4`, `index*0.04`) and **Polyphonic demo duration** (`durationSteps/4`) remain. These are known ambiguous/incorrect timing policies, not safe equivalent BPM conversions. No new runtime timing behavior is introduced through them.
5. **Transport display indexing** (`%4`, `%16`, frame-like `*6`) remains; correcting it would change UI behavior. **Tap tempo** (`60000/averageInterval`) is a single input BPM estimator, not a second scheduling conversion; its estimator/rounding policy is untouched.
6. **Fixed grid/content constants** remain in presets, default step arrays, rack length choices, 16-cell Gross Beat gate, Euclidean arp and demo graphics. They describe existing content/device/UI dimensions, not meter conversions. They must not all become meter-dependent.
7. **Audio seconds and DSP constants** remain: envelope attack/decay/release, source trim and buffer seconds, anti-click fades, sidechain milliseconds, sample-rate/frame math, LFO frequencies, oscillator harmonics. They are not musical-beat conversions and must not be tempo-scaled.
8. **Wall-clock / UI duration formatting** (`/60`, `/1000`) in recording capture, telemetry, export audition and clocks remains. Recording timing/capture is not being redesigned.
9. **Tests and render harnesses** retain independent numeric expectations (16, 120, 480, `60/bpm`, etc.) as regression oracles; replacing expected values with the implementation would weaken coverage. Historical reports/documentation remain historical.

There are no remaining independent production `60 / <project BPM>` or `240 / <project BPM>` scheduling formulas outside the canonical module. No live/offline/clip code was switched to `meta.timeSignature`.

## Tests-first evidence and regression coverage

1. Added `musicalTime.test.ts` before the module; test run failed with `ERR_MODULE_NOT_FOUND` (RED).
2. Implemented the module; pure tests passed (GREEN). The MIDI-tempo helper also had a separate missing-export RED run before implementation.
3. Before changing consumers, captured nine SHA-256 MIDI byte fingerprints at 60/120/240 BPM for project Pattern, project Song and Piano Roll exports. Fixture covers fractional notes, steps, swing, trim, hidden content and a non-4/4 metadata label without runtime meter adoption.
4. Ran the new compatibility tests against the original consumers before replacement; passed. The same fingerprints must still match after migration; they are not regenerated to accept changes.
5. Added compatibility coverage for pattern normalization, Song content-derived loops, fractional onset/swing, recording sizing, render plans, playlist split/trim, transport grid and the intentionally unchanged tempo-change policy.
6. `test:timing` runs the new tests; `test:audio` includes them so the existing CI audio gate exercises the foundation. No workflow/dependency/lockfile changes.

Validation after consumer migration:

| Command | Result |
|---|---|
| `npm run test:timing` | 25 passed |
| `npm run test:audio` (includes timing, MIDI, pattern, transport and offline tests) | 1,158 passed |
| `npm run test:history` | 610 passed |
| `npm run test:truth` | 83 passed |
| `npm run test:pianoroll` | 111 passed |
| `npx tsx --test src/utils/*.test.ts src/audio/phase68.midiExportParity.test.ts` | 34 passed |
| `npm run test:browser:node` | 8 real offline DSP checks passed (Node fallback, not a Chromium run) |
| `npm run lint` | Passed |
| `npm run verify:test-discovery` | 180 files covered; zero orphaned |
| `npm run verify:desktop` | Passed |
| `npm run build` | Passed; Vite emitted its large-chunk warning |

Test counts overlap across commands. No unintended behavior changes were observed. Existing note-duration, tempo-continuity, meter, pattern-ownership and MIDI-import limitations remain deliberately unresolved.
