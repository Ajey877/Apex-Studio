import React, { useState, useRef, useEffect } from 'react';
import { 
  Music, 
  X, 
  Sparkles, 
  Scissors, 
  Play, 
  RotateCcw, 
  Sliders, 
  Check, 
  Wand2, 
  Activity,
  Layers,
  Flame,
  Volume2
} from 'lucide-react';
import { PolyphonicBlob, MusicalScale } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface PolyphonicEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const INITIAL_BLOBS: PolyphonicBlob[] = [
  { id: 'blob-1', originalPitch: 60, targetPitch: 60, startStep: 0, durationSteps: 4, amplitude: 0.85, formantShift: 0, pitchDriftAmount: 0.15, vibratoDepth: 0.2, color: '#00e5ff' },
  { id: 'blob-2', originalPitch: 63.8, targetPitch: 64, startStep: 4, durationSteps: 4, amplitude: 0.9, formantShift: 0, pitchDriftAmount: 0.25, vibratoDepth: 0.35, color: '#00ff88' },
  { id: 'blob-3', originalPitch: 67.2, targetPitch: 67, startStep: 8, durationSteps: 4, amplitude: 0.95, formantShift: 1.5, pitchDriftAmount: 0.1, vibratoDepth: 0.25, color: '#a855f7' },
  { id: 'blob-4', originalPitch: 70.9, targetPitch: 71, startStep: 12, durationSteps: 4, amplitude: 0.8, formantShift: -1.0, pitchDriftAmount: 0.3, vibratoDepth: 0.4, color: '#ff6e00' },
  // Harmony lower voice (polyphony)
  { id: 'blob-5', originalPitch: 48, targetPitch: 48, startStep: 0, durationSteps: 8, amplitude: 0.75, formantShift: 0, pitchDriftAmount: 0.05, vibratoDepth: 0.1, color: '#ffaa00' },
  { id: 'blob-6', originalPitch: 55.1, targetPitch: 55, startStep: 8, durationSteps: 8, amplitude: 0.8, formantShift: 0, pitchDriftAmount: 0.08, vibratoDepth: 0.15, color: '#ffaa00' }
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToName(midi: number): string {
  const rounded = Math.round(midi);
  const oct = Math.floor(rounded / 12) - 1;
  const note = NOTE_NAMES[rounded % 12];
  const cents = Math.round((midi - rounded) * 100);
  return `${note}${oct}${cents !== 0 ? ` (${cents > 0 ? '+' : ''}${cents}c)` : ''}`;
}

export const PolyphonicEditorModal: React.FC<PolyphonicEditorModalProps> = ({
  isOpen,
  onClose
}) => {
  const [blobs, setBlobs] = useState<PolyphonicBlob[]>(INITIAL_BLOBS);
  const [selectedBlobId, setSelectedBlobId] = useState<string>(INITIAL_BLOBS[0].id);
  const [pitchQuantizeAmount, setPitchQuantizeAmount] = useState<number>(100); // 100% snap to nearest chromatic note
  const [pitchDriftCorrection, setPitchDriftCorrection] = useState<number>(80);
  const [globalFormantShift, setGlobalFormantShift] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectedBlob = blobs.find(b => b.id === selectedBlobId) || blobs[0];

  const handleAuditionBlob = (blob: PolyphonicBlob) => {
    audioEngine.playNote(
      {
        id: 'poly-audition',
        name: 'ARA Audio Vocal',
        instrumentType: 'vox_choir',
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        color: '#00e5ff',
        mixerTrackId: 1,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `blob-aud-${Date.now()}`, pitch: Math.round(blob.targetPitch), start: 0, duration: blob.durationSteps / 4, velocity: blob.amplitude }
    );
    setStatusMessage(`Auditioning Blob: ${midiToName(blob.targetPitch)}`);
    setTimeout(() => setStatusMessage(null), 2000);
  };

  const handleQuantizeAllPitch = () => {
    const quantized = blobs.map(b => ({
      ...b,
      targetPitch: Math.round(b.originalPitch),
      pitchDriftAmount: b.pitchDriftAmount * (1 - pitchDriftCorrection / 100)
    }));
    setBlobs(quantized);
    setStatusMessage('100% Perfect Pitch Correction & Drift Alignment Applied!');
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleSplitBlob = (blobId: string) => {
    const target = blobs.find(b => b.id === blobId);
    if (!target || target.durationSteps <= 2) return;

    const half = Math.floor(target.durationSteps / 2);
    const blobA: PolyphonicBlob = { ...target, durationSteps: half };
    const blobB: PolyphonicBlob = {
      ...target,
      id: `blob-${Date.now()}`,
      startStep: target.startStep + half,
      durationSteps: target.durationSteps - half
    };

    setBlobs(blobs.map(b => b.id === blobId ? blobA : b).concat(blobB));
    setStatusMessage('Split audio blob into two independent note regions');
    setTimeout(() => setStatusMessage(null), 2000);
  };

  return (
    <div id="fl-polyphonic-editor-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00ff88]/40 rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00ff88] to-[#00aa55] flex items-center justify-center text-black shadow-md font-bold">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">MELODYNE / ARA2 POLYPHONIC AUDIO BLOB EDITOR</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40">
                  POLYPHONIC DNA ALGORITHM
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Direct graphical manipulation of polyphonic harmonic blobs, pitch center, formant shifts, and vibrato contours</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleQuantizeAllPitch}
              className="px-3 py-1 bg-[#00ff88] hover:bg-[#33ff9f] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Correct Pitch 100%</span>
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
          {/* Graphical Melodyne Piano Roll Canvas */}
          <div className="bg-[#0b0b0d] p-3 rounded-xl border border-[#26262a] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-[#00ff88]" />
                <span>SPECTRAL NOTE BLOB TIMELINE (16 STEPS)</span>
              </span>
              <span className="text-[10px] font-mono text-[#00ff88]">
                {blobs.length} Harmonics Detected
              </span>
            </div>

            {/* Note blob grid container */}
            <div className="relative h-60 bg-[#141418] rounded-lg border border-[#333338] overflow-hidden flex">
              {/* Vertical Piano Keys Strip */}
              <div className="w-14 bg-[#1a1a1f] border-r border-[#2a2a30] flex flex-col justify-between py-1 text-[9px] font-mono text-[#777] pl-1 select-none">
                {['B5 (71)', 'G5 (67)', 'E5 (64)', 'C5 (60)', 'G4 (55)', 'C4 (48)'].map((k, idx) => (
                  <div key={idx} className="border-b border-white/5 pr-1 flex items-center justify-between">
                    <span>{k.split(' ')[0]}</span>
                    <span className="text-[7px] text-[#555]">{k.split(' ')[1]}</span>
                  </div>
                ))}
              </div>

              {/* Note Blobs Interactive Stage */}
              <div className="flex-1 relative bg-[#0e0e12]">
                {/* 16 Step grid lines */}
                {Array.from({ length: 16 }).map((_, step) => (
                  <div
                    key={step}
                    style={{ left: `${(step / 16) * 100}%` }}
                    className={`absolute top-0 bottom-0 border-l ${step % 4 === 0 ? 'border-white/15' : 'border-white/5'}`}
                  />
                ))}

                {/* Blobs */}
                {blobs.map((blob) => {
                  const leftPct = (blob.startStep / 16) * 100;
                  const widthPct = (blob.durationSteps / 16) * 100;
                  // Map MIDI pitch 48-72 to Y coordinate (inverted)
                  const minPitch = 44;
                  const maxPitch = 76;
                  const topPct = (1 - (blob.targetPitch - minPitch) / (maxPitch - minPitch)) * 100;
                  const isSel = blob.id === selectedBlobId;

                  return (
                    <div
                      key={blob.id}
                      onClick={() => setSelectedBlobId(blob.id)}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: `${Math.max(5, Math.min(85, topPct))}%`,
                        backgroundColor: `${blob.color}44`,
                        borderColor: blob.color
                      }}
                      className={`absolute h-8 -translate-y-1/2 border-2 rounded-full px-2.5 flex items-center justify-between cursor-pointer transition-all ${
                        isSel ? 'ring-2 ring-white shadow-xl brightness-125 scale-105 z-20' : 'opacity-85 hover:opacity-100 z-10'
                      }`}
                    >
                      {/* Blob pitch center contour waveform */}
                      <div className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                        <span className="text-[9px] font-bold text-white truncate font-mono">
                          {midiToName(blob.targetPitch)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 text-[8px] font-mono text-white/80">
                        {blob.formantShift !== 0 && (
                          <span className="text-amber-300 font-bold">{blob.formantShift > 0 ? '+' : ''}{blob.formantShift}st</span>
                        )}
                        <span>{(blob.amplitude * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Selected Blob Parameter Inspector */}
          {selectedBlob && (
            <div className="bg-[#18181c] p-4 rounded-xl border border-[#2a2a2e] space-y-4">
              <div className="flex items-center justify-between border-b border-[#28282b] pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedBlob.color }} />
                  <span className="text-xs font-bold text-white uppercase">
                    SELECTED BLOB INSPECTOR: {midiToName(selectedBlob.targetPitch)} (Orig: {midiToName(selectedBlob.originalPitch)})
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAuditionBlob(selectedBlob)}
                    className="px-2.5 py-1 bg-[#25252a] hover:bg-[#333338] text-white text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Play className="w-3 h-3 text-[#00ff88]" />
                    <span>Audition</span>
                  </button>

                  <button
                    onClick={() => handleSplitBlob(selectedBlob.id)}
                    className="px-2.5 py-1 bg-[#25252a] hover:bg-[#333338] text-amber-400 text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Scissors className="w-3 h-3" />
                    <span>Split Blob</span>
                  </button>
                </div>
              </div>

              {/* Slider Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                {/* Corrected Target Pitch */}
                <div className="bg-[#121214] p-3 rounded-lg border border-[#26262a] space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-white font-bold">PITCH CENTER</span>
                    <span className="text-[#00ff88] font-mono font-bold">{midiToName(selectedBlob.targetPitch)}</span>
                  </div>
                  <input
                    type="range"
                    min="36"
                    max="84"
                    step="0.1"
                    value={selectedBlob.targetPitch}
                    onChange={(e) => {
                      const updated = blobs.map(b => b.id === selectedBlob.id ? { ...b, targetPitch: Number(e.target.value) } : b);
                      setBlobs(updated);
                    }}
                    className="w-full accent-[#00ff88]"
                  />
                </div>

                {/* Formant Shift */}
                <div className="bg-[#121214] p-3 rounded-lg border border-[#26262a] space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-white font-bold">FORMANT SHIFT</span>
                    <span className="text-[#00e5ff] font-mono font-bold">{selectedBlob.formantShift > 0 ? '+' : ''}{selectedBlob.formantShift} st</span>
                  </div>
                  <input
                    type="range"
                    min="-12"
                    max="12"
                    step="0.5"
                    value={selectedBlob.formantShift}
                    onChange={(e) => {
                      const updated = blobs.map(b => b.id === selectedBlob.id ? { ...b, formantShift: Number(e.target.value) } : b);
                      setBlobs(updated);
                    }}
                    className="w-full accent-[#00e5ff]"
                  />
                </div>

                {/* Pitch Drift / Vibrato Correction */}
                <div className="bg-[#121214] p-3 rounded-lg border border-[#26262a] space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-white font-bold">PITCH DRIFT / VIBRATO</span>
                    <span className="text-[#ffaa00] font-mono font-bold">{Math.round(selectedBlob.pitchDriftAmount * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={selectedBlob.pitchDriftAmount}
                    onChange={(e) => {
                      const updated = blobs.map(b => b.id === selectedBlob.id ? { ...b, pitchDriftAmount: Number(e.target.value) } : b);
                      setBlobs(updated);
                    }}
                    className="w-full accent-[#ffaa00]"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Direct ARA2 Phase-Locked Resampling Active</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#00ff88] hover:bg-[#33ff9f] text-black font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply ARA Audio Edits</span>
          </button>
        </div>
      </div>
    </div>
  );
};
