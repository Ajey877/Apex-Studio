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
    ctx.clearRect(0, 0, width, height);

    // Draw background
    ctx.fillStyle = '#0f0f12';
    ctx.fillRect(0, 0, width, height);

    // Draw waveform
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.fillStyle = '#ff6e00';
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

      ctx.strokeStyle = isActive ? '#00e5ff' : '#ffffff';
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Draw slice badge
      ctx.fillStyle = isActive ? '#00e5ff' : '#222225';
      ctx.fillRect(x + 2, 4, 18, 14);
      ctx.fillStyle = isActive ? '#000000' : '#ffffff';
      ctx.font = '9px monospace';
      ctx.fillText(`${idx + 1}`, x + 5, 15);
    });
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
    <ModalFrame id="audio-slicer-modal" labelledBy="audio-slicer-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00bcd4] to-[#00e5ff] flex items-center justify-center text-black shadow-md">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="audio-slicer-modal-title" className="text-sm font-bold text-white tracking-wide">SAMPLE TRANSIENT SLICER & CHOPPER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00bcd4]/20 text-[#00bcd4] border border-[#00bcd4]/40">
                  AUTO-CHOP
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Chop drum breaks, loops & samples into 16 chromatic pads</p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close audio slicer"
            className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222225] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action Toast Feedback */}
        {statusMessage && (
          <div className="bg-[#00bcd4] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Content */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Controls Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Target Channel */}
            <div className="bg-[#18181b] p-2.5 rounded-lg border border-[#28282b]">
              <span className="text-[10px] text-[#888] font-bold uppercase block mb-1">TARGET CHANNEL</span>
              <select
                value={selectedChannelId}
                onChange={(e) => setSelectedChannelId(e.target.value)}
                className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336] focus:outline-none"
              >
                {channels.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.instrumentType})
                  </option>
                ))}
              </select>
            </div>

            {/* Slicing Algorithm Mode */}
            <div className="bg-[#18181b] p-2.5 rounded-lg border border-[#28282b]">
              <span className="text-[10px] text-[#888] font-bold uppercase block mb-1">DETECTION MODE</span>
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
                        ? 'bg-[#00bcd4] text-black'
                        : 'bg-[#121214] text-[#888] hover:text-white border border-[#28282b]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Transient Sensitivity */}
            <div className="bg-[#18181b] p-2.5 rounded-lg border border-[#28282b]">
              <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                <span>THRESHOLD SENSITIVITY</span>
                <span className="text-[#00bcd4] font-mono">{Math.round(sensitivity * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.2"
                max="0.95"
                step="0.05"
                value={sensitivity}
                onChange={(e) => handleSensitivityChange(parseFloat(e.target.value))}
                disabled={!sourceReady}
                className="w-full h-1.5 accent-[#00bcd4] bg-[#121214] rounded cursor-pointer disabled:opacity-40"
              />
              <div className="flex justify-between text-[9px] text-[#555] mt-1 font-mono">
                <span>Fewer Chops</span>
                <span>Micro Slices</span>
              </div>
            </div>
          </div>

          {/* Interactive Waveform Canvas View */}
          <div className="bg-[#0f0f12] rounded-xl border border-[#28282b] p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Disc className="w-3.5 h-3.5 text-[#00bcd4]" />
                <span>
                  {sourceReady
                    ? `SAMPLE WAVEFORM (${slices.length} CHOP REGIONS)`
                    : 'SAMPLE WAVEFORM — NO AUDIO LOADED'}
                </span>
              </span>
              <span className="text-[10px] text-[#777] font-mono">
                {sourceReady ? 'Click pads below to audition chops' : 'Nothing to slice yet'}
              </span>
            </div>

            {sourceReady ? (
              <canvas
                ref={canvasRef}
                width={700}
                height={140}
                className="w-full h-36 rounded-lg bg-[#0a0a0c] border border-[#222225]"
              />
            ) : (
              <div className="w-full h-36 rounded-lg bg-[#0a0a0c] border border-[#ffaa00]/40 flex items-center justify-center px-5">
                <p className="text-[11px] text-[#ffaa00] text-center font-mono leading-relaxed">
                  NO SAMPLE TO SLICE
                  <span className="block mt-1.5 text-[#888] font-sans">{unavailableMessage}</span>
                </p>
              </div>
            )}
          </div>

          {/* 16 Chop Drum Pads Matrix — only exists when there is real audio behind it. */}
          {sourceReady && slices.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white font-bold text-xs flex items-center gap-1.5">
                  <Grid className="w-3.5 h-3.5 text-[#00bcd4]" />
                  <span>16-CHOP AUDITION PADS (CLICK TO PLAY)</span>
                </span>
                <span className="text-[10px] font-mono text-[#666]">Chop notes C2 - D#3</span>
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
                          ? 'bg-[#00bcd4] border-[#00e5ff] text-black shadow-lg'
                          : 'bg-[#18181b] border-[#28282b] hover:border-[#00bcd4] text-white hover:bg-[#1e1e24]'
                      }`}
                    >
                      <span className="font-mono font-bold text-sm">PAD {idx + 1}</span>
                      <span className={`text-[9px] font-mono mt-0.5 ${isActive ? 'text-black/80' : 'text-[#777]'}`}>
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
        <div className="px-5 py-3.5 bg-[#18181b] border-t border-[#2e2e32] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={handleMapToPianoRoll}
              disabled={!sourceReady || slices.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00bcd4] hover:bg-[#00acc1] disabled:opacity-40 disabled:hover:bg-[#00bcd4] text-black font-bold rounded transition shadow"
            >
              <Music className="w-3.5 h-3.5" />
              <span>Map Chops to Piano Roll</span>
            </button>
            <button
              onClick={handleMapToStepSequencer}
              disabled={!sourceReady || slices.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#222225] hover:bg-[#333338] disabled:opacity-40 disabled:hover:bg-[#222225] text-white font-semibold rounded border border-[#333336] transition"
            >
              <Zap className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span>Map to 16 Steps</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#222225] hover:bg-[#333338] text-white rounded transition"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
