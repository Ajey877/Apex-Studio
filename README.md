<div align="center">

# 🎛️ Apex Studio

### A free, local-first DAW for making music.

**Create. Arrange. Record. Mix. Export.**

Build beats, write melodies, arrange tracks, record audio, shape your mix, and export your work — without a subscription or cloud-first workflow.

<br />

[![Latest Release](https://img.shields.io/github/v/release/Ajey877/Apex-Studio?display_name=tag&sort=semver&style=for-the-badge&label=LATEST)](https://github.com/Ajey877/Apex-Studio/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Ajey877/Apex-Studio/ci.yml?style=for-the-badge&label=CI)](https://github.com/Ajey877/Apex-Studio/actions/workflows/ci.yml)
[![Audio Validation](https://img.shields.io/github/actions/workflow/status/Ajey877/Apex-Studio/audio-validation.yml?style=for-the-badge&label=AUDIO%20VALIDATION)](https://github.com/Ajey877/Apex-Studio/actions/workflows/audio-validation.yml)
[![Desktop Validation](https://img.shields.io/github/actions/workflow/status/Ajey877/Apex-Studio/desktop-validation.yml?style=for-the-badge&label=DESKTOP%20VALIDATION)](https://github.com/Ajey877/Apex-Studio/actions/workflows/desktop-validation.yml)

<br />

[🚀 **Download Apex Studio v1.2.2**](https://github.com/Ajey877/Apex-Studio/releases/tag/v1.2.2) · [📖 **Documentation**](#-getting-started) · [🐛 **Report a Bug**](https://github.com/Ajey877/Apex-Studio/issues/new/choose) · [💡 **Request an Improvement**](https://github.com/Ajey877/Apex-Studio/issues/new/choose)

</div>

---

## ✨ What is Apex Studio?

Apex Studio is a creator-focused digital audio workstation built around a simple idea:

> **Music software should help you make music, not get in the way.**

It brings the main parts of a music-production workflow into one application — from the first drum pattern to the final WAV export.

### The workflow

```text
        CREATE
          ↓
        EDIT
          ↓
       ARRANGE
          ↓
       RECORD
          ↓
         MIX
          ↓
        SAVE
          ↓
       EXPORT
```

**v1.2.2** is a reliability-focused release centered on the complete music-production loop: create, edit, arrange, record, mix, save, reopen, and export. It includes hardened audio playback/rendering, project persistence and recovery, export validation, and Windows packaging/runtime validation.

---

## 🎬 See Apex Studio

### 🎛️ Your studio, in one place

<p align="center">
  <img src="assets/screenshots/playlist.jpg" alt="Apex Studio Playlist Arranger" width="100%">
</p>

<p align="center">
  <b>Playlist Arranger</b><br>
  Build your arrangement across patterns, audio clips and automation.
</p>

<br />

<table>
<tr>
<td width="50%">

<img src="assets/screenshots/channel-rack.jpg" alt="Apex Studio Channel Rack" width="100%">

### 🥁 Channel Rack
Program beats, patterns, swing and velocity.

</td>
<td width="50%">

<img src="assets/screenshots/piano-roll.jpg" alt="Apex Studio Piano Roll" width="100%">

### 🎹 Piano Roll
Write melodies, chords and detailed note performances.

</td>
</tr>
<tr>
<td width="50%">

<img src="assets/screenshots/mixer.jpg" alt="Apex Studio Mixer" width="100%">

### 🎚️ Mixer
Balance channels, route audio and shape your mix — including level-detected sidechain ducking.

</td>
<td width="50%">

<img src="assets/screenshots/synth.jpg" alt="Apex Studio Synth" width="100%">

### 🎛️ Synth
Shape sounds with two oscillators, filters and modulation.

</td>
</tr>
</table>

<br />

<p align="center">
  <img src="assets/screenshots/recorder.jpg" alt="Apex Studio Recorder" width="80%">
</p>

<p align="center">
  <b>🎙️ Record directly into your project.</b>
</p>

---

## 🎚️ Built for the actual workflow

| 🎹 Workspace | What it does |
|---|---|
| **Channel Rack** | Build independent patterns — each pattern keeps its own steps and notes for every channel — with step sequencing, swing, velocity and MIDI learn. Add an empty pattern or clone one to start a variation. |
| **Piano Roll** | Create polyphonic melodies, edit note length and velocity, use scales/chords and quantization tools. |
| **Playlist Arranger** | Arrange patterns and audio clips across multiple lanes, including automation. Each pattern clip plays the pattern it names, live and in every export. |
| **Mixer** | Work across mixer tracks with volume, pan, routing, metering and insert effects (EQ, reverb, delay, compression, limiter), plus sidechain ducking: a real audio-thread level detector (threshold, ratio, attack/release) driven by another track's post-fader output, or the legacy note-triggered envelope. See [docs/SIDECHAIN.md](docs/SIDECHAIN.md) for the detector tap point, curve, ranges and which render paths carry it. |
| **Synth** | Shape sounds with the dual-oscillator subtractive synth, filters, ADSR and modulation controls, or switch the channel to the wavetable instrument: a six-frame morphing table with table warp, H1–H8 partial gains and up to 7 detuned unison voices. |
| **Recording** | Capture audio and place recorded takes into the project. |
| **Take Comping** | Comp a performance by phrase: draw regions across a recorded take group, point each phrase at the take that sounded best in it, and let equal-power crossfades join them. Whole-take selection is still there as the fallback. |
| **FX** | Use EQ, reverb, delay, compression and time/volume-style effects. |
| **Mastering Suite** | Process the master bus with a 3-band multiband compressor, stereo imager and maximizer, alongside gated loudness and true-peak metering. |
| **Export** | Render WAV, export Standard MIDI, and create project/stem packages. |

---

## 🎵 Why Apex Studio?

### 🆓 Free to use
No subscription is required to run the project.

### 💾 Local-first
Your project workflow is designed around local storage and local processing rather than requiring a cloud account.

### 🎛️ One workflow
Step sequencing, piano roll editing, arrangement, recording, mixing and export live together instead of being split across separate tools.

### ↩️ Real project editing
Document-level undo/redo covers the core project state, with continuous controls grouped into meaningful history actions.

### 🔊 Real audio pipeline
Apex Studio uses Web Audio APIs for playback, mixing, effects, recording and offline rendering rather than being only a visual mock-up.

### 🖥️ Windows desktop build
The project can be packaged as a Windows installer or portable executable through Electron.

---

## 🚀 Get Apex Studio

### Windows — recommended

Download the latest release from GitHub:

**👉 [Download Apex Studio v1.2.2](https://github.com/Ajey877/Apex-Studio/releases/tag/v1.2.2)**

The release workflow builds Windows packages including:

- **Windows installer (.exe)**
- **Portable Windows build**
- Release metadata generated by the build pipeline

> **Note:** Windows releases are generated by GitHub Actions. If you are looking at a release while its build is still running, wait for the release assets to appear.

### Run from source

Requirements:

- **Node.js 20 or newer**
- npm

```bash
git clone https://github.com/Ajey877/Apex-Studio.git
cd Apex-Studio
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

### Production build

```bash
npm run build
```

### Package Windows locally

```bash
npm install
npm run package:win
```

Build output is written to `dist-electron/`.

---

## ⚡ Your first session

### 1. 🥁 Start with a beat

Open **Channel Rack** and program a simple Kick, Snare, Hi-Hat or 808 pattern.

**Shortcut:** `F6` or `1`

### 2. 🎹 Write a melody

Open **Piano Roll**, draw notes, adjust their length and velocity, and use the available scale/chord tools.

**Shortcut:** `F7` or `2`

### 3. 🧩 Build the arrangement

Open **Playlist Arranger**, choose a pattern in the toolbar's **Pattern** picker, and place it on a lane — or place audio clips. Switch between pattern/song workflow as needed.

**Shortcut:** `F5` or `3`

### 4. 🎚️ Shape the mix

Open the **Mixer**, balance your channels, route tracks, and add effects.

**Shortcut:** `F9` or `4`

### 5. 🎙️ Record

Arm recording, capture audio, and place the take into your project.

**Shortcut:** `R`

### 6. 💾 Save and reopen

Use project save/reopen workflows to keep working across sessions.

**Shortcut:** `Ctrl + S`

### 7. 📦 Export

Render your finished work as WAV, export Standard MIDI, or create project/stem packages.

---

## ⌨️ Essential shortcuts

| Shortcut | Action |
|---|---|
| `Space` | Play / Pause |
| `L` | Pattern / Song Mode |
| `R` | Arm Recording |
| `M` | Metronome |
| `Ctrl + S` | Save Project |
| `Ctrl + Z` | Undo |
| `Ctrl + Y` | Redo |
| `F5` / `3` | Playlist Arranger |
| `F6` / `1` | Channel Rack |
| `F7` / `2` | Piano Roll |
| `F9` / `4` | Mixer & FX Rack |

---

## 🧪 Built with reliability in mind

Apex Studio is being developed with automated checks and real-runtime validation around the parts that matter most to a DAW: audio behavior, project state, desktop configuration, production builds, persistence, and export.

The v1.2.2 release was validated through:

- ✅ TypeScript compilation
- ✅ Audio regression and persistence tests
- ✅ Project recovery/audio hydration tests
- ✅ Project history and undo/redo tests
- ✅ Desktop security configuration
- ✅ Production Vite builds
- ✅ Windows Electron packaging
- ✅ Live/offline audio workflow validation
- ✅ Real browser cold-reopen persistence validation
- ✅ WAV export verification

The final runtime workflow was exercised as:

> **Create → Edit → Arrange → Mix → Play → Save → Close → Reopen → Restore → Play → Export**

Check the **Actions** tab for the current CI state:

**[View GitHub Actions →](https://github.com/Ajey877/Apex-Studio/actions)**

---

## 🧭 Product direction

Apex Studio is intentionally focusing on **trustworthy core DAW workflows before adding more headline features**.

That means the current priority is making this loop dependable:

> **Create → Edit → Arrange → Record → Mix → Save → Reopen → Export**

Features that are not production-ready are not presented as finished just for the sake of a bigger feature list.

### Feature status

The table in [Built for the actual workflow](#-built-for-the-actual-workflow) lists capabilities that run end to end.
The surfaces below are **in the app but not wired into the audio engine yet**, and they say so in their own UI.
(Audio to MIDI is *not* on this list: it writes real notes into real patterns, though it does not process the live signal path.)

| Surface | Status |
|---|---|
| **Vocal Tuner** | The live signal path applies **no** pitch processing, and the ON/OFF toggle only stores intent. Phase 8A adds an explicit **offline** workflow: it analyses the selected audio clip's real pitch (YIN, monophonic material, fundamentals E2–B5) and its Render & Commit action writes pitch-corrected PCM toward the chosen key/scale as a new durable asset (the original is kept for undo). Formant shift, vibrato and humanize remain stored intent — **not applied**. |
| **Warp Processor** | Applies **pitch and playback rate** to an audio clip (Repitch: pitch rides with the rate). Its separate stretch action renders **real length-preserving WSOLA** (or transient-anchored TAW) PCM and commits it as a new durable asset, so the stretch survives reopen and export; the original asset is kept for undo. Not implemented: elastic/phase-vocoder stretching beyond the supported WSOLA ratio range, and beat detection — Fit-to-tempo needs the source tempo entered by the user. |
| **Audio to MIDI** | Transcribes the **selected audio clip's real PCM** into editable MIDI notes (shared YIN detector, monophonic material only, fundamentals 75–1000 Hz ≈ E2–B5). It analyses, shows a reviewable preview with measured confidence, and writes notes only on an explicit commit — into a new pattern by default, as one undo step. Silence, noise, unstable pitch, clips shorter than 0.25 s and **polyphonic material (chords) are refused with a reason**; there is no chord or source separation and harmonics are never reported as extra notes. |

The **Wavetable Synth** is *not* on that list: it is a real instrument. The `wavetable`
instrument renders a band-limited single-cycle table (64 partials) through
`PeriodicWave` oscillators, with morph across six phase-aligned frames, PWM /
phase-bend / hard-sync table warp, H1–H8 partial gains, and 1–7 detuned unison
voices with optional stereo spread. Settings live on the channel, so playback,
undo/redo, save/reopen and WAV export all use the same table. Not implemented:
per-sample warp automation, FM/mirror warps, and oversampled output (the cycle
is band-limited to 64 partials and is not oversampled at extreme pitches).

### Mastering Suite processing path

The mastering processors **are applied to the master bus**. The same `MasteringProcessor`
graph is installed in the live `AudioContext` and in the `OfflineAudioContext` used for
export, so playback and rendered files follow the same settings. Bypassing the suite is a
literal dry path rather than a no-op setting.

What is in the signal path:

- **3-band multiband compressor** — low/mid/high crossovers (low 80–500 Hz, high 1.8–16 kHz),
  and per band: threshold, ratio, makeup gain, attack, release, knee, solo and mute.
- **Stereo imager** — width multiplier plus a sub-bass mono collapse below a set frequency.
- **Maximizer** — threshold (drive) and release into a 20:1 compressor (fixed 3 ms attack).
- **Lookahead true-peak limiter** — an `AudioWorklet` that examines the upcoming
  5 ms (configurable 0–20 ms) of audio, detects inter-sample peaks with a 4×
  oversampled reconstruction of the waveform, and holds `maximizerCeiling`. Its gain
  reduction is measured on the audio thread and shown in the suite. See
  [`docs/MASTERING-LIMITER.md`](docs/MASTERING-LIMITER.md).

Known limitations, stated here and in the suite's own UI:

- The limiter adds its lookahead as latency while the suite is enabled (5 ms by
  default). Exports trim exactly that amount, so a render is not shifted; live playback
  is delayed by it, which is what lookahead means. If the platform has no `AudioWorklet`
  (or the module fails to load) the chain says so and falls back to the older
  4× oversampled hard peak guard, which is **sample-peak only and not a true-peak
  limiter**.
- The limiter's detector is a 4×/12-tap interpolator and applies gain at the base rate;
  it is a real limiter, not a mastering-grade oversampled ISP limiter. No listening test
  backs any claim about how it sounds.
- The **LUFS target is a metering reference only**. It is displayed next to the measured
  integrated loudness; it does not apply automatic gain.
- Loudness, true-peak and stereo metering measure the master bus. The limiter's gain
  reduction is measured; the **per-band** GR readouts still say `NOT MEASURED` because
  nothing measures them yet.
- The crossover splits are 12 dB/octave biquads summed after their compressors, not a
  unity-sum alignment, so bands overlap at the crossover points.

### Take comping scope

Take comping works on **recorded take groups that exist in the project**: two or more passes
over the same track and the same bars. The comping window lists every take group and offers two
levels of editing.

**Whole take (the fallback).** Selecting a take makes it the group's `activeTakeIndex`; every
other take is silenced in live playback and in export. The selection is written to the project,
is undoable, and never deletes anything. This is exactly the behaviour shipped in Phase 1M, and
it is what **Revert to whole take** returns to.

**Phrase regions (Phase 10A).** *Start comp* turns the group into an explicit list of phrases.
Each phrase is a span of the group's own timeline, measured in bars relative to the clip start,
and names the take that sounds inside it — so one group can play take 1 for bars 1–2 and take 3
for bars 3–4. Phrases can be split, moved, trimmed and repointed; a phrase can be removed, which
leaves silence there rather than shifting its neighbours. The phrase list is persisted on the
project (`PlaylistClip.compRegions`), so it survives save/reopen, undo/redo, project reload and
every render path.

Boundaries are **real equal-power crossfades**: equal to the phrase's `Crossfade (bar)` value
(default 1/16 bar), bounded by half of either neighbouring phrase and by the material the two
takes actually have, and centred on the boundary where both sides can reach into each other.
Playing `sin(t·π/2)` on the incoming take against `cos(t·π/2)` on the outgoing one keeps the
summed power constant through the seam — measured, not asserted: the browser suite renders a
220 Hz take and an 880 Hz take through the production export and finds both tones at the seam at
≈0.71 of their steady amplitude with the window RMS unchanged to within 0.01 dB. When a take has
no material to overlap (a phrase that begins on its very first sample and ends on its last), the
blend collapses to a short guarded fade instead of inventing audio, and the editor says so.

Every edit is auditioned through project state — the same state live playback, WAV export, stem
export and bounce-in-place read. There is no separate comp preview renderer. *Apply comp*
commits one undoable edit; *Discard*, or closing the window, restores the persisted comp.

Boundaries worth knowing:

- A comp region is a view of *existing* recorded audio. Comping never creates or repairs audio:
  a project with no recorded takes has no take groups to show.
- A phrase naming a take whose audio could not be restored blocks WAV/stem export (the Phase 8B
  rule) instead of rendering a silent hole; the editor marks the phrase as unavailable.
- A phrase naming a take that no longer exists is dropped and reported — there is no asset to
  restore, so the rest of the comp still renders.
- Clip-level `pitchShiftSemitones`, `timeStretchRate` and `offsetSteps` all still apply per take,
  because each phrase is scheduled as that take's own window. Takes with different `lengthBars`
  in one group are clamped to the audio each take really has, and a phrase that would need
  material past a take's buffer is trimmed (reported in the editor, never silently stretched).
- `bouncePlaylistLaneToAudioClip` (Bounce-In-Place) and `renderProjectStems` follow the comp
  automatically because they call the same offline timeline renderer. A bounce of a comped lane
  therefore flattens the assembled performance — including its crossfades — into a new clip.

The representation, the crossfade law, the validation table and the measured evidence are in
[`docs/TAKE-COMPING.md`](docs/TAKE-COMPING.md).

### Patterns scope

Every pattern owns its own content: each channel's step-sequencer cells and Piano Roll notes
belong to the pattern they were written in. **Add pattern** creates an empty pattern,
**Clone pattern** copies the selected one for a variation, and editing a pattern never changes
another one. A playlist pattern clip plays its lane channel's content in the pattern the clip
names (shown on the clip, together with a preview of its first bar), and the same resolution is
used by live Song Mode, WAV and stem export, Standard MIDI export and Bounce-In-Place. A MIDI
take is written into the pattern that was selected when recording started.

Selecting a pattern is a view change, not an undo step. Undo returns to the project exactly as
it was just before the undone change — including the pattern that was selected at that moment —
and Redo is its exact inverse, so undoing an edit never jumps back to a pattern that was
selected before it.

Projects saved before patterns were independent open unchanged — every pattern still shows the
content it showed before. The first pattern operation (selecting, adding or cloning a pattern)
gives each pattern its own copy of that content and keeps every placed clip playing what it
played, so nothing audible changes.

Its current scope:

- Pattern clips are **per channel lane**: a clip plays one channel's part of a pattern. There
  is no single clip that plays every channel of a pattern at once.
- Patterns can be added, cloned and selected; there is **no delete or rename** for patterns yet.
- In Song Mode a clip loops its content's own length (as before), not the pattern's declared
  16/32-step length, which governs Pattern Mode and the Pattern Loop export.

### Local collaboration and sync status

Apex Studio currently uses a **local-first project workflow**. Project state and audio assets are stored locally; live network collaboration and cloud synchronization are not currently active.

### AI status

**Apex Studio currently does not include active AI generation, AI stem separation, or an AI API integration.** AI is intentionally outside the current core scope.

---

## 🛠️ Tech stack

- **React 19** — application UI
- **TypeScript** — application logic and type safety
- **Vite** — development and production web builds
- **Web Audio API** — audio playback, processing and rendering
- **Electron** — Windows desktop packaging
- **Electron Builder** — installer and portable builds
- **IndexedDB** — local project/audio persistence
- **Tailwind CSS** — UI styling

The project is designed to run locally and does not require a hosted backend for its core music-production workflow.

---

## 🤝 Feedback, bugs & contributions

Apex Studio is most useful when real producers tell us where the workflow breaks down.

When opening an issue, include:

1. **What you were trying to do**
2. **What you expected to happen**
3. **What actually happened**
4. **Steps to reproduce it**
5. **Browser/Windows environment**, if relevant

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development and pull-request guidelines and **[SECURITY.md](SECURITY.md)** for security reports.

### Useful links

- 🐛 [Report a bug](https://github.com/Ajey877/Apex-Studio/issues/new/choose)
- 💡 [Open an issue / suggest an improvement](https://github.com/Ajey877/Apex-Studio/issues/new/choose)
- 🔀 [View pull requests](https://github.com/Ajey877/Apex-Studio/pulls)
- ⚙️ [View GitHub Actions](https://github.com/Ajey877/Apex-Studio/actions)
- 📦 [View releases](https://github.com/Ajey877/Apex-Studio/releases)

If Apex Studio is useful to you, **a GitHub star helps the project get discovered by other creators.** ⭐

---

## 📈 Version

**Current release: `v1.2.2`**

v1.2.2 focuses on release parity and real-world DAW reliability: audio transport and rendering, mixer/FX behavior, project persistence and recovery, missing-audio handling, export/stem integrity, and Windows runtime validation.

See the [release page](https://github.com/Ajey877/Apex-Studio/releases/tag/v1.2.2) for the downloadable Windows build and release information.

---

## 📜 License

Apex Studio is licensed under the **MIT License**. See [`LICENSE`](LICENSE) for the full terms.

---

<div align="center">

### 🎛️ Make music. Keep it local. Keep creating.

**Apex Studio — v1.2.2**

[⬇️ Download](https://github.com/Ajey877/Apex-Studio/releases/tag/v1.2.2) · [⭐ Star on GitHub](https://github.com/Ajey877/Apex-Studio) · [🐛 Report an issue](https://github.com/Ajey877/Apex-Studio/issues/new/choose)

</div>
