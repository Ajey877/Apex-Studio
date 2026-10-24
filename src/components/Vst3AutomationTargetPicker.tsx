import React, { useEffect, useState } from 'react';
import type { Channel, PlaylistClip } from '../types/daw';
import { getVst3Bridge, type Vst3Parameter } from '../audio/nativeVst3Types';
import { isAutomatable, nativeTarget, nativeTargetMatches } from '../audio/nativeVst3Automation';
import { validateMetadata } from '../../native/vst3/parameters.mjs';

const control = 'rounded border border-[var(--apex-border)] bg-[var(--apex-surface-2)] text-[var(--apex-text)] px-2 py-1 disabled:opacity-40';

/** Only explicit association publishes a target/history operation. Metadata and
 * selection are local; a late describe response cannot rebind a saved lane. */
export function Vst3AutomationTargetPicker({ channels, target, onBind }: {
  channels: Channel[]; target: NonNullable<PlaylistClip['automationTarget']>;
  onBind: (target: NonNullable<PlaylistClip['automationTarget']>) => void;
}) {
  const [channelId, setChannelId] = useState(String(target.targetId || channels.find(c => c.instrumentType === 'vst3')?.id || ''));
  const channel = channels.find(c => c.id === channelId && c.instrumentType === 'vst3');
  const [parameters, setParameters] = useState<Vst3Parameter[]>([]);
  const [parameterId, setParameterId] = useState('');
  const [status, setStatus] = useState('Loading controller metadata…');
  const bindingKey = JSON.stringify(target);
  useEffect(() => {
    let cancelled = false;
    setParameters([]); setParameterId(''); setStatus('Loading controller metadata…');
    const bridge = getVst3Bridge();
    if (!bridge || !channel?.vst3) { setStatus('Unavailable target: select a loaded desktop VST3 instrument.'); return; }
    void bridge.describe(channel.vst3).then(result => {
      const metadata = validateMetadata(result.parameters, result.controllerAvailable).filter(isAutomatable);
      if (cancelled) return;
      setParameters(metadata);
      const saved = nativeTargetMatches(target, channel) ? metadata.find(p => p.id === target.native?.parameterId) : undefined;
      setParameterId(String(saved?.id ?? metadata[0]?.id ?? ''));
      setStatus(!metadata.length ? 'Unavailable target: no supported automatable controller parameters.' :
        saved ? 'Target available. Curve values are normalized 0–1.' : 'Unavailable/unassociated target. Choose a genuine parameter and explicitly associate it.');
    }).catch(error => { if (!cancelled) setStatus(`Unavailable target: ${error.message}`); });
    return () => { cancelled = true; };
  }, [channel?.id, channel?.vst3, bindingKey]);
  const parameter = parameters.find(p => String(p.id) === parameterId);
  return <div aria-label="Native VST3 automation target" className="space-y-2">
    <p>Native automation uses the existing Playlist curve. Saved base values are not rewritten. Endpoints latch until the next clip or transport reset.</p>
    {target.native && <p>Saved: {target.label} · {target.native.path} · {target.native.classId}</p>}
    <label>VST3 automation channel <select className={control} value={channelId} onChange={e => setChannelId(e.target.value)}>
      <option value="">Choose loaded instrument</option>
      {channels.filter(c => c.instrumentType === 'vst3').map(c => <option key={c.id} value={c.id}>{c.name} · {c.vst3?.name || 'Unresolved instrument'}</option>)}
    </select></label>
    <label>VST3 automation parameter <select className={control} value={parameterId} onChange={e => setParameterId(e.target.value)} disabled={!parameters.length}>
      {!parameters.length && <option value="">No genuine parameters available</option>}
      {parameters.map(p => <option key={p.id} value={p.id}>{p.name || `Unnamed parameter #${p.id}`} · ID {p.id}{p.units ? ` · ${p.units}` : ''}</option>)}
    </select></label>
    <button className={control} disabled={!channel || !parameter} onClick={() => { if (channel && parameter) onBind(nativeTarget(channel, parameter)); }}>Associate VST3 parameter</button>
    <p role="status">{status}</p>
  </div>;
}
