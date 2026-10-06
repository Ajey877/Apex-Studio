import React, { useState, useEffect } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Sliders, 
  Radio, 
  X, 
  Zap, 
  Trash2, 
  Plus, 
  Check, 
  Sparkles, 
  RotateCcw, 
  Smartphone, 
  Activity,
  Cpu,
  Keyboard
} from 'lucide-react';
import { MidiMapping, Channel, MixerTrack, MidiDeviceInfo } from '../types/daw';
import { audioEngine, type MidiEventPayload } from '../audio/audioEngine';
import { buildFxSlotParameterMapping, createMidiMappingForCc, resolveMidiLearnCapture, type MidiLearnTarget } from '../audio/midiMappingRuntime';
import { formatFxParameterRange, listFxParameterOptions, listFxSlotOptions } from '../audio/fxParameterControl';

export const isChannelScopedMidiTarget = (targetType: MidiMapping['targetType']): boolean =>
  targetType === 'channel_vol' || targetType === 'channel_pan' || targetType === 'fx_param';

/**
 * Phase 81: the target-control dropdown offers one entry that is not itself a
 * persisted `MidiMapping.targetType`. `"fx_slot_param"` is the UI mode for
 * "bind a contract parameter on an insert FX slot"; it publishes as
 * `targetType: 'fx_param'` with the composite `"<trackId>/<slotId>"` target id
 * and the contract param id as `paramName`. The pre-existing `"fx_param"`
 * entry (channel filter cutoff) is untouched.
 */
export const FX_SLOT_PARAM_UI_TARGET = 'fx_slot_param' as const;

export type MidiLearnUiTarget = MidiMapping['targetType'] | typeof FX_SLOT_PARAM_UI_TARGET;

export const isFxSlotParamUiTarget = (
  targetType: MidiLearnUiTarget,
): targetType is typeof FX_SLOT_PARAM_UI_TARGET => targetType === FX_SLOT_PARAM_UI_TARGET;

/**
 * The first FX slot parameter the project can actually bind, or `null` when the
 * project has no FX slot with a contract parameter. Used to seed the slot and
 * parameter selectors so the form never starts in an unbindable state.
 */
export const defaultFxSlotParameterSelection = (
  mixerTracks: readonly MixerTrack[],
): { slotTargetId: string; paramId: string } | null => {
  const first = listFxParameterOptions(mixerTracks)[0];
  return first ? { slotTargetId: first.targetId, paramId: first.paramId } : null;
};

export const normalizeMidiLearnTargetSelection = (
  targetType: MidiMapping['targetType'],
  currentTargetId: string | number,
  channels: readonly Channel[],
  mixerTracks: readonly MixerTrack[],
): { targetId: string | number; paramName?: string } => {
  if (targetType === 'master_vol') {
    return { targetId: 0 };
  }

  if (isChannelScopedMidiTarget(targetType)) {
    const matched = channels.find(c => c.id === String(currentTargetId));
    const targetId = matched ? matched.id : (channels[0]?.id ?? 'ch-1');
    return targetType === 'fx_param'
      ? { targetId, paramName: 'filterCutoff' }
      : { targetId };
  }

  const matchedTrack = mixerTracks.find(t => String(t.id) === String(currentTargetId));
  const targetId = matchedTrack ? matchedTrack.id : (mixerTracks[0]?.id ?? 0);
  return { targetId };
};

export const buildMidiLearnMapping = (
  ccNumber: number,
  targetType: MidiMapping['targetType'],
  currentTargetId: string | number,
  channels: readonly Channel[],
  mixerTracks: readonly MixerTrack[],
): MidiMapping => {
  const normalized = normalizeMidiLearnTargetSelection(targetType, currentTargetId, channels, mixerTracks);
  return createMidiMappingForCc(ccNumber, targetType, normalized.targetId, normalized.paramName);
};

interface MidiLearnModalProps {
  isOpen: boolean;
  onClose: () => void;
  midiMappings: MidiMapping[];
  onUpdateMidiMappings: (mappings: MidiMapping[]) => void;
  channels: Channel[];
  mixerTracks: MixerTrack[];
  connectedDevices?: MidiDeviceInfo[];
  isMidiLearnActive: boolean;
  onToggleMidiLearn: (active: boolean) => void;
}

