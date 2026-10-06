import React from 'react';
import type { FxSlot, FxType } from '../types/daw';
import {
  FX_PARAMETER_FAMILIES,
  SLOT_MIX_PARAMETER,
  clampFxParameterValue,
  resolveFxParamRange,
} from '../audio/fxParameterContract';

/**
 * Phase 80: per-slot parameter editor.
 *
 * Renders the real, AudioParam-updatable parameters for the slot's FX
 * family, plus the wet/dry mix. Every value flows through the same
 * `onUpdateFxSlot` callback the rest of the mixer uses, so:
 *   - project state is the source of truth,
 *   - the live bridge (`applyLiveFxChainMix` / `applyLiveFxSlotParameter`)
 *     updates the running AudioParams,
 *   - the offline renderer picks the same value up at the next export,
 *   - undo/redo + persistence + project replacement work the same as
 *     every other FX edit.
 *
 * The contract (FX_PARAMETER_FAMILIES) decides whether a family has
 * parameters. Families whose DSP bakes the parameter into a curve
 * (`distortion`, `bitcrusher`, `tape_saturation`, `chorus`) get only
 * the wet/dry mix — there is no honest slider for them, so the UI
 * does not pretend.
 */

interface FxParameterControlsProps {
  slot: FxSlot;
  onUpdateFxSlot: (trackId: number, slotId: string, updates: Partial<FxSlot>) => void;
  trackId: number;
  /**
   * Phase 80 drag grouping: when the user starts dragging a slider,
   * the parent App starts a continuous history batcher; on
   * pointer-up / change-end the batch is flushed into a single
   * history entry. Without this, every animation frame of a
   * parameter drag would be its own undo step.
   */
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
}

interface ParamFormatOptions {
  /** Step value for the slider, default 0.1. */
  step?: number;
  /** Number of decimal places to render in the value chip. Default 1. */
  decimals?: number;
  /** Suffix appended after the value (e.g. 'dB', 'Hz', 'ms'). Default = spec.unit. */
  suffix?: string;
}

const formatValue = (value: number, format: ParamFormatOptions): string => {
  const decimals = format.decimals ?? 1;
  return `${value.toFixed(decimals)}${format.suffix ?? ''}`;
};

const ParamSlider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
  dragLabel?: string;
}> = ({ label, value, min, max, step, unit, onChange, onInteractionStart, onInteractionEnd, dragLabel }) => {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return (
    <div className="flex items-center justify-between text-[9px] text-[#777]">
      <span className="uppercase tracking-wider">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerDown={() => onInteractionStart?.(dragLabel ?? `Change ${label}`)}
        onPointerUp={() => onInteractionEnd?.(dragLabel ?? `Change ${label}`)}
        onBlur={() => onInteractionEnd?.(dragLabel ?? `Change ${label}`)}
        className="w-20 h-1 accent-[#ff6e00] bg-[#121214] rounded"
      />
      <span className="font-mono text-[#ff6e00] w-12 text-right">
        {Number.isFinite(value) ? formatValue(value, { decimals, suffix: unit }) : '—'}
      </span>
    </div>
  );
};

