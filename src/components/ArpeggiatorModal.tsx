import React, { useState } from 'react';
import { 
  Sparkles, 
  Play, 
  RotateCw, 
  Layers, 
  Check, 
  X, 
  Activity, 
  Flame, 
  Sliders,
  Clock
} from 'lucide-react';
import { Channel, ArpSettings } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface ArpeggiatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  channel: Channel;
  onUpdateChannel: (channel: Channel) => void;
  bpm: number;
}

const ARP_MODES = [
  { id: 'up', label: 'UP (Ascending)', desc: 'Lowest pitch to highest pitch' },
  { id: 'down', label: 'DOWN (Descending)', desc: 'Highest pitch down to lowest' },
  { id: 'updown', label: 'UP / DOWN (Bounce)', desc: 'Ascends and reverses smoothly' },
  { id: 'random', label: 'RANDOM (Stochastic)', desc: 'Unpredictable melodic chaos' },
  { id: 'chord_strum', label: 'CHORD STRUM', desc: 'Polyphonic micro-delayed guitar strum' },
  { id: 'euclidean', label: 'EUCLIDEAN RHYTHM', desc: 'Mathematical Afrobeat / Techno spacing' }
];

const ARP_RATES = [
  { id: '1/4', label: '1/4 Beat' },
  { id: '1/8', label: '1/8 Beat' },
  { id: '1/16', label: '1/16 Beat' },
  { id: '1/32', label: '1/32 Fast' },
  { id: '1/8t', label: '1/8 Triplet' },
  { id: '1/16t', label: '1/16 Triplet' }
];

