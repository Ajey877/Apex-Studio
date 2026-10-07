import React from 'react';
import type { ThemeMode } from '../state/theme';
import { ModalFrame } from './ModalFrame';

interface AppearanceSettingsModalProps {
  isOpen: boolean;
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  onClose: () => void;
}

export const AppearanceSettingsModal: React.FC<AppearanceSettingsModalProps> = ({ isOpen, mode, onChange, onClose }) => {
  if (!isOpen) return null;

  return (
    <ModalFrame
      id="appearance-settings-modal"
      labelledBy="appearance-settings-modal-title"
      onClose={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
    >
      <div className="apex-dialog w-[min(92vw,32rem)] border border-[var(--apex-border)] bg-[var(--apex-surface)] p-5 text-[var(--apex-text)]">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="appearance-settings-modal-title" className="text-base font-semibold">Settings</h2>
            <p className="mt-1 text-xs text-[var(--apex-text-2)]">Appearance and accessibility preferences</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close Settings" className="apex-icon-btn rounded-md px-2 text-[var(--apex-text-2)] hover:text-[var(--apex-text)]">✕</button>
        </div>
        <fieldset>
          <legend className="mb-3 text-sm font-semibold">Appearance</legend>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Color theme">
            {(['dark', 'light'] as const).map(option => (
              <label key={option} className={`cursor-pointer rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-[var(--apex-state-focus)] ${mode === option ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]' : 'border-[var(--apex-border)] hover:border-[var(--apex-accent)]'}`}>
                <input type="radio" name="theme-mode" value={option} checked={mode === option} onChange={() => onChange(option)} className="sr-only" />
                <span className="block text-sm font-medium">{option === 'dark' ? 'Dark' : 'Light'}</span>
                <span className="mt-1 block text-xs text-[var(--apex-text-2)]">{option === 'dark' ? 'Midnight Aurora' : 'Bright workspace'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </ModalFrame>
  );
};
