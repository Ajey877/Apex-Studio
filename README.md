# 🎛️ Apex Studio DAW

> **A free, open-access digital audio workstation for making complete tracks in your browser or on Windows.**

Apex Studio combines a step sequencer, piano roll, playlist arranger, mixer, instruments, effects, recording, automation, and WAV/MIDI export in one project.

**[🚀 Get Apex Studio](https://github.com/Ajey877/Apex-Studio) · [⬇️ Windows Releases](https://github.com/Ajey877/Apex-Studio/releases) · [🐛 Report a Bug](https://github.com/Ajey877/Apex-Studio/issues/new/choose) · [💬 Issues](https://github.com/Ajey877/Apex-Studio/issues)**

[![CI](https://github.com/Ajey877/Apex-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/Ajey877/Apex-Studio/actions/workflows/ci.yml)
[![Audio Validation](https://github.com/Ajey877/Apex-Studio/actions/workflows/audio-validation.yml/badge.svg)](https://github.com/Ajey877/Apex-Studio/actions/workflows/audio-validation.yml)
[![Desktop Validation](https://github.com/Ajey877/Apex-Studio/actions/workflows/desktop-validation.yml/badge.svg)](https://github.com/Ajey877/Apex-Studio/actions/workflows/desktop-validation.yml)

---

## 🎧 What is Apex Studio?

Apex Studio is being built as a practical DAW for producers, beatmakers, and sound designers who want a focused music-production workflow without paying for a commercial DAW.

### Core workflow

**Create → Arrange → Mix → Record → Automate → Export**

| Module | What you can do |
| :--- | :--- |
| **Channel Rack** | Step sequencing, swing, velocity, MIDI learn |
| **Piano Roll** | Polyphonic notes, scales, chords, velocity, quantize |
| **Playlist Arranger** | Multi-lane arrangement, audio/pattern clips, automation |
| **Mixer** | 16 tracks, inserts, routing, meters, spectrum visualization |
| **Synth** | Dual wavetable oscillators, filters, ADSR, modulation |
| **Recording** | Capture audio and place takes into the project |
| **FX** | EQ, reverb, delay, compression, Gross Beat-style time/volume effects |
| **Mastering** | Compression, stereo control, limiting and loudness tools |
| **Export** | WAV, Standard MIDI and project/stem ZIP workflows |

---

## ⚡ Try it quickly

### 1. Build a beat
Open the **Channel Rack** and program Kick, Snare, Hi-Hat and 808 steps.

**Shortcut:** `F6` or `1`

### 2. Write melodies
Open the **Piano Roll**, draw notes, change their length/velocity, and use the scale/chord tools.

**Shortcut:** `F7` or `2`

### 3. Arrange the song
Open the **Playlist Arranger**, switch to **SONG** mode, paint patterns and place audio clips on the timeline.

**Shortcut:** `F5` or `3`

### 4. Mix it
Open the **Mixer**, route tracks, add effects and balance the master.

**Shortcut:** `F9` or `4`

### 5. Export
Use the export workflow to render WAV, export Standard MIDI, or create a project/stem package.

---

## 💻 Run Apex Studio locally

### Browser development build

Requirements: **Node.js 20+**.

```bash
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

### Production build

```bash
npm run build
```

### Windows desktop build

```bash
npm install
npm run package:win
```

The Windows installer and portable build are generated under `dist-electron/`.

### Official Windows releases

Tagged releases are built by GitHub Actions and publish the Windows `.exe`, `.zip`, and related release artifacts.

**[Download from GitHub Releases →](https://github.com/Ajey877/Apex-Studio/releases)**

---

## ⌨️ Essential shortcuts

| Key | Action | Key | Action |
| :--- | :--- | :--- | :--- |
| `Space` | Play / Pause | `F5` / `3` | Playlist Arranger |
| `L` | Pattern / Song Mode | `F6` / `1` | Channel Rack |
| `R` | Arm Recording | `F7` / `2` | Piano Roll |
| `M` | Metronome | `F9` / `4` | Mixer & FX Rack |
| `Ctrl` + `S` | Save Project | `Ctrl` + `Z` / `Y` | Undo / Redo |

---

## 🧪 Engineering quality

Apex Studio is developed with automated validation around the audio engine and desktop packaging.

Current repository validation includes:

- TypeScript validation
- Audio regression tests
- Project/history regression tests
- Desktop security configuration checks
- Production Vite build
- Windows Electron packaging validation

See the GitHub Actions checks at the top of this README for the current status.

---

## 🛠️ Current development focus

The project is prioritizing **reliability and real DAW workflows before adding more headline features**.

Recent engineering work includes project persistence, portable project/audio bundles, offline rendering, live mixer FX integration, playlist/audio reliability, and document-level undo/redo. The repository history contains the detailed implementation and validation notes.

### AI policy

**Apex Studio currently has no active AI generation, AI stem separation, or AI API integration.** AI is intentionally out of scope until a later release.

---

## 🤝 Feedback and contributions

If you try Apex Studio, the most useful feedback is concrete:

- What workflow did you try?
- What worked?
- What broke?
- What feature blocked you from finishing a track?

**[Open an issue →](https://github.com/Ajey877/Apex-Studio/issues/new/choose)**

If Apex Studio is useful to you, **a GitHub star helps other producers discover the project.**

---

## 📜 License

Apex Studio is free and open access for music producers, beatmakers, and sound designers.
