import React from 'react';
import { AlertTriangle, ArchiveRestore, X } from 'lucide-react';
import type { ProjectReplacementPlan } from '../state/projectReplacement';
import { describeReplacementSource } from '../state/projectReplacement';
import { MAX_PROJECT_BACKUPS } from '../state/projectBackup';

interface ProjectReplaceConfirmModalProps {
  plan: ProjectReplacementPlan | null;
  isWorking: boolean;
  /** Set when the backup step failed; the user may retry or cancel. */
  backupError: string | null;
  /** Set when replacement failed for a reason other than the backup. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Phase 8A — explicit confirmation before the open project is replaced.
 * Rendered above every other modal (z-60) because the request can originate
 * from the Project Hub or bundle importer, which are themselves modals.
 */
export const ProjectReplaceConfirmModal: React.FC<ProjectReplaceConfirmModalProps> = ({
  plan,
  isWorking,
  backupError,
  error,
  onConfirm,
  onCancel
}) => {
  if (!plan) return null;

  return (
    <div
      id="project-replace-confirm-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="project-replace-confirm-title"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-3 sm:p-4"
    >
      <div className="bg-[var(--apex-panel)] border border-[var(--apex-state-selected-border)] rounded-xl w-full max-w-md shadow-2xl overflow-hidden text-[var(--apex-text-2)]">
        <div className="px-4 py-3 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-[var(--apex-state-selected)] border border-[var(--apex-state-selected-border)] rounded flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-[var(--apex-accent)]" />
            </div>
            <h3 id="project-replace-confirm-title" className="font-bold text-sm text-[var(--apex-text)] tracking-tight">REPLACE CURRENT PROJECT?</h3>
          </div>
          <button
            id="project-replace-cancel-icon"
            onClick={onCancel}
            disabled={isWorking}
            className="p-1 rounded hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)] transition disabled:opacity-40"
            title="Keep current project"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <p className="text-[var(--apex-text-2)] leading-relaxed select-text">
            <strong className="text-[var(--apex-text)]">{plan.currentName}</strong> is open and contains work.
            {' '}{describeReplacementSource(plan.source)} will replace it with <strong className="text-[var(--apex-text)]">{plan.incomingName}</strong>.
          </p>

          <div className="flex items-start gap-2 p-2.5 bg-[var(--apex-chrome-inset)] border border-[var(--apex-grid-line)] rounded-lg text-[11px] text-[var(--apex-text-muted)]">
            <ArchiveRestore className="w-4 h-4 text-[var(--apex-success)] shrink-0 mt-0.5" />
            <span>
              A backup of <strong className="text-[var(--apex-text)]">{plan.currentName}</strong> (including its audio) is saved first and can be
              restored from <strong className="text-[var(--apex-text)]">Project Hub → Recent Backups</strong>. The {MAX_PROJECT_BACKUPS} most recent backups are kept.
            </span>
          </div>

          {backupError && (
            <div id="project-replace-backup-error" role="alert" className="p-2.5 bg-[color-mix(in_srgb,var(--apex-danger)_12%,var(--apex-panel))] border border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)] rounded-lg text-[11px] text-[var(--apex-danger)] select-text">
              <strong>Backup failed:</strong> {backupError}. Retry the backup or keep the current project.
            </div>
          )}

          {error && (
            <div id="project-replace-error" role="alert" className="p-2.5 bg-[color-mix(in_srgb,var(--apex-danger)_12%,var(--apex-panel))] border border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)] rounded-lg text-[11px] text-[var(--apex-danger)] select-text">
              <strong>Project could not be loaded:</strong> {error}. The current project was not changed.
            </div>
          )}
        </div>

        <div className="px-4 py-3 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex flex-wrap items-center justify-end gap-2">
          <button
            id="project-replace-cancel-btn"
            onClick={onCancel}
            disabled={isWorking}
            className="px-3 py-1.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text)] font-bold text-xs rounded border border-[var(--apex-border)] transition disabled:opacity-40"
          >
            Keep Current Project
          </button>
          <button
            id="project-replace-confirm-btn"
            onClick={onConfirm}
            disabled={isWorking || Boolean(error)}
            className="px-3 py-1.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition disabled:opacity-40"
          >
            {isWorking ? 'Backing Up…' : backupError ? 'Retry Backup & Replace' : 'Back Up & Replace'}
          </button>
        </div>
      </div>
    </div>
  );
};