export const ArpeggiatorModal: React.FC<ArpeggiatorModalProps> = ({
  isOpen,
  onClose,
  channel,
  onUpdateChannel,
  bpm
}) => {
  const currentArp: ArpSettings = channel.arp || {
    enabled: false,
    mode: 'up',
    rate: '1/16',
    octaves: 2,
    gate: 0.85,
    swing: 0,
    strumMs: 15,
    euclideanSteps: 16,
    euclideanHits: 5,
    euclideanRotate: 0
  };

  const [arpState, setArpState] = useState<ArpSettings>(currentArp);

  if (!isOpen) return null;

  const handleAudition = () => {
    const dummyNote = { id: 'arp-preview', pitch: 60, start: 0, duration: 2, velocity: 0.9 };
    const tempChannel: Channel = {
      ...channel,
      arp: arpState
    };
    audioEngine.playNote(tempChannel, dummyNote, undefined, bpm);
  };

  const handleSave = () => {
    onUpdateChannel({
      ...channel,
      arp: arpState
    });
    onClose();
  };

  // Generate Euclidean circle preview
  const euclideanPattern = audioEngine.generateEuclideanPattern(
    arpState.euclideanSteps || 16,
    arpState.euclideanHits || 5,
    arpState.euclideanRotate || 0
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-md animate-fade-in select-none">
      <div className="bg-[#121215] border border-[#ff6e00]/40 rounded-xl w-full max-w-xl flex flex-col shadow-2xl overflow-hidden text-[#e0e0e0]">
        {/* Header */}
        <div className="bg-[#18181c] border-b border-[#28282e] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ffaa00] flex items-center justify-center text-black font-black">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white uppercase">{channel.name} ARPEGGIATOR</h2>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${
                  arpState.enabled ? 'bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40' : 'bg-[#222] text-[#888]'
                }`}>
                  {arpState.enabled ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
              <p className="text-[11px] text-[#888]">Polyphonic pattern generator, Euclidean math rhythms & humanizer</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setArpState(prev => ({ ...prev, enabled: !prev.enabled }))}
              className={`px-3 py-1 text-xs font-bold rounded transition ${
                arpState.enabled ? 'bg-[#00ff88] text-black shadow' : 'bg-[#282830] text-[#888] hover:text-white'
              }`}
            >
              {arpState.enabled ? 'ON' : 'OFF'}
            </button>
            <button onClick={onClose} className="p-1 text-[#888] hover:text-white rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto custom-scrollbar">
          {/* Mode Selector */}
          <div>
            <span className="text-xs font-bold text-[#888] uppercase tracking-wider block mb-2">Arp Mode</span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ARP_MODES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => setArpState(prev => ({ ...prev, mode: mode.id as any }))}
                  className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between gap-1 ${
                    arpState.mode === mode.id 
                      ? 'bg-[#ff6e00]/15 border-[#ff6e00] text-white' 
                      : 'bg-[#18181d] border-[#282830] text-[#888] hover:text-white'
                  }`}
                >
                  <span className="text-xs font-bold text-white">{mode.label}</span>
                  <span className="text-[10px] text-[#777] line-clamp-1">{mode.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Rate Selector */}
          <div>
            <span className="text-xs font-bold text-[#888] uppercase tracking-wider block mb-2">Step Rate (Grid Division)</span>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {ARP_RATES.map((rate) => (
                <button
                  key={rate.id}
                  onClick={() => setArpState(prev => ({ ...prev, rate: rate.id as any }))}
                  className={`py-1.5 px-2 rounded font-mono font-bold text-xs border transition text-center ${
                    arpState.rate === rate.id 
                      ? 'bg-[#ff6e00] text-black border-[#ff6e00] shadow' 
                      : 'bg-[#18181d] border-[#282830] text-[#888] hover:text-white'
                  }`}
                >
                  {rate.label}
                </button>
              ))}
            </div>
          </div>

          {/* Octave, Gate, Swing */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[#18181d] border border-[#282830] rounded-xl p-3 text-xs">
            <div>
              <div className="flex justify-between text-[#888] mb-1">
                <span>Octaves Range</span>
                <span className="font-mono text-[#ff6e00]">{arpState.octaves} Oct</span>
              </div>
              <input 
                type="range" min="1" max="4" step="1"
                value={arpState.octaves}
                onChange={(e) => setArpState(prev => ({ ...prev, octaves: Number(e.target.value) }))}
                className="w-full accent-[#ff6e00]"
              />
            </div>

            <div>
              <div className="flex justify-between text-[#888] mb-1">
                <span>Gate Length</span>
                <span className="font-mono text-[#00ff88]">{Math.round(arpState.gate * 100)}%</span>
              </div>
              <input 
                type="range" min="0.1" max="1.5" step="0.05"
                value={arpState.gate}
                onChange={(e) => setArpState(prev => ({ ...prev, gate: Number(e.target.value) }))}
                className="w-full accent-[#00ff88]"
              />
            </div>

            <div>
              <div className="flex justify-between text-[#888] mb-1">
                <span>Strum Micro-Delay</span>
                <span className="font-mono text-[#00e5ff]">{arpState.strumMs || 0}ms</span>
              </div>
              <input 
                type="range" min="0" max="50" step="2"
                value={arpState.strumMs || 0}
                onChange={(e) => setArpState(prev => ({ ...prev, strumMs: Number(e.target.value) }))}
                className="w-full accent-[#00e5ff]"
              />
            </div>
          </div>

          {/* Euclidean Settings (if mode is Euclidean) */}
          {arpState.mode === 'euclidean' && (
            <div className="bg-[#18181d] border border-[#ff6e00]/30 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-[#ff6e00]" />
                  EUCLIDEAN RHYTHM GENERATOR
                </span>
                <span className="text-[10px] font-mono text-[#ff6e00]">
                  E({arpState.euclideanHits}, {arpState.euclideanSteps})
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="flex justify-between text-[11px] text-[#888] mb-1">
                    <span>Total Steps</span>
                    <span className="font-mono text-white">{arpState.euclideanSteps || 16}</span>
                  </div>
                  <input 
                    type="range" min="4" max="32" step="1"
                    value={arpState.euclideanSteps || 16}
                    onChange={(e) => setArpState(prev => ({ ...prev, euclideanSteps: Number(e.target.value) }))}
                    className="w-full accent-[#ff6e00]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-[#888] mb-1">
                    <span>Pulse Hits</span>
                    <span className="font-mono text-[#00ff88]">{arpState.euclideanHits || 5}</span>
                  </div>
                  <input 
                    type="range" min="1" max={arpState.euclideanSteps || 16} step="1"
                    value={arpState.euclideanHits || 5}
                    onChange={(e) => setArpState(prev => ({ ...prev, euclideanHits: Number(e.target.value) }))}
                    className="w-full accent-[#00ff88]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-[#888] mb-1">
                    <span>Rotation</span>
                    <span className="font-mono text-[#00e5ff]">{arpState.euclideanRotate || 0}</span>
                  </div>
                  <input 
                    type="range" min="0" max={arpState.euclideanSteps || 16} step="1"
                    value={arpState.euclideanRotate || 0}
                    onChange={(e) => setArpState(prev => ({ ...prev, euclideanRotate: Number(e.target.value) }))}
                    className="w-full accent-[#00e5ff]"
                  />
                </div>
              </div>

              {/* Visual Rhythm Step Visualizer */}
              <div className="flex items-center gap-1 bg-[#0c0c0e] p-2 rounded-lg border border-[#282830] overflow-x-auto">
                {euclideanPattern.map((hit, idx) => (
                  <div
                    key={idx}
                    className={`h-7 flex-1 min-w-[12px] rounded-xs flex items-center justify-center text-[8px] font-mono font-bold transition ${
                      hit ? 'bg-[#ff6e00] text-black shadow-sm' : 'bg-[#222] text-[#555]'
                    }`}
                  >
                    {hit ? idx + 1 : ''}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-[#18181c] border-t border-[#28282e] px-4 py-2.5 flex items-center justify-between">
          <button
            onClick={handleAudition}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#282830] hover:bg-[#33333d] text-white font-bold text-xs rounded transition"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            <span>Audition Pattern</span>
          </button>

          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition shadow"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Save Arp Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
