# Apex Studio

Apex Studio is an actively developed digital audio workstation focused on building a serious,
local-first music production environment around Web Audio, MIDI, audio arrangement, instruments,
mixing, recording, and offline rendering. It runs in the browser and can be packaged as a desktop
application with Electron.

It is **not yet a professional DAW**, and it is not presented as one. This README describes what
the project actually does today, and what it does not.

---

## Current Status

> **Development status: Active development / pre-professional DAW**

The core audio foundation is real. Procedural instrument and audio generation, sampler and
drum-pad paths, basic mixer and routing, insert effects and aux sends, local IndexedDB
persistence, project history and recovery, offline WAV/stem rendering, Standard MIDI
import/export, mastering DSP, K-weighted loudness and inter-sample true-peak measurement, and a
persisted dark/light theme are all implemented and used by the application.

However, Apex Studio is still undergoing architectural and workflow development before it should
be considered production-ready or a full professional DAW. Several musical-model, automation,
recording, MIDI-interoperability, and desktop-integration areas remain incomplete, and a small
number of advanced panels are intentionally disclosed as prototypes rather than finished
features. Those gaps are documented in [Current Limitations](#current-limitations) and
[Transparency: Prototype / Demo Features](#transparency-prototype--demo-features).

---

## Try Apex Studio

**[🎛️ Launch Apex Studio →](https://ajey877.github.io/Apex-Studio/)**

Try the current browser build of Apex Studio.

The live site is the browser build of `main`, published by the repository's GitHub Pages
deployment workflow. It is the same active-development / pre-professional build described in this
README — loading the site is not a claim that every workflow is production-ready, and
[Current Limitations](#current-limitations) and
[Transparency: Prototype / Demo Features](#transparency-prototype--demo-features) remain
authoritative.

---

## What Works Today

| Area | Current status |
|---|---|
| Web Audio engine | Implemented |
| Procedural instruments | Implemented |
| Sampler / drum-pad path | Implemented |
| Mixer / routing | Implemented |
| Insert effects / aux sends | Implemented |
| MIDI note workflow | Implemented, limited interoperability |
| Piano Roll | Implemented, core musical-model limitations remain |
| Playlist / arrangement | Implemented, timeline/model limitations remain |
| Audio recording | Implemented, limited DAW workflow |
| Audio import/export | Implemented, format/workflow limitations |
| Project persistence | Implemented locally |
| Undo/redo/history | Implemented locally |
| Offline rendering | Implemented |
| Mastering DSP | Implemented |
| Loudness / true-peak measurement | Implemented |
| Dark/light theme | Implemented |
| Desktop/Electron | Partial |
| Plugin hosting | Not implemented |
| Advanced audio warp | Not implemented |
| Full multitrack recording | Not implemented |
| Take comping | Prototype/demo |
| Polyphonic audio editing | Prototype/demo |
| Wavetable synthesis | Prototype/demo / not implemented in engine |

---

## Core Capabilities

### Audio Engine

Playback, mixing, effects, recording, and export run on the Web Audio API — Apex Studio is not a
visual mock-up. The engine builds and maintains a real audio graph: per-channel voices, insert
effect chains, mixer routing, aux sends, a master bus with measurement taps, and a transport
scheduler. Offline rendering (WAV and stem export) rebuilds the same graph in an
`OfflineAudioContext` and reuses the same playback routines. Instrument generation is
procedural: the built-in subtractive synth and drum/sampler voices are synthesized or played
back from real buffers, not placeholders.

### MIDI

Apex Studio supports MIDI-note-oriented workflows: notes can be written and edited in the Piano
Roll and Channel Rack, performed through a MIDI controller, and exported as Standard MIDI Files.
MIDI import is supported for note data with a number of interoperability limitations — see
[Current Limitations](#midi). MIDI Learn maps controller input to real project and mixer
parameters at runtime.

### Arrangement

The Playlist Arranger provides clip- and lane-based arrangement over a timeline, including audio
clips, pattern playback, automation lanes, mute/solo, and bounce-in-place. The arrangement layer
is functional, but the underlying pattern model still needs architectural work: patterns do not
yet own independent musical note content, and time-signature and note-duration semantics are not
fully consistent with the transport. See [Current Limitations](#core-musical-model).

### Mixer

The mixer provides per-track gain, pan, mute/solo, routing, insert effects (including EQ,
compression, delay, and reverb), and aux sends to return tracks. Master processing is applied to
both live playback and offline renders when enabled.

### Persistence

Projects are stored locally in IndexedDB with autosave, recovery snapshots, backups, and project
history. Persistence is local-only: there is no cloud account, background sync, or server-side
storage, and network collaboration is not active.

### Mastering

The mastering chain applies real multiband compression, stereo width, mono-sub filtering, and
ceiling processing to the master path, and the master bus exposes real measurement: ITU-R
BS.1770-4 K-weighted gated loudness, 4× oversampled inter-sample true-peak detection, and
stereo correlation/Mid-Side metering. Measurement reports `null`/`NOT MEASURED` rather than
inventing values, and reports `unavailable` during an offline bounce.
What it does **not** yet guarantee: the maximizer is a fast-attack compressor plus an
oversampled hard clip rather than a true lookahead brickwall limiter, and the LUFS target is a
metering/compliance reference, not an automatic loudness-normalization stage.

---

## Current Limitations

Apex Studio has meaningful gaps. These are the most important ones, based on the project's
read-only engineering audits.

### Core musical model

- **Patterns do not own independent musical note content.** A pattern currently carries
  identity, naming, and length, while note content lives on channels. This limits how patterns
  can be reused, copied, and varied across an arrangement.
- **Note-duration semantics are inconsistent with tempo.** Note lengths are not yet expressed in
  a single, tempo-consistent musical unit across editing, playback, and export.
- **Time signature is largely metadata/display.** The transport runs 4/4 internally; changing
  the project time signature does not yet change transport timing.
- **Automation has lifecycle/reset defects.** Automation lanes and parameters are functional, but
  reset, re-initialization, and reload behavior are not yet fully reliable.

### MIDI

- **Import limitations for same-pitch overlapping notes** — such notes are not represented
  correctly on import.
- **Tempo metadata handling is incomplete** during MIDI interoperation.
- **Pitch bend is not fully implemented**, and pitch bend/output MIDI paths are incomplete.
- **MIDI output is incomplete**, so Apex Studio is not yet a reliable MIDI master/slave endpoint
  for external hardware or other DAWs.
- **Broader controller, program-change, and automation interchange** is not yet complete.

### Audio

- **Time-stretch is repitching, not pitch-preserving warp.** Clip stretch and the warp surface
  change speed and pitch together (sample-rate/playback-rate change). Pitch-preserving
  time-stretching, granular processing, and formant handling are not implemented.
- **Advanced audio editing is not implemented** in the engine; polyphonic audio editing remains a
  disclosed demo surface.
- **Recording is real but not a full multitrack DAW recording workflow.** Recording captures
  audio and places takes in the project, but the recording path is not yet a complete multitrack
  tracking workflow with full monitoring/comping semantics.
- **Take comping is a disclosed prototype**, not a finished comping engine.
- **32-bit float WAV export clamps samples before writing**, so float export is not currently a
  fully lossless container for above-0 dBFS material.

### Effects and routing

- **Sidechain is note-triggered ducking, not detector-based sidechain compression.** There is no
  level detector or sidechain input, so threshold-based and frequency-selective ducking behavior
  is not available.
- **Deeper live effect-parameter coverage is incomplete** — some effect surfaces and parameters
  are stored intent rather than being applied in the live/offline signal path.
- **No third-party plugin hosting.** There is no VST/AU/AAX host, and no plugin scanning,
  sandboxing, or bridging architecture.

### Desktop

- **Electron/package parity is incomplete.** The generated Windows packaging path does not fully
  match the root Electron packaging path, so desktop builds and the browser build are not yet
  guaranteed to behave identically.
- **No native low-latency driver path.** The desktop build uses the browser/Chromium audio stack;
  there is no ASIO/CoreAudio/WASAPI-exclusive low-latency driver integration.
- **No AudioWorklet processor.** Audio processing runs on the standard Web Audio node graph;
  custom worklet DSP has not been implemented.

### Accessibility

- **Browser-level accessibility validation remains incomplete.** Some focus order, keyboard
  navigation, labeling, and screen-reader behaviors have not yet been verified across browsers.

---

## Transparency: Prototype / Demo Features

Some visible advanced panels are intentionally prototypes or demos. They are useful as design
sketches and as a preview of direction, but they are **not** production DSP implementations, and
they are labeled as such where the application surfaces them.

| Surface | Status |
|---|---|
| Wavetable preview | UI/demo representation. The channel keeps playing its dual-oscillator subtractive synth; there is no wavetable engine behind this window. |
| Take comping | Prototype/demo. It does not invent audio and will not promote a comp without real recorded assets. |
| Polyphonic audio editing | Prototype/demo. Displays sample blobs; it does not analyze, import, or play back project audio. |
| Certain waveform/visual previews | UI/demo representation, not a rendering of the user's audio content. |
| Sidechain visual preview | UI/demo representation of routing intent; the audio path applies note-triggered ducking, not detector-based compression. |
| Analytics presentation | Some values are seeded/static presentation values rather than measured telemetry. |

The distinction matters:

> **UI/demo representation ≠ production DSP implementation**

Where a capability is not implemented in the engine, the project's goal is to say so in the UI
and in this README rather than to imply that the processing exists.

---

## Testing

The repository contains substantial automated validation, but test definitions should not be
interpreted as proof that every workflow is currently production-ready.

Current validation covers:

- **TypeScript validation** — `npm run lint` (`tsc --noEmit`).
- **State/history tests** — `npm run test:history` covers undo/redo, playlist and project
  history, routing, shell, and application-state behavior.
- **Audio tests** — `npm run test:audio` covers engine, instrument, effect, automation,
  persistence, metering, and rendering behavior.
- **Offline rendering tests** — export, stem integrity, and offline/live parity suites, plus a
  headless Node rendering harness.
- **Playwright/browser tests** — `browser-tests/realOfflineRender.spec.ts` exercises real
  offline audio rendering in Chromium.
- **Production build** — `npm run build`.
- **Electron/desktop validation** — desktop security-configuration checks and a packaged
  Windows runtime smoke test, run in the desktop validation workflow.
- **Test discovery guard** — `npm run verify:test-discovery` fails when a test file is not
  covered by any test script.

CI runs these suites in the workflows under `.github/workflows/`. No coverage percentage is
claimed here. Passing tests should be read as "the covered contracts hold", not as a statement
that every user workflow is production-ready.

---

## Architecture

Apex Studio is a single-page application with a layered audio architecture:

```text
React / UI
    ↓
Project / Application State
    ↓
Audio Engine
    ↓
Instrument / Voice / FX / Mixer / Mastering
    ↓
Web Audio
```

- **React / UI** — the workspace surfaces (Channel Rack, Piano Roll, Playlist Arranger, Mixer,
  modals) and the application shell.
- **Project / Application State** — the single `ProjectState` document plus history and mutation
  paths. Persisted audio-affecting fields are tracked in an explicit registry so a field must
  either have a real audio consumer or be classified as metadata/intent.
- **Audio Engine** — owns the `AudioContext`, transport, scheduler, voice lifecycle, recording,
  and the offline render path, and rebuilds an equivalent graph in an `OfflineAudioContext` for
  export.
- **Instrument / Voice / FX / Mixer / Mastering** — synth, sampler, and drum voices; insert
  effects; mixer routing and sends; the master chain and its measurement taps.
- **Web Audio** — the platform layer that actually runs the graph.

Two supporting systems sit alongside the audio path:

- **Persistence** — IndexedDB-backed project documents, audio-asset hydration, backups,
  recovery, and project history.
- **Offline rendering** — WAV and stem rendering through an offline graph.
- **Electron/desktop integration** — the desktop shell packages the built web application and
  applies its own security and audio-related configuration; parity between the desktop and
  browser paths is still being brought into line (see
  [Current Limitations](#desktop)).

---

## Running Locally

Requirements: **Node.js 20 or newer** and npm.

```bash
git clone https://github.com/Ajey877/Apex-Studio.git
cd Apex-Studio
npm install
npm run dev
```

The Vite dev server prints the local URL to open.

```bash
npm run build        # production web build
npm run package:win  # Windows Electron package (installer + portable), output in dist-electron/
```

---

## Roadmap

The next strategic priorities identified by the project's audits, in rough order:

1. **Core musical model and timing correctness** — independent pattern content, tempo-consistent
   note durations, and real time-signature/timing semantics.
2. **Automation, MIDI, and recording semantics** — automation lifecycle/reset correctness, MIDI
   interoperability (overlapping notes, tempo, pitch bend, MIDI output), and a complete
   recording workflow.
3. **Instrument/effect depth** — deeper live parameter coverage, detector-based sidechain, and
   stronger instrument/effect implementations.
4. **Persistence/export integrity** — export correctness and fidelity, including lossless float
   export that does not clamp samples before writing, and clearer export behavior.
5. **Desktop/package truth and parity** — aligning the generated Windows packaging path with the
   root Electron packaging path.
6. **Accessibility and interaction quality** — browser-level accessibility validation and
   interaction hardening.
7. **Professional engine capabilities** — wavetable synthesis, pitch-preserving time-stretch,
   take comping, polyphonic audio editing, plugin hosting, and native low-latency paths.

The exact implementation order may change as engineering audits continue.

---

## Positioning

Apex Studio should be described as:

> Apex Studio is an actively developed DAW project with a credible Web Audio foundation and an
> ambitious path toward professional music production.

It is **not** production-ready, and it is **not** a fully featured professional DAW today. Its
strongest attributes right now are the honesty of its contracts, the breadth of its implemented
Web Audio foundation, and a test suite that pins the behavior it claims.

---

## Contributing

Contributions are welcome, especially bug reports that describe a real production workflow
breakdown. Please include what you were trying to do, what you expected, what happened, and the
steps to reproduce it.

- See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidelines.
- See [SECURITY.md](SECURITY.md) for security reports.
- [Report a bug or request an improvement](https://github.com/Ajey877/Apex-Studio/issues/new/choose)

---

## License

Apex Studio is licensed under the **MIT License**. See [LICENSE](LICENSE) for the full terms.
