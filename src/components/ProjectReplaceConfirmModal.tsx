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
      <div className="bg-[#141416] border border-[#ff6e00]/50 rounded-xl w-full max-w-md shadow-2xl overflow-hidden text-[#b0b0b0]">
        <div className="px-4 py-3 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <h3 id="project-replace-confirm-title" className="font-bold text-sm text-white tracking-tight">REPLACE CURRENT PROJECT?</h3>
          </div>
          <button
            id="project-replace-cancel-icon"
            onClick={onCancel}
            disabled={isWorking}
            className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition disabled:opacity-40"
            title="Keep current project"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <p className="text-[#d0d0d0] leading-relaxed select-text">
            <strong className="text-white">{plan.currentName}</strong> is open and contains work.
            {' '}{describeReplacementSource(plan.source)} will replace it with <strong className="text-white">{plan.incomingName}</strong>.
          </p>

          <div className="flex items-start gap-2 p-2.5 bg-[#121214] border border-[#222225] rounded-lg text-[11px] text-[#999]">
            <ArchiveRestore className="w-4 h-4 text-[#00ff88] shrink-0 mt-0.5" />
            <span>
              A backup of <strong className="text-[#ddd]">{plan.currentName}</strong> (including its audio) is saved first and can be
              restored from <strong className="text-[#ddd]">Project Hub → Recent Backups</strong>. The {MAX_PROJECT_BACKUPS} most recent backups are kept.
            </span>
          </div>

          {backupError && (
            <div id="project-replace-backup-error" role="alert" className="p-2.5 bg-[#361111] border border-red-500/60 rounded-lg text-[11px] text-red-200 select-text">
              <strong>Backup failed:</strong> {backupError}. Retry the backup or keep the current project.
            </div>
          )}

          {error && (
            <div id="project-replace-error" role="alert" className="p-2.5 bg-[#361111] border border-red-500/60 rounded-lg text-[11px] text-red-200 select-text">
              <strong>Project could not be loaded:</strong> {error}. The current project was not changed.
            </div>
          )}
        </div>

        <div className="px-4 py-3 bg-[#1a1a1d] border-t border-[#333336] flex flex-wrap items-center justify-end gap-2">
          <button
            id="project-replace-cancel-btn"
            onClick={onCancel}
            disabled={isWorking}
            className="px-3 py-1.5 bg-[#25252a] hover:bg-[#333338] text-white font-bold text-xs rounded border border-[#444] transition disabled:opacity-40"
          >
            Keep Current Project
          </button>
          <button
            id="project-replace-confirm-btn"
            onClick={onConfirm}
            disabled={isWorking || Boolean(error)}
            className="px-3 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition disabled:opacity-40"
          >
            {isWorking ? 'Backing Up…' : backupError ? 'Retry Backup & Replace' : 'Back Up & Replace'}
          </button>
        </div>
      </div>
    </div>
  );
};
