import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import type { PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { appendDraft, editWaveform, validateSelection, type FrameSelection, type WaveformOperation } from '../audio/waveformEditing';
import { openWaveformSession, WaveformAudition, type WaveformSession } from '../audio/waveformEditorCommit';

interface Props {
  clip: PlaylistClip; bpm: number; timeSignature: unknown;
  onClose(): void;
  onCommit(session: WaveformSession, buffer: AudioBuffer, signal: AbortSignal): Promise<void>;
}
const control = 'rounded border border-[var(--apex-border)] bg-[var(--apex-surface-2)] px-3 py-2 disabled:opacity-40';
export function WaveformEditorModal({ clip, bpm, timeSignature, onClose, onCommit }: Props) {
  const [session, setSession] = useState<WaveformSession | null>(null);
  const [draft, setDraft] = useState<{ buffers: AudioBuffer[]; index: number }>({ buffers: [], index: 0 });
  const working = draft.buffers[draft.index];
  const [selection, setSelection] = useState<FrameSelection>({ start: 0, end: 0 });
  const [zoom, setZoom] = useState(1), [position, setPosition] = useState(0);
  const [target, setTarget] = useState('-1'), [gain, setGain] = useState('-3');
  const [status, setStatus] = useState('Loading the selected clip’s actual PCM…');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const busyRef = useRef(false), abort = useRef(new AbortController());
  const audition = useRef(new WaveformAudition());
  const canvas = useRef<HTMLCanvasElement>(null), anchor = useRef<number | null>(null);
  useEffect(() => {
    // StrictMode may mount/clean/remount effects. Each load owns a fresh token.
    const controller = new AbortController(); abort.current = controller;
    void openWaveformSession(clip, bpm, timeSignature, audioEngine, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSession(value); setDraft({ buffers: [value.buffer], index: 0 });
      setSelection({ start: 0, end: value.buffer.length }); setStatus('Draft only — project and original asset are unchanged.');
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); });
    return () => { controller.abort(); audition.current.stop(); };
    // The App keys this modal by document generation and selected clip ID.
    // Other project edits invalidate publication instead of silently resetting a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stop = () => { audition.current.stop(); };
  const span = working ? Math.max(1, Math.ceil(working.length / zoom)) : 1;
  const start = working ? Math.min(position, Math.max(0, working.length - span)) : 0;
  const columns = useMemo(() => {
    if (!working) return [];
    return Array.from({ length: working.numberOfChannels }, (_, channel) => {
      const values = working.getChannelData(channel), points = new Float32Array(2000);
      for (let x = 0; x < 1000; x++) {
        const from = start + Math.floor(x * span / 1000), to = Math.min(working.length, start + Math.max(Math.floor((x + 1) * span / 1000), Math.floor(x * span / 1000) + 1));
        let min = Infinity, max = -Infinity;
        for (let i = from; i < to; i++) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); }
        points[x * 2] = Number.isFinite(min) ? min : 0; points[x * 2 + 1] = Number.isFinite(max) ? max : 0;
      }
      return points;
    });
  }, [working, start, span]);
  useEffect(() => {
    const node = canvas.current, ctx = node?.getContext('2d'); if (!ctx || !node || !working) return;
    const style = getComputedStyle(node);
    const color = style.getPropertyValue('--apex-accent').trim() || '#36d6ac';
    ctx.clearRect(0, 0, 1000, 260);
    const row = 230 / working.numberOfChannels;
    ctx.strokeStyle = color;
    columns.forEach((points, channel) => {
      const mid = 25 + row * (channel + 0.5);
      ctx.beginPath();
      for (let x = 0; x < 1000; x++) { ctx.moveTo(x, mid - points[x * 2] * row * 0.44); ctx.lineTo(x, mid - points[x * 2 + 1] * row * 0.44); }
      ctx.stroke();
    });
    ctx.fillStyle = style.getPropertyValue('--apex-text').trim() || '#ddd'; ctx.font = '12px monospace';
    for (let tick = 0; tick <= 5; tick++) ctx.fillText(`${((start + span * tick / 5) / working.sampleRate).toFixed(3)}s`, Math.min(940, tick * 200), 14);
    const left = Math.max(0, (selection.start - start) / span * 1000), right = Math.min(1000, (selection.end - start) / span * 1000);
    if (right > left) { ctx.globalAlpha = 0.2; ctx.fillStyle = color; ctx.fillRect(left, 20, right - left, 240); ctx.globalAlpha = 1; }
    for (const frame of [selection.start, selection.end]) {
      const x = (frame - start) / span * 1000;
      if (x >= 0 && x <= 1000) { ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, 260); ctx.stroke(); }
    }
  }, [working, columns, start, span, selection]);
  let selectionError = '';
  if (working) { try { validateSelection(working, selection); } catch (reason) { selectionError = (reason as Error).message; } }
  const frameAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(working?.length ?? 0, Math.round(start + (event.clientX - rect.left) / rect.width * span)));
  };
  const apply = async (operation: WaveformOperation) => {
    if (!working || busyRef.current) return;
    stop(); busyRef.current = true; setBusy(true); setError('');
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (abort.current.signal.aborted) return;
      const next = editWaveform(working, selection, operation, (c, n, sr) => audioEngine.getContext().createBuffer(c, n, sr));
      setDraft(previous => { const buffers = appendDraft(previous.buffers, previous.index, next); return { buffers, index: buffers.length - 1 }; });
      setSelection(operation.type === 'crop' || operation.type === 'delete' ? { start: 0, end: next.length } : selection);
      setPosition(0); setStatus(`${operation.type}: ${next.length} frames, ${(next.length / next.sampleRate).toFixed(4)} s. Draft only; Apply commits a new asset.`);
    } catch (reason) { setError((reason as Error).message); }
    finally { busyRef.current = false; if (!abort.current.signal.aborted) setBusy(false); }
  };
  const preview = async (buffer: AudioBuffer, range: FrameSelection) => {
    setError(''); try { await audition.current.play(audioEngine.getContext(), buffer, range.start, range.end); }
    catch (reason) { if (!abort.current.signal.aborted) setError((reason as Error).message); }
  };
  const changeDraft = (index: number) => { stop(); setDraft({ ...draft, index }); setSelection({ start: 0, end: draft.buffers[index].length }); setPosition(0); setStatus('Draft history restored — project is still unchanged.'); };
  return <ModalFrame onClose={onClose} labelledBy="waveform-editor-title" id="waveform-editor-modal" className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-3">
    <div className="w-full max-w-5xl max-h-[94vh] overflow-auto rounded-xl border border-[var(--apex-border)] bg-[var(--apex-panel)] text-[var(--apex-text)] p-4 space-y-3">
      <header className="flex justify-between gap-4"><div><h2 id="waveform-editor-title" className="text-lg font-bold">Waveform Audio Editor</h2><p>{clip.name} · clip {clip.id}</p></div><button className={control} onClick={onClose}>Cancel / close draft</button></header>
      <p className="text-xs text-[var(--apex-text-2)]">Edit the clip’s visible source region, before mixer/clip fades. Original asset is never overwritten. Crop keeps the selection at the clip’s existing start; Delete joins the remainder and shortens only this clip; Silence preserves duration. Other clips never ripple. Playback rate is retained.</p>
      {working && <>
        <p data-testid="editor-audio-info">{working.numberOfChannels} channel(s) · {working.sampleRate} Hz · {working.length} frames · {(working.length / working.sampleRate).toFixed(4)} seconds · zoom {zoom}×</p>
        <canvas ref={canvas} width={1000} height={260} className="w-full bg-[var(--apex-canvas)] rounded border border-[var(--apex-border)] touch-none" aria-label="Audio waveform. Drag to select; precise frame boundaries are editable below."
          onPointerDown={event => { if (busyRef.current) return; stop(); anchor.current = frameAt(event); event.currentTarget.setPointerCapture(event.pointerId); setSelection({ start: anchor.current, end: anchor.current }); }}
          onPointerMove={event => { if (anchor.current === null) return; const end = frameAt(event); setSelection({ start: Math.min(anchor.current, end), end: Math.max(anchor.current, end) }); }}
          onPointerUp={() => { anchor.current = null; }} onPointerCancel={() => { anchor.current = null; }} />
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
          <div className="flex flex-wrap items-center gap-3">
            <button className={control} onClick={() => setZoom(Math.min(128, zoom * 2))}>Zoom in</button><button className={control} onClick={() => setZoom(Math.max(1, zoom / 2))}>Zoom out</button>
            <label>Navigate <input aria-label="Waveform position" type="range" min={0} max={Math.max(0, working.length - span)} value={start} step={Math.max(1, Math.floor(span / 100))} onChange={event => setPosition(Number(event.target.value))} /></label>
            <label>Start frame <input className={control} aria-label="Selection start frame" type="number" min={0} max={working.length} value={selection.start} onChange={event => { stop(); setSelection({ ...selection, start: Number(event.target.value) }); }} /></label>
            <label>End frame (exclusive) <input className={control} aria-label="Selection end frame" type="number" min={0} max={working.length} value={selection.end} onChange={event => { stop(); setSelection({ ...selection, end: Number(event.target.value) }); }} /></label>
            <button className={control} onClick={() => { stop(); setSelection({ start: 0, end: working.length }); }}>Select all</button>
          </div>
          <p className="text-xs">Selection: {(selection.start / working.sampleRate).toFixed(4)}–{(selection.end / working.sampleRate).toFixed(4)} s · {selection.end - selection.start} frames. Operations affect all source channels in this range only.</p>
          <div className="flex flex-wrap gap-2">{(['crop', 'delete', 'silence', 'reverse', 'fade-in', 'fade-out'] as const).map(type => <button className={control} key={type} disabled={!!selectionError} onClick={() => void apply({ type })}>{type === 'crop' ? 'Crop to selection' : type.replace('-', ' ')}</button>)}</div>
          <div className="flex flex-wrap items-center gap-3"><label>Target dBFS <input aria-label="Normalize target dBFS" className={control} type="number" min={-60} max={0} step={0.1} value={target} onChange={event => setTarget(event.target.value)} /></label><button className={control} disabled={!!selectionError} onClick={() => void apply({ type: 'normalize', db: target.trim() ? Number(target) : NaN })}>Normalize selection</button>
            <label>Gain dB <input aria-label="Selection gain dB" className={control} type="number" min={-60} max={24} step={0.1} value={gain} onChange={event => setGain(event.target.value)} /></label><button className={control} disabled={!!selectionError} onClick={() => void apply({ type: 'gain', db: gain.trim() ? Number(gain) : NaN })}>Apply gain to selection</button></div>
          <div className="flex flex-wrap gap-2"><button className={control} disabled={!!selectionError} onClick={() => void preview(working, selection)}>Preview edited selection</button><button className={control} onClick={() => void preview(working, { start: 0, end: working.length })}>Preview all edits</button><button className={control} onClick={() => session && void preview(session.buffer, { start: 0, end: session.buffer.length })}>Preview original region</button><button className={control} onClick={stop}>Stop audition</button></div>
          <p className="text-xs">Audition is raw PCM at 80% monitor gain, independent of the project mixer. Linear fades include endpoints (one-frame fade becomes silence). Draft undo retains at most 8 versions / 128 MiB.</p>
          <div className="flex gap-2"><button className={control} disabled={draft.index === 0} onClick={() => changeDraft(draft.index - 1)}>Undo draft</button><button className={control} disabled={draft.index >= draft.buffers.length - 1} onClick={() => changeDraft(draft.index + 1)}>Redo draft</button>
            <button className={`${control} font-bold`} disabled={!session || working === session.buffer} onClick={() => {
              if (!session || busyRef.current) return; stop(); busyRef.current = true; setBusy(true); setError(''); setStatus('Persisting a new lossless audio asset before updating the selected clip…');
              void onCommit(session, working, abort.current.signal).catch(reason => { if (!abort.current.signal.aborted) setError((reason as Error).message); }).finally(() => { busyRef.current = false; if (!abort.current.signal.aborted) setBusy(false); });
            }}>Apply to selected clip</button></div>
        </fieldset>
      </>}
      {selectionError && <p role="alert">{selectionError}</p>}{error && <p role="alert" className="text-[var(--apex-danger)]">{error}</p>}
      <p role="status">{status}</p><p className="text-xs">Cancel discards the draft and stops audition. After Apply, use project Undo/Redo to restore the exact original/edited asset. No spectral repair, denoising or pitch-preserving DSP is claimed.</p>
    </div>
  </ModalFrame>;
}
