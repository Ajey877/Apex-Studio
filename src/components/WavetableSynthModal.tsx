import React, { useState, useEffect, useRef } from 'react';
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

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Background gradient
      ctx.fillStyle = '#0a0a0d';
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
          ? '#ff6e00' 
          : `rgba(0, 229, 255, ${0.15 + (1 - frameProgress) * 0.4})`;
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
    setStatusMessage('Auditioning Wavetable Lead (C4)...');
    setTimeout(() => setStatusMessage(null), 2000);
  };

  const handleApplyPreset = (p: typeof WAVETABLE_PRESETS[0]) => {
    setMorphPosition(p.morphPosition);
    setWarpMode(p.warpMode as any);
    setWarpAmount(p.warpAmount);
    setStatusMessage(`Loaded Wavetable: ${p.name}`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  return (
    <div id="fl-wavetable-synth-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00e5ff]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00e5ff] to-[#0077ff] flex items-center justify-center text-black shadow-md font-bold">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">SERUM / VITAL ADVANCED WAVETABLE OSCILLATOR</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00e5ff]/20 text-[#00e5ff] border border-[#00e5ff]/40">
                  256-FRAME 3D MORPHING
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Frame interpolation, spectral warp modes, additive harmonic series, & 16-voice hypersaw</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAudition}
              className="px-3 py-1 bg-[#00e5ff] hover:bg-[#33edff] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition C3</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[#00e5ff] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* 3D Waterfall Display */}
          <div className="bg-[#0b0b0d] p-3 rounded-xl border border-[#26262a] flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-[#00e5ff]" />
                <span>3D WAVETABLE WATERFALL OSCILLOGRAM</span>
              </span>
              <span className="text-[10px] font-mono text-[#00e5ff]">
                FRAME {(morphPosition * 255).toFixed(0)} / 256
              </span>
            </div>

            <canvas ref={canvas3DRef} width={760} height={200} className="w-full h-48 rounded-lg bg-[#08080a] border border-[#202025]" />
          </div>

          {/* Wavetable Controls Matrix */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Morph Position */}
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs text-white font-bold">
                <span>WAVETABLE MORPH (WT POS)</span>
                <span className="text-[#00e5ff] font-mono">{Math.round(morphPosition * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={morphPosition}
                onChange={(e) => setMorphPosition(Number(e.target.value))}
                className="w-full accent-[#00e5ff]"
              />
              <p className="text-[10px] text-[#777]">Smooth spline interpolation between adjacent wavetable frames.</p>
            </div>

            {/* Spectral Warp Mode */}
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs text-white font-bold">
                <span>SPECTRAL WARP MODE</span>
                <span className="text-[#ff6e00] font-mono uppercase">{warpMode}</span>
              </div>
              <select
                value={warpMode}
                onChange={(e) => setWarpMode(e.target.value as any)}
                className="w-full bg-[#121214] text-white text-xs p-1.5 rounded border border-[#333336]"
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
                className="w-full accent-[#ff6e00]"
              />
            </div>

            {/* Hyper Unison */}
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs text-white font-bold">
                <span>HYPERSAW UNISON VOICES</span>
                <span className="text-[#00ff88] font-mono">{unisonVoices} Voices</span>
              </div>
              <input
                type="range"
                min="1"
                max="16"
                step="1"
                value={unisonVoices}
                onChange={(e) => setUnisonVoices(Number(e.target.value))}
                className="w-full accent-[#00ff88]"
              />
              <div className="flex justify-between text-[10px] text-[#777]">
                <span>Detune: {(unisonDetune * 100).toFixed(0)}%</span>
                <span>Spread: {(unisonSpread * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>

          {/* Additive Harmonic Series Bars */}
          <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
            <span className="text-xs font-bold text-white block uppercase tracking-wider">
              ADDITIVE HARMONIC SERIES (PARTIALS 1 - 8)
            </span>
            <div className="grid grid-cols-8 gap-2">
              {harmonics.map((hVal, idx) => (
                <div key={idx} className="flex flex-col items-center gap-1 bg-[#121214] p-2 rounded border border-[#26262a]">
                  <span className="text-[9px] font-mono text-[#777]">H{idx + 1}</span>
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
                    className="w-full accent-[#00e5ff] h-16 [writing-mode:vertical-lr] [direction:rtl]"
                  />
                  <span className="text-[9px] font-mono text-white">{(hVal * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Presets Grid */}
          <div className="bg-[#141418] p-3 rounded-xl border border-[#28282e] space-y-2">
            <span className="text-xs font-bold text-white block uppercase tracking-wider">
              FLAGSHIP WAVETABLE PRESETS
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {WAVETABLE_PRESETS.map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => handleApplyPreset(p)}
                  className="p-2.5 rounded-lg bg-[#1a1a1f] hover:bg-[#25252e] border border-[#333] hover:border-[#00e5ff] text-left transition flex items-center justify-between group"
                >
                  <span className="text-xs font-bold text-white group-hover:text-[#00e5ff] transition">{p.name}</span>
                  <span className="text-[9px] font-mono text-[#00e5ff] bg-[#00e5ff]/10 px-1.5 py-0.5 rounded uppercase">{p.warpMode}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Real-time Wavetable Osc Routing active for active Channel synthesizer</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#00e5ff] hover:bg-[#33edff] text-black font-bold rounded transition shadow"
          >
            Apply Wavetable to Track
          </button>
        </div>
      </div>
    </div>
  );
};
