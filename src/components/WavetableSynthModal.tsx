import React, { useState, useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Sliders, 
  X, 
  Sparkles, 
  Zap, 
  Activity, 
  Waves, 
  Play, 
  RotateCcw,
  Layers,
  Flame,
  Radio,
  Cpu
} from 'lucide-react';
import { Channel } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { readWavetablePalette, waveFrameStroke } from './wavetableTheme';

interface WavetableSynthModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

const WAVETABLE_PRESETS = [
  { name: 'Warm Analog Saw / Square', type: 'analog', morphPosition: 0.25, warpMode: 'pwm', warpAmount: 0.3 },
  { name: 'Modern Hyper EDM Supersaw', type: 'supersaw', morphPosition: 0.85, warpMode: 'sync', warpAmount: 0.6 },
  { name: 'Metallic Cyberpunk FM Wavetable', type: 'fm_metallic', morphPosition: 0.5, warpMode: 'fm', warpAmount: 0.75 },
  { name: 'Dark Reese Bass Sub-Growl', type: 'reese_growl', morphPosition: 0.4, warpMode: 'bend', warpAmount: 0.5 },
  { name: 'Ethereal Glass Vocal Choir', type: 'vocal_formant', morphPosition: 0.6, warpMode: 'mirror', warpAmount: 0.4 }
];

