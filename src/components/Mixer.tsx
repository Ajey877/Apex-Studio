import React, { useState, useEffect, useRef } from 'react';
import { 
  Sliders, 
  Volume2, 
  Plus, 
  Activity, 
  Power, 
  Trash2, 
  Disc, 
  Layers, 
  Sparkles,
  Zap
} from 'lucide-react';
import { MixerTrack, FxSlot, FxType } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { MixerRoutingGraph } from '../audio/mixerRouting';
import { FxParameterControls } from './fxParameterControls';

export const applyMixerRoutingSelection = (
  tracks: MixerTrack[],
  trackId: number,
  targetId: number,
  onUpdateTrack: (trackId: number, updates: Partial<MixerTrack>) => void
): boolean => {
  const graph = new MixerRoutingGraph();
  for (const track of tracks) {
    if (track.id === 0 || track.id === trackId) continue;
    const result = graph.setRoute(track.id, track.routingTargetId ?? 0);
    if (!result.valid) return false;
  }

  const validation = graph.setRoute(trackId, targetId);
  if (!validation.valid) return false;

  onUpdateTrack(trackId, { routingTargetId: targetId });
  return true;
};

export const applyAuxSendSelection = (
  tracks: MixerTrack[],
  sourceId: number,
  nextAuxSends: Array<{ targetId: number; amount: number }>,
  onUpdateTrack: (trackId: number, updates: Partial<MixerTrack>) => void
): boolean => {
  if (nextAuxSends.length > 2) return false;
  const validIds = new Set(tracks.map(t => t.id));
  const seen = new Set<number>();
  for (const s of nextAuxSends) {
    if (!Number.isInteger(s.targetId) || s.targetId === sourceId || s.targetId === 0) return false;
    if (!validIds.has(s.targetId)) return false;
    if (seen.has(s.targetId)) return false;
    seen.add(s.targetId);
    if (typeof s.amount !== 'number' || !Number.isFinite(s.amount) || s.amount < 0 || s.amount > 1) return false;
  }
  // Cycle check: aux edges + bus routes must be acyclic
  const graph = new MixerRoutingGraph();
  for (const track of tracks) {
    if (track.id === 0) continue;
    const r = graph.setRoute(track.id, track.routingTargetId ?? 0);
    if (!r.valid) return false;
  }
  // Build adjacency including aux
  const adj = new Map<number, Set<number>>();
  for (const t of tracks) {
    if (t.id === 0) continue;
    const rt = t.routingTargetId ?? 0;
    if (rt !== 0) {
      if (!adj.has(t.id)) adj.set(t.id, new Set());
      adj.get(t.id)!.add(rt);
    }
    const sends = t.id === sourceId ? nextAuxSends : (t.auxSends ?? []);
    for (const s of sends) {
      if (s.targetId === 0 || s.targetId === t.id) continue;
      if (!adj.has(t.id)) adj.set(t.id, new Set());
      adj.get(t.id)!.add(s.targetId);
    }
  }
  const visited = new Set<number>();
  const stack = new Set<number>();
  const dfs = (node: number): boolean => {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    const neigh = adj.get(node);
    if (neigh) for (const n of neigh) { if (n===0) continue; if (dfs(n)) return true; }
    stack.delete(node);
    return false;
  };
  for (const id of adj.keys()) if (dfs(id)) return false;

  onUpdateTrack(sourceId, { auxSends: nextAuxSends.length === 0 ? undefined : nextAuxSends });
  return true;
};

interface MixerProps {
  tracks: MixerTrack[];
  selectedTrackId: number;
  onSelectTrack: (trackId: number) => void;
  onUpdateTrack: (trackId: number, updates: Partial<MixerTrack>) => void;
  onAddFxSlot: (trackId: number, type: FxType) => void;
  onDeleteFxSlot: (trackId: number, slotId: string) => void;
  onUpdateFxSlot: (trackId: number, slotId: string, updates: Partial<FxSlot>) => void;
  isPlaying: boolean;
  onOpenParametricEq?: (track: MixerTrack) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
  onCreateAuxReturn?: () => void;
}

