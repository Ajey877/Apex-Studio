import React, { useEffect, useState } from 'react';
import type { Vst3Effect, Vst3Identity, Vst3Parameter, Vst3ParameterChange, Vst3State } from '../audio/nativeVst3Types';
import { getVst3Bridge } from '../audio/nativeVst3Types';
import { validateMetadata } from '../../native/vst3/parameters.mjs';

const field = 'rounded border border-[var(--apex-border)] bg-[var(--apex-surface-2)] px-2 py-1 text-[10px] disabled:opacity-40';

export function Vst3EffectPicker({ onChoose, onCancel }: {
  onChoose: (effect: Vst3Effect) => void;
  onCancel: () => void;
}) {
  const [plugins, setPlugins] = useState<Vst3Identity[]>([]);
  const [errors, setErrors] = useState<Array<{ path: string; error: string }>>([]);
  const [status, setStatus] = useState('Scanning authorized VST3 folders…');
  const [busy, setBusy] = useState(true);
  const scan = async (active = () => true) => {
    const bridge = getVst3Bridge();
    if (!bridge) { setBusy(false); setStatus('VST3 effects require the desktop application.'); return; }
    setBusy(true); setStatus('Scanning authorized VST3 folders…');
    try {
      const result = await bridge.discoverEffects();
      if (!active()) return;
      setPlugins(result.plugins); setErrors(result.errors);
      setStatus(result.plugins.length ? `${result.plugins.length} genuine VST3 effects found.` : 'No compatible VST3 effects found.');
    } catch (error) {
      if (active()) setStatus(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (active()) setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    void scan(() => active);
    return () => { active = false; };
  }, []);
  const choose = async (plugin: Vst3Identity) => {
    const bridge = getVst3Bridge();
    if (!bridge) { setStatus('VST3 effects require the desktop application.'); return; }
    setBusy(true); setStatus(`Opening ${plugin.name} in the native helper…`);
    try {
      const state: Vst3State = { schema: 1, classId: plugin.classId, parameters: [] };
      const effect = await bridge.inspectEffect(plugin, state);
      onChoose(effect);
    } catch (error) {
      setStatus(`Could not load ${plugin.name}: ${error instanceof Error ? error.message : String(error)}. No project insert was added.`);
      setBusy(false);
    }
  };
  return <section className="border-b border-[var(--apex-border)] bg-[var(--apex-panel-header)] p-2 space-y-1.5" aria-label="VST3 effect picker">
    <div className="flex items-center justify-between">
      <strong className="text-[10px] uppercase">Native VST3 Audio Effects</strong>
      <button className={field} onClick={onCancel}>Close</button>
    </div>
    <p role="status" className="text-[9px] text-[var(--apex-text-3)]">{status}</p>
    <button className={field} disabled={busy || !getVst3Bridge()} onClick={() => void (async () => {
      const bridge = getVst3Bridge();
      if (!bridge) return;
      try { if (await bridge.choosePath()) await scan(); }
      catch (error) { setStatus(`Folder selection failed: ${error instanceof Error ? error.message : String(error)}`); }
    })()}>Add VST3 folder…</button>
    <div className="max-h-36 overflow-y-auto space-y-1">
      {plugins.map(plugin => <button key={`${plugin.path}:${plugin.classId}`} disabled={busy}
        onClick={() => void choose(plugin)} className={`${field} block w-full text-left`}>
        <span className="font-semibold">{plugin.name}</span><span className="text-[var(--apex-text-3)]"> · {plugin.vendor}</span>
        <span className="block truncate text-[9px] text-[var(--apex-text-3)]">{plugin.path}</span>
      </button>)}
    </div>
    {errors.slice(0, 4).map(item => <p key={item.path} className="text-[9px] text-[var(--apex-danger)]">{item.path}: {item.error}</p>)}
    {!getVst3Bridge() && <p className="text-[9px]">Use Apex Studio Desktop to scan authorized plugin folders.</p>}
  </section>;
}

export function Vst3EffectControls({ effect, disabled = false, onApply, onRelink }: {
  effect?: Vst3Effect;
  disabled?: boolean;
  onApply: (changes: Vst3ParameterChange[]) => Promise<void>;
  onRelink: () => void;
}) {
  const [parameters, setParameters] = useState<Vst3Parameter[]>([]);
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading native parameter metadata…');
  const [error, setError] = useState('');
  const parameterSignature = effect?.state.parameters.map(parameter => `${parameter.id}:${parameter.value}`).join(',') ?? '';
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setParameters([]); setDraft({}); setSearch(''); setPage(0);
    const bridge = getVst3Bridge();
    if (!bridge || !effect) {
      setStatus(!effect ? 'Plugin identity/state is missing. Original project data is retained; relink this slot.' : 'Native parameters require the desktop application.');
      setLoading(false); return;
    }
    void bridge.describeEffect(effect).then(result => {
      if (!active) return;
      const metadata = validateMetadata(result.parameters, result.controllerAvailable) as Vst3Parameter[];
      setParameters(metadata);
      setStatus(!result.controllerAvailable ? 'This effect has no edit controller; parameter editing is unavailable.' :
        metadata.length ? 'Parameters are genuine values from this plugin controller. Stop playback to edit; Apply saves one undoable state change.' : 'This controller exposes no editable parameters.');
    }).catch(reason => {
      if (active) { setError(String(reason instanceof Error ? reason.message : reason)); setStatus('Native effect metadata could not be restored.'); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [effect?.path, effect?.classId, parameterSignature]);
  const visibleParameters = parameters.filter(parameter => !(parameter.flags & 16) &&
    `${parameter.name} ${parameter.shortTitle} ${parameter.units} ${parameter.id}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(visibleParameters.length / 32));
  const currentPage = Math.min(page, pages - 1);
  const apply = async () => {
    const changes = Object.entries(draft).map(([id, value]) => ({ id: Number(id), value }));
    if (!changes.length || busy) return;
    setBusy(true); setError('');
    try {
      await onApply(changes);
      setDraft({}); setStatus('Native plugin accepted the values and its state was saved to the project.');
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
      setStatus('Edit failed; saved project state was not changed.');
    } finally { setBusy(false); }
  };
  return <div className="space-y-1.5 border-t border-[var(--apex-border)] pt-1.5">
    <div className="flex items-center justify-between gap-1">
      <span className="text-[9px] font-semibold">{effect?.name ?? 'Unresolved VST3 effect'}</span>
      <button className={field} disabled={disabled || busy} onClick={onRelink}>Relink</button>
    </div>
    {effect && <p className="truncate text-[8px] text-[var(--apex-text-3)]" title={effect.path}>{effect.vendor} · {effect.path}</p>}
    <p role="status" className="text-[9px] text-[var(--apex-text-3)]">{loading ? 'Loading…' : status}</p>
    {error && <p role="alert" className="text-[9px] text-[var(--apex-danger)]">{error}</p>}
    <label className="block text-[9px]">Search parameters <input className={`${field} w-full`} type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
    <p className="text-[8px]">{visibleParameters.length} matching parameters · page {currentPage + 1}/{pages}</p>
    {visibleParameters.slice(currentPage * 32, (currentPage + 1) * 32).map(parameter => {
      const value = draft[parameter.id] ?? parameter.currentValue;
      const unavailable = value === null || Boolean(parameter.flags & (2 | 32768)) || Boolean((parameter.flags & 8) && !parameter.choices);
      return <label key={parameter.id} className="block text-[9px]" title={`${parameter.name} · ${parameter.units || 'normalized'} · ID ${parameter.id}`}>
        <span className="flex justify-between gap-1"><span className="truncate">{parameter.name || `Parameter ${parameter.id}`}</span><span className="font-mono">{value === null ? 'n/a' : value.toFixed(3)}</span></span>
        {parameter.choices ? <select aria-label={`${parameter.name} · ${effect?.name ?? 'VST3 effect'}`} className={`${field} w-full`} disabled={disabled || busy || loading || unavailable}
          value={value ?? ''} onChange={event => setDraft(previous => ({ ...previous, [parameter.id]: Number(event.target.value) }))}>
          {parameter.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select> : <input aria-label={`${parameter.name} · ${effect?.name ?? 'VST3 effect'}`} className="w-full accent-[var(--apex-accent)]" type="range" min="0" max="1"
          step={parameter.stepCount > 0 ? 1 / parameter.stepCount : 0.001} value={value ?? 0}
          disabled={disabled || busy || loading || unavailable}
          onChange={event => setDraft(previous => ({ ...previous, [parameter.id]: Number(event.target.value) }))} />}
      </label>;
    })}
    <div className="flex gap-1">
      <button className={field} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <button className={field} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div>
    <button className={field} disabled={disabled || busy || loading || !Object.keys(draft).length} onClick={() => void apply()}>
      {busy ? 'Applying…' : 'Apply native parameters'}
    </button>
    {disabled && <p className="text-[8px] text-[var(--apex-text-3)]">Stop playback before editing or relinking this native insert.</p>}
  </div>;
}