export const WavetableSynthModal: React.FC<WavetableSynthModalProps> = ({
  isOpen,
  onClose,
  channels,
  onUpdateChannel
}) => {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(channels[0]?.id || '');
  const [morphPosition, setMorphPosition] = useState<number>(0.35);
  const [warpMode, setWarpMode] = useState<'none' | 'sync' | 'pwm' | 'fm' | 'bend' | 'mirror'>('pwm');
  const [warpAmount, setWarpAmount] = useState<number>(0.4);
  const [unisonVoices, setUnisonVoices] = useState<number>(7);
  const [unisonDetune, setUnisonDetune] = useState<number>(0.24);
  const [unisonSpread, setUnisonSpread] = useState<number>(0.8);
  const [harmonics, setHarmonics] = useState<number[]>([1.0, 0.5, 0.33, 0.25, 0.2, 0.15, 0.1, 0.05]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canvas3DRef = useRef<HTMLCanvasElement | null>(null);

  // Render 3D Wavetable Waterfall visualizer
  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    let time = 0;

    const render = () => {
      time += 0.02;
      const canvas = canvas3DRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const palette = readWavetablePalette();

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Background gradient
      ctx.fillStyle = palette.canvasBackground;
      ctx.fillRect(0, 0, width, height);

      // Draw 16 cascading wavetable frames in pseudo-3D
      const numFrames = 16;
      for (let f = numFrames - 1; f >= 0; f--) {
        const frameProgress = f / (numFrames - 1);
        const isCurrent = Math.abs(frameProgress - morphPosition) < (1 / numFrames);
        const yOffset = 40 + f * 9;
        const xOffset = 30 + f * 12;
        const frameWidth = width - 180;

        ctx.beginPath();
        ctx.strokeStyle = isCurrent
          ? palette.signal.current
          : waveFrameStroke(palette.signal, frameProgress);
        ctx.lineWidth = isCurrent ? 2.5 : 1;

        for (let x = 0; x <= frameWidth; x += 3) {
          const normX = x / frameWidth;
          // Harmonic wave equation
          let wave = 0;
          harmonics.forEach((hAmp, hIdx) => {
            const freq = hIdx + 1;
            wave += Math.sin(normX * Math.PI * 2 * freq + (f * 0.3)) * hAmp;
          });

          // Apply warp effect
          if (warpMode === 'pwm') {
            wave = wave > warpAmount ? 1 : -1;
          } else if (warpMode === 'sync') {
            wave = Math.sin(normX * Math.PI * 2 * (1 + warpAmount * 3));
          } else if (warpMode === 'bend') {
            const bendFactor = Math.pow(normX, 1 + warpAmount * 2);
            wave = Math.sin(bendFactor * Math.PI * 2);
          }

          const amp = isCurrent ? 35 : 22;
          const py = yOffset - (wave * amp);
          const px = xOffset + x;

          if (x === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [isOpen, morphPosition, warpMode, warpAmount, harmonics]);

  if (!isOpen) return null;

  const handleAudition = () => {
    const targetChannel = channels.find(c => c.id === selectedChannelId) || channels[0];
    if (targetChannel) {
      audioEngine.playNote(targetChannel, { id: `wt-aud-${Date.now()}`, pitch: 60, start: 0, duration: 2, velocity: 0.85 });
    }
    // Truthful label: this plays the channel's existing voice. None of the
    // preview controls above reach the audio engine.
    setStatusMessage('Previewing the channel synth as-is (C4)...');
    setTimeout(() => setStatusMessage(null), 2000);
  };

  const handleApplyPreset = (p: typeof WAVETABLE_PRESETS[0]) => {
    setMorphPosition(p.morphPosition);
    setWarpMode(p.warpMode as any);
    setWarpAmount(p.warpAmount);
    setStatusMessage(`Loaded preview curve: ${p.name} (display only)`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  return (
    <ModalFrame id="fl-wavetable-synth-modal" labelledBy="fl-wavetable-synth-modal-title" onClose={onClose} className="fixed inset-0 apex-modal-overlay backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-cyan)]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-cyan)] to-[var(--apex-accent)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-wavetable-synth-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">ADVANCED SYNTH PREVIEW (WAVETABLE NOT IMPLEMENTED)</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[var(--apex-cyan)]/20 text-[var(--apex-cyan-text)] border border-[var(--apex-cyan)]/40">
                  PREVIEW ONLY
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Preview surface. The selected channel plays with its existing subtractive synth; no wavetable engine exists yet.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAudition}
              className="px-3 py-1 bg-[var(--apex-cyan)] hover:bg-[var(--apex-cyan-strong)] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition C3</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close wavetable synth"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-surface-2)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          <div className="bg-[var(--apex-bg)] border border-[var(--apex-gold)]/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono font-bold text-[var(--apex-gold)] uppercase tracking-wider">
              NOT APPLIED — NO WAVETABLE OSCILLATOR IN THE ENGINE
            </span>
            <span className="text-[10px] text-[var(--apex-text-3)] whitespace-nowrap">CHANNEL USES ITS SUBTRACTIVE SYNTH</span>
          </div>

          {/* 3D Waterfall Display */}
          <div className="bg-[var(--apex-bg)] p-3 rounded-xl border border-[var(--apex-border)] flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-[var(--apex-cyan)]" />
                <span>3D WAVETABLE WATERFALL OSCILLOGRAM</span>
              </span>
              <span className="text-[10px] font-mono text-[var(--apex-cyan-text)]">
                FRAME {(morphPosition * 15).toFixed(0)} / 16 (preview)
              </span>
            </div>

            <canvas ref={canvas3DRef} width={760} height={200} className="w-full h-48 rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-border)]" />
          </div>

          {/* Wavetable Controls Matrix */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Morph Position */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs text-[var(--apex-text)] font-bold">
                <span>WAVETABLE MORPH (WT POS)</span>
                <span className="text-[var(--apex-cyan-text)] font-mono">{Math.round(morphPosition * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={morphPosition}
                onChange={(e) => setMorphPosition(Number(e.target.value))}
                className="w-full accent-[var(--apex-cyan)]"
              />
              <p className="text-[10px] text-[var(--apex-text-3)]">Preview curve only — no audio is generated from it.</p>
            </div>

            {/* Spectral Warp Mode */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs text-[var(--apex-text)] font-bold">
                <span>SPECTRAL WARP MODE</span>
                <span className="text-[var(--apex-accent)] font-mono uppercase">{warpMode}</span>
              </div>
              <select
                value={warpMode}
                onChange={(e) => setWarpMode(e.target.value as any)}
                className="w-full bg-[var(--apex-surface)] text-[var(--apex-text)] text-xs p-1.5 rounded border border-[var(--apex-border)]"
              >
                <option value="none">None (Pure Wavetable)</option>
                <option value="pwm">Pulse Width Modulation (PWM)</option>
                <option value="sync">Hard Oscillator Sync</option>
                <option value="fm">FM from Sub Osc</option>
                <option value="bend">Bend (+ / -)</option>
                <option value="mirror">Spectral Mirror Symmetry</option>
              </select>

              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={warpAmount}
                onChange={(e) => setWarpAmount(Number(e.target.value))}
                className="w-full accent-[var(--apex-accent)]"
              />
            </div>

            {/* Hyper Unison */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs text-[var(--apex-text)] font-bold">
                <span>UNISON VOICES (ENGINE MAX 7)</span>
                <span className="text-[var(--apex-success)] font-mono">{unisonVoices} Voices</span>
              </div>
              <input
                type="range"
                min="1"
                max="7"
                step="1"
                value={unisonVoices}
                onChange={(e) => setUnisonVoices(Number(e.target.value))}
                className="w-full accent-[var(--apex-success)]"
              />
              <div className="flex justify-between text-[10px] text-[var(--apex-text-3)]">
                <span>Detune: {(unisonDetune * 100).toFixed(0)}%</span>
                <span>Spread: {(unisonSpread * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>

          {/* Additive Harmonic Series Bars */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
            <span className="text-xs font-bold text-[var(--apex-text)] block uppercase tracking-wider">
              ADDITIVE HARMONIC SERIES (PARTIALS 1 - 8)
            </span>
            <div className="grid grid-cols-8 gap-2">
              {harmonics.map((hVal, idx) => (
                <div key={idx} className="flex flex-col items-center gap-1 bg-[var(--apex-surface)] p-2 rounded border border-[var(--apex-border)]">
                  <span className="text-[9px] font-mono text-[var(--apex-text-3)]">H{idx + 1}</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={hVal}
                    onChange={(e) => {
                      const next = [...harmonics];
                      next[idx] = Number(e.target.value);
                      setHarmonics(next);
                    }}
                    className="w-full accent-[var(--apex-cyan)] h-16 [writing-mode:vertical-lr] [direction:rtl]"
                  />
                  <span className="text-[9px] font-mono text-[var(--apex-text)]">{(hVal * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Presets Grid */}
          <div className="bg-[var(--apex-surface)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
            <span className="text-xs font-bold text-[var(--apex-text)] block uppercase tracking-wider">
              PREVIEW PRESETS (CURVE SHAPES ONLY)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {WAVETABLE_PRESETS.map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => handleApplyPreset(p)}
                  className="p-2.5 rounded-lg bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] border border-[var(--apex-border)] hover:border-[var(--apex-cyan)] text-left transition flex items-center justify-between group"
                >
                  <span className="text-xs font-bold text-[var(--apex-text)] group-hover:text-[var(--apex-cyan-text)] transition">{p.name}</span>
                  <span className="text-[9px] font-mono text-[var(--apex-cyan-text)] bg-[var(--apex-cyan)]/10 px-1.5 py-0.5 rounded uppercase">{p.warpMode}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Preview only: this window does not change how the channel sounds</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-cyan)] hover:bg-[var(--apex-cyan-strong)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow"
          >
            Close Preview
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
