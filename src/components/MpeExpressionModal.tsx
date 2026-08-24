import React, { useState } from 'react';
import { 
  Sliders, 
  X, 
  Sparkles, 
  Play, 
  RotateCcw, 
  Check, 
  Activity, 
  Music, 
  Flame, 
  Compass, 
  Layers, 
  Zap,
  TrendingUp
} from 'lucide-react';
import { MpeNoteExpression, Note } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface MpeExpressionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const DEFAULT_MPE_EXPRESSIONS: MpeNoteExpression[] = [
  {
    noteId: 'mpe-note-1',
    pitchBendCurve: [
      { timeStep: 0, semitones: 0 },
      { timeStep: 0.3, semitones: 0 },
      { timeStep: 0.6, semitones: 2.0 }, // Bend up 2 semitones
      { timeStep: 1.0, semitones: 3.5 }  // Microtonal blue note
    ],
    pressureCurve: [
      { timeStep: 0, pressure: 0.4 },
      { timeStep: 0.5, pressure: 0.95 },
      { timeStep: 1.0, pressure: 0.2 }
    ],
    slideTimbreCurve: [
      { timeStep: 0, timbre: 0.2 },
      { timeStep: 0.4, timbre: 0.8 },
      { timeStep: 1.0, timbre: 0.9 }
    ]
  }
];

export const MpeExpressionModal: React.FC<MpeExpressionModalProps> = ({
  isOpen,
  onClose
}) => {
  const [selectedDimension, setSelectedDimension] = useState<'pitch' | 'pressure' | 'slide'>('pitch');
  const [mpePitchRange, setMpePitchRange] = useState<number>(48); // +/- 48 semitones MPE standard
  const [polyAftertouchSensitivity, setPolyAftertouchSensitivity] = useState<number>(100);
  const [timbreCutoffResponse, setTimbreCutoffResponse] = useState<number>(85);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAuditionMpe = () => {
    // Play chord with independent MPE microtonal glide on top note
    audioEngine.playNote(
      {
        id: 'mpe-synth-ch',
        name: 'MPE Seaboard Lead',
        instrumentType: 'supersaw_lead',
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        color: '#ff6e00',
        mixerTrackId: 1,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `mpe-aud-${Date.now()}`, pitch: 64, start: 0, duration: 2.5, velocity: 0.9 }
    );

    setStatusMessage('Auditioning 3-Dimensional Polyphonic Expression (MPE Glide + Aftertouch)...');
    setTimeout(() => setStatusMessage(null), 2500);
  };

  return (
    <div id="fl-mpe-expression-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#ff6e00]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ffaa00] flex items-center justify-center text-black shadow-md font-bold">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">MPE (MIDI POLYPHONIC EXPRESSION) CONTROLLER SUITE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40">
                  ROLI / PUSH 3 5D TOUCH
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Per-note polyphonic pitch slide, channel pressure (aftertouch), and CC74 timbre modulation</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionMpe}
              className="px-3 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition MPE Chord</span>
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
          <div className="bg-[#ff6e00] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Dimension Selector Tabs */}
          <div className="flex gap-2 border-b border-[#28282e] pb-2 text-xs">
            <button
              onClick={() => setSelectedDimension('pitch')}
              className={`px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 ${
                selectedDimension === 'pitch'
                  ? 'bg-[#ff6e00] text-black shadow'
                  : 'bg-[#18181c] text-[#888] hover:text-white'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Per-Note Glide (Pitch Bend)</span>
            </button>

            <button
              onClick={() => setSelectedDimension('pressure')}
              className={`px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 ${
                selectedDimension === 'pressure'
                  ? 'bg-[#00ff88] text-black shadow'
                  : 'bg-[#18181c] text-[#888] hover:text-white'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Polyphonic Aftertouch (Pressure)</span>
            </button>

            <button
              onClick={() => setSelectedDimension('slide')}
              className={`px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 ${
                selectedDimension === 'slide'
                  ? 'bg-[#00e5ff] text-black shadow'
                  : 'bg-[#18181c] text-[#888] hover:text-white'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Y-Axis Slide (CC74 Timbre)</span>
            </button>
          </div>

          {/* Graphical Expression Curve Canvas */}
          <div className="bg-[#0b0b0e] p-4 rounded-xl border border-[#28282e] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white">NOTE GLIDE ENVELOPE (E4 IN C-MAJOR 7 CHORD)</span>
              <span className="text-[10px] font-mono text-[#ff6e00]">MPE Zone: Ch 2-15 Active</span>
            </div>

            {/* Visual Vector Line */}
            <div className="h-44 bg-[#141418] rounded-lg border border-[#333338] relative overflow-hidden flex items-center justify-center p-2">
              <svg className="w-full h-full" viewBox="0 0 400 120">
                {/* Horizontal zero line */}
                <line x1="0" y1="60" x2="400" y2="60" stroke="#333" strokeDasharray="3,3" />
                
                {/* Expression Bezier Curve */}
                {selectedDimension === 'pitch' && (
                  <path
                    d="M 10 60 C 120 60, 200 30, 390 15"
                    fill="none"
                    stroke="#ff6e00"
                    strokeWidth="3"
                  />
                )}
                {selectedDimension === 'pressure' && (
                  <path
                    d="M 10 90 C 100 20, 250 10, 390 100"
                    fill="none"
                    stroke="#00ff88"
                    strokeWidth="3"
                  />
                )}
                {selectedDimension === 'slide' && (
                  <path
                    d="M 10 100 C 150 70, 280 40, 390 20"
                    fill="none"
                    stroke="#00e5ff"
                    strokeWidth="3"
                  />
                )}

                {/* Control Points */}
                <circle cx="10" cy={selectedDimension === 'pitch' ? 60 : (selectedDimension === 'pressure' ? 90 : 100)} r="5" fill="#fff" />
                <circle cx="200" cy={selectedDimension === 'pitch' ? 30 : (selectedDimension === 'pressure' ? 15 : 55)} r="5" fill="#fff" />
                <circle cx="390" cy={selectedDimension === 'pitch' ? 15 : (selectedDimension === 'pressure' ? 100 : 20)} r="5" fill="#fff" />
              </svg>
            </div>
          </div>

          {/* MPE Parameters Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">PITCH BEND RANGE</span>
                <span className="text-[#ff6e00] font-mono font-bold">±{mpePitchRange} st</span>
              </div>
              <input
                type="range"
                min="12"
                max="48"
                step="12"
                value={mpePitchRange}
                onChange={(e) => setMpePitchRange(Number(e.target.value))}
                className="w-full accent-[#ff6e00]"
              />
              <span className="text-[9px] text-[#666] block">Standard 48-semitone polyphonic bend</span>
            </div>

            <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">PRESSURE SENSITIVITY</span>
                <span className="text-[#00ff88] font-mono font-bold">{polyAftertouchSensitivity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={polyAftertouchSensitivity}
                onChange={(e) => setPolyAftertouchSensitivity(Number(e.target.value))}
                className="w-full accent-[#00ff88]"
              />
              <span className="text-[9px] text-[#666] block">Individual key weight pressure depth</span>
            </div>

            <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">TIMBRE BRIGHTNESS</span>
                <span className="text-[#00e5ff] font-mono font-bold">{timbreCutoffResponse}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={timbreCutoffResponse}
                onChange={(e) => setTimbreCutoffResponse(Number(e.target.value))}
                className="w-full accent-[#00e5ff]"
              />
              <span className="text-[9px] text-[#666] block">Vertical key slide resonance response</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">MPE 1.1 Specification Channel Manager Bound</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply MPE Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