/**
 * Peak-meter level for one mixer strip.
 *
 * `audioEngine.getMixerTrackPeak` reads the channel analyser, which is wired
 * after the channel's own gain node - so the reading already contains the
 * fader's effect. The previous code multiplied by `track.volume` again, which
 * displayed a track at 0.5 as another 6 dB quieter than the audio actually is
 * (and `Math.min` then hid the error at the top of the scale). A meter must
 * show what its tap measured, so the scaling factor is simply the tap.
 */
export const computeMixerMeterLevel = (rawPeak: number, isPlaying: boolean): number => {
  if (!isPlaying) return 0;
  if (!Number.isFinite(rawPeak) || rawPeak <= 0) return 0;
  return Math.min(1.0, rawPeak);
};

export const Mixer: React.FC<MixerProps> = ({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onUpdateTrack,
  onAddFxSlot,
  onDeleteFxSlot,
  onUpdateFxSlot,
  isPlaying,
  onOpenParametricEq,
  onInteractionStart,
  onInteractionEnd,
  onCreateAuxReturn
}) => {
  const [showAddFxMenu, setShowAddFxMenu] = useState(false);
  const [trackPeaks, setTrackPeaks] = useState<number[]>(Array(tracks.length).fill(0));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const masterFaderCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const selectedTrack = tracks.find(t => t.id === selectedTrackId) || tracks[0];

  const handleRoutingChange = (trackId: number, targetId: number) => {
    if (!applyMixerRoutingSelection(tracks, trackId, targetId, onUpdateTrack)) return;

    const target = tracks.find(t => t.id === trackId);
    if (target) {
      audioEngine.updateMixerTrack({ ...target, routingTargetId: targetId });
    }
  };

  const handleAuxSendAmountChange = (trackId: number, index: number, amount: number) => {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const base = track.auxSends ? [...track.auxSends] : [];
    // Ensure we have entries up to index
    while (base.length <= index) {
      // For placeholder, pick first available return as target if possible
      const candidateTargets = tracks.filter(t => t.id !== trackId && t.id !== 0).map(t => t.id);
      const used = new Set(base.map(s => s.targetId));
      const free = candidateTargets.find(id => !used.has(id));
      if (free === undefined) return;
      base.push({ targetId: free, amount: 0 });
    }
    const clamped = Math.max(0, Math.min(1, amount));
    base[index] = { ...base[index], amount: clamped };
    if (!applyAuxSendSelection(tracks, trackId, base, onUpdateTrack)) return;
    const updated = tracks.find(t => t.id === trackId);
    // Apply live gain
    const liveTrack = { ...(updated ?? track), auxSends: base } as typeof track;
    audioEngine.updateMixerTrack(liveTrack);
    // Also sync aux gain directly if engine already has channel
    try { (audioEngine as unknown as { syncAuxSendsForTrack?: (t: unknown) => void }).syncAuxSendsForTrack?.(liveTrack); } catch (_) {}
  };

  const handleAuxSendTargetChange = (trackId: number, index: number, targetId: number) => {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const base = track.auxSends ? [...track.auxSends] : [];
    while (base.length <= index) {
      base.push({ targetId, amount: 0 });
      if (!applyAuxSendSelection(tracks, trackId, base, onUpdateTrack)) return;
      const updated = { ...(tracks.find(t => t.id === trackId) ?? track), auxSends: base } as typeof track;
      audioEngine.updateMixerTrack(updated);
      return;
    }
    base[index] = { ...base[index], targetId };
    if (!applyAuxSendSelection(tracks, trackId, base, onUpdateTrack)) return;
    const updated = { ...(tracks.find(t => t.id === trackId) ?? track), auxSends: base } as typeof track;
    audioEngine.updateMixerTrack(updated);
    try { (audioEngine as unknown as { syncAuxSendsForTrack?: (t: unknown) => void }).syncAuxSendsForTrack?.(updated); } catch (_) {}
  };

  const handleAddAuxSend = (trackId: number) => {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const base = track.auxSends ? [...track.auxSends] : [];
    if (base.length >= 2) return;
    const candidateTargets = tracks.filter(t => t.id !== trackId && t.id !== 0).map(t => t.id);
    const used = new Set(base.map(s => s.targetId));
    let free = candidateTargets.find(id => !used.has(id));
    if (free === undefined) {
      if (onCreateAuxReturn) {
        onCreateAuxReturn();
        return;
      }
      return;
    }
    base.push({ targetId: free, amount: 0.5 });
    if (!applyAuxSendSelection(tracks, trackId, base, onUpdateTrack)) return;
    const updated = { ...(tracks.find(t => t.id === trackId) ?? track), auxSends: base } as typeof track;
    audioEngine.updateMixerTrack(updated);
  };

  const handleRemoveAuxSend = (trackId: number, index: number) => {
    const track = tracks.find(t => t.id === trackId);
    if (!track || !track.auxSends) return;
    const base = track.auxSends.filter((_, i) => i !== index);
    applyAuxSendSelection(tracks, trackId, base, onUpdateTrack);
    const updated = { ...(tracks.find(t => t.id === trackId) ?? track), auxSends: base.length === 0 ? undefined : base } as typeof track;
    audioEngine.updateMixerTrack(updated);
    // Cleanup gain
    try {
      const ch = (audioEngine as unknown as { mixerChannels?: Map<number, { auxSendGains?: Map<number, unknown> }> }).mixerChannels?.get(trackId);
      // gain cleanup handled by sync
      (audioEngine as unknown as { syncAuxSendsForTrack?: (t: unknown) => void }).syncAuxSendsForTrack?.(updated);
    } catch (_) {}
  };

  // Spectrum Visualizer & Peak Meter Animation loop
  useEffect(() => {
    let animId: number;
    const freqData = new Uint8Array(128);

    const updateVisuals = () => {
      // 1. Peak levels for each track
      // Post-fader tap, no second copy of the fader gain (see computeMixerMeterLevel).
      const peaks = tracks.map(t => computeMixerMeterLevel(audioEngine.getMixerTrackPeak(t.id), isPlaying));
      setTrackPeaks(peaks);

      // 2. Master Spectrum Analyzer (Top Bar)
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          audioEngine.getMasterFrequencyData(freqData);
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const barWidth = (canvas.width / 64) - 1;
          for (let i = 0; i < 64; i++) {
            const val = freqData[i] || 0;
            const barHeight = (val / 255) * canvas.height;

            const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
            grad.addColorStop(0, '#00ff00');
            grad.addColorStop(0.6, '#ff6e00');
            grad.addColorStop(1, '#ff0000');

            ctx.fillStyle = grad;
            ctx.fillRect(i * (barWidth + 1), canvas.height - barHeight, barWidth, barHeight);
          }
        }
      }

      // 3. Master Fader Real-Time Spectrum Backdrop
      if (masterFaderCanvasRef.current) {
        const faderCanvas = masterFaderCanvasRef.current;
        const faderCtx = faderCanvas.getContext('2d');
        if (faderCtx) {
          faderCtx.clearRect(0, 0, faderCanvas.width, faderCanvas.height);
          const barCount = 16;
          const barW = faderCanvas.width / barCount;
          for (let i = 0; i < barCount; i++) {
            const val = isPlaying ? (freqData[i * 4] || 0) : 0;
            const barH = (val / 255) * faderCanvas.height;
            faderCtx.fillStyle = 'rgba(0, 255, 136, 0.25)';
            faderCtx.fillRect(i * barW, faderCanvas.height - barH, barW - 1, barH);
          }
        }
      }

      animId = requestAnimationFrame(updateVisuals);
    };

    animId = requestAnimationFrame(updateVisuals);
    return () => cancelAnimationFrame(animId);
  }, [tracks, isPlaying]);

  const handleVolumeChange = (trackId: number, val: number) => {
    onUpdateTrack(trackId, { volume: val });
    const target = tracks.find(t => t.id === trackId);
    if (target) {
      audioEngine.updateMixerTrack({ ...target, volume: val });
    }
  };

  const handlePanChange = (trackId: number, val: number) => {
    onUpdateTrack(trackId, { pan: val });
    const target = tracks.find(t => t.id === trackId);
    if (target) {
      audioEngine.updateMixerTrack({ ...target, pan: val });
    }
  };

  return (
    <div id="fl-mixer-console" className="flex flex-col h-full bg-[#0a0a0b] select-none text-[#b0b0b0]">
      {/* Top Header with Master Spectrum Analyzer */}
      <div className="h-9 bg-[#1e1e20] border-b border-[#333336] flex items-center justify-between px-4 shrink-0 gap-4">
        <div className="flex items-center gap-2">
          <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span className="text-[10px] text-white font-bold uppercase tracking-wider">STUDIO MIXING CONSOLE & FX INSERT ROUTING</span>
        </div>

        {/* Master Real-time FFT Visualizer */}
        <div className="flex items-center gap-2 bg-[#121214] px-2.5 py-0.5 rounded border border-[#333336]">
          <span className="text-[9px] font-mono text-[#777]">MASTER FFT</span>
          <canvas
            ref={canvasRef}
            width={180}
            height={20}
            className="rounded bg-[#0a0a0b]"
          />
        </div>
      </div>

      {/* Main Console Split: Left Channel Strips | Right FX Rack */}
      <div className="flex-1 flex overflow-hidden bg-[#1a1a1d] p-3 gap-2">
        {/* Left: Mixer Channel Faders Strip (Scrollable) */}
        <div className="flex-1 flex overflow-x-auto custom-scrollbar gap-1.5 pb-2">
          {tracks.map((track, idx) => {
            const isSelected = track.id === selectedTrackId;
            const peak = trackPeaks[idx] || 0;
            const isMaster = track.id === 0;

            return (
              <div
                key={track.id}
                id={`mixer-strip-${track.id}`}
                onClick={() => onSelectTrack(track.id)}
                className={`w-20 sm:w-24 flex-shrink-0 flex flex-col justify-between py-2 px-1.5 rounded border transition-all cursor-pointer ${
                  isSelected 
                    ? 'bg-[#222225] border-[#ff6e00] border-t-2 shadow-lg' 
                    : isMaster 
                      ? 'bg-[#18181b] border-[#333336]' 
                      : 'bg-[#222225] border-[#333336] hover:border-[#555]'
                }`}
              >
                {/* Channel Header (Name & Mute) */}
                <div className="flex flex-col items-center gap-1">
                  <div className="w-full flex items-center justify-between px-1">
                    <span className={`text-[9px] font-bold font-mono ${isSelected ? 'text-[#ff6e00]' : 'text-[#777]'}`}>
                      {isMaster ? 'MST' : `INS ${track.id}`}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateTrack(track.id, { mute: !track.mute });
                      }}
                      className={`w-2.5 h-2.5 rounded-full border ${
                        !track.mute ? 'bg-[#00ff00] border-[#00ff00]' : 'bg-[#333336] border-[#444]'
                      }`}
                      title={track.mute ? 'Unmute' : 'Mute'}
                    />
                  </div>

                  <span 
                    className="text-[11px] font-bold truncate max-w-full px-1 text-white"
                    style={{ color: isSelected ? '#ff6e00' : track.color || '#fff' }}
                  >
                    {track.name}
                  </span>
                </div>

                {/* Pan Mini Slider */}
                <div className="flex flex-col items-center gap-0.5 my-1.5 px-1">
                  <div className="flex items-center justify-between w-full text-[8px] text-[#777]">
                    <span>PAN</span>
                    <span className="font-mono">{Math.round(track.pan * 100)}</span>
                  </div>
                  <input
                    type="range"
                    min="-1"
                    max="1"
                    step="0.05"
                    value={track.pan}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={() => onInteractionStart?.('Change mixer pan')}
                    onPointerUp={() => onInteractionEnd?.('Change mixer pan')}
                    onChange={(e) => handlePanChange(track.id, parseFloat(e.target.value))}
                    className="w-full h-1 accent-[#777] bg-[#121214] rounded cursor-pointer"
                  />
                </div>

                {/* Vertical Fader & Peak Meter Pair */}
                <div className="flex-1 flex items-center justify-center gap-2 my-2 min-h-[140px]">
                  {/* VU Peak Meter */}
                  <div className="w-2 h-full bg-[#121214] rounded-full p-0.5 flex flex-col justify-end overflow-hidden border border-[#333336]">
                    <div 
                      className="w-full rounded-full transition-all duration-75"
                      style={{
                        height: `${Math.min(100, peak * 100)}%`,
                        background: 'linear-gradient(to top, #00ff00 60%, #ff6e00 85%, #ff0000 100%)'
                      }}
                    />
                  </div>

                  {/* Fader Slider with Master FFT spectrum backdrop */}
                  <div className="relative h-full flex items-center justify-center">
                    {isMaster && (
                      <canvas
                        ref={masterFaderCanvasRef}
                        width={28}
                        height={120}
                        className="absolute inset-0 w-full h-full pointer-events-none opacity-80 rounded"
                      />
                    )}
                    <input
                      type="range"
                      min="0"
                      max="1.25"
                      step="0.01"
                      value={track.volume}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={() => onInteractionStart?.('Change mixer volume')}
                      onPointerUp={() => onInteractionEnd?.('Change mixer volume')}
                      onChange={(e) => handleVolumeChange(track.id, parseFloat(e.target.value))}
                      className="relative z-10 h-28 sm:h-32 w-1.5 accent-[#ff6e00] bg-[#121214] rounded cursor-pointer"
                      style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                    />
                  </div>
                </div>

                {/* dB Readout */}
                <div className="text-center font-mono text-[9px] text-[#777] bg-[#121214] py-0.5 rounded border border-[#333336]">
                  {track.volume > 0.05 ? `${(20 * Math.log10(track.volume)).toFixed(1)} dB` : '-INF'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right: Studio FX Rack Inspector */}
        <div className="w-56 sm:w-64 border border-[#333336] rounded bg-[#121214] flex flex-col shrink-0">
          <div className="p-2 text-[10px] font-bold border-b border-[#333336] flex items-center justify-between text-white bg-[#1a1a1d]">
            <span className="uppercase tracking-wider">FX SLOTS ({selectedTrack.name.toUpperCase()})</span>
            <div className="flex items-center gap-1">
              {onOpenParametricEq && (
                <button
                  onClick={() => onOpenParametricEq(selectedTrack)}
                  className="px-1.5 py-0.5 bg-[#00bcd4]/15 hover:bg-[#00bcd4]/30 text-[#00bcd4] rounded text-[9px] font-mono border border-[#00bcd4]/30 transition"
                  title="Open 3-Band EQ Interface"
                >
                  EQ
                </button>
              )}
              <button
                onClick={() => setShowAddFxMenu(!showAddFxMenu)}
                className="p-1 text-[#ff6e00] hover:text-white rounded hover:bg-[#2d2d30] transition"
                title="Add Effect Plugin"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Add FX dropdown */}
          {showAddFxMenu && (
            <div className="bg-[#1e1e20] border-b border-[#333336] p-2 space-y-1 text-xs">
              <div className="text-[9px] font-bold text-[#777] uppercase">Choose Effect Plugin</div>
              <div className="grid grid-cols-2 gap-1 pt-1">
                {[
                  { id: 'equalizer', name: '3-Band EQ' },
                  { id: 'tape_saturation', name: 'Tape Saturation' },
                  { id: 'reverb', name: 'Studio Reverb' },
                  { id: 'delay', name: 'Tape Delay' },
                  { id: 'distortion', name: 'Fast Distortion' },
                  { id: 'compressor', name: 'Studio Compressor' },
                  { id: 'chorus', name: 'Stereo Chorus' },
                  { id: 'bitcrusher', name: 'Bitcrusher' },
                  { id: 'limiter', name: 'Transparent Limiter' }
                ].map((fx) => (
                  <button
                    key={fx.id}
                    onClick={() => {
                      onAddFxSlot(selectedTrack.id, fx.id as FxType);
                      setShowAddFxMenu(false);
                    }}
                    className="p-1.5 bg-[#141416] hover:bg-[#ff6e00] hover:text-black rounded text-[10px] text-left font-medium transition truncate"
                  >
                    {fx.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* FX Slots List */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
            {/* Dynamic Sidechain Routing Header for Inserts (Track 1+) */}
            {selectedTrack.id > 0 && (
              <div className="bg-[#18181b] border border-[#2e2e32] rounded p-2 text-[10px] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1">
                    <Zap className="w-3 h-3 text-[#ff6e00]" />
                    <span>DYNAMIC SIDECHAIN DUCK</span>
                  </span>
                  <button
                    onClick={() => {
                      const cur = selectedTrack.sidechain?.enabled;
                      // Phase 79: only emit the sidechain fields the engine
                      // actually consumes (enabled/source/amount/attack/release).
                      // threshold / lowFreqOnly / highPassFilterHz were UI-only
                      // and were never wired to DSP — they are stripped.
                      const newSidechain = {
                        enabled: !cur,
                        sourceTrackId: selectedTrack.sidechain?.sourceTrackId ?? 1,
                        amount: selectedTrack.sidechain?.amount ?? 0.75,
                        attackMs: selectedTrack.sidechain?.attackMs ?? 5,
                        releaseMs: selectedTrack.sidechain?.releaseMs ?? 140,
                      };
                      onUpdateTrack(selectedTrack.id, { sidechain: newSidechain });
                      audioEngine.updateMixerTrack({ ...selectedTrack, sidechain: newSidechain });
                    }}
                    className={`px-1.5 py-0.5 rounded font-bold text-[9px] transition ${
                      selectedTrack.sidechain?.enabled
                        ? 'bg-[#ff6e00] text-black'
                        : 'bg-[#222225] text-[#777] hover:text-white'
                    }`}
                  >
                    {selectedTrack.sidechain?.enabled ? 'ACTIVE' : 'OFF'}
                  </button>
                </div>

                {selectedTrack.sidechain?.enabled && (
                  <div className="space-y-1.5 pt-1 border-t border-[#262629]">
                    <div className="flex items-center justify-between text-[#888]">
                      <span>TRIGGER SOURCE</span>
                      <select
                        value={selectedTrack.sidechain.sourceTrackId}
                        onChange={(e) => {
                          const srcId = parseInt(e.target.value);
                          const sc = { ...selectedTrack.sidechain!, sourceTrackId: srcId };
                          onUpdateTrack(selectedTrack.id, { sidechain: sc });
                          audioEngine.updateMixerTrack({ ...selectedTrack, sidechain: sc });
                        }}
                        className="bg-[#121214] text-white text-[9px] px-1.5 py-0.5 rounded border border-[#333336]"
                      >
                        {tracks.filter(t => t.id !== selectedTrack.id && t.id > 0).map(t => (
                          <option key={t.id} value={t.id}>
                            Track {t.id}: {t.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center justify-between text-[#888]">
                      <span>DUCK DEPTH</span>
                      <input
                        type="range"
                        min="0.1"
                        max="1.0"
                        step="0.05"
                        value={selectedTrack.sidechain.amount}
                        onPointerDown={() => onInteractionStart?.('Update sidechain')}
                        onPointerUp={() => onInteractionEnd?.('Update sidechain')}
                        onChange={(e) => {
                          const amt = parseFloat(e.target.value);
                          const sc = { ...selectedTrack.sidechain!, amount: amt };
                          onUpdateTrack(selectedTrack.id, { sidechain: sc });
                          audioEngine.updateMixerTrack({ ...selectedTrack, sidechain: sc });
                        }}
                        className="w-20 h-1 accent-[#ff6e00] bg-[#121214] rounded"
                      />
                      <span className="font-mono text-[#ff6e00] text-[9px]">{Math.round(selectedTrack.sidechain.amount * 100)}%</span>
                    </div>

                    <div className="text-[9px] text-[#666] italic pt-0.5">
                      Note-triggered envelope — no level detector.
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Phase 88: Post-Fader Aux Sends (≤2, no pre/post, no pan) */}
            {selectedTrack.id !== 0 && (
              <div className="bg-[#18181b] border border-[#2e2e32] rounded p-2 text-[10px] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1">
                    <span className="w-2 h-2 bg-[#7e57c2] rounded-full" />
                    <span>AUX SENDS (POST-FADER)</span>
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[8px] text-[#777]">{(selectedTrack.auxSends?.length ?? 0)}/2</span>
                    {onCreateAuxReturn && (
                      <button
                        onClick={onCreateAuxReturn}
                        className="px-1 py-0.5 bg-[#7e57c2]/15 hover:bg-[#7e57c2]/30 text-[#7e57c2] rounded text-[7px] font-bold border border-[#7e57c2]/30 transition"
                        title="Create new aux return track"
                      >
                        + RETURN
                      </button>
                    )}
                  </div>
                </div>

                {(selectedTrack.auxSends ?? []).map((send, idx) => (
                  <div key={idx} className="bg-[#222225] rounded p-1.5 flex flex-col gap-1.5 border border-[#2a2a2e]">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-bold text-[#aaa]">SEND {idx + 1}</span>
                      <button
                        onClick={() => handleRemoveAuxSend(selectedTrack.id, idx)}
                        className="text-[#777] hover:text-red-400 text-[10px] leading-none"
                        title="Remove send"
                      >
                        ×
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[#888]">RETURN</span>
                      <select
                        value={send.targetId}
                        onChange={(e) => handleAuxSendTargetChange(selectedTrack.id, idx, parseInt(e.target.value, 10))}
                        className="bg-[#121214] text-white text-[9px] px-1.5 py-0.5 rounded border border-[#333336] min-w-[110px]"
                      >
                        {tracks.filter(t => t.id !== selectedTrack.id && t.id !== 0).map(t => (
                          <option key={t.id} value={t.id}>
                            {t.isAux ? '↳ ' : ''}{t.id}: {t.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-1 text-[#888]">
                      <span>AMOUNT</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={send.amount}
                        onPointerDown={() => onInteractionStart?.('Change aux send')}
                        onPointerUp={() => onInteractionEnd?.('Change aux send')}
                        onChange={(e) => handleAuxSendAmountChange(selectedTrack.id, idx, parseFloat(e.target.value))}
                        className="w-20 h-1 accent-[#7e57c2] bg-[#121214] rounded"
                      />
                      <span className="font-mono text-[#7e57c2] text-[9px] min-w-[28px] text-right">{Math.round(send.amount * 100)}%</span>
                    </div>
                  </div>
                ))}

                {(selectedTrack.auxSends?.length ?? 0) < 2 && (
                  <button
                    onClick={() => handleAddAuxSend(selectedTrack.id)}
                    className="w-full py-1 text-[9px] font-bold rounded border border-dashed border-[#333336] hover:border-[#7e57c2]/50 text-[#777] hover:text-[#7e57c2] transition"
                  >
                    + Add Post-Fader Send
                  </button>
                )}

                {(selectedTrack.auxSends?.length ?? 0) === 0 && (
                  <div className="text-[9px] text-[#666] italic">No sends. Post-fader sends feed the Return track&apos;s FX → Master.</div>
                )}
              </div>
            )}

            {selectedTrack.fxSlots.length === 0 ? (
              <div className="text-center py-6 text-xs text-[#777]">
                No effect plugins loaded. Click + to insert Tape Saturation, EQ 2, or Delay.
              </div>
            ) : (
              selectedTrack.fxSlots.map((slot, idx) => (
                <div
                  key={slot.id}
                  className={`bg-[#222225] px-2 py-2 rounded text-[11px] flex flex-col gap-1.5 border-l-2 transition ${
                    slot.enabled ? 'border-[#ff6e00]' : 'border-[#444] opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between text-white">
                    <div className="flex items-center gap-1.5 font-bold text-xs truncate">
                      <button
                        onClick={() => onUpdateFxSlot(selectedTrack.id, slot.id, { enabled: !slot.enabled })}
                        className={`text-xs ${slot.enabled ? 'text-[#ff6e00]' : 'text-[#777]'}`}
                      >
                        ●
                      </button>
                      <span className="truncate">{slot.name}</span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onDeleteFxSlot(selectedTrack.id, slot.id)}
                        className="text-[#777] hover:text-red-400 p-0.5"
                        title="Remove FX"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Wet/Dry Mix + per-slot parameter controls. The mix
                      slider is duplicated inside the controls panel for
                      layout symmetry; the contract is the same
                      `onUpdateFxSlot({ mix: … })` call. Phase 80 wires
                      the in-contract params (EQ bands, compressor
                      threshold/ratio/attack/release/knee, delay time +
                      feedback, limiter ceiling/release/drive) to the
                      live AudioParams via the live-bridge registry. */}
                  <FxParameterControls
                    slot={slot}
                    trackId={selectedTrack.id}
                    onUpdateFxSlot={onUpdateFxSlot}
                    onInteractionStart={onInteractionStart}
                    onInteractionEnd={onInteractionEnd}
                  />
                </div>
              ))
            )}

            {/* Empty Slot Placeholder */}
            <div 
              onClick={() => setShowAddFxMenu(true)}
              className="border border-dashed border-[#333336] hover:border-[#ff6e00]/50 h-8 rounded mt-2 flex items-center justify-center cursor-pointer text-[10px] text-[#555] hover:text-[#ff6e00] transition"
            >
              + Add Next Effect Slot
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
