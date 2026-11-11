import React, { useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import type { Vst3EditorView } from '../audio/nativeVst3EditorSession';

const control = 'rounded border border-[var(--apex-border)] bg-[var(--apex-surface-2)] px-2 py-1 text-[10px] disabled:opacity-40';

/**
 * Status and lifecycle panel for a genuine VST3 editor.
 *
 * The plug-in's own editor lives in a separate native OS window painted by the
 * plug-in (not by this component). This panel exists so the app can say which
 * plug-in owns that window, show the validated parameter callbacks the plug-in
 * is sending, and — importantly — let the user close it deliberately and see
 * whether the captured final state reached the project or the recovery file.
 */
export function Vst3EditorWindowPanel({ view, busy, onClose, onDismiss }: {
  view: Vst3EditorView;
  busy: boolean;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const finished = view.phase === 'committed' || view.phase === 'recovered' || view.phase === 'failed';
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <ModalFrame
      onClose={onDismiss}
      dismissible={!busy && view.phase !== 'closing'}
      labelledBy="vst3-editor-window-title"
      id="vst3-editor-window-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3"
    >
      <section className="w-full max-w-md space-y-2 rounded border border-[var(--apex-border)] bg-[var(--apex-panel)] p-3 text-[var(--apex-text)]">
        <header className="flex items-start justify-between gap-2">
          <div>
            <h2 id="vst3-editor-window-title" className="text-sm font-bold">
              {view.name ? `Native VST3 editor · ${view.name}` : 'Native VST3 editor'}
            </h2>
            <p className="text-[9px] text-[var(--apex-text-3)]">
              The plug-in draws its own controls in a separate Windows window. Closing that window saves its final state here.
            </p>
          </div>
          <span className="rounded border border-[var(--apex-border)] px-1.5 py-0.5 text-[9px] uppercase">{view.phase}</span>
        </header>
        <p role="status" className="text-[10px]" data-testid="vst3-editor-status">{view.status}</p>
        {view.error && <p role="alert" className="text-[9px] text-[var(--apex-danger)]" data-testid="vst3-editor-error">{view.error}</p>}
        <p className="text-[9px] text-[var(--apex-text-3)]" data-testid="vst3-editor-callbacks">
          {view.editedParameterIds.length} parameter{view.editedParameterIds.length === 1 ? '' : 's'} changed by the plug-in
          {view.activeEditIds.length ? ` · ${view.activeEditIds.length} gesture(s) in progress` : ''}
          {view.dirty ? ' · plug-in reports unsaved internal state' : ''}
        </p>
        <div className="flex justify-end gap-1">
          {!finished && (
            <button ref={closeRef} className={control} disabled={busy || view.phase === 'closing'} onClick={onClose}>
              {view.phase === 'closing' ? 'Capturing final state…' : 'Close editor and save state'}
            </button>
          )}
          {finished && <button ref={closeRef} className={control} onClick={onDismiss}>Dismiss</button>}
        </div>
      </section>
    </ModalFrame>
  );
}
