import React, { useState } from 'react';
import { ModalFrame } from './ModalFrame';
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
    <ModalFrame labelledBy="arpeggiator-modal-title" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 backdrop-blur-md animate-fade-in select-none">
      {/* UI-03K: every surface, border, text and state below consumes the
          existing `--apex-*` semantic tokens. The warm orange arp identity is
          kept through `--apex-gold`; the enabled/gate green stays on
          `--apex-success` and the strum/rotation cyan on `--apex-cyan` /
          `--apex-cyan-text`. The dead dark overlay fill is gone —
          ModalFrame's themed scrim is the shared backdrop. */}
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-gold)]/40 rounded-xl w-full max-w-xl flex flex-col shadow-2xl overflow-hidden text-[var(--apex-text-2)]">
        {/* Header */}
        <div className="bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-gold)] flex items-center justify-center text-[var(--apex-state-playing-fg)] font-black">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="arpeggiator-modal-title" className="text-sm font-bold text-[var(--apex-text)] uppercase">{channel.name} ARPEGGIATOR</h2>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${
                  arpState.enabled ? 'bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-success)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]' : 'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)]'
                }`}>
                  {arpState.enabled ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
              <p className="text-[11px] text-[var(--apex-text-3)]">Polyphonic pattern generator, Euclidean math rhythms & humanizer</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setArpState(prev => ({ ...prev, enabled: !prev.enabled }))}
              className={`px-3 py-1 text-xs font-bold rounded transition ${
                arpState.enabled ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] shadow' : 'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              {arpState.enabled ? 'ON' : 'OFF'}
            </button>
            <button onClick={onClose} aria-label="Close arpeggiator" className="p-1 text-[var(--apex-text-3)] hover:text-[var(--apex-text)] rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto custom-scrollbar">
          {/* Mode Selector */}
          <div>
            <span className="text-xs font-bold text-[var(--apex-text-3)] uppercase tracking-wider block mb-2">Arp Mode</span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ARP_MODES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => setArpState(prev => ({ ...prev, mode: mode.id as any }))}
                  className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between gap-1 ${
                    arpState.mode === mode.id 
                      ? 'bg-[color-mix(in_srgb,var(--apex-gold)_15%,var(--apex-surface-2))] border-[var(--apex-gold)] text-[var(--apex-text)]'
                      : 'bg-[var(--apex-surface-2)] border-[var(--apex-border)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
                  }`}
                >
                  <span className="text-xs font-bold text-[var(--apex-text)]">{mode.label}</span>
                  <span className="text-[10px] text-[var(--apex-text-3)] line-clamp-1">{mode.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Rate Selector */}
          <div>
            <span className="text-xs font-bold text-[var(--apex-text-3)] uppercase tracking-wider block mb-2">Step Rate (Grid Division)</span>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {ARP_RATES.map((rate) => (
                <button
                  key={rate.id}
                  onClick={() => setArpState(prev => ({ ...prev, rate: rate.id as any }))}
                  className={`py-1.5 px-2 rounded font-mono font-bold text-xs border transition text-center ${
                    arpState.rate === rate.id 
                      ? 'bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)] border-[var(--apex-gold)] shadow'
                      : 'bg-[var(--apex-surface-2)] border-[var(--apex-border)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
                  }`}
                >
                  {rate.label}
                </button>
              ))}
            </div>
          </div>

          {/* Octave, Gate, Swing */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 text-xs">
            <div>
              <div className="flex justify-between text-[var(--apex-text-3)] mb-1">
                <span>Octaves Range</span>
                <span className="font-mono text-[var(--apex-gold)]">{arpState.octaves} Oct</span>
              </div>
              <input 
                type="range" min="1" max="4" step="1"
                value={arpState.octaves}
                onChange={(e) => setArpState(prev => ({ ...prev, octaves: Number(e.target.value) }))}
                className="w-full accent-[var(--apex-gold)]"
              />
            </div>

            <div>
              <div className="flex justify-between text-[var(--apex-text-3)] mb-1">
                <span>Gate Length</span>
                <span className="font-mono text-[var(--apex-success)]">{Math.round(arpState.gate * 100)}%</span>
              </div>
              <input 
                type="range" min="0.1" max="1.5" step="0.05"
                value={arpState.gate}
                onChange={(e) => setArpState(prev => ({ ...prev, gate: Number(e.target.value) }))}
                className="w-full accent-[var(--apex-success)]"
              />
            </div>

            <div>
              <div className="flex justify-between text-[var(--apex-text-3)] mb-1">
                <span>Strum Micro-Delay</span>
                <span className="font-mono text-[var(--apex-cyan-text)]">{arpState.strumMs || 0}ms</span>
              </div>
              <input 
                type="range" min="0" max="50" step="2"
                value={arpState.strumMs || 0}
                onChange={(e) => setArpState(prev => ({ ...prev, strumMs: Number(e.target.value) }))}
                className="w-full accent-[var(--apex-cyan)]"
              />
            </div>
          </div>

          {/* Euclidean Settings (if mode is Euclidean) */}
          {arpState.mode === 'euclidean' && (
            <div className="bg-[var(--apex-surface-2)] border border-[color-mix(in_srgb,var(--apex-gold)_30%,transparent)] rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-[var(--apex-gold)]" />
                  EUCLIDEAN RHYTHM GENERATOR
                </span>
                <span className="text-[10px] font-mono text-[var(--apex-gold)]">
                  E({arpState.euclideanHits}, {arpState.euclideanSteps})
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-3)] mb-1">
                    <span>Total Steps</span>
                    <span className="font-mono text-[var(--apex-text)]">{arpState.euclideanSteps || 16}</span>
                  </div>
                  <input 
                    type="range" min="4" max="32" step="1"
                    value={arpState.euclideanSteps || 16}
                    onChange={(e) => setArpState(prev => ({ ...prev, euclideanSteps: Number(e.target.value) }))}
                    className="w-full accent-[var(--apex-gold)]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-3)] mb-1">
                    <span>Pulse Hits</span>
                    <span className="font-mono text-[var(--apex-success)]">{arpState.euclideanHits || 5}</span>
                  </div>
                  <input 
                    type="range" min="1" max={arpState.euclideanSteps || 16} step="1"
                    value={arpState.euclideanHits || 5}
                    onChange={(e) => setArpState(prev => ({ ...prev, euclideanHits: Number(e.target.value) }))}
                    className="w-full accent-[var(--apex-success)]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-3)] mb-1">
                    <span>Rotation</span>
                    <span className="font-mono text-[var(--apex-cyan-text)]">{arpState.euclideanRotate || 0}</span>
                  </div>
                  <input 
                    type="range" min="0" max={arpState.euclideanSteps || 16} step="1"
                    value={arpState.euclideanRotate || 0}
                    onChange={(e) => setArpState(prev => ({ ...prev, euclideanRotate: Number(e.target.value) }))}
                    className="w-full accent-[var(--apex-cyan)]"
                  />
                </div>
              </div>

              {/* Visual Rhythm Step Visualizer */}
              <div className="flex items-center gap-1 bg-[var(--apex-chrome-inset)] p-2 rounded-lg border border-[var(--apex-border)] overflow-x-auto">
                {euclideanPattern.map((hit, idx) => (
                  <div
                    key={idx}
                    className={`h-7 flex-1 min-w-[12px] rounded-xs flex items-center justify-center text-[8px] font-mono font-bold transition ${
                      hit ? 'bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)] shadow-sm' : 'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)]'
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
        <div className="bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] px-4 py-2.5 flex items-center justify-between">
          <button
            onClick={handleAudition}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] font-bold text-xs rounded transition"
          >
            <Play className="w-3.5 h-3.5 fill-[var(--apex-text)]" />
            <span>Audition Pattern</span>
          </button>

          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition shadow"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Save Arp Settings</span>
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
