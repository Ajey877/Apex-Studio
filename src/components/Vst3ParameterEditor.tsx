import React, { useEffect, useRef, useState } from 'react';
import type { Channel } from '../types/daw';
import { getVst3Bridge, type Vst3Parameter, type Vst3ParameterEditorCommit } from '../audio/nativeVst3Types';
import { validateMetadata } from '../../native/vst3/parameters.mjs';

const control = 'rounded border border-[var(--apex-border)] bg-[var(--apex-surface-2)] p-2 disabled:opacity-40';
const PAGE = 32;
/** Draft gestures are local. One explicit Apply = one acknowledged native edit/history action. */
export function Vst3ParameterEditor({ channel, onCommit, cancellation }: { channel: Channel; onCommit: Vst3ParameterEditorCommit; cancellation?: AbortSignal }) {
  const [parameters, setParameters] = useState<Vst3Parameter[]>([]);
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const [status, setStatus] = useState('Loading genuine parameter metadata…'), [error, setError] = useState('');
  const [busy, setBusy] = useState(true), [available, setAvailable] = useState(false);
  const controller = useRef(new AbortController()), pending = useRef(false);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    const cancel = () => request.abort();
    cancellation?.addEventListener('abort', cancel, { once: true });
    if (cancellation?.aborted) request.abort();
    setBusy(true); setAvailable(false); setParameters([]); setDraft({}); setError('');
    const bridge = getVst3Bridge();
    if (!bridge || !channel.vst3) { setStatus('Native parameters require the desktop application.'); setBusy(false); return; }
    void bridge.describe(channel.vst3).then(result => {
      if (request.signal.aborted) return;
      const metadata = validateMetadata(result.parameters, result.controllerAvailable);
      setParameters(metadata); setAvailable(result.controllerAvailable);
      setStatus(!result.controllerAvailable ? 'This instrument has no edit controller; parameter metadata is unavailable.' : !metadata.length ? 'The controller exposes no parameters.' : 'Draft only. Apply sends real values to the native processor and records one undo action.');
    }).catch(reason => { if (!request.signal.aborted) setError(String(reason.message ?? reason)); })
      .finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => { request.abort(); cancellation?.removeEventListener('abort', cancel); };
  }, [channel.id, channel.vst3, cancellation]);
  const visible = parameters.filter(p => !(p.flags & 16) && `${p.name} ${p.shortTitle} ${p.units} ${p.id}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE)), currentPage = Math.min(page, pages - 1);
  const stage = (p: Vst3Parameter, value: number) => {
    setDraft(previous => { const next = { ...previous }; if (value === p.currentValue) delete next[p.id]; else next[p.id] = value; return next; });
    setError(''); setStatus('Draft only — the processor/project have not changed. Apply to hear and save.');
  };
  const apply = async () => {
    if (pending.current || !Object.keys(draft).length) return;
    pending.current = true; setBusy(true); setError('');
    const request = controller.current;
    try {
      await onCommit(channel, Object.entries(draft).map(([id, value]) => ({ id: Number(id), value })), request.signal);
      if (!request.signal.aborted) { setDraft({}); setStatus('Native processor accepted the edit. Project Undo/Redo restores saved sound.'); }
    } catch (reason) { if (!request.signal.aborted) setError(String((reason as Error).message ?? reason)); }
    finally { pending.current = false; if (!request.signal.aborted) setBusy(false); }
  };
  return <section aria-label="VST3 parameter editor" className="space-y-2 border border-[var(--apex-border)] p-3 rounded">
    <h3 className="font-semibold">Native instrument parameters</h3>
    <p>Values are normalized 0–1, not invented physical ranges. Continuous gestures stage a draft; Apply commits one undoable batch. Existing buffered audio may play for about 50 ms before the change is heard.</p>
    <label>Search parameters <input className={control} type="search" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>
    <p>{visible.length} matching parameters · page {currentPage + 1} / {pages}</p>
    <fieldset disabled={busy || !available} className="space-y-2">
      {visible.slice(currentPage * PAGE, (currentPage + 1) * PAGE).map(p => {
        const value = draft[p.id] ?? p.currentValue, name = p.name || `Unnamed parameter #${p.id}`;
        return <div key={p.id} className="border-b border-[var(--apex-border)] pb-2">
          <label htmlFor={`vst3-param-${p.id}`}>{name} · ID {p.id}</label>
          <p>{p.shortTitle && `Short title: ${p.shortTitle}. `}{p.units && `Plugin units: ${p.units}. `}Normalized: {value === null ? 'unavailable' : value.toFixed(5)} · default {p.defaultValue.toFixed(5)}{p.flags & 1 ? ' · automatable (plugin flag; no arrangement lanes)' : ''}{p.flags & 65536 ? ' · bypass' : ''}</p>
          {p.flags & 32768 ? <p>Program change requires reinitialization; use Reset/relink outside this editor.</p> : p.flags & 2 ? <p>Read-only</p> : value === null ? <p>Current value unavailable; editing disabled.</p> : p.choices ?
            <select className={control} id={`vst3-param-${p.id}`} value={value} onChange={e => stage(p, Number(e.target.value))}>
              {!p.choices.some(c => c.value === value) && <option value={value}>Current normalized value {value}</option>}
              {p.choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select> : <input id={`vst3-param-${p.id}`} type="range" min={0} max={1} step={p.stepCount > 0 ? 1 / p.stepCount : 0.001} value={value} onChange={e => stage(p, Number(e.target.value))} />}
        </div>;
      })}
      <button className={control} disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous parameters</button>
      <button className={control} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next parameters</button>
      <button className={control} disabled={!Object.keys(draft).length} onClick={() => void apply()}>Apply parameter changes</button>
      <button className={control} disabled={!Object.keys(draft).length} onClick={() => { setDraft({}); setStatus('Draft discarded.'); }}>Discard parameter draft</button>
    </fieldset>
    {busy && pending.current && <button className={control} onClick={() => { controller.current.abort(); setBusy(false); setAvailable(false); setDraft({}); setStatus('Cancelled. Saved state is unchanged; close/reopen the panel after native cleanup to retry.'); }}>Cancel pending parameter edit</button>}
    <p role="status">{busy ? 'Waiting for native parameters…' : status}</p>
    {error && <p role="alert">{error} Saved project state has not been changed. Close/reopen this panel to retry.</p>}
  </section>;
}
