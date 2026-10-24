# Audio to MIDI

Apex Studio transcribes the **real PCM of the audio clip you select** into editable
MIDI notes. There are two **explicitly chosen** analysis modes, and the panel always
says which one produced the notes you are looking at.

| | Monophonic (default) | Polyphonic (Phase 10B) |
|---|---|---|
| Detector | shared YIN (`src/audio/pitchDetection.ts`) | short-time spectral salience (`src/audio/polyphonicTranscription.ts`) |
| Voices | one | up to **4** simultaneous fundamentals |
| Range | 75–1000 Hz (≈ E2–B5) | **C2–C6** (MIDI 36–84) |
| Good input | a sung or played line | clear chords, a melody over a held bass |
| Chords | refused (`polyphonic-suspected`) | transcribed |
| Confidence | YIN confidence | share of the frame's spectrum the note explains (documented curve) |

Both modes resolve the same clip window (trim offset, `lengthBars`, `timeStretchRate`,
`pitchShiftSemitones`, tempo and meter), show a reviewable preview, and write notes
only on an explicit commit — into a **new pattern by default**, as one undo step.

---

## Workflow

1. Select an audio clip in the Playlist Arranger.
2. Open **Tools → Audio to MIDI**.
3. Choose the analysis mode (Monophonic is the default) and, if you want, the minimum
   note length and the quantize grid.
4. **Analyse clip.** Nothing is written. You get either
   - a note list (pitch, start step, length, measured confidence, measured velocity,
     cents deviation) plus the statistics the verdict was built from, or
   - a typed refusal with a reason.
5. Choose the destination. The default is **a new pattern**; an existing pattern can
   be appended to, and replacing its notes requires ticking an explicit confirmation.
   A dry run states exactly what will be written before you commit. The destination
   **channel** (instrument) is chosen here too — if it is a drum pad, the panel says
   so, because transcribed pitches cannot become pitched notes on a kit.
6. **Commit notes to project** — one undoable step through the App's history path,
   autosaved, then **Open in Piano Roll** to edit and hear it.

Failed, refused or discarded analyses never touch project state.

---

## Polyphonic mode — how it works

```
windowed PCM ──► STFT (4096-sample Hann, hop 1024) ──► per-frame greedy multi-pitch
                                                       │
                                                       ├─ harmonic salience of 49 candidates
                                                       ├─ a candidate must own its fundamental
                                                       │   and round to its own semitone
                                                       ├─ select up to 4 voices
                                                       └─ record the energy each one explains
                                                          (so its overtones cannot score again)
        ──► per-pitch note runs ──► re-attack splitting ──► duration policy ──► quantize
```

Why this and not a peak picker: a plain FFT peak picker reports **every overtone as a
note** — a sawtooth C4 becomes C4+G4+C5+E5+… That is the failure mode this mode must
never have. Instead, each candidate pitch scores the measured magnitude at its harmonic
series, minus the energy that already-selected notes explain. A note's own overtones are
explained by that note and cannot come back as separate notes; a genuine second note
keeps whatever it adds on top of a bin it shares with a louder one (a C5 melody sits
exactly on the 4th harmonic of a C3 bass).

Two further gates keep candidates honest:

- the candidate's **measured fundamental must round to that candidate**, so spectral
  leakage cannot be attributed to the neighbouring semitone;
- it must clear an absolute share of the frame's magnitude **and** a share relative to
  the frame's strongest note.

Then the note events are built with the *same* musical-time utilities as monophonic
mode: source seconds → timeline seconds with the clip's real playback rate → project
steps → the caller's grid, with lengths raised through `quantizeDurationSteps`. There
is no second time model and no second minimum length
(`docs` audit: `polyphonic-transcription.note-timing` in
`src/music/noteDurationPolicy.ts`).

**Confidence** is not decorative: per frame it is `clamp01((share × 2)^0.75)` where
`share` is the fraction of the frame's spectral magnitude the note's harmonic series
explains; a note reports the mean of its frames. **Velocity** is
`0.35 + 0.65·√(amplitude / loudest note in the clip)`, clamped to 0.2–1.0 — a measured
relative loudness, not an absolute MIDI velocity.

---

## Measured accuracy (not claims)

The suite `src/audio/phase10b.polyphonic.test.ts` renders every fixture **sample by
sample** (additive harmonic tones with independent attack/release envelopes, vibrato
integrated as a real frequency offset, deterministic LCG noise, click trains, bell
partials) and scores the analyzer against explicit ground truth with
**±0.5 step onset / ±0.75 step offset** tolerances. One measurement run over the
suite's 15 fixtures:

| Fixture | Notes found / expected | Result |
|---|---|---|
| single rich C4 (harmonics 1, ½, ¼, ⅛) | 1 / 1 | exact |
| sawtooth-like A3 (12 partials) | 1 / 1 | no overtone inflation |
| two notes, independent onsets/offsets | 2 / 2 | both onsets preserved |
| triad C4 E4 G4 | 3 / 3 | exact |
| four-voice chord C3 G3 E4 C5 | 4 / 4 | at the voice ceiling |
| melody over sustained bass (shared harmonics) | 4 / 4 | C5 survives on C3's 4th harmonic |
| repeated same pitch, with a gap | 2 / 2 | split at the re-attack |
| repeated same pitch, legato | 2 / 2 | split at the re-attack |
| vibrato A4 (±14 cents, 5.5 Hz) | 1 / 1 | no spurious notes |
| two notes 6 dB apart | 2 / 2 | velocity ordering follows amplitude |
| C2 and C6 boundaries | 1 / 1 each | in range |
| 60 / 180 / 240 BPM (4 / 12 / 16 steps per second) | 1 / 1 each | onset error ≤ 0.25 step |

