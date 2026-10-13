import React, { useState, useRef, useEffect } from 'react';
import { ModalFrame } from './ModalFrame';
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
import { Channel, Note, PolyphonicBlob, MusicalScale } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

/**
 * Phase 1B — the audition note for a vocal blob.
 *
 * `PolyphonicBlob.durationSteps` and `Note.duration` are BOTH sixteenth-note
 * steps, so the value is passed straight through. The previous code divided by
 * 4, converting steps to beats and then feeding beats into a steps field — a
 * 4-step blob auditioned with a 1-beat gate, a quarter of its real length once
 * the renderer converted again.
 *
 * Pure and exported so the unit contract is regression-tested without a DOM.
 */
export const polyphonicBlobAuditionNote = (blob: PolyphonicBlob): Note => ({
  id: `blob-aud-${Date.now()}`,
  pitch: Math.round(blob.targetPitch),
  start: 0,
  duration: blob.durationSteps,
  velocity: blob.amplitude,
});

/** Synthetic preview channel for blob auditioning (no project audio involved). */
const PREVIEW_CHANNEL: Channel = {
  id: 'poly-audition',
  name: 'Prototype Blob Preview',
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
  synthParams: {} as any,
};

interface PolyphonicEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * UI-03M — demo blob identity palette.
 *
 * `INITIAL_BLOBS` is a module-local constant of this self-declared prototype:
 * the modal takes no blob props, publishes nothing, and the footer states that
 * edits never reach the audio engine. These colours are therefore decorative
 * chrome rather than stored project data, so they resolve through the semantic
 * tokens and stay legible on both palettes. Four map onto the hue they stood
 * for (`#00e5ff` -> cyan, `#00ff88` -> success, `#a855f7` -> aux, `#ff6e00` ->
 * gold). The two shared harmony-voice blobs were `#ffaa00`, one step from the
 * lead's `#ff6e00`; both warm hues collapse onto `--apex-gold`, so the harmony
 * pair takes `--apex-accent` instead and all six demo blobs stay
 * distinguishable. Each entry clears WCAG 1.4.11 3:1 as a blob border on every
 * surface it is painted on, in both palettes.
 */
