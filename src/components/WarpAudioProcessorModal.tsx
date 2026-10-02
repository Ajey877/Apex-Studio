import React, { useEffect, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { Zap, X, Sparkles, Play, Check } from 'lucide-react';
import { PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  WARP_BEHAVIOUR_SUMMARY,
  isWarpTargetReady,
  resolveWarpTarget,
  warpTargetMessage,
} from './warpClipTarget';

interface WarpAudioProcessorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Every clip in the project plus the id of the clip the user selected, so the
   * tool edits the clip they chose. It used to receive `playlistClips[0]`, which
   * silently edited an unrelated clip on any multi-clip timeline.
   */
  clips: PlaylistClip[];
  selectedClipId: string | null;
  onUpdateClip?: (clip: PlaylistClip) => void;
}

export const WarpAudioProcessorModal: React.FC<WarpAudioProcessorModalProps> = ({
  isOpen,
  onClose,
  clips,
  selectedClipId,
  onUpdateClip
}) => {
  const target = resolveWarpTarget(clips, selectedClipId);
  const targetClip = isWarpTargetReady(target) ? target.clip : null;
  const blocker = isWarpTargetReady(target) ? '' : warpTargetMessage(target);

  const [pitchSemitones, setPitchSemitones] = useState<number>(targetClip?.pitchShiftSemitones || 0);
  const [stretchRate, setStretchRate] = useState<number>(targetClip?.timeStretchRate || 1.0);
  const [isAuditioning, setIsAuditioning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // The modal stays mounted between openings, so re-seed the controls whenever
  // it opens or the target clip changes. Without this the sliders would keep
  // showing the previous clip's values.
  useEffect(() => {
    if (!isOpen) return;
    setPitchSemitones(targetClip?.pitchShiftSemitones ?? 0);
    setStretchRate(targetClip?.timeStretchRate ?? 1.0);
  }, [isOpen, targetClip?.id]);

  if (!isOpen) return null;

  /**
   * Audition the *selected clip's own audio* at the current pitch and rate.
   *
   * The previous audition built a fake `sampler` channel with no sample behind
   * it; the sampler renderer finds no buffer and returns early, so the button
   * played nothing while reporting "Auditioning … Warp DSP Algorithm". This
   * plays the real buffer through the engine's context so the preview is the
   * actual clip audio at the settings shown.
   */
  const handleAuditionWarp = () => {
    if (!targetClip?.audioBufferId) {
      setStatusMessage('This clip has no loaded audio to audition.');
      setTimeout(() => setStatusMessage(null), 2500);
      return;
    }
    const buffer = audioEngine.getSampleBuffer(targetClip.audioBufferId);
    if (!buffer) {
      setStatusMessage('This clip’s audio is not loaded in this session, so it cannot be auditioned.');
      setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    const ctx = audioEngine.getContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = stretchRate;
    source.detune.value = pitchSemitones * 100;

    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain);
    gain.connect(ctx.destination);

    const previewSeconds = Math.min(buffer.duration / Math.max(0.05, stretchRate), 4);
    setIsAuditioning(true);
    source.start(0, 0, previewSeconds);
    source.onended = () => setIsAuditioning(false);

    setStatusMessage('Previewing the clip’s own audio at the pitch and rate above (mixer inserts bypassed).');
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleApplyWarp = () => {
    if (!targetClip || !onUpdateClip) return;
    onUpdateClip({
      ...targetClip,
      pitchShiftSemitones: pitchSemitones,
      timeStretchRate: stretchRate
    });
    setStatusMessage(`Applied pitch ${pitchSemitones > 0 ? '+' : ''}${pitchSemitones} st and ${stretchRate.toFixed(2)}x rate to "${targetClip.name}".`);
    setTimeout(() => {
      onClose();
    }, 1000);
  };

  return (
    <ModalFrame id="fl-warp-processor-modal" labelledBy="fl-warp-processor-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00ff88]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00ff88] to-[#00aa55] flex items-center justify-center text-black shadow-md font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-warp-processor-modal-title" className="text-sm font-bold text-white tracking-wide">AUDIO CLIP PITCH &amp; PLAYBACK RATE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40">
                  REPITCH — LENGTH NOT PRESERVED
                </span>
              </div>
              <p className="text-[10px] text-[#777]">
                {targetClip ? `Editing "${targetClip.name}"` : 'No audio clip selected'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionWarp}
              disabled={!targetClip}
              className={`px-3 py-1 text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow disabled:opacity-40 ${
                isAuditioning ? 'bg-white' : 'bg-[#00ff88] hover:bg-[#33ff9f]'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isAuditioning ? 'Previewing...' : 'Preview Clip'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close warp processor"
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
          {/* Target: the clip this tool will actually change. */}
          <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e]">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white font-bold uppercase tracking-wider">TARGET CLIP</span>
              {targetClip ? (
                <span className="text-[10px] font-mono text-[#00ff88]">
                  {targetClip.name} · bar {targetClip.startBar} · {targetClip.lengthBars} bar{targetClip.lengthBars === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="text-[10px] font-mono text-[#ffaa00]">NOTHING SELECTED</span>
              )}
            </div>
          </div>

          {!targetClip && (
            <div className="bg-[#0a0a0c] border border-[#ffaa00]/40 rounded-xl px-4 py-3">
              <span className="text-[11px] font-mono font-bold text-[#ffaa00] uppercase tracking-wider block mb-1">
                NO AUDIO CLIP TO WARP
              </span>
              <span className="text-[11px] text-[#888]">{blocker}</span>
            </div>
          )}

          {/* What is and is not implemented. */}
          <div className="bg-[#0a0a0c] border border-[#ffaa00]/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono font-bold text-[#ffaa00] uppercase tracking-wider">
              PITCH AND RATE ONLY — LENGTH IS NOT PRESERVED
            </span>
            <span className="text-[10px] text-[#777] whitespace-nowrap">NO LENGTH-PRESERVING STRETCH</span>
          </div>

          {/* Implemented controls */}
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white uppercase">PITCH &amp; SPEED (APPLIED TO THIS CLIP)</span>
              <span className="text-[10px] font-mono text-[#00ff88]">{WARP_BEHAVIOUR_SUMMARY}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
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
                  disabled={!targetClip}
                  onChange={(e) => setPitchSemitones(Number(e.target.value))}
                  className="w-full accent-[#00ff88] disabled:opacity-40"
                />
                <span className="text-[9px] text-[#666] block">Detunes the clip without changing its length.</span>
              </div>

              {/* Stretch Rate */}
              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">PLAYBACK RATE</span>
                  <span className="text-[#00e5ff] font-mono font-bold">{stretchRate.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.25"
                  max="3.0"
                  step="0.05"
                  value={stretchRate}
                  disabled={!targetClip}
                  onChange={(e) => setStretchRate(Number(e.target.value))}
                  className="w-full accent-[#00e5ff] disabled:opacity-40"
                />
                <span className="text-[9px] text-[#666] block">
                  Speeds the clip up or slows it down. Pitch rides with the rate: slower is lower.
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">
            Applies to live playback and WAV export
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#25252a] hover:bg-[#333338] text-white rounded font-bold transition"
            >
              Cancel
            </button>
            <button
              onClick={handleApplyWarp}
              disabled={!targetClip}
              className="px-4 py-1.5 bg-[#00ff88] hover:bg-[#33ff9f] disabled:opacity-40 disabled:hover:bg-[#00ff88] text-black font-bold rounded transition shadow flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Apply to Clip</span>
            </button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
};