Totals for that run: **27 ground-truth notes, 0 false positives, 0 false negatives
(precision 1.000, recall 1.000), worst onset error 0.25 step, worst offset error
0.25 step, worst pitch deviation 0.05 semitone.**

These numbers describe *these fixtures* — clean, additive, well-separated tonal
material. They are not a promise about recorded music.

### Refusals (typed, with a message, zero mutation)

| Input | Refusal |
|---|---|
| silence | `silence-or-noise` |
| deterministic broadband noise | `no-fundamentals` |
| click train / transients | `no-fundamentals` |
| bell-like inharmonic partials | `unreliable-harmonics` (the detected notes explained only 55 % of the peak spectral mass; the threshold is 80 %) |
| 5 or 6 simultaneous notes | `polyphony-exceeded` |
| fundamentals outside C2–C6 (C1, C7, or a +36-semitone clip shift) | `no-fundamentals` |
| window longer than the budget (> 30 s) | `analysis-budget` |
| notes all shorter than the chosen minimum | `no-notes` |

A refusal always returns `notes: []`; the commit path additionally refuses an empty
note list, so the project cannot be touched by a refused analysis.

### Measured limits — stated, not hidden

- **Adjacent semitones in one register merge.** Two fundamentals a semitone apart
  (261.6 Hz vs 277.2 Hz) are 1.4 FFT bins apart in a 93 ms window and cannot always be
  resolved. The honest consequence, pinned by
  `phase10b.polyphonic.test.ts › pins the measured limit for two fundamentals a
  semitone apart`: both fundamentals are still reported (measured confidence 0.47 and
  0.49), and what the merge adds is a **weaker extra at the octave** (0.22 — under half
  the fundamentals' confidence), never a competing fundamental.
- **A note sharing its fundamental with a much louder note can be missed.** Over-
  explaining is deliberate: a missed note is recoverable in the Piano Roll, a fake note
  is not. Measured on an octave pair (C3 + C5, C5 sitting on C3's 4th harmonic): C5 is
  still reported when it is up to **6 dB below** the C3, and is lost at 9 dB below.
  Melodies in a separate register, or within ~6 dB of the accompaniment, are recovered.
- **Up to 4 voices.** Denser material is *refused* rather than partially transcribed.
- **No source separation, no instrument identification, no reverb or bleed removal.**
  Dense mixes, drums and distortion are refused or under-detected. Polyphonic mode
  transcribes pitched tonal material, not "any song".
- **CPU budget:** counted, not timed — 1600 frames, 49 candidate pitches, 16 harmonics,
  4 greedy passes. A 30 s clip analyses in ≈0.4 s on the development machine.
  `stats.analysisMilliseconds` is reported for information only and never feeds a
  decision, so the same PCM always produces the same notes.

---

## Monophonic mode (unchanged)

Monophonic mode is the Phase 8C pipeline and it is untouched by Phase 10B:

- `src/audio/audioToMidi.ts` — `describeClipTimeline`, `normalizeAudioToMidiOptions`,
  `segmentPitchContour`, `harmonicEnergyRatio`, `transcribePcmToMidi`;
- `src/audio/pitchDetection.ts` — the YIN detector the Vocal Tuner also uses;
- refusals include `polyphonic-suspected`, and **chords are still refused** in this
  mode. That refusal is a product guarantee, not a limitation to work around: if you
  want a chord, choose the polyphonic mode explicitly.

The two modes share the clip-window resolution, the option defaults, the note-duration
policy, the commit contract (`src/state/audioToMidiCommit.ts`) and the history path.
Only the pitch analysis differs, and neither mode can silently take the other's path.

---

## Where the code lives

| File | Role |
|---|---|
| `src/audio/polyphonicTranscription.ts` | pure polyphonic analyzer (FFT, salience, note runs, refusals, stats) |
| `src/audio/polyphonicAudioToMidi.ts` | polyphonic mode entry: clip window → analyzer |
| `src/audio/audioToMidiSource.ts` | real-PCM resolution (engine memory → persisted asset store) for both modes |
| `src/components/AudioToMidiModal.tsx` | mode switch, review, dry-run, explicit commit |
| `src/state/audioToMidiCommit.ts` | notes → project patterns (append by default, replace needs confirmation) |

## Tests

- `src/audio/phase10b.polyphonic.test.ts` — 28 tests: musical accuracy on
  sample-by-sample PCM, refusals, determinism, bounds, caps, measurement honesty.
- `src/audio/phase10b.polyphonicWorkflow.test.ts` — 17 tests: clip-window resolution,
  commit (append / replace / new pattern), undo & redo, save → cold reload, Piano Roll
  edits, Standard MIDI export, and "a refusal changes nothing".
- `browser-tests/polyphonicAudioToMidi.spec.ts` — real Chromium: durable asset →
  polyphonic mode → review → commit → Piano Roll → MIDI export → offline render of the
  committed pattern (the chord's pitches are measured in the rendered audio) → reload.
- Existing monophonic regressions stay green: `src/audio/audioToMidi.test.ts`,
  `src/state/audioToMidiCommit.test.ts`, `src/components/audioToMidiModalThemeUi.test.tsx`,
  `browser-tests/audioToMidi.spec.ts`.