export const MidiLearnModal: React.FC<MidiLearnModalProps> = ({
  isOpen,
  onClose,
  midiMappings,
  onUpdateMidiMappings,
  channels,
  mixerTracks,
  connectedDevices = [],
  isMidiLearnActive,
  onToggleMidiLearn
}) => {
  const [selectedTargetType, setSelectedTargetType] = useState<MidiLearnUiTarget>('master_vol');
  const [selectedTargetId, setSelectedTargetId] = useState<string | number>(0);
  const [manualCc, setManualCc] = useState<number>(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  /** Phase 81: composite `"<trackId>/<slotId>"` id + contract param id for the FX slot binder. */
  const [fxSlotTargetId, setFxSlotTargetId] = useState<string>('');
  const [fxParamId, setFxParamId] = useState<string>('');

  const fxSlotOptions = listFxSlotOptions(mixerTracks);
  const allFxParamOptions = listFxParameterOptions(mixerTracks);
  const fxParamOptions = allFxParamOptions.filter(option => option.targetId === fxSlotTargetId);
  const fxSlotExists = fxSlotOptions.some(option => option.targetId === fxSlotTargetId);
  const fxParamExists = fxParamOptions.some(option => option.paramId === fxParamId);
  /**
   * The selection the form falls back to when the current one is unbindable:
   * the picked slot's first contract parameter when the slot still exists,
   * otherwise the project's first bindable FX parameter.
   */
  const fxFallback = fxSlotExists
    ? fxParamOptions[0]
    : allFxParamOptions.find(option => option.targetId === fxSlotTargetId) ?? allFxParamOptions[0];
  const fxFallbackSlotTargetId = fxFallback?.targetId ?? '';
  const fxFallbackParamId = fxFallback?.paramId ?? '';

  /**
   * Keeps the FX slot selection valid: it seeds the pickers the first time the
   * user chooses the FX slot binder, and re-seeds when the picked slot no
   * longer exists (an effect was deleted while the modal was open) so the form
   * can never publish a binding for a slot that is gone. The dependency list is
   * all primitives, so a re-render that changes nothing re-runs nothing.
   */
  useEffect(() => {
    if (!isFxSlotParamUiTarget(selectedTargetType)) return;
    if (fxSlotExists && fxParamExists) return;
    setFxSlotTargetId(fxFallbackSlotTargetId);
    setFxParamId(fxFallbackParamId);
  }, [fxFallbackParamId, fxFallbackSlotTargetId, fxParamExists, fxSlotExists, fxParamId, fxSlotTargetId, selectedTargetType]);

  const handleAddMapping = () => {
    const exists = midiMappings.some(m => m.ccNumber === manualCc);
    if (exists) {
      setStatusMessage(`CC #${manualCc} is already bound. Overwriting...`);
    }

    const newMapping: MidiMapping | null = isFxSlotParamUiTarget(selectedTargetType)
      ? buildFxSlotParameterMapping(manualCc, mixerTracks, fxSlotTargetId, fxParamId)
      : buildMidiLearnMapping(
          manualCc,
          selectedTargetType,
          selectedTargetId,
          channels,
          mixerTracks,
        );

    if (!newMapping) {
      setStatusMessage('That FX slot has no contract parameter to bind.');
      setTimeout(() => setStatusMessage(null), 3000);
      return;
    }

    const filtered = midiMappings.filter(m => m.ccNumber !== manualCc);
    onUpdateMidiMappings([...filtered, newMapping]);
    setStatusMessage(`Bound MIDI CC #${manualCc} to ${newMapping.paramName}!`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleDelete = (cc: number) => {
    onUpdateMidiMappings(midiMappings.filter(m => m.ccNumber !== cc));
  };

  const handleClearAll = () => {
    onUpdateMidiMappings([]);
    setStatusMessage('Cleared all MIDI CC mappings.');
    setTimeout(() => setStatusMessage(null), 3000);
  };

  /**
   * MIDI Learn is armed by the header button; this connects that state to the
   * engine's existing MIDI event stream. The first incoming CC is captured,
   * bound to the selected target, stored through the project mutation path and
   * then actually controls the target through the runtime mapping bridge.
   */
  useEffect(() => {
    if (!isOpen || !isMidiLearnActive) return;

    const handleLearnedCc = (event: MidiEventPayload) => {
      // Phase 81: the FX slot binder publishes as `fx_param` with the composite
      // `"<trackId>/<slotId>"` id and the contract param id; every other entry
      // keeps the pre-existing normalization.
      const learnTarget: MidiLearnTarget = isFxSlotParamUiTarget(selectedTargetType)
        ? { targetType: 'fx_param', targetId: fxSlotTargetId, paramName: fxParamId }
        : (() => {
            const normalized = normalizeMidiLearnTargetSelection(
              selectedTargetType,
              selectedTargetId,
              channels,
              mixerTracks,
            );
            return {
              targetType: selectedTargetType,
              targetId: normalized.targetId,
              paramName: normalized.paramName,
            };
          })();
      const capture = resolveMidiLearnCapture(event, midiMappings, learnTarget);
      if (!capture) return;

      onUpdateMidiMappings(capture.mappings);
      setManualCc(capture.ccNumber);
      setStatusMessage(`Learned MIDI CC #${capture.ccNumber} → ${capture.mapping.paramName}.`);
      onToggleMidiLearn(false);
      setTimeout(() => setStatusMessage(null), 3000);
    };

    audioEngine.addMidiListener(handleLearnedCc);
    return () => audioEngine.removeMidiListener(handleLearnedCc);
  }, [
    channels,
    isOpen,
    isMidiLearnActive,
    midiMappings,
    mixerTracks,
    onToggleMidiLearn,
    onUpdateMidiMappings,
    selectedTargetId,
    selectedTargetType,
    fxSlotTargetId,
    fxParamId
  ]);

  if (!isOpen) return null;

  return (
    <ModalFrame id="fl-midi-learn-modal" labelledBy="fl-midi-learn-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ffaa00] flex items-center justify-center text-black shadow-md">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-midi-learn-modal-title" className="text-sm font-bold text-white tracking-wide">MIDI CONTROLLER LEARN & MAPPING</h2>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                  isMidiLearnActive 
                    ? 'bg-[#ff6e00]/20 text-[#ff6e00] border-[#ff6e00]/40 animate-pulse' 
                    : 'bg-[#333]/20 text-[#777] border-[#444]'
                }`}>
                  {isMidiLearnActive ? 'LEARN ACTIVE' : 'STANDBY'}
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Map physical MIDI knobs, faders, and pads to DAW controls</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleMidiLearn(!isMidiLearnActive)}
              className={`px-3 py-1 rounded text-xs font-bold transition flex items-center gap-1.5 ${
                isMidiLearnActive 
                  ? 'bg-[#ff6e00] text-black shadow-lg animate-pulse' 
                  : 'bg-[#222225] text-[#888] hover:text-white border border-[#333]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{isMidiLearnActive ? 'STOP LEARN' : 'START MIDI LEARN'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close MIDI learn"
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222225] transition"
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
          {/* Connected WebMIDI Devices */}
          <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b]">
            <span className="text-[10px] text-[#888] font-bold uppercase tracking-wider block mb-1.5">CONNECTED HARDWARE CONTROLLERS</span>
            {connectedDevices.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {connectedDevices.map(d => (
                  <div key={d.id} className="bg-[#121214] p-2 rounded border border-[#2e2e32] flex items-center gap-2">
                    <Keyboard className="w-4 h-4 text-[#00ff88]" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-bold text-white truncate">{d.name}</span>
                      <span className="text-[9px] text-[#777] font-mono">{d.manufacturer || 'Generic USB MIDI'} ({d.state})</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-[#121214] p-3 rounded border border-[#28282b] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[#ff6e00]" />
                  <span className="text-xs text-[#aaa]">WebMIDI ready. Plug in any USB MIDI keyboard or DJ controller.</span>
                </div>
                <span className="text-[9px] font-mono text-[#666]">Auto-Detecting</span>
              </div>
            )}
          </div>

          {isMidiLearnActive && (
            <div className="bg-[#ff6e00]/10 border border-[#ff6e00]/50 rounded-lg p-3 flex items-center gap-2 animate-pulse">
              <Radio className="w-4 h-4 text-[#ff6e00]" />
              <span className="text-xs text-white font-bold">
                Waiting for a MIDI CC — move a knob or fader to bind it to the selected target.
              </span>
            </div>
          )}

          {/* Quick Manual Bind Form */}
          <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] space-y-2">
            <span className="text-[10px] text-[#888] font-bold uppercase tracking-wider block">QUICK PARAMETER BIND</span>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              {/* CC Number */}
              <div>
                <label className="text-[9px] text-[#777] font-mono block mb-0.5">MIDI CC #</label>
                <input
                  type="number"
                  min="0"
                  max="127"
                  value={manualCc}
                  onChange={(e) => setManualCc(parseInt(e.target.value) || 0)}
                  className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336] font-mono"
                />
              </div>

              {/* Target Type */}
              <div>
                <label className="text-[9px] text-[#777] font-mono block mb-0.5">TARGET CONTROL</label>
                <select
                  value={selectedTargetType}
                  onChange={(e) => {
                    const nextType = e.target.value as MidiLearnUiTarget;
                    setSelectedTargetType(nextType);
                    if (isFxSlotParamUiTarget(nextType)) {
                      // Phase 81: seed the slot + parameter pickers from the FX
                      // contract so the form starts on a bindable parameter.
                      const seed = defaultFxSlotParameterSelection(mixerTracks);
                      setFxSlotTargetId(seed?.slotTargetId ?? '');
                      setFxParamId(seed?.paramId ?? '');
                      return;
                    }
                    setSelectedTargetId(
                      normalizeMidiLearnTargetSelection(nextType, selectedTargetId, channels, mixerTracks).targetId
                    );
                  }}
                  className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336]"
                >
                  <option value="master_vol">Master Out Volume</option>
                  <option value="channel_vol">Channel Volume Fader</option>
                  <option value="channel_pan">Channel Pan Knob</option>
                  <option value="mixer_vol">Mixer Insert Fader</option>
                  <option value="mixer_pan">Mixer Insert Pan</option>
                  <option value="fx_param">Filter Cutoff (Hz)</option>
                  <option value={FX_SLOT_PARAM_UI_TARGET}>FX Slot Parameter</option>
                </select>
              </div>

              {/* Target Item / Track (or FX slot, for the Phase 81 FX binder) */}
              <div>
                <label className="text-[9px] text-[#777] font-mono block mb-0.5">
                  {isFxSlotParamUiTarget(selectedTargetType) ? 'ASSIGN TO FX SLOT' : 'ASSIGN TO TRACK'}
                </label>
                {isFxSlotParamUiTarget(selectedTargetType) ? (
                  <select
                    value={fxSlotTargetId}
                    onChange={(e) => {
                      const nextSlot = e.target.value;
                      setFxSlotTargetId(nextSlot);
                      setFxParamId(allFxParamOptions.find(option => option.targetId === nextSlot)?.paramId ?? '');
                    }}
                    className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336]"
                  >
                    {fxSlotOptions.length === 0 && <option value="">No effect slots</option>}
                    {fxSlotOptions.map(option => (
                      <option key={option.targetId} value={option.targetId}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={selectedTargetId}
                    onChange={(e) => setSelectedTargetId(e.target.value)}
                    className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336]"
                  >
                    {isChannelScopedMidiTarget(selectedTargetType) ? (
                      channels.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))
                    ) : (
                      mixerTracks.map(m => (
                        <option key={m.id} value={m.id}>{m.name} (#{m.id})</option>
                      ))
                    )}
                  </select>
                )}
              </div>

              {/* Phase 81: the contract parameter the CC drives. Every entry is
                  a parameter with a real AudioParam consumer, and the label
                  shows the DSP range the 0-127 byte is mapped across. */}
              {isFxSlotParamUiTarget(selectedTargetType) && (
                <div>
                  <label className="text-[9px] text-[#777] font-mono block mb-0.5">FX PARAMETER</label>
                  <select
                    value={fxParamId}
                    onChange={(e) => setFxParamId(e.target.value)}
                    className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336]"
                  >
                    {fxParamOptions.length === 0 && <option value="">No contract parameter</option>}
                    {fxParamOptions.map(option => (
                      <option key={option.paramId} value={option.paramId}>
                        {`${option.paramLabel} (${formatFxParameterRange(option)})`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Add Button */}
              <div className="flex items-end">
                <button
                  onClick={handleAddMapping}
                  className="w-full py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center justify-center gap-1 shadow"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Bind CC</span>
                </button>
              </div>
            </div>
          </div>

          {/* Active Mappings Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white font-bold flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>ACTIVE MIDI CC BINDINGS ({midiMappings.length})</span>
              </span>
              {midiMappings.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="text-[10px] text-red-400 hover:text-red-300 transition"
                >
                  Clear All
                </button>
              )}
            </div>

            {midiMappings.length === 0 ? (
              <div className="bg-[#18181b] p-6 rounded-lg border border-dashed border-[#2e2e32] text-center space-y-2">
                <Sliders className="w-8 h-8 text-[#555] mx-auto" />
                <p className="text-xs text-[#888]">No MIDI CC bindings active yet.</p>
                <p className="text-[10px] text-[#666]">
                  Click <strong>START MIDI LEARN</strong> above, or bind a knob manually.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {midiMappings.map(m => (
                  <div
                    key={m.ccNumber}
                    className="bg-[#18181b] p-2.5 rounded-lg border border-[#28282b] flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-7 rounded bg-[#222225] border border-[#333338] flex items-center justify-center font-mono font-bold text-xs text-[#ff6e00]">
                        CC {m.ccNumber}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-white">{m.paramName || m.targetType}</span>
                        <span className="text-[9px] text-[#777] font-mono">
                          Target: {m.targetType} | ID: {m.targetId}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(m.ccNumber)}
                      className="p-1.5 text-[#777] hover:text-red-400 rounded hover:bg-[#222225] transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181b] border-t border-[#2e2e32] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Standard MIDI CC: 1=ModWheel, 7=Volume, 10=Pan, 11=Expression, 71=Resonance, 74=Cutoff</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#222225] hover:bg-[#333338] text-white font-bold rounded transition"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
