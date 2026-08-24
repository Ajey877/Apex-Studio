# 🎛️ Apex Studio DAW — Professional Digital Audio Workstation

> **A studio-grade, multi-track digital audio workstation running directly in the browser and as a standalone native Windows desktop application.**
> 
> *100% Free & Unlocked for All Producers and Creators.*

---

## ⚡ 5-Minute Quickstart Tutorial

### 1. Build a Drum Beat (Channel Rack)
- Press <kbd>F6</kbd> (or <kbd>1</kbd>) to open the **Channel Rack**.
- Click the 16 step buttons across Kick, Snare, Hi-Hat, and 808 channels to create a groove.
- Press <kbd>Space</kbd> to listen in real time. Adjust tempo (BPM) at the top.

### 2. Play Melodies & Chords (Piano Roll or Keyboard)
- Press <kbd>F7</kbd> (or <kbd>2</kbd>) to open the **Piano Roll**.
- **No MIDI keyboard needed:** Play directly with your computer keys:
  - White keys: <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>G</kbd> <kbd>H</kbd> <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd>
  - Black keys: <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> <kbd>O</kbd> <kbd>P</kbd>
  - Octave shift: <kbd>Z</kbd> (Down) / <kbd>X</kbd> (Up)
  - Drum pads: Numeric Keypad <kbd>1</kbd>–<kbd>9</kbd>
- Click to draw notes, drag edges to resize note length, or use **Chord & Scale Stamps**.

### 3. Arrange Your Song (Playlist Arranger)
- Press <kbd>F5</kbd> (or <kbd>3</kbd>) to view the **Playlist Arranger**.
- Switch transport from **PAT** (Pattern) to **SONG** mode (<kbd>L</kbd>).
- Click on any track lane to paint your patterns, loop sections, and structure verse/chorus.
- Drag audio files (WAV/MP3) straight from your desktop onto the timeline.

### 4. Mix & Polish (Mixer & FX Racks)
- Press <kbd>F9</kbd> (or <kbd>4</kbd>) to open the **16-Track Mixer**.
- Add studio plugins to any channel: **Parametric EQ2**, **Gross Beat**, **Reverb**, **Delay**, or **Sidechain Ducking**.
- Open the **Mastering Suite** on the Master track for 3-Band Linear-Phase Compression & True Peak Limiting.

### 5. Save & Export
- Click **Export** in the top bar to render 24-bit/32-bit Float **WAV**, **MP3**, or **Stem ZIP** bundles.
- Save your session locally with <kbd>Ctrl</kbd> + <kbd>S</kbd> or export a project `.zip` bundle.

---

## 🖥️ Standalone Windows Desktop App (.EXE)

Apex Studio runs offline as an independent Windows program:

- **1-Click Batch Runner**: Open the **DESKTOP APP** menu, download the bundle, and double-click `ApexStudio-Windows-Launcher.bat`.
- **Compile `.EXE` Installer**: Right-click `Build-Windows-EXE.ps1` → *Run with PowerShell* to generate `Apex Studio DAW Setup.exe`.
- **Install PWA**: Click the Install icon in Chrome/Edge to pin Apex Studio to your Windows Start Menu & Taskbar.

---

## 🎹 Studio Feature Matrix

| Module | Core Capabilities |
| :--- | :--- |
| **Channel Rack** | 64-Step Drum Sequencer, Swing %, Velocity Offsets, MIDI Learn. |
| **Piano Roll** | Polyphonic Editing, Scale/Chord Stamps, Velocity Bars, Note Chop/Quantize. |
| **Playlist Arranger** | Multi-lane Timeline, Audio & Pattern Clips, Automation Curves, Tape Scrub. |
| **16-Track Mixer** | 10 FX Inserts/Track, Spectrum Visualizer, Sidechain Routing, Peak Meters. |
| **3D Wavetable Synth** | Dual Morphing Oscillators, 3D Wave Surface, Moog 24dB Filter, Dual ADSR. |
| **Mastering Suite** | 3-Band Linear Phase Compressor, Mid/Side Width, True Peak Limiter, LUFS. |
| **Gross Beat** | 36 Time/Volume Curves (Half-Speed, Stutter, Vinyl Brake, Gate, Flanger). |
| **Stem Splitter AI** | 4-Stem Audio Separation (Vocals, Drums, Bass, Instruments) to Timeline. |

---

## ⌨️ Essential Hotkeys

| Key | Action | Key | Action |
| :--- | :--- | :--- | :--- |
| <kbd>Space</kbd> | Play / Pause | <kbd>F5</kbd> or <kbd>3</kbd> | Playlist Arranger |
| <kbd>L</kbd> | Pattern / Song Mode | <kbd>F6</kbd> or <kbd>1</kbd> | Channel Rack |
| <kbd>R</kbd> | Arm Recording | <kbd>F7</kbd> or <kbd>2</kbd> | Piano Roll |
| <kbd>M</kbd> | Toggle Metronome | <kbd>F9</kbd> or <kbd>4</kbd> | Mixer & FX Rack |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save Project | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd> | Undo / Redo |

---

## 🛠️ Quick Developer Commands

```bash
npm install          # Install dependencies
npm run dev          # Run dev server (http://localhost:3000)
npm run build        # Build production web bundle
npx electron-builder --win --x64  # Build Windows .exe installer
```

---

## 📜 License & Community Access

Apex Studio is **100% Free & Open Access** for all music producers, beatmakers, and sound designers.
