import React, { useState } from 'react';
import { 
  Zap, 
  X, 
  Sparkles, 
  Activity, 
  Play, 
  RotateCcw, 
  Check, 
  Sliders, 
  Layers, 
  Flame, 
  Compass, 
  Radio, 
  Volume2
} from 'lucide-react';
import { WarpMode, PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface WarpAudioProcessorModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedClip?: PlaylistClip | null;
  onUpdateClip?: (clip: PlaylistClip) => void;
}

export const WarpAudioProcessorModal: React.FC<WarpAudioProcessorModalProps> = ({
  isOpen,
  onClose,
  selectedClip,
  onUpdateClip
}) => {
  const [warpMode, setWarpMode] = useState<WarpMode>(selectedClip?.warpMode || 'complex_pro');
  const [transientGranularity, setTransientGranularity] = useState<number>(32); // 1/16, 1/32, 1/64
  const [grainSizeMs, setGrainSizeMs] = useState<number>(65); // 20 to 150 ms
  const [formantPreservation, setFormantPreservation] = useState<number>(85); // 0 to 100%
  const [envelopeDecay, setEnvelopeDecay] = useState<number>(100); // 0 to 100%
  const [pitchSemitones, setPitchSemitones] = useState<number>(selectedClip?.pitchShiftSemitones || 0);
  const [stretchRate, setStretchRate] = useState<number>(selectedClip?.timeStretchRate || 1.0);
  const [isAuditioning, setIsAuditioning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAuditionWarp = () => {
    setIsAuditioning(true);
    // Audition with pitch shift and warp timbre
    audioEngine.playNote(
      {
        id: 'warp-audition',
        name: 'Warp Sample',
        instrumentType: 'sampler',
        volume: 0.9,
        pan: 0,
        pitch: pitchSemitones,
        mute: false,
        solo: false,
        color: '#00ff88',
        mixerTrackId: 1,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `warp-test-${Date.now()}`, pitch: 60 + pitchSemitones, start: 0, duration: 2 * stretchRate, velocity: 0.9 }
    );

    setTimeout(() => {
      setIsAuditioning(false);
    }, 1800);
    setStatusMessage(`Auditioning ${warpMode.toUpperCase()} Warp DSP Algorithm`);
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleApplyWarp = () => {
    if (selectedClip && onUpdateClip) {
      onUpdateClip({
        ...selectedClip,
        warpMode,
        pitchShiftSemitones: pitchSemitones,
        timeStretchRate: stretchRate
      });
    }
    setStatusMessage(`Applied ${warpMode.toUpperCase()} Granular Warp to Timeline Clip!`);
    setTimeout(() => {
      onClose();
    }, 1000);
  };

  const WARP_MODES = [
    {
      id: 'beats' as WarpMode,
      name: 'Beats Mode',
      desc: 'Optimized for rhythmic material, percussive transients, and drum loops. Zero transient phase smearing.',
      color: '#00ff88',
      tag: 'TRANSIENT LOCK'
    },
    {
      id: 'tones' as WarpMode,
      name: 'Tones Mode',
      desc: 'Granular pitch synchronous overlap-add for monophonic lead vocals, basslines, and solo brass.',
      color: '#00e5ff',
      tag: 'MONO PITCH'
    },
    {
      id: 'texture' as WarpMode,
      name: 'Texture Mode',
      desc: 'Micro-grain cloud synthesis with random flux for ambient drone pads, lush polyphonic fields, and soundscapes.',
      color: '#a855f7',
      tag: 'GRAIN CLOUD'
    },
    {
      id: 'complex_pro' as WarpMode,
      name: 'Complex Pro (Élastique)',
      desc: 'State-of-the-art polyphonic time-stretching with formant preservation and vocal envelope morphing.',
      color: '#ff6e00',
      tag: 'FLAGSHIP PRO'
    },
    {
      id: 'repitch' as WarpMode,
      name: 'Re-Pitch (Tape Speed)',
      desc: 'Classic vinyl tape-stop and sampler repitching where tempo and pitch scale proportionately together.',
      color: '#ffaa00',
      tag: 'ANALOG TAPE'
    }
  ];

  return (
    <div id="fl-warp-processor-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00ff88]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00ff88] to-[#00aa55] flex items-center justify-center text-black shadow-md font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">ADVANCED TIME-STRETCH & TRANSIENT WARP ENGINE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40">
                  ÉLASTIQUE PRO DSP
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Granular time-stretching, formant preservation, and transient preservation algorithms</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionWarp}
              className={`px-3 py-1 text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow ${
                isAuditioning ? 'bg-white' : 'bg-[#00ff88] hover:bg-[#33ff9f]'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isAuditioning ? 'Auditioning...' : 'Audition Warp'}</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toast */}
        {statusMessage && (
          <div className="bg-[#00ff88] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Warp Mode Selection Grid */}
          <div className="space-y-2">
            <span className="text-xs font-bold text-white uppercase tracking-wider block">
              SELECT WARP ALGORITHM
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {WARP_MODES.map((m) => {
                const isSelected = warpMode === m.id;
                return (
                  <div
                    key={m.id}
                    onClick={() => setWarpMode(m.id)}
                    style={{ borderColor: isSelected ? m.color : '#28282e' }}
                    className={`p-3 rounded-xl border-2 cursor-pointer transition flex flex-col justify-between space-y-2 ${
                      isSelected ? 'bg-[#18181f] ring-2 ring-white/20 shadow-lg' : 'bg-[#141417] hover:border-[#444]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white">{m.name}</span>
                      <span 
                        style={{ color: m.color, borderColor: `${m.color}66` }}
                        className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border bg-white/[0.03]"
                      >
                        {m.tag}
                      </span>
                    </div>

                    <p className="text-[10px] text-[#777] leading-relaxed">{m.desc}</p>

                    <div className="flex items-center justify-between text-[9px] font-mono pt-1 border-t border-white/5">
                      <span className="text-[#555]">Phase Coherence</span>
                      <span style={{ color: isSelected ? m.color : '#888' }} className="font-bold">
                        {isSelected ? '✓ ACTIVE' : 'Select'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Granular & Formant Sliders */}
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white uppercase">FINE-GRAIN TIMBRE & FORMANT CONTROLS</span>
              <span className="text-[10px] font-mono text-[#00ff88]">Real-time Resynthesis</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              {/* Pitch Shift */}
              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">PITCH OFFSET</span>
                  <span className="text-[#00ff88] font-mono font-bold">{pitchSemitones > 0 ? `+${pitchSemitones}` : pitchSemitones} st</span>
                </div>
                <input
                  type="range"
                  min="-24"
                  max="24"
                  value={pitchSemitones}
                  onChange={(e) => setPitchSemitones(Number(e.target.value))}
                  className="w-full accent-[#00ff88]"
                />
                <span className="text-[9px] text-[#666] block">-2 to +2 full octaves</span>
              </div>

              {/* Stretch Rate */}
              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">STRETCH RATIO</span>
                  <span className="text-[#00e5ff] font-mono font-bold">{stretchRate.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.25"
                  max="3.0"
                  step="0.05"
                  value={stretchRate}
                  onChange={(e) => setStretchRate(Number(e.target.value))}
                  className="w-full accent-[#00e5ff]"
                />
                <span className="text-[9px] text-[#666] block">0.25x (hyper-speed) to 3x (super-slow)</span>
              </div>

              {/* Formant Preservation */}
              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">FORMANT LOCK</span>
                  <span className="text-[#ff6e00] font-mono font-bold">{formantPreservation}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={formantPreservation}
                  onChange={(e) => setFormantPreservation(Number(e.target.value))}
                  className="w-full accent-[#ff6e00]"
                />
                <span className="text-[9px] text-[#666] block">Prevents "chipmunk" vocal effect</span>
              </div>

              {/* Grain Window Size */}
              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">GRAIN WINDOW</span>
                  <span className="text-[#a855f7] font-mono font-bold">{grainSizeMs} ms</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="150"
                  value={grainSizeMs}
                  onChange={(e) => setGrainSizeMs(Number(e.target.value))}
                  className="w-full accent-[#a855f7]"
                />
                <span className="text-[9px] text-[#666] block">Micro-grain overlap window</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Élastique 3.4.1 Resampling Kernel Ready</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#25252a] hover:bg-[#333338] text-white rounded font-bold transition"
            >
              Cancel
            </button>
            <button
              onClick={handleApplyWarp}
              className="px-4 py-1.5 bg-[#00ff88] hover:bg-[#33ff9f] text-black font-bold rounded transition shadow flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Apply Warp Algorithm</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