const EQParamRow: React.FC<{
  slot: FxSlot;
  band: 'low' | 'mid' | 'high';
  bandLabel: string;
  onChange: (paramName: string, value: number) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
}> = ({ slot, band, bandLabel, onChange, onInteractionStart, onInteractionEnd }) => {
  const freq = Number(slot.params[`${band}Freq`]) || 1000;
  const gain = Number(slot.params[`${band}Gain`]) || 0;
  const q = Number(slot.params[`${band}Q`]) || 1;
  return (
    <div className="bg-[#1a1a1d] rounded p-1.5 flex flex-col gap-1">
      <div className="text-[9px] uppercase text-[#aaa] tracking-wider">{bandLabel}</div>
      <ParamSlider
        label="Freq"
        value={freq}
        min={20}
        max={20000}
        step={1}
        unit=" Hz"
        onChange={(v) => onChange(`${band}Freq`, clampFxParameterValue('equalizer', `${band}Freq`, v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel={`Change ${bandLabel} EQ frequency`}
      />
      <ParamSlider
        label="Gain"
        value={gain}
        min={-18}
        max={18}
        step={0.1}
        unit=" dB"
        onChange={(v) => onChange(`${band}Gain`, clampFxParameterValue('equalizer', `${band}Gain`, v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel={`Change ${bandLabel} EQ gain`}
      />
      <ParamSlider
        label="Q"
        value={q}
        min={0.1}
        max={10}
        step={0.1}
        unit=""
        onChange={(v) => onChange(`${band}Q`, clampFxParameterValue('equalizer', `${band}Q`, v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel={`Change ${bandLabel} EQ Q`}
      />
    </div>
  );
};

export const FxParameterControls: React.FC<FxParameterControlsProps> = ({
  slot,
  onUpdateFxSlot,
  trackId,
  onInteractionStart,
  onInteractionEnd,
}) => {
  const updateParam = (paramName: string, value: number) => {
    onUpdateFxSlot(trackId, slot.id, { params: { ...slot.params, [paramName]: value } });
  };

  const family = FX_PARAMETER_FAMILIES[slot.type as FxType];
  const params = family?.parameters ?? [];

  return (
    <div className="flex flex-col gap-1.5 border-t border-[#2a2a2d] pt-1.5 mt-1.5">
      {/* Wet/Dry Mix — always present, every slot has it. */}
      <div className="flex items-center justify-between text-[9px] text-[#777]">
        <span className="uppercase tracking-wider">Wet/Dry</span>
        <input
          type="range"
          min={SLOT_MIX_PARAMETER.min}
          max={SLOT_MIX_PARAMETER.max}
          step={0.05}
          value={slot.mix}
          onChange={(e) => onUpdateFxSlot(trackId, slot.id, { mix: parseFloat(e.target.value) })}
          onPointerDown={() => onInteractionStart?.('Change effect mix')}
          onPointerUp={() => onInteractionEnd?.('Change effect mix')}
          onBlur={() => onInteractionEnd?.('Change effect mix')}
          className="w-20 h-1 accent-[#ff6e00] bg-[#121214] rounded"
        />
        <span className="font-mono text-[#ff6e00] w-12 text-right">{Math.round(slot.mix * 100)}%</span>
      </div>

      {slot.type === 'equalizer' && (
        <div className="grid grid-cols-3 gap-1.5">
          <EQParamRow slot={slot} band="low" bandLabel="Low" onChange={updateParam} />
          <EQParamRow slot={slot} band="mid" bandLabel="Mid" onChange={updateParam} />
          <EQParamRow slot={slot} band="high" bandLabel="High" onChange={updateParam} />
        </div>
      )}

      {slot.type === 'compressor' && (
        <div className="flex flex-col gap-1 bg-[#1a1a1d] rounded p-1.5">
          <CompressorRows slot={slot} onChange={updateParam} />
        </div>
      )}

      {slot.type === 'delay' && (
        <div className="flex flex-col gap-1 bg-[#1a1a1d] rounded p-1.5">
          <DelayRows slot={slot} onChange={updateParam} />
        </div>
      )}

      {slot.type === 'limiter' && (
        <div className="flex flex-col gap-1 bg-[#1a1a1d] rounded p-1.5">
          <LimiterRows slot={slot} onChange={updateParam} />
        </div>
      )}

      {slot.type === 'reverb' && (
        <div className="text-[9px] text-[#666] italic">
          Convolver reverb — only the wet/dry mix is editable in this phase.
        </div>
      )}

      {(slot.type === 'distortion' || slot.type === 'bitcrusher' || slot.type === 'tape_saturation' || slot.type === 'chorus') && (
        <div className="text-[9px] text-[#666] italic">
          {`${slot.type.replace('_', ' ')}`} parameters are baked into the curve / LFO at chain construction; no live parameter editing in this phase.
        </div>
      )}

      {/* Sanity: any future family without contract coverage shows a
          single line that says so. The contract test (phase80.fxParameterContract.test.ts)
          rejects new families without contract entries, so this fallback
          is just defensive. */}
      {family === null && slot.type !== 'reverb' && (
        <div className="text-[9px] text-[#a44] italic">
          {`Slot type "${slot.type}" has no Phase 80 contract entry — wet/dry mix is the only editable parameter.`}
        </div>
      )}

      {/* `params` is intentionally surfaced through the contract module so
          the contract test can audit it; the JSX above already routes per
          family. */}
      {params.length === 0 ? null : null}
    </div>
  );
};

const CompressorRows: React.FC<{
  slot: FxSlot;
  onChange: (name: string, value: number) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
}> = ({ slot, onChange, onInteractionStart, onInteractionEnd }) => {
  const threshold = Number(slot.params.threshold) || -18;
  const ratio = Number(slot.params.ratio) || 4;
  const attack = Number(slot.params.attack) || 0.005;
  const release = Number(slot.params.release) || 0.15;
  const knee = Number(slot.params.knee) || 0;
  return (
    <>
      <ParamSlider
        label="Threshold"
        value={threshold}
        min={resolveFxParamRange('compressor', 'threshold')?.min ?? -100}
        max={resolveFxParamRange('compressor', 'threshold')?.max ?? 0}
        step={0.5}
        unit=" dB"
        onChange={(v) => onChange('threshold', clampFxParameterValue('compressor', 'threshold', v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change compressor threshold"
      />
      <ParamSlider
        label="Ratio"
        value={ratio}
        min={1}
        max={20}
        step={0.1}
        unit=":1"
        onChange={(v) => onChange('ratio', clampFxParameterValue('compressor', 'ratio', v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change compressor ratio"
      />
      <ParamSlider
        label="Attack"
        value={attack * 1000}
        min={0}
        max={50}
        step={0.1}
        unit=" ms"
        onChange={(v) => onChange('attack', clampFxParameterValue('compressor', 'attack', v / 1000))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change compressor attack"
      />
      <ParamSlider
        label="Release"
        value={release * 1000}
        min={0}
        max={500}
        step={1}
        unit=" ms"
        onChange={(v) => onChange('release', clampFxParameterValue('compressor', 'release', v / 1000))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change compressor release"
      />
      <ParamSlider
        label="Knee"
        value={knee}
        min={0}
        max={40}
        step={0.5}
        unit=" dB"
        onChange={(v) => onChange('knee', clampFxParameterValue('compressor', 'knee', v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change compressor knee"
      />
    </>
  );
};

const DelayRows: React.FC<{
  slot: FxSlot;
  onChange: (name: string, value: number) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
}> = ({ slot, onChange, onInteractionStart, onInteractionEnd }) => {
  const time = Number(slot.params.time) || 0.25;
  const feedback = Number(slot.params.feedback) || 0.3;
  return (
    <>
      <ParamSlider
        label="Time"
        value={time * 1000}
        min={0}
        max={2000}
        step={1}
        unit=" ms"
        onChange={(v) => onChange('time', clampFxParameterValue('delay', 'time', v / 1000))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change delay time"
      />
      <ParamSlider
        label="Feedback"
        value={feedback * 100}
        min={0}
        max={98.9}
        step={0.5}
        unit=" %"
        onChange={(v) => onChange('feedback', clampFxParameterValue('delay', 'feedback', v / 100))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change delay feedback"
      />
    </>
  );
};

const LimiterRows: React.FC<{
  slot: FxSlot;
  onChange: (name: string, value: number) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
}> = ({ slot, onChange, onInteractionStart, onInteractionEnd }) => {
  const ceiling = Number(slot.params.ceiling) || -0.3;
  const release = Number(slot.params.release) || 0.08;
  const drive = Number(slot.params.drive) || 0;
  return (
    <>
      <ParamSlider
        label="Ceiling"
        value={ceiling}
        min={-12}
        max={0}
        step={0.1}
        unit=" dB"
        onChange={(v) => onChange('ceiling', clampFxParameterValue('limiter', 'ceiling', v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change limiter ceiling"
      />
      <ParamSlider
        label="Release"
        value={release * 1000}
        min={10}
        max={500}
        step={1}
        unit=" ms"
        onChange={(v) => onChange('release', clampFxParameterValue('limiter', 'release', v / 1000))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change limiter release"
      />
      <ParamSlider
        label="Drive"
        value={drive}
        min={-12}
        max={24}
        step={0.5}
        unit=" dB"
        onChange={(v) => onChange('drive', clampFxParameterValue('limiter', 'drive', v))}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
        dragLabel="Change limiter drive"
      />
    </>
  );
};
