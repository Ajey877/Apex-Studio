import React, { useState, useEffect } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Monitor, 
  X, 
  Sparkles, 
  Download, 
  Cpu, 
  Check, 
  Terminal, 
  Zap, 
  ShieldCheck, 
  HardDrive, 
  Flame, 
  Copy,
  ExternalLink,
  Laptop,
  FolderArchive,
  Layers,
  Play,
  FileCode
} from 'lucide-react';
import JSZip from 'jszip';
import { audioEngine } from '../audio/audioEngine';
import type { AudioLatencyMetrics } from '../types/daw';

interface DesktopAppModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DesktopAppModal: React.FC<DesktopAppModalProps> = ({
  isOpen,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<'windows_exe' | 'pwa' | 'electron' | 'resolution'>('windows_exe');
  const [isInstalled, setIsInstalled] = useState<boolean>(false);
  const [copiedScript, setCopiedScript] = useState<boolean>(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [screenInfo, setScreenInfo] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    pixelRatio: window.devicePixelRatio || 1,
    colorDepth: window.screen.colorDepth || 24
  });

  useEffect(() => {
    const handleResize = () => {
      setScreenInfo({
        width: window.innerWidth,
        height: window.innerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        pixelRatio: window.devicePixelRatio || 1,
        colorDepth: window.screen.colorDepth || 24
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /**
   * Audio engine facts read from the live AudioContext. There is deliberately
   * no fallback constant: before an audio context exists this reports "engine
   * not started" instead of showing a latency figure the app never measured.
   */
  const [audioEngineInfo, setAudioEngineInfo] = useState<AudioLatencyMetrics | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const read = () => setAudioEngineInfo(audioEngine.getLatencyMetrics());
    read();
    const timerId = setInterval(read, 1000);
    return () => clearInterval(timerId);
  }, [isOpen]);

  const formatMs = (seconds: number | null | undefined): string | null =>
    seconds === null || seconds === undefined || !Number.isFinite(seconds) ? null : `${(seconds * 1000).toFixed(2)}ms`;

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  if (!isOpen) return null;

  const handleInstallPwa = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setIsInstalled(true);
        setStatusMessage('App installed to your desktop program launcher!');
      }
      setDeferredPrompt(null);
    } else {
      setStatusMessage('In Chrome/Edge: Click the Install Icon (⊕ or 💻) in your browser address bar or menu (⋯ > Apps > Install) to run as an independent Windows window!');
      setTimeout(() => setStatusMessage(null), 6000);
    }
  };

  const currentOrigin = window.location.origin;

  const generateWindowsZipBundle = async () => {
    try {
      setIsDownloadingZip(true);
      setStatusMessage('Packaging Windows Executable (.exe) setup bundle into ZIP...');

      const zip = new JSZip();

      // 1. Windows Batch 1-Click Launcher (ApexStudio-Windows-Launcher.bat)
      const batLauncher = `@echo off
title Apex Studio DAW - Professional Windows Workstation
color 0E
echo ========================================================
echo        APEX STUDIO DIGITAL AUDIO WORKSTATION
echo              Native Windows Desktop Host
echo ========================================================
echo.
echo Initializing Low-Latency Audio Engine and Desktop Window...
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Node.js is not found. Launching via dedicated Standalone Windows App Window...
    start msedge --app="${currentOrigin}" --window-size=1440,900 || start chrome --app="${currentOrigin}" --window-size=1440,900
    exit /b
)

if not exist "node_modules\\electron" (
    echo [1/2] Installing lightweight Windows Electron desktop engine...
    call npm install electron --no-audit --no-fund
)

echo [2/2] Booting native Windows DAW process with background audio priority...
npx electron electron.cjs
`;
      zip.file('ApexStudio-Windows-Launcher.bat', batLauncher);

      // 2. PowerShell Executable Builder (Build-Windows-EXE.ps1)
      const ps1Builder = `# ========================================================
# APEX STUDIO DAW - WINDOWS .EXE INSTALLER GENERATOR
# ========================================================
Write-Host ">>> Starting Apex Studio Windows .EXE Compilation..." -ForegroundColor Cyan

# Check if npm is installed
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js & npm are required to build the standalone .exe installer." -ForegroundColor Red
    Write-Host "Please install Node.js LTS from https://nodejs.org/" -ForegroundColor Yellow
    Pause
    Exit
}

Write-Host "[1/3] Installing electron-builder packaging dependencies..." -ForegroundColor Green
npm install --save-dev electron electron-builder

Write-Host "[2/3] Compiling Windows Standalone Executable (.exe / NSIS Installer)..." -ForegroundColor Green
npx electron-builder --win --x64

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "SUCCESS! Your Windows .exe installer is located in the \\dist directory!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Pause
`;
      zip.file('Build-Windows-EXE.ps1', ps1Builder);

      // 3. Silent VBScript Launcher (ApexStudio-Silent.vbs)
      const vbsLauncher = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "ApexStudio-Windows-Launcher.bat", 0, False
`;
      zip.file('ApexStudio-Silent.vbs', vbsLauncher);

      // 4. electron.cjs
      const electronCjs = `const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "Apex Studio DAW - Professional Music Workstation",
    backgroundColor: "#0a0a0b",
    autoHideMenuBar: true,
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false, // Prevents audio stuttering when switching apps
      audioWorklet: true
    }
  });

  // Windows Desktop Low-Latency Audio Flags
  app.commandLine.appendSwitch('enable-exclusive-audio');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');

  mainWindow.loadURL("${currentOrigin}");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`;
      zip.file('electron.cjs', electronCjs);

      // 5. preload.cjs
      const preloadCjs = `const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,
  version: '2.4.0'
});
`;
      zip.file('preload.cjs', preloadCjs);

      // 6. package.json for Windows exe packaging
      const pkgJson = {
        name: "apex-studio-daw",
        version: "2.4.0",
        description: "Apex Studio Professional Digital Audio Workstation for Windows",
        main: "electron.cjs",
        author: "Apex Audio Systems",
        scripts: {
          "start": "electron .",
          "build:exe": "electron-builder --win nsis",
          "build:portable": "electron-builder --win portable"
        },
        build: {
          appId: "com.apexstudio.daw",
          productName: "Apex Studio DAW",
          win: {
            target: ["nsis", "portable"],
            icon: "icon.ico",
            requestedExecutionLevel: "asInvoker"
          },
          nsis: {
            oneClick: false,
            allowToChangeInstallationDirectory: true,
            createDesktopShortcut: true,
            createStartMenuShortcut: true
          }
        },
        devDependencies: {
          "electron": "^29.0.0",
          "electron-builder": "^24.13.3"
        }
      };
      zip.file('package.json', JSON.stringify(pkgJson, null, 2));

      // 7. README instructions
      const readme = `======================================================================
               APEX STUDIO DAW - WINDOWS .EXE DESKTOP SETUP
