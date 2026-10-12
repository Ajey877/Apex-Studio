import React, { useState, useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  X, 
  Scissors, 
  Play, 
  RotateCcw, 
  Volume2, 
  Grid, 
  Zap, 
  Sparkles, 
  Check, 
  Music,
  ArrowRight,
  Disc
} from 'lucide-react';
import { Channel, InstrumentType } from '../types/daw';
import { AudioSlicer, AudioSlice } from '../utils/audioSlicer';
import { audioEngine } from '../audio/audioEngine';
import { isSlicerSourceReady, resolveSlicerAudioSource, slicerSourceMessage } from './audioSlicerSource';
import {
  MAX_SLICER_CHOPS,
  isSlicerChopRefused,
  publishSlicerChops,
  slicerChopPianoRollMessage,
  slicerChopStepSequencerMessage,
} from './audioSlicerPublication';
import { readSlicerPalette } from './audioSlicerTheme';

interface AudioSlicerModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
  onAddChannel?: (name: string, type: InstrumentType) => void;
}

export const AudioSlicerModal: React.FC<AudioSlicerModalProps> = ({
  isOpen,
  onClose,
  channels,
  onUpdateChannel
}) => {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(channels[0]?.id || '');
  const [sliceMode, setSliceMode] = useState<'transient' | 'beat_8' | 'beat_16' | 'beat_32'>('transient');
  const [sensitivity, setSensitivity] = useState<number>(0.65);
  const [slices, setSlices] = useState<AudioSlice[]>([]);
  const [activeSliceId, setActiveSliceId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeChannel = channels.find(c => c.id === selectedChannelId) || channels[0];

  // Phase 52: the slicer operates on a real, already-loaded sample and nothing
  // else. It used to synthesize a breakbeat whenever the channel had no sample,
  // then draw that generated buffer as the channel's audio and report slice and
  // "chops mapped" counts for it. There is no generated audio here: when no real
  // buffer is available the source resolves to an explicit unavailable state.
  const slicerSource = resolveSlicerAudioSource(
    activeChannel,
    id => audioEngine.getSampleBuffer(id)
  );
  const sourceReady = isSlicerSourceReady(slicerSource);
  const audioBuffer = sourceReady ? slicerSource.buffer : null;
  const unavailableMessage = slicerSourceMessage(slicerSource);

  // Reload the real sample buffer whenever the modal opens or the target
  // channel changes. Slices are recomputed from that buffer only.
  useEffect(() => {
    if (!isOpen) return;
    if (slicerSource.kind !== 'sample') {
      setSlices([]);
      setActiveSliceId(null);
      return;
    }
    setActiveSliceId(null);
    computeSlices(slicerSource.buffer, sliceMode, sensitivity);
  }, [isOpen, selectedChannelId, slicerSource.kind, slicerSource.kind === 'sample' ? slicerSource.sampleId : '']);

  const computeSlices = (buf: AudioBuffer, mode: string, sens: number) => {
    if (!buf) return;
    let detected: AudioSlice[] = [];
    if (mode === 'transient') {
      detected = AudioSlicer.detectTransients(buf, sens, 16);
    } else if (mode === 'beat_8') {
      detected = AudioSlicer.divideIntoEqualSlices(buf, 8);
    } else if (mode === 'beat_16') {
      detected = AudioSlicer.divideIntoEqualSlices(buf, 16);
    } else {
      detected = AudioSlicer.divideIntoEqualSlices(buf, 32);
    }
    setSlices(detected);
  };

  const handleSensitivityChange = (newSens: number) => {
    setSensitivity(newSens);
    if (audioBuffer) {
      computeSlices(audioBuffer, sliceMode, newSens);
    }
  };

  const handleModeChange = (newMode: 'transient' | 'beat_8' | 'beat_16' | 'beat_32') => {
    setSliceMode(newMode);
    if (audioBuffer) {
      computeSlices(audioBuffer, newMode, sensitivity);
    }
  };

  // Play a single slice audition
  const playSlice = (slice: AudioSlice) => {
    if (!audioBuffer) return;
    setActiveSliceId(slice.id);
    const ctx = audioEngine.getContext();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.9;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    const now = ctx.currentTime;
    const dur = slice.endSec - slice.startSec;
    source.start(now, slice.startSec, dur);

    setTimeout(() => {
      setActiveSliceId(null);
    }, dur * 1000);
  };

  // Render waveform and slice boundary markers on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const draw = () => {
      // UI-03E: the palette is re-read from the document on every repaint, so a
      // theme flip is picked up without a reload. Canvas draw commands cannot
      // read CSS custom properties, which is why the colours come from the seam.
      const palette = readSlicerPalette();
      const signal = palette.signal;

      ctx.clearRect(0, 0, width, height);

      // Draw background
      ctx.fillStyle = palette.canvasBackground;
      ctx.fillRect(0, 0, width, height);

      // Draw waveform
      const data = audioBuffer.getChannelData(0);
      const step = Math.ceil(data.length / width);
      const amp = height / 2;

      ctx.fillStyle = signal.wave;
      ctx.beginPath();
      for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
          const datum = data[i * step + j] || 0;
          if (datum < min) min = datum;
          if (datum > max) max = datum;
        }
        ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
      }

      // Draw slice vertical markers
      slices.forEach((slice, idx) => {
        const x = slice.startRatio * width;
        const isActive = activeSliceId === slice.id;

        ctx.strokeStyle = isActive ? signal.markerActive : signal.markerInactive;
        ctx.lineWidth = isActive ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Draw slice badge
        ctx.fillStyle = isActive ? signal.badgeActive : signal.badgeInactive;
        ctx.fillRect(x + 2, 4, 18, 14);
        ctx.fillStyle = isActive ? signal.badgeTextActive : signal.badgeTextInactive;
        ctx.font = '9px monospace';
        ctx.fillText(`${idx + 1}`, x + 5, 15);
      });
    };

    draw();

    // The canvas is painted imperatively, so nothing in the CSS layer can
    // respond to a theme change on its own. Repaint when the theme flips.
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [audioBuffer, slices, activeSliceId]);

  // Phase 55: both publication actions go through the audited chop publisher.
  // The chops that leave this modal are the regions the detector found — real
  // start/end trims on the channel's real sample, on real pad notes — or the
  // publication is refused and the user is told why. Neither action publishes a
  // slice count on its own any more.
  const publishChops = () =>
    publishSlicerChops(slices, slicerSource, {
      stepCount: activeChannel?.steps.length || MAX_SLICER_CHOPS,
    });

  const showStatus = (message: string) => {
    setStatusMessage(message);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  // Publish the detected chops to the piano roll as real, playable chops.
  const handleMapToPianoRoll = () => {
    if (!activeChannel) return;

    const publication = publishChops();
    if (isSlicerChopRefused(publication)) {
      showStatus(publication.message);
      return;
    }

    onUpdateChannel(activeChannel.id, {
      instrumentType: 'drumpad',
      drumPads: publication.pads,
      notes: publication.notes,
    });
    showStatus(slicerChopPianoRollMessage(publication));
  };

  // Publish the detected chops to the 16-pad step sequencer.
  const handleMapToStepSequencer = () => {
    if (!activeChannel) return;

    const publication = publishChops();
    if (isSlicerChopRefused(publication)) {
      showStatus(publication.message);
      return;
    }

    onUpdateChannel(activeChannel.id, {
      instrumentType: 'drumpad',
      drumPads: publication.pads,
      steps: publication.steps,
    });
    showStatus(slicerChopStepSequencerMessage(publication));
  };

  if (!isOpen) return null;

  return (
    <ModalFrame id="audio-slicer-modal" labelledBy="audio-slicer-modal-title" onClose={onClose} className="fixed inset-0 apex-modal-overlay backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-cyan)] to-[var(--apex-cyan-strong)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="audio-slicer-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">SAMPLE TRANSIENT SLICER & CHOPPER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[var(--apex-cyan)]/20 text-[var(--apex-cyan-text)] border border-[var(--apex-cyan)]/40">
                  AUTO-CHOP
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Chop drum breaks, loops & samples into 16 chromatic pads</p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close audio slicer"
            className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-surface-2)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action Toast Feedback */}
        {statusMessage && (
          <div className="bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Content */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Controls Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Target Channel */}
            <div className="bg-[var(--apex-surface-2)] p-2.5 rounded-lg border border-[var(--apex-border)]">
              <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase block mb-1">TARGET CHANNEL</span>
              <select
                value={selectedChannelId}
                onChange={(e) => setSelectedChannelId(e.target.value)}
                className="w-full bg-[var(--apex-surface)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)] focus:outline-none"
              >
                {channels.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.instrumentType})
                  </option>
                ))}
              </select>
            </div>

            {/* Slicing Algorithm Mode */}
            <div className="bg-[var(--apex-surface-2)] p-2.5 rounded-lg border border-[var(--apex-border)]">
              <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase block mb-1">DETECTION MODE</span>
              <div className="grid grid-cols-4 gap-1">
                {[
                  { id: 'transient', label: 'Trans' },
                  { id: 'beat_8', label: '8-Grid' },
                  { id: 'beat_16', label: '16-Grid' },
                  { id: 'beat_32', label: '32-Grid' }
                ].map(m => (
                  <button
                    key={m.id}
                    onClick={() => handleModeChange(m.id as any)}
                    disabled={!sourceReady}
                    className={`py-1 rounded text-[10px] font-bold transition font-mono ${
                      sliceMode === m.id
                        ? 'bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)]'
                        : 'bg-[var(--apex-surface)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)] border border-[var(--apex-border)]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Transient Sensitivity */}
            <div className="bg-[var(--apex-surface-2)] p-2.5 rounded-lg border border-[var(--apex-border)]">
              <div className="flex items-center justify-between text-[10px] text-[var(--apex-text-2)] font-bold uppercase mb-1">
                <span>THRESHOLD SENSITIVITY</span>
                <span className="text-[var(--apex-cyan-text)] font-mono">{Math.round(sensitivity * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.2"
                max="0.95"
                step="0.05"
                value={sensitivity}
                onChange={(e) => handleSensitivityChange(parseFloat(e.target.value))}
                disabled={!sourceReady}
                className="w-full h-1.5 accent-[var(--apex-cyan)] bg-[var(--apex-surface)] rounded cursor-pointer disabled:opacity-40"
              />
              <div className="flex justify-between text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">
                <span>Fewer Chops</span>
                <span>Micro Slices</span>
              </div>
            </div>
          </div>

          {/* Interactive Waveform Canvas View */}
          <div className="bg-[var(--apex-bg)] rounded-xl border border-[var(--apex-border)] p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                <Disc className="w-3.5 h-3.5 text-[var(--apex-cyan)]" />
                <span>
                  {sourceReady
                    ? `SAMPLE WAVEFORM (${slices.length} CHOP REGIONS)`
                    : 'SAMPLE WAVEFORM — NO AUDIO LOADED'}
                </span>
              </span>
              <span className="text-[10px] text-[var(--apex-text-3)] font-mono">
                {sourceReady ? 'Click pads below to audition chops' : 'Nothing to slice yet'}
              </span>
            </div>

            {sourceReady ? (
              <canvas
                ref={canvasRef}
                width={700}
                height={140}
                className="w-full h-36 rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-border)]"
              />
            ) : (
              <div className="w-full h-36 rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-gold)]/40 flex items-center justify-center px-5">
                <p className="text-[11px] text-[var(--apex-gold)] text-center font-mono leading-relaxed">
                  NO SAMPLE TO SLICE
                  <span className="block mt-1.5 text-[var(--apex-text-2)] font-sans">{unavailableMessage}</span>
                </p>
              </div>
            )}
          </div>

          {/* 16 Chop Drum Pads Matrix — only exists when there is real audio behind it. */}
          {sourceReady && slices.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold text-xs flex items-center gap-1.5">
                  <Grid className="w-3.5 h-3.5 text-[var(--apex-cyan)]" />
                  <span>16-CHOP AUDITION PADS (CLICK TO PLAY)</span>
                </span>
                <span className="text-[10px] font-mono text-[var(--apex-text-3)]">Chop notes C2 - D#3</span>
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                {slices.map((slice, idx) => {
                  const isActive = activeSliceId === slice.id;
                  return (
                    <button
                      key={slice.id}
                      onClick={() => playSlice(slice)}
                      className={`p-3 rounded-lg border flex flex-col items-center justify-center transition active:scale-95 ${
                        isActive
                          ? 'bg-[var(--apex-cyan)] border-[var(--apex-cyan-strong)] text-[var(--apex-state-playing-fg)] shadow-lg'
                          : 'bg-[var(--apex-surface-2)] border-[var(--apex-border)] hover:border-[var(--apex-cyan)] text-[var(--apex-text)] hover:bg-[var(--apex-surface-3)]'
                      }`}
                    >
                      <span className="font-mono font-bold text-sm">PAD {idx + 1}</span>
                      <span className={`text-[9px] font-mono mt-0.5 ${isActive ? 'text-[var(--apex-state-playing-fg)]' : 'text-[var(--apex-text-3)]'}`}>
                        {(slice.endSec - slice.startSec).toFixed(2)}s
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={handleMapToPianoRoll}
              disabled={!sourceReady || slices.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--apex-cyan)] hover:bg-[var(--apex-cyan-strong)] disabled:opacity-40 disabled:hover:bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow"
            >
              <Music className="w-3.5 h-3.5" />
              <span>Map Chops to Piano Roll</span>
            </button>
            <button
              onClick={handleMapToStepSequencer}
              disabled={!sourceReady || slices.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] disabled:opacity-40 disabled:hover:bg-[var(--apex-surface-2)] text-[var(--apex-text)] font-semibold rounded border border-[var(--apex-border)] transition"
            >
              <Zap className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
              <span>Map to 16 Steps</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] rounded transition"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
