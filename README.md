# 🎛️ Apex Studio DAW — Professional Digital Audio Workstation

> **A studio-grade, multi-track digital audio workstation running directly in the browser and as a standalone native Windows desktop application.**
> 
> *100% Free & Unlocked for All Producers and Creators.*

---

## ⚡ Highlights & Core Architecture

Apex Studio DAW brings the iconic, ultra-fast pattern-and-playlist production workflow (inspired by legendary DAWs like FL Studio and Ableton) to modern web standards and native desktop environments.

- **🎚️ Complete Multi-Track Production**: 64-step polyphonic channel rack, multi-lane piano roll with chord/scale stamps, unlimited playlist arranger with audio clips, and 16-channel stereo mixer with 10 insert FX per track.
- **🎹 Advanced Synthesizers & Samplers**: 3D Wavetable Morphing Synthesizer, DirectWave-style Multi-Zone Velocity Keymapped Sampler, Gross Beat (36 Time/Volume gates), and Web Audio Modules 2.0 (WAM2) plugin host.
- **🎛️ Studio FX & Mastering Suite**: 7-Band Interactive Parametric EQ2 with FFT spectrum, 3-Band Linear-Phase Multiband Mastering Suite with True Peak Maximizer and LUFS metering, Tape Saturation, Chorus, Stereo Widener, and Sidechain Ducking.
- **🚀 Advanced Studio Innovations**:
  - **4-Stem AI Splitter**: Vocal, Drum, Bass, and Other stem isolation.
  - **Élastique Transient Warp**: Real-time audio time-stretching with transient markers.
  - **3D Spatial Audio & Binaural Panning**: Dolby Atmos-style 3D soundstage placement.
  - **MPE 5D Touch Expression**: Multi-dimensional polyphonic glide, pressure, and timbre shaping.
  - **SMPTE Cinema Scoring**: Lock audio cues to video timestamps at 24/30/60 fps.
  - **Real-Time Tape Audio Scrubbing**: Analog auditioning when dragging the arranger ruler playhead.
  - **Project `.ZIP` Bundle Exporter & Importer**: 1-click portable session packages with MIDI patterns and routing manifests.

---

## 🖥️ Running on Windows (.EXE & Desktop Launcher)

Apex Studio includes full native desktop support for **Windows 10 & Windows 11**:

### Option 1: 1-Click Launcher (No Installation Required)
1. Open the **"DESKTOP APP"** menu in the top toolbar.
2. Click **"Download Windows .EXE Bundle (.ZIP)"** and extract the files.
3. Double-click `ApexStudio-Windows-Launcher.bat` (or `ApexStudio-Silent.vbs`) to run Apex Studio in a dedicated standalone window with hardware GPU acceleration and low-latency audio processing.

### Option 2: Compile Standalone `.EXE` Installer
1. Extract the downloaded Windows ZIP bundle.
2. Right-click `Build-Windows-EXE.ps1` and select **"Run with PowerShell"** (or run `npx electron-builder --win --x64` in terminal).
3. The standalone Windows installer (`Apex Studio DAW Setup.exe`) will be generated inside the `\dist` folder!

### Option 3: Progressive Web App (PWA)
1. Open in Google Chrome, Microsoft Edge, or Brave.
2. Click the **Install** button in the browser address bar (or in the Desktop App modal).
3. Apex Studio will install directly to your Windows Start Menu and Desktop with unthrottled background audio playback.

---

## 🎹 Studio Feature Reference

| Module | Features & Capabilities |
| :--- | :--- |
| **Channel Rack** | 64-Step Drum Sequencer, Swing %, Note Pitch/Velocity offsets, Channel mute/solo, MIDI Learn. |
| **Piano Roll** | Polyphonic note editing, Chord Stamps (Maj, Min, 7th, 9th, Sus4), Scale Snapping (Aeolian, Dorian, Pentatonic), Velocity velocity bars, Note Splitting & Quantize. |
| **Playlist Arranger** | Multi-lane timeline, Audio Clips, Pattern Clips, Automation Curves, Marker Navigation, Real-time Tape Scrub Audition. |
| **Mixer** | 16 Stereo Insert Tracks + Master, 10 FX slots per track, Interactive Mini-FFT spectrum backdrop, Sidechain Send routing, Peak Metering. |
| **3D Wavetable Synth** | Dual wavetable morphing oscillators, 3D surface visualizer, Sub-osc, Noise generator, Dual ADSR, 24dB Moog-style filter. |
| **Mastering Suite** | 3-Band Linear Phase Compressor, Mid/Side Stereo Enhancer, True Peak Brickwall Maximizer, EBU R128 LUFS Loudness Meter. |
| **Gross Beat** | 36 Time & Volume gating curves (Half-Speed, Stutter, Vinyl Brake, Gate, Flanger). |
| **DirectWave Sampler** | Multi-zone velocity keymapping, Root Key tuning, Pitch envelope, Loop points, Reverse mode. |
| **Stem Splitter AI** | 4-stem separation (Vocals, Drums, Bass, Instruments) with instant timeline placement. |

---

## ⌨️ Essential Keyboard Shortcuts

- <kbd>Space</kbd> — Play / Pause Transport
- <kbd>F5</kbd> — Open Playlist Arranger
- <kbd>F6</kbd> — Open Channel Rack Step Sequencer
- <kbd>F7</kbd> — Open Piano Roll
- <kbd>F9</kbd> — Open Mixer & FX Rack
- <kbd>Ctrl</kbd> + <kbd>Z</kbd> — Undo Last Action
- <kbd>Ctrl</kbd> + <kbd>Y</kbd> — Redo
- <kbd>Ctrl</kbd> + <kbd>S</kbd> — Save Project to Local Storage
- <kbd>M</kbd> — Toggle Metronome Click
- <kbd>R</kbd> — Toggle Arm Audio Recording

---

## 🛠️ Development & Building

### Requirements
- Node.js 18+
- npm / yarn / pnpm

### Quickstart
```bash
# 1. Install dependencies
npm install

# 2. Run local development server (binds to http://localhost:3000)
npm run dev

# 3. Build optimized production web app
npm run build

# 4. Package Windows .EXE installer (via Electron Builder)
npx electron-builder --win --x64
```

---

## 📜 License & Access

Apex Studio is **100% Free & Open Access** for all music producers, beatmakers, sound designers, and audio engineers.

*Crafted with precision for next-generation music creators.*
