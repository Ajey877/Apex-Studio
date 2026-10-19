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
Balance channels, route audio and shape your mix.

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
| **Mixer** | Work across mixer tracks with volume, pan, routing, metering and insert effects (EQ, reverb, delay, compression, limiter). |
| **Synth** | Shape sounds with dual oscillators, filters, ADSR and modulation controls. |
| **Recording** | Capture audio and place recorded takes into the project. |
| **Take Comping** | Pick the active take in each recorded take group; the takes you do not select are silenced in playback and export. |
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
The surfaces below are **in the app but not wired into the audio engine yet**, and they say so in their own UI:

| Surface | Status |
|---|---|
| **Vocal Tuner** | Settings are saved with the project but **not applied** — there is no pitch detection or pitch correction in the signal path. |
| **Warp Processor** | Applies **pitch and playback rate** to an audio clip. Length-preserving time-stretch is **not implemented**, so pitch rides with the rate. |
| **Wavetable Synth** | **Preview surface.** The channel keeps playing with its dual-oscillator subtractive synth; there is no wavetable engine behind this window yet. |
| **Polyphonic Blob Editor** | **Prototype.** Displays sample blobs; it does not analyse, import or play back project audio. |

### Mastering Suite processing path

The mastering processors **are applied to the master bus**. The same `MasteringProcessor`
graph is installed in the live `AudioContext` and in the `OfflineAudioContext` used for
export, so playback and rendered files follow the same settings. Bypassing the suite is a
literal dry path rather than a no-op setting.

What is in the signal path:

- **3-band multiband compressor** — low/mid/high crossovers (low 80–500 Hz, high 1.8–16 kHz),
  and per band: threshold, ratio, makeup gain, attack, release, knee, solo and mute.
- **Stereo imager** — width multiplier plus a sub-bass mono collapse below a set frequency.
- **Maximizer** — threshold (drive), release, and a brickwall ceiling.

Known limitations, stated here and in the suite's own UI:

- The maximizer is a fast-attack compressor followed by a 4× oversampled hard clip. It is
  **not** a true-peak lookahead limiter: there is no delay buffer, and the "lookahead"
  setting only switches the compressor attack between 1 ms and 5 ms.
- The **LUFS target is a metering reference only**. It is displayed next to the measured
  integrated loudness; it does not apply automatic gain.
- Loudness, true-peak and stereo metering measure the master bus, but there is **no
  gain-reduction metering** — the per-band GR readouts say `NOT MEASURED` because nothing
  measures them yet.
- The crossover splits are 12 dB/octave biquads summed after their compressors, not a
  unity-sum alignment, so bands overlap at the crossover points.

### Take comping scope

Take comping works on **recorded take groups that exist in the project**. The comping window
lists every take group, shows which take is currently active, and lets you select a different
one. The selection is written to the project, is undoable, and the audio engine honours it:
takes that are not active are silenced in both live playback and offline export. Nothing is
deleted when you switch takes.

Its scope is whole-take selection. It does not split a take into regions, and it does not
crossfade between takes, so it is comping by take rather than comping by phrase. It also never
creates audio: a project with no recorded takes has no take groups to show.

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
