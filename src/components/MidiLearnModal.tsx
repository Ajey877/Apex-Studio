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
    <ModalFrame id="fl-midi-learn-modal" labelledBy="fl-midi-learn-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/*
        UI-03L: presentation-only migration onto the existing `--apex-*` semantic
        tokens. This modal is DOM-rendered (no canvas), so its chrome follows the
        active palette directly and needs no palette seam or theme observer.

        Three color families carry meaning and keep it in both themes:
          - the MIDI Learn accent (armed state, primary bind CTA, CC identity)
            resolves through `--apex-accent`, exactly as the sibling
            MidiControllerModal MIDI Learn tab does, and exactly as the legacy
            compatibility layer already resolved that legacy orange literal;
          - connected-hardware readiness stays green through `--apex-success`;
          - destructive clear/delete stays red through `--apex-danger`.
        The dead dark-only scrim fill is removed; ModalFrame supplies the
        shared themed `--apex-modal-overlay` scrim.
      */}
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-accent)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-midi-learn-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">MIDI CONTROLLER LEARN & MAPPING</h2>
                {/*
                  The armed badge keeps its accent wash, accent border and pulse,
                  but its label uses --apex-text rather than --apex-accent:
                  accent-on-accent-wash measures 4.23:1 (Dark) and 3.90:1 (Light)
                  over the header band, below the AA floor this 9px bold label
                  needs, while --apex-text measures 10.97:1 and 11.09:1.
                */}
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                  isMidiLearnActive 
                    ? 'bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] text-[var(--apex-text)] border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] animate-pulse'
                    : 'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)] border-[var(--apex-border)]'
                }`}>
                  {isMidiLearnActive ? 'LEARN ACTIVE' : 'STANDBY'}
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Map physical MIDI knobs, faders, and pads to DAW controls</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleMidiLearn(!isMidiLearnActive)}
              className={`px-3 py-1 rounded text-xs font-bold transition flex items-center gap-1.5 ${
                isMidiLearnActive 
                  ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow-lg animate-pulse'
                  : 'bg-[var(--apex-surface-3)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)] border border-[var(--apex-border)]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{isMidiLearnActive ? 'STOP LEARN' : 'START MIDI LEARN'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close MIDI learn"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="opacity-70 hover:opacity-100 transition">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Connected WebMIDI Devices */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)]">
            <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase tracking-wider block mb-1.5">CONNECTED HARDWARE CONTROLLERS</span>
            {connectedDevices.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {connectedDevices.map(d => (
                  <div key={d.id} className="bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)] flex items-center gap-2">
                    <Keyboard className="w-4 h-4 text-[var(--apex-success)]" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-bold text-[var(--apex-text)] truncate">{d.name}</span>
                      <span className="text-[9px] text-[var(--apex-text-3)] font-mono">{d.manufacturer || 'Generic USB MIDI'} ({d.state})</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-[var(--apex-canvas)] p-3 rounded border border-[var(--apex-border)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[var(--apex-accent)]" />
                  <span className="text-xs text-[var(--apex-text-2)]">WebMIDI ready. Plug in any USB MIDI keyboard or DJ controller.</span>
                </div>
                <span className="text-[9px] font-mono text-[var(--apex-text-3)]">Auto-Detecting</span>
              </div>
            )}
          </div>

          {isMidiLearnActive && (
            <div className="bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded-lg p-3 flex items-center gap-2 animate-pulse">
              <Radio className="w-4 h-4 text-[var(--apex-accent)]" />
              <span className="text-xs text-[var(--apex-text)] font-bold">
                Waiting for a MIDI CC — move a knob or fader to bind it to the selected target.
              </span>
            </div>
          )}

          {/* Quick Manual Bind Form */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] space-y-2">
            <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase tracking-wider block">QUICK PARAMETER BIND</span>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              {/* CC Number */}
              <div>
                <label className="text-[9px] text-[var(--apex-text-3)] font-mono block mb-0.5">MIDI CC #</label>
                <input
                  type="number"
                  min="0"
                  max="127"
                  value={manualCc}
                  onChange={(e) => setManualCc(parseInt(e.target.value) || 0)}
                  className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)] font-mono"
                />
              </div>

              {/* Target Type */}
              <div>
                <label className="text-[9px] text-[var(--apex-text-3)] font-mono block mb-0.5">TARGET CONTROL</label>
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
                  className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)]"
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
                <label className="text-[9px] text-[var(--apex-text-3)] font-mono block mb-0.5">
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
                    className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)]"
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
                    className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)]"
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
                  <label className="text-[9px] text-[var(--apex-text-3)] font-mono block mb-0.5">FX PARAMETER</label>
                  <select
                    value={fxParamId}
                    onChange={(e) => setFxParamId(e.target.value)}
                    className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)]"
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
                  className="w-full py-1.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center justify-center gap-1 shadow"
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
              <span className="text-[var(--apex-text)] font-bold flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
                <span>ACTIVE MIDI CC BINDINGS ({midiMappings.length})</span>
              </span>
              {midiMappings.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="text-[10px] text-[var(--apex-danger)] hover:text-[color-mix(in_srgb,var(--apex-danger)_78%,var(--apex-text))] transition"
                >
                  Clear All
                </button>
              )}
            </div>

            {midiMappings.length === 0 ? (
              <div className="bg-[var(--apex-surface-2)] p-6 rounded-lg border border-dashed border-[var(--apex-border)] text-center space-y-2">
                <Sliders className="w-8 h-8 text-[var(--apex-text-3)] mx-auto" />
                <p className="text-xs text-[var(--apex-text-2)]">No MIDI CC bindings active yet.</p>
                <p className="text-[10px] text-[var(--apex-text-3)]">
                  Click <strong>START MIDI LEARN</strong> above, or bind a knob manually.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {midiMappings.map(m => (
                  <div
                    key={m.ccNumber}
                    className="bg-[var(--apex-surface-2)] p-2.5 rounded-lg border border-[var(--apex-border)] flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-7 rounded bg-[var(--apex-surface-3)] border border-[var(--apex-border)] flex items-center justify-center font-mono font-bold text-xs text-[var(--apex-accent)]">
                        CC {m.ccNumber}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-[var(--apex-text)]">{m.paramName || m.targetType}</span>
                        <span className="text-[9px] text-[var(--apex-text-3)] font-mono">
                          Target: {m.targetType} | ID: {m.targetId}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(m.ccNumber)}
                      aria-label={`Remove MIDI CC ${m.ccNumber} binding`}
                      className="p-1.5 text-[var(--apex-text-3)] hover:text-[var(--apex-danger)] rounded hover:bg-[var(--apex-state-hover)] transition"
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
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Standard MIDI CC: 1=ModWheel, 7=Volume, 10=Pan, 11=Expression, 71=Resonance, 74=Cutoff</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] font-bold rounded transition"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