const INITIAL_BLOBS: PolyphonicBlob[] = [
  { id: 'blob-1', originalPitch: 60, targetPitch: 60, startStep: 0, durationSteps: 4, amplitude: 0.85, formantShift: 0, pitchDriftAmount: 0.15, vibratoDepth: 0.2, color: 'var(--apex-cyan-text)' },
  { id: 'blob-2', originalPitch: 63.8, targetPitch: 64, startStep: 4, durationSteps: 4, amplitude: 0.9, formantShift: 0, pitchDriftAmount: 0.25, vibratoDepth: 0.35, color: 'var(--apex-success)' },
  { id: 'blob-3', originalPitch: 67.2, targetPitch: 67, startStep: 8, durationSteps: 4, amplitude: 0.95, formantShift: 1.5, pitchDriftAmount: 0.1, vibratoDepth: 0.25, color: 'var(--apex-aux-text)' },
  { id: 'blob-4', originalPitch: 70.9, targetPitch: 71, startStep: 12, durationSteps: 4, amplitude: 0.8, formantShift: -1.0, pitchDriftAmount: 0.3, vibratoDepth: 0.4, color: 'var(--apex-gold)' },
  // Harmony lower voice (polyphony)
  { id: 'blob-5', originalPitch: 48, targetPitch: 48, startStep: 0, durationSteps: 8, amplitude: 0.75, formantShift: 0, pitchDriftAmount: 0.05, vibratoDepth: 0.1, color: 'var(--apex-accent)' },
  { id: 'blob-6', originalPitch: 55.1, targetPitch: 55, startStep: 8, durationSteps: 8, amplitude: 0.8, formantShift: 0, pitchDriftAmount: 0.08, vibratoDepth: 0.15, color: 'var(--apex-accent)' }
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
      PREVIEW_CHANNEL,
      polyphonicBlobAuditionNote(blob),
    );
    // Truthful label: this plays a synthesised preview at the blob's pitch.
    // It does not play back (or pitch-shift) any audio from the project.
    setStatusMessage(`Preview tone at ${midiToName(blob.targetPitch)} (synth preview, not your audio)`);
    setTimeout(() => setStatusMessage(null), 2000);
  };

  const handleQuantizeAllPitch = () => {
    const quantized = blobs.map(b => ({
      ...b,
      targetPitch: Math.round(b.originalPitch),
      pitchDriftAmount: b.pitchDriftAmount * (1 - pitchDriftCorrection / 100)
    }));
    setBlobs(quantized);
    setStatusMessage('Demo blobs snapped to the nearest semitone (prototype display only).');
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
    <ModalFrame id="fl-polyphonic-editor-modal" labelledBy="fl-polyphonic-editor-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/* UI-03M: chrome moves onto the existing `--apex-*` semantic tokens. The
          prototype's green identity is kept through `--apex-success`, the
          NOT-APPLIED warnings stay on the `--apex-gold` info banner the other
          migrated modals use, and the three inspector parameters keep one
          distinct signal hue each (success / cyan / gold).

          Nothing here changes what the surface claims: every PROTOTYPE,
          DEMO BLOBS and NOT APPLIED string is preserved verbatim, so the
          migration cannot make a stub read as a working feature. The dead
          `bg-black/85` scrim is gone — ModalFrame supplies the shared themed
          `--apex-modal-overlay`. */}
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)] rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-success)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-polyphonic-editor-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">POLYPHONIC AUDIO BLOB EDITOR (PROTOTYPE)</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]">
                  PROTOTYPE — DEMO BLOBS
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Prototype surface with sample blobs. It does not analyse, import or play back your audio.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleQuantizeAllPitch}
              className="px-3 py-1 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Correct Pitch 100%</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close polyphonic editor"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} aria-label="Dismiss status message" className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          <div className="bg-[color-mix(in_srgb,var(--apex-gold)_14%,transparent)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono font-bold text-[var(--apex-text)] uppercase tracking-wider">
              NOT APPLIED — PROTOTYPE, NO AUDIO ANALYSIS OR EDITING
            </span>
            {/* --apex-text-2, not -3: the qualifier measures 4.17:1 in Dark on
                the gold wash at -3 and 6.11:1 at -2. */}
            <span className="text-[10px] text-[var(--apex-text-2)] whitespace-nowrap">SAMPLE BLOBS ONLY</span>
          </div>

          {/* Prototype blob timeline */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                <span>SPECTRAL NOTE BLOB TIMELINE (16 STEPS)</span>
              </span>
              <span className="text-[10px] font-mono text-[var(--apex-success)]">
                {blobs.length} Demo Blobs (not detected from audio)
              </span>
            </div>

            {/* Note blob grid container */}
            <div className="relative h-60 bg-[var(--apex-surface-2)] rounded-lg border border-[var(--apex-border)] overflow-hidden flex">
              {/* Vertical Piano Keys Strip */}
              <div className="w-14 bg-[var(--apex-surface-3)] border-r border-[var(--apex-border)] flex flex-col justify-between py-1 text-[9px] font-mono text-[var(--apex-text-3)] pl-1 select-none">
                {['B5 (71)', 'G5 (67)', 'E5 (64)', 'C5 (60)', 'G4 (55)', 'C4 (48)'].map((k, idx) => (
                  <div key={idx} className="border-b border-[var(--apex-grid-line)] pr-1 flex items-center justify-between">
                    <span>{k.split(' ')[0]}</span>
                    <span className="text-[7px] text-[var(--apex-text-3)]">{k.split(' ')[1]}</span>
                  </div>
                ))}
              </div>

              {/* Note Blobs Interactive Stage */}
              <div className="flex-1 relative bg-[var(--apex-chrome-inset)]">
                {/* 16 Step grid lines. Derived from --apex-text rather than a
                    fixed white alpha, so the step grid stays visible on the
                    dark inset AND on the light one. */}
                {Array.from({ length: 16 }).map((_, step) => (
                  <div
                    key={step}
                    style={{ left: `${(step / 16) * 100}%` }}
                    className={`absolute top-0 bottom-0 border-l ${step % 4 === 0 ? 'border-[color-mix(in_srgb,var(--apex-text)_26%,transparent)]' : 'border-[color-mix(in_srgb,var(--apex-text)_12%,transparent)]'}`}
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
                        backgroundColor: `color-mix(in srgb, ${blob.color} 27%, transparent)`,
                        borderColor: blob.color
                      }}
                      className={`absolute h-8 -translate-y-1/2 border-2 rounded-full px-2.5 flex items-center justify-between cursor-pointer transition-all ${
                        isSel ? 'ring-2 ring-[var(--apex-accent-strong)] shadow-xl brightness-125 scale-105 z-20' : 'opacity-85 hover:opacity-100 z-10'
                      }`}
                    >
                      {/* Blob pitch center contour waveform. The blob hue stays
                          on the border and the wash; the labels use the theme
                          text scale, because a same-hue label on its own wash
                          measures 3.36:1 in Light and cannot clear AA. The
                          8px amplitude and formant-shift read-outs use
                          --apex-text for the same reason: --apex-text-2 and
                          --apex-cyan-text land at 4.19-4.52:1 on a 27% blob
                          wash in Light. The cyan formant identity is preserved
                          on the inspector read-out and its slider accent. */}
                      <div className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-[var(--apex-text)] animate-pulse" />
                        <span className="text-[9px] font-bold text-[var(--apex-text)] truncate font-mono">
                          {midiToName(blob.targetPitch)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 text-[8px] font-mono text-[var(--apex-text)]">
                        {blob.formantShift !== 0 && (
                          <span className="font-bold">{blob.formantShift > 0 ? '+' : ''}{blob.formantShift}st</span>
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
            <div className="bg-[var(--apex-panel-header)] p-4 rounded-xl border border-[var(--apex-border)] space-y-4">
              <div className="flex items-center justify-between border-b border-[var(--apex-border)] pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedBlob.color }} />
                  <span className="text-xs font-bold text-[var(--apex-text)] uppercase">
                    SELECTED BLOB INSPECTOR: {midiToName(selectedBlob.targetPitch)} (Orig: {midiToName(selectedBlob.originalPitch)})
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAuditionBlob(selectedBlob)}
                    className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Play className="w-3 h-3 text-[var(--apex-success)]" />
                    <span>Audition</span>
                  </button>

                  <button
                    onClick={() => handleSplitBlob(selectedBlob.id)}
                    className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Scissors className="w-3 h-3 text-[var(--apex-gold)]" />
                    <span>Split Blob</span>
                  </button>
                </div>
              </div>

              {/* Slider Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                {/* Corrected Target Pitch */}
                <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--apex-text)] font-bold">PITCH CENTER</span>
                    <span className="text-[var(--apex-success)] font-mono font-bold">{midiToName(selectedBlob.targetPitch)}</span>
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
                    className="w-full accent-[var(--apex-success)]"
                  />
                </div>

                {/* Formant Shift */}
                <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--apex-text)] font-bold">FORMANT SHIFT</span>
                    <span className="text-[var(--apex-cyan-text)] font-mono font-bold">{selectedBlob.formantShift > 0 ? '+' : ''}{selectedBlob.formantShift} st</span>
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
                    className="w-full accent-[var(--apex-cyan)]"
                  />
                </div>

                {/* Pitch Drift / Vibrato Correction */}
                <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--apex-text)] font-bold">PITCH DRIFT / VIBRATO</span>
                    <span className="text-[var(--apex-gold)] font-mono font-bold">{Math.round(selectedBlob.pitchDriftAmount * 100)}%</span>
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
                    className="w-full accent-[var(--apex-gold)]"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Prototype: edits stay in this window and never reach the audio engine</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Close Prototype</span>
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
