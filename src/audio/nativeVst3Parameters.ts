import type { Vst3Instrument, Vst3ParameterChange } from './nativeVst3Types';

/** Preserve authoritative streams and only add explicit edits, never controller defaults. */
export function withVst3Parameters(instrument: Vst3Instrument, changes: Vst3ParameterChange[]): Vst3Instrument {
  if (!changes.length || changes.length > 4096) throw new Error('Invalid VST3 parameter batch');
  const parameters = new Map((instrument.state.parameters ?? []).map(p => [p.id, p.value]));
  const seen = new Set<number>();
  for (const p of changes) {
    if (!Number.isInteger(p.id) || p.id < 0 || p.id > 0xffffffff || seen.has(p.id) || !Number.isFinite(p.value) || p.value < 0 || p.value > 1) throw new Error('Invalid VST3 parameter change');
    seen.add(p.id); parameters.delete(p.id); parameters.set(p.id, p.value);
  }
  if (parameters.size > 4096) throw new Error('VST3 parameter limit exceeded');
  return { ...instrument, state: { ...instrument.state, parameters: [...parameters].map(([id, value]) => ({ id, value })) } };
}