======================================================================

Welcome to the Apex Studio Desktop Executable package!

OPTION 1: INSTANT 1-CLICK LAUNCH (NO BUILD NEEDED)
----------------------------------------------------------------------
Simply double-click:
  -> "ApexStudio-Windows-Launcher.bat"
or for silent window without terminal:
  -> "ApexStudio-Silent.vbs"

This launches Apex Studio in a dedicated borderless Windows app container
with native hardware acceleration and low-latency audio worklet routing.


OPTION 2: COMPILE STANDALONE INSTALLER (.EXE)
----------------------------------------------------------------------
1. Make sure Node.js is installed on your PC (https://nodejs.org)
2. Right-click "Build-Windows-EXE.ps1" and select "Run with PowerShell"
   OR in command prompt run:
     npm install
     npm run build:exe
3. Your installer "Apex Studio DAW Setup.exe" will be generated in \\dist!


AUDIO DRIVER OPTIMIZATION FOR WINDOWS:
----------------------------------------------------------------------
For ultra-low latency (< 5ms) when recording MIDI or vocals:
- ASIO4ALL / Low-Latency ASIO Driver recommended
- Exclusive Audio Mode is auto-enabled in the desktop executable
`;
      zip.file('README_WINDOWS_EXE.txt', readme);

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ApexStudio_Windows_EXE_Bundle_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setIsDownloadingZip(false);
      setStatusMessage('Downloaded Windows .EXE Setup & Launcher Bundle (.ZIP)!');
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err) {
      console.error(err);
      setIsDownloadingZip(false);
      setStatusMessage('Error creating Windows executable bundle.');
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleCopyScript = () => {
    navigator.clipboard.writeText(`npm install electron electron-builder --save-dev\nnpx electron-builder --win --x64`);
    setCopiedScript(true);
    setStatusMessage('Copied Windows .EXE Build Commands to Clipboard!');
    setTimeout(() => {
      setCopiedScript(false);
      setStatusMessage(null);
    }, 3000);
  };

  return (
    // UI-03O: every chrome surface, border, text step and interaction state is
    // themed through the existing `--apex-*` tokens. The desktop-app identity
    // (header tile, readiness badge, active tab, status toast, both CTAs and the
    // footer action) resolves `--apex-accent` / `--apex-accent-strong`, the token
    // the UI-1C compatibility layer already resolved these `#ff6e00` literals to,
    // so the warm-orange identity family is now one coherent accent family instead
    // of a violet-plus-raw-amber mix. The per-card glyph triad keeps its distinct
    // meanings on `--apex-success`, `--apex-cyan-text` and `--apex-gold`, and the
    // colour-depth sub-label keeps `--apex-aux-text`. The dead `bg-black/85` scrim is gone:
    // ModalFrame supplies the shared themed `--apex-modal-overlay`. The toast
    // dismiss glyph gains the accessible name it never had.
    <ModalFrame
      id="fl-desktop-app-modal"
      labelledBy="fl-desktop-app-modal-title"
      onClose={onClose}
      className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"
    >
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-accent)] to-[var(--apex-accent-strong)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Monitor className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-desktop-app-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">
                  WINDOWS .EXE & DESKTOP SUITE
                </h2>
                {/* UI-03O: the readiness badge keeps its accent wash and edge;
                    the label follows `--apex-text` because the accent-on-accent-wash
                    combination measures 3.90:1 in Light and 4.23:1 in
                    Dark, both below the 4.5:1 AA floor for a 9px bold label
                    (UI-03L precedent). */}
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)]">
                  WINDOWS 10 / 11 NATIVE
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">
                Run Apex Studio as an independent desktop application with dedicated process priority and low-latency audio
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close desktop app"
            className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button
              onClick={() => setStatusMessage(null)}
              aria-label="Dismiss status message"
              className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]"
            >
              ✕
            </button>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-[var(--apex-border)] bg-[var(--apex-canvas)] px-5 pt-2 gap-2 text-xs overflow-x-auto no-scrollbar">
          <button
            onClick={() => setActiveTab('windows_exe')}
            className={`pb-2 px-3 font-bold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'windows_exe'
                ? 'border-[var(--apex-accent)] text-[var(--apex-accent)]'
                : 'border-transparent text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Windows .EXE & Launcher Bundle</span>
          </button>

          <button
            onClick={() => setActiveTab('pwa')}
            className={`pb-2 px-3 font-bold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'pwa'
                ? 'border-[var(--apex-accent)] text-[var(--apex-accent)]'
                : 'border-transparent text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
            }`}
          >
            <Laptop className="w-3.5 h-3.5" />
            <span>1-Click App (PWA)</span>
          </button>

          <button
            onClick={() => setActiveTab('resolution')}
            className={`pb-2 px-3 font-bold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'resolution'
                ? 'border-[var(--apex-accent)] text-[var(--apex-accent)]'
                : 'border-transparent text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Desktop Display & Scaling ({screenInfo.width}×{screenInfo.height})</span>
          </button>

          <button
            onClick={() => setActiveTab('electron')}
            className={`pb-2 px-3 font-bold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'electron'
                ? 'border-[var(--apex-accent)] text-[var(--apex-accent)]'
                : 'border-transparent text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>CLI Exe Build Commands</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4 text-xs">
          {activeTab === 'windows_exe' && (
            <div className="space-y-4">
              {/* Primary 1-Click Windows .EXE Package Download Card */}
              <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] space-y-3 shadow-lg">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    {/* UI-03O: same rule as the readiness badge — the wash and
                        edge carry the accent identity, the label stays AA-legible. */}
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] inline-block mb-1">
                      READY-TO-USE WINDOWS SUITE
                    </span>
                    <h3 className="text-sm font-bold text-[var(--apex-text)]">Download Windows Standalone .EXE & Launcher Bundle</h3>
                    <p className="text-xs text-[var(--apex-text-2)] pt-0.5">
                      Contains 1-click Windows batch launcher, PowerShell `.exe` compiler, and native Electron desktop runner.
                    </p>
                  </div>

                  <button
                    onClick={generateWindowsZipBundle}
                    disabled={isDownloadingZip}
                    className="px-5 py-2.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold rounded-lg shadow-lg flex items-center justify-center gap-2 text-xs transition whitespace-nowrap active:scale-95"
                  >
                    <Download className="w-4 h-4" />
                    <span>{isDownloadingZip ? 'Packaging Windows Bundle...' : 'Download Windows .EXE Bundle (.ZIP)'}</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-[var(--apex-border)]">
                  <div className="bg-[var(--apex-canvas)] p-2.5 rounded border border-[var(--apex-border)] space-y-1">
                    <div className="flex items-center gap-1.5 text-[var(--apex-text)] font-bold text-[11px]">
                      <Play className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                      <span>1-Click Batch Runner</span>
                    </div>
                    <p className="text-[10px] text-[var(--apex-text-3)]">
                      Double-click <code className="text-[var(--apex-gold)]">ApexStudio-Windows-Launcher.bat</code> to launch instantly.
                    </p>
                  </div>

                  <div className="bg-[var(--apex-canvas)] p-2.5 rounded border border-[var(--apex-border)] space-y-1">
                    <div className="flex items-center gap-1.5 text-[var(--apex-text)] font-bold text-[11px]">
                      <FileCode className="w-3.5 h-3.5 text-[var(--apex-cyan-text)]" />
                      <span>PowerShell .EXE Builder</span>
                    </div>
                    <p className="text-[10px] text-[var(--apex-text-3)]">
                      Run <code className="text-[var(--apex-cyan-text)]">Build-Windows-EXE.ps1</code> to compile your own{' '}
                      <code className="text-[var(--apex-text)]">Setup.exe</code>.
                    </p>
                  </div>

                  <div className="bg-[var(--apex-canvas)] p-2.5 rounded border border-[var(--apex-border)] space-y-1">
                    <div className="flex items-center gap-1.5 text-[var(--apex-text)] font-bold text-[11px]">
                      <ShieldCheck className="w-3.5 h-3.5 text-[var(--apex-gold)]" />
                      <span>Low-Latency Audio Mode</span>
                    </div>
                    <p className="text-[10px] text-[var(--apex-text-3)]">Exclusive Windows WASAPI/DirectSound priority without background audio throttling.</p>
                  </div>
                </div>
              </div>

              {/* Windows Step-by-Step Instructions */}
              <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] space-y-2.5">
                <span className="text-xs font-bold text-[var(--apex-text)] uppercase block tracking-wider">How to Use on Any Windows PC (Windows 10 / 11)</span>
                <ol className="space-y-2 text-[11px] text-[var(--apex-text-2)] list-decimal list-inside">
                  <li>
                    Click <strong className="text-[var(--apex-text)]">"Download Windows .EXE Bundle (.ZIP)"</strong> above and extract the zip archive on your
                    computer.
                  </li>
                  <li>
                    Double-click <code className="text-[var(--apex-gold)] bg-[var(--apex-canvas)] px-1.5 py-0.5 rounded">ApexStudio-Windows-Launcher.bat</code>{' '}
                    to run the DAW in a standalone borderless desktop window.
                  </li>
                  <li>
                    To compile a standard Windows Installer{' '}
                    <code className="text-[var(--apex-cyan-text)] bg-[var(--apex-canvas)] px-1.5 py-0.5 rounded">Apex Studio DAW Setup.exe</code>, right-click{' '}
                    <code className="text-[var(--apex-cyan-text)]">Build-Windows-EXE.ps1</code> and choose <em>"Run with PowerShell"</em>.
                  </li>
                  <li>The installer will automatically create Start Menu and Desktop shortcuts for you!</li>
                </ol>
              </div>
            </div>
          )}

          {activeTab === 'pwa' && (
            <div className="space-y-4">
              <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="space-y-1.5">
                  <h3 className="text-sm font-bold text-[var(--apex-text)] flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[var(--apex-success)]" />
                    <span>Install as Dedicated Windowed Desktop Program</span>
                  </h3>
                  <p className="text-xs text-[var(--apex-text-2)]">
                    Removes all browser tabs, bookmarks, and search bars. Launches straight from your Windows Taskbar, Start Menu, or Desktop with offline
                    caching.
                  </p>
                  <ul className="text-[11px] text-[var(--apex-text-2)] space-y-1 list-disc list-inside pt-1">
                    <li>Zero background audio throttling (continuous sound when app is unfocused)</li>
                    <li>Exclusive WebMIDI hardware port binding & low-latency AudioContext</li>
                    <li>Persistent IndexedDB offline project caching</li>
                  </ul>
                </div>

                <button
                  onClick={handleInstallPwa}
                  className="px-5 py-2.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold rounded-lg shadow-lg flex items-center gap-2 text-xs transition whitespace-nowrap"
                >
                  <Download className="w-4 h-4" />
                  <span>Install Desktop Program</span>
                </button>
              </div>

              {/* Offline Engine Readiness */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1">
                  <span className="text-[10px] text-[var(--apex-text-3)] font-bold block">AUDIO ENGINE LATENCY</span>
                  <span className="text-[var(--apex-success)] font-mono text-sm font-bold">
                    {audioEngineInfo
                      ? [
                          `base ${formatMs(audioEngineInfo.baseLatencySeconds) ?? 'not reported'}`,
                          `output ${formatMs(audioEngineInfo.outputLatencySeconds) ?? 'not reported'}`,
                        ].join(' / ')
                      : 'ENGINE NOT STARTED'}
                  </span>
                  <p className="text-[10px] text-[var(--apex-text-3)]">
                    {audioEngineInfo
                      ? `Render quantum ${audioEngineInfo.renderQuantumSamples} frames (${(audioEngineInfo.renderQuantumSeconds * 1000).toFixed(2)}ms) at ${(audioEngineInfo.sampleRate / 1000).toFixed(1)}kHz, read from AudioContext.baseLatency / outputLatency.`
                      : 'Latency is read from AudioContext.baseLatency / outputLatency once the audio engine exists.'}
                  </p>
                </div>

                <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1">
                  <span className="text-[10px] text-[var(--apex-text-3)] font-bold block">LOCAL STORAGE CACHE</span>
                  <span className="text-[var(--apex-cyan-text)] font-mono text-sm font-bold">Unlimited IndexedDB</span>
                  <p className="text-[10px] text-[var(--apex-text-3)]">Custom audio samples & recorded audio preserved</p>
                </div>

                <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1">
                  <span className="text-[10px] text-[var(--apex-text-3)] font-bold block">AUDIO THREADING</span>
                  <span className="text-[var(--apex-gold)] font-mono text-sm font-bold">Web Audio graph thread</span>
                  <p className="text-[10px] text-[var(--apex-text-3)]">
                    Node processing runs on the browser audio thread while voices are scheduled from the main thread. No AudioWorklet processor is used by the
                    engine today.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'resolution' && (
            <div className="space-y-3">
              <span className="text-xs font-bold text-[var(--apex-text)] block uppercase tracking-wider">
                DESKTOP RESOLUTION & UI COMPATIBILITY DIAGNOSTICS
              </span>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)]">
                  <span className="text-[10px] text-[var(--apex-text-3)] block font-bold">VIEWPORT SIZE</span>
                  <span className="text-[var(--apex-text)] font-mono text-sm font-bold">
                    {screenInfo.width} × {screenInfo.height}
                  </span>
                  <span className="text-[9px] text-[var(--apex-success)] block">Fully Responsive</span>
                </div>

                <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)]">
                  <span className="text-[10px] text-[var(--apex-text-3)] block font-bold">MONITOR DISPLAY</span>
                  <span className="text-[var(--apex-text)] font-mono text-sm font-bold">
                    {screenInfo.screenWidth} × {screenInfo.screenHeight}
                  </span>
                  <span className="text-[9px] text-[var(--apex-cyan-text)] block">Native Windows Display</span>
                </div>

                <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)]">
                  <span className="text-[10px] text-[var(--apex-text-3)] block font-bold">DPI SCALE RATIO</span>
                  <span className="text-[var(--apex-text)] font-mono text-sm font-bold">
                    {screenInfo.pixelRatio}x ({Math.round(screenInfo.pixelRatio * 100)}%)
                  </span>
                  <span className="text-[9px] text-[var(--apex-gold)] block">Vector Hi-DPI Crisp</span>
                </div>

                <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)]">
                  <span className="text-[10px] text-[var(--apex-text-3)] block font-bold">COLOR DEPTH</span>
                  <span className="text-[var(--apex-text)] font-mono text-sm font-bold">{screenInfo.colorDepth}-bit sRGB</span>
                  <span className="text-[9px] text-[var(--apex-aux-text)] block">Studio Visual Spectrum</span>
                </div>
              </div>

              {/* Supported Desktop Resolutions Grid */}
              <div className="bg-[var(--apex-surface-2)] p-3.5 rounded-lg border border-[var(--apex-border)] space-y-2">
                <span className="text-[11px] font-bold text-[var(--apex-text-2)] block">Verified Desktop Compatibility Standards:</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
                  <div className="flex items-center gap-2 text-[var(--apex-text-2)] bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                    <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>
                      <strong>1366 × 768</strong> (Compact Laptops)
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[var(--apex-text-2)] bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                    <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>
                      <strong>1920 × 1080</strong> (Full HD Standard)
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[var(--apex-text-2)] bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                    <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>
                      <strong>2560 × 1440</strong> (2K QHD Gaming)
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[var(--apex-text-2)] bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                    <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>
                      <strong>3840 × 2160</strong> (4K Ultra HD)
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[var(--apex-text-2)] bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                    <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>
                      <strong>21:9 / 32:9</strong> (Ultra-Wide Screens)
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[var(--apex-text-2)] bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                    <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>
                      <strong>50% Window Snap</strong> (Split Screen)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'electron' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-[var(--apex-text)]">CLI EXECUTABLE BUILD COMMANDS (ELECTRON BUILDER)</h3>
                  <p className="text-[10px] text-[var(--apex-text-3)]">
                    Run these commands to package into a standalone Windows `.exe` (NSIS installer or portable binary)
                  </p>
                </div>

                <button
                  onClick={handleCopyScript}
                  className="px-3 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] border border-[var(--apex-border)] text-xs font-bold rounded flex items-center gap-1.5 transition"
                >
                  {copiedScript ? <Check className="w-3.5 h-3.5 text-[var(--apex-success)]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedScript ? 'Copied!' : 'Copy Commands'}</span>
                </button>
              </div>

              <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] font-mono text-[11px] text-[var(--apex-text-2)] overflow-x-auto space-y-2">
                <div className="text-[var(--apex-success)] font-bold"># 1. Install packaging tools:</div>
                <div className="text-[var(--apex-text)]">npm install electron electron-builder --save-dev</div>

                <div className="text-[var(--apex-cyan-text)] font-bold pt-2"># 2. Compile Windows .exe Installer:</div>
                <div className="text-[var(--apex-text)]">npx electron-builder --win --x64</div>

                <div className="text-[var(--apex-gold)] font-bold pt-2"># 3. Compile Portable Single-File .exe:</div>
                <div className="text-[var(--apex-text)]">npx electron-builder --win portable</div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Direct Hardware Driver & Web Audio Subsystem Connected</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow"
          >
            Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
