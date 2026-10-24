import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Channel } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { getVst3Bridge, type Vst3Identity } from '../audio/nativeVst3Types';
import { getVst3Diagnostics, reportVst3, subscribeVst3Diagnostics } from '../audio/nativeVst3Runtime';

export function Vst3StatusBanner() {
  const diagnostics = useSyncExternalStore(subscribeVst3Diagnostics, getVst3Diagnostics, getVst3Diagnostics);
  const errors = diagnostics.filter(item => !item.message.startsWith('VST3 ready') && !item.message.startsWith('VST3 active'));
  if (!errors.length) return null;
  return <div role="alert" className="px-3 py-2 text-xs bg-[var(--apex-panel)] text-[var(--apex-text)] border-b border-[var(--apex-border)]">
    {errors.map(item => <p key={item.channelId}>VST3 ({item.channelId}): {item.message} Saved instrument data is retained. Open Instruments to retry or relink.</p>)}
  </div>;
}

export function Vst3InstrumentPanel({ channel, onUpdateChannel }: {
  channel: Channel; onUpdateChannel: (id: string, updates: Partial<Channel>) => void;
}) {
  const bridge = getVst3Bridge();
  const [expanded, setExpanded] = useState(channel.instrumentType === 'vst3');
  const [paths, setPaths] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<Vst3Identity[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [channel]);
  const diagnostics = useSyncExternalStore(subscribeVst3Diagnostics, getVst3Diagnostics, getVst3Diagnostics);
  const diagnostic = diagnostics.find(item => item.channelId === channel.id);
  async function run(operation: () => Promise<void>) {
    setBusy(true); setErrors([]);
    try { await operation(); }
    catch (error) { setErrors([error instanceof Error ? error.message : String(error)]); }
    finally { setBusy(false); }
  }
  async function scan() {
    if (!bridge) return;
    setPaths(await bridge.paths());
    const result = await bridge.discover();
    setPlugins(result.plugins);
    setErrors(result.errors.map(item => `${item.path}: ${item.error}`));
  }
  async function select(plugin: Vst3Identity) {
    if (!bridge) return;
    if (audioEngine.isPlaybackActive()) throw new Error('Stop transport before selecting/relinking a native instrument.');
    const token = generation.current;
    // Relink by exact class ID and restore original state. A different class
    // is an intentional replacement, explicitly labelled in the UI/history.
    const state = channel.instrumentType === 'vst3' && channel.vst3?.classId === plugin.classId ? channel.vst3.state : undefined;
    const instrument = await bridge.inspect(plugin, state);
    if (generation.current !== token) return; // project/channel changed during native load
    const prepared: Channel = { ...channel, instrumentType: 'vst3', vst3: instrument };
    await audioEngine.prepareVst3Channel(prepared);
    if (generation.current !== token) { audioEngine.discardPreparedVst3Channel(prepared); return; }
    onUpdateChannel(channel.id, { instrumentType: 'vst3', vst3: instrument });
    reportVst3(channel.id, 'VST3 ready (loaded on this channel)');
  }
  return <section aria-label="VST3 instrument hosting" className="p-3 space-y-2 border-b border-[var(--apex-border)] text-xs text-[var(--apex-text)] bg-[var(--apex-panel)]">
    <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} className="font-semibold">VST3 instruments — desktop only</button>
    {expanded && <>
      {!bridge ? <p>Native VST3 hosting requires the Windows desktop application. Saved plugin identity/state is preserved in the browser; native playback/export is unavailable.</p> : <>
        <p>Third-party plugins run native code with your user privileges, not in a security sandbox. Load only plugins you trust.</p>
        {channel.instrumentType === 'vst3' && <div>
          <strong>{channel.vst3?.name || 'Unresolved VST3 instrument'}</strong>
          <p className="break-all">{channel.vst3?.path}</p>
          <p>Class: {channel.vst3?.classId} · Channel fader/pan and mixer routing apply. Per-note pan/editor windows are not supported.</p>
          <button disabled={busy} type="button" onClick={() => void run(async () => { await audioEngine.prepareVst3Channel(channel); })}>Retry saved instrument</button>
          <button disabled={busy} type="button" onClick={() => onUpdateChannel(channel.id, { instrumentType: 'minisynth' })} className="ml-4">Use built-in MiniSynth instead (undoable)</button>
        </div>}
        <div className="flex gap-4">
          <button disabled={busy} type="button" onClick={() => void run(async () => { if (await bridge.choosePath()) await scan(); })}>Add VST3 folder…</button>
          <button disabled={busy} type="button" onClick={() => void run(scan)}>Scan configured folders</button>
        </div>
        {paths.map(path => <p key={path} className="break-all text-[var(--apex-text-3)]">{path}</p>)}
        {plugins.map(plugin => <button key={`${plugin.path}:${plugin.classId}`} disabled={busy} type="button" onClick={() => void run(() => select(plugin))} className="block text-left border border-[var(--apex-border)] p-2 rounded w-full">
          {channel.instrumentType === 'vst3' ? (channel.vst3?.classId === plugin.classId ? 'Relink / restore' : 'Replace instrument with') : 'Load'} {plugin.name} · {plugin.vendor} {plugin.version}
          <span className="block text-[var(--apex-text-3)] break-all">{plugin.path} · {plugin.classId}</span>
        </button>)}
        {!busy && plugins.length === 0 && <p>No instruments listed. Add a folder and scan; discovery loads genuine plugin factories.</p>}
        {diagnostic && <p role="status">{diagnostic.message}{diagnostic.inputLatencyMs !== undefined ? ` · Last monitored input buffered by ${diagnostic.inputLatencyMs} ms (plus device latency)` : ''}</p>}
      </>}
      {busy && <p role="status">Waiting for native plugin…</p>}
      {errors.map((error, index) => <p role="alert" key={index} className="break-all">{error} The project has not been changed.</p>)}
    </>}
  </section>;
}
