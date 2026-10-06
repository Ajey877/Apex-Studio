import React, { useEffect, useId, useRef } from 'react';
import type { ThemeMode } from '../state/theme';

interface AppearanceSettingsModalProps {
  isOpen: boolean;
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  onClose: () => void;
}

export const AppearanceSettingsModal: React.FC<AppearanceSettingsModalProps> = ({ isOpen, mode, onChange, onClose }) => {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (isOpen) closeRef.current?.focus(); }, [isOpen]);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <section className="w-[min(92vw,32rem)] rounded-[var(--apex-radius-lg)] border border-[var(--apex-border)] bg-[var(--apex-surface)] p-5 text-[var(--apex-text)] shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div><h2 id={titleId} className="text-base font-semibold">Settings</h2><p className="mt-1 text-xs text-[var(--apex-text-2)]">Appearance and accessibility preferences</p></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close Settings" className="apex-icon-btn rounded-md px-2 text-[var(--apex-text-2)] hover:text-[var(--apex-text)]">✕</button>
        </div>
        <fieldset>
          <legend className="mb-3 text-sm font-semibold">Appearance</legend>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Color theme">
            {(['dark', 'light'] as const).map(option => (
              <label key={option} className={`cursor-pointer rounded-lg border p-3 transition-colors ${mode === option ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]' : 'border-[var(--apex-border)] hover:border-[var(--apex-accent)]'}`}>
                <input type="radio" name="theme-mode" value={option} checked={mode === option} onChange={() => onChange(option)} className="sr-only" />
                <span className="block text-sm font-medium">{option === 'dark' ? 'Dark' : 'Light'}</span>
                <span className="mt-1 block text-xs text-[var(--apex-text-2)]">{option === 'dark' ? 'Midnight Aurora' : 'Bright workspace'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
    </div>
  );
};
