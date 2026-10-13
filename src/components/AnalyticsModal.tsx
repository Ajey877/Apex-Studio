import React, { useEffect, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  BarChart2, 
  Clock, 
  X, 
  Music, 
  Sliders, 
  Flame, 
  Activity, 
  CheckCircle,
  TrendingUp
} from 'lucide-react';
import { Channel, PlaylistClip, ProjectMetadata } from '../types/daw';
import { listProjectBackups, type ProjectBackupSummary } from '../state/projectBackup';

interface AnalyticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  meta: ProjectMetadata;
  channels: Channel[];
  clips: PlaylistClip[];
  /**
   * Phase 68 F4: the real save state the persistence layer reports
   * (`App.saveError`). A failed write is the most safety-critical thing this
   * modal can say, so it takes precedence over the backup listing.
   */
  saveError?: string | null;
}

/** Everything the backup row is allowed to depend on; every field is observable. */
export interface OfflineBackupState {
  /** True while the real backup records are still being read. */
  loading: boolean;
  /** Real backup records (`listProjectBackups`); omitted while loading. */
  backups?: ProjectBackupSummary[];
  /** Set when the backup store could not be read. */
  error?: string | null;
  /** Set when the project could not be persisted. */
  saveError?: string | null;
}

/**
 * Phase 68 F4 — what the "Offline Backup Status" row says.
 *
 * The row used to be the constant "Synchronized & Cached", which claimed a
 * backup that no state backed. It now reports only what the application can
 * actually observe: a failed save, an unreadable store, no backup yet, or the
 * real records the Project Manager lists. There is deliberately no plain
 * "backed up" claim — the product has no background synchronization, and this
 * function must never invent one.
 */
export const describeOfflineBackupStatus = (state: OfflineBackupState): string => {
  const saveError = typeof state.saveError === 'string' && state.saveError.trim().length > 0
    ? state.saveError.trim()
    : null;
  if (saveError) return `Save failed — ${saveError}`;
  if (state.loading) return 'Checking offline backups…';
  if (state.error) return `Unavailable — ${state.error}`;
  const backups = state.backups ?? [];
  if (backups.length === 0) return 'No offline backup yet';
  const newest = backups.reduce((latest, record) => (record.createdAt > latest ? record.createdAt : latest), backups[0].createdAt);
  const noun = backups.length === 1 ? 'offline backup' : 'offline backups';
  return `${backups.length} ${noun} · newest ${formatBackupTime(newest)}`;
};

/** Mirrors `ProjectManagerModal`'s existing backup timestamp presentation. */
const formatBackupTime = (timestamp: number): string => {
  try {
    return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(timestamp).toISOString();
  }
};

/**
 * The recorded edit time, formatted for the stopwatch banner.
 *
 * Returns `null` when the project has not recorded any edit time: the banner
 * states that explicitly instead of printing a stopwatch value (or a fabricated
 * 30 minutes) that was never measured.
 */
const formatRecordedSessionTime = (totalEditTimeSeconds: unknown): string | null => {
  const seconds = typeof totalEditTimeSeconds === 'number' && Number.isFinite(totalEditTimeSeconds)
    ? Math.max(0, Math.floor(totalEditTimeSeconds))
    : 0;
  if (seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

export const AnalyticsModal: React.FC<AnalyticsModalProps> = ({
  isOpen,
  onClose,
  meta,
  channels,
  clips,
  saveError
}) => {
  const [backups, setBackups] = useState<ProjectBackupSummary[] | null>(null);
  const [backupsError, setBackupsError] = useState<string | null>(null);

  // The modal cannot know the backup state by itself, so it reads the same real
  // records the Project Manager modal lists. Until they resolve, the row says
  // what it is doing rather than claiming a completed synchronization.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    listProjectBackups()
      .then(records => {
        if (cancelled) return;
        setBackups(records);
        setBackupsError(null);
      })
      .catch(error => {
        if (cancelled) return;
        setBackups([]);
        setBackupsError(error instanceof Error ? error.message : 'Backups are unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const totalNotes = channels.reduce((acc, ch) => acc + (ch.notes?.length || 0), 0);
  const activeChannelsCount = channels.filter(c => !c.mute).length;
  const activeClipsCount = clips.length;

  const sessionSeconds = formatRecordedSessionTime(meta.totalEditTimeSeconds);
  const backupState: OfflineBackupState = {
    loading: backups === null && backupsError === null,
    backups: backups ?? [],
    error: backupsError,
    saveError
  };
  const backupStatus = describeOfflineBackupStatus(backupState);
  const backupTone =
    backupState.saveError || backupState.error ? 'text-[var(--apex-danger)]' : backupState.loading ? 'text-[var(--apex-text-3)]' : 'text-[var(--apex-success)]';

  return (
    // UI-03O: the statistics panel is fully themed through the existing
    // `--apex-*` tokens. Its metric identity (tile, tile glyph, the two numeric
    // read-outs, the clock inset) stays on `--apex-accent` — the token the UI-1C
    // compatibility layer already resolved these `#ff6e00` literals to, so the
    // rendered identity hue is unchanged. Genuine status stays semantic: the
    // FLOW STATE badge is `--apex-success`, and the backup row is `--apex-danger`
    // on a failed or unreadable store, `--apex-text-3` while reading and
    // `--apex-success` only for real records. `text-[#ff6b6b]` was never covered
    // by the compatibility layer, so the failure row previously painted a raw
    // near-white red in Light; it now follows the theme. The dead `bg-black/85`
    // scrim is gone: ModalFrame supplies `--apex-modal-overlay`.
    <ModalFrame
      id="analytics-modal"
      labelledBy="analytics-modal-title"
      onClose={onClose}
      className="fixed inset-0 backdrop-blur-sm z-50 flex items-center justify-center p-4"
    >
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[var(--apex-text-2)]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded flex items-center justify-center">
              <BarChart2 className="w-4 h-4 text-[var(--apex-accent)]" />
            </div>
            <div>
              <h3 id="analytics-modal-title" className="font-bold text-sm text-[var(--apex-text)] tracking-tight">
                STUDIO TELEMETRY & PRODUCTION METRICS
              </h3>
              <p className="text-[10px] text-[var(--apex-text-3)]">Time Tracking, Arranger Density & Performance Stats</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            aria-label="Close analytics"
            className="p-1 rounded hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Main Stopwatch Banner */}
          <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-3 bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] text-[var(--apex-accent)] rounded-lg border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)]">
                <Clock className="w-6 h-6 animate-spin-slow" />
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-[var(--apex-text-3)] tracking-wider">Recorded Studio Session Time</span>
                <div className="text-2xl font-mono font-bold text-[var(--apex-text)]">{sessionSeconds ?? 'Not recorded'}</div>
              </div>
            </div>
            <div className="text-right">
              {/* UI-03O: the FLOW STATE badge keeps its green identity on the
                  success wash and border; the label follows `--apex-text`.
                  Measured in Chromium, the legacy success-on-success-wash
                  combination is 4.32:1 in Light (the 10px bold label's AA floor
                  is 4.5:1) and 6.11:1 in Dark, so one label token serves both. */}
              <span className="text-[10px] text-[var(--apex-text)] font-bold bg-[color-mix(in_srgb,var(--apex-success)_16%,transparent)] px-2 py-0.5 rounded border border-[color-mix(in_srgb,var(--apex-success)_48%,transparent)]">
                FLOW STATE
              </span>
            </div>
          </div>

          {/* Grid Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] p-3 rounded-lg">
              <span className="text-[10px] text-[var(--apex-text-3)]">Total Notes</span>
              <div className="text-lg font-bold text-[var(--apex-accent)] font-mono">{totalNotes}</div>
            </div>
            <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] p-3 rounded-lg">
              <span className="text-[10px] text-[var(--apex-text-3)]">Active Channels</span>
              <div className="text-lg font-bold text-[var(--apex-text)] font-mono">{activeChannelsCount}</div>
            </div>
            <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] p-3 rounded-lg">
              <span className="text-[10px] text-[var(--apex-text-3)]">Arranged Clips</span>
              <div className="text-lg font-bold text-[var(--apex-text)] font-mono">{activeClipsCount}</div>
            </div>
            <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] p-3 rounded-lg">
              <span className="text-[10px] text-[var(--apex-text-3)]">Project BPM</span>
              <div className="text-lg font-bold text-[var(--apex-accent)] font-mono">{meta.bpm}</div>
            </div>
          </div>

          {/* Project Details */}
          <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] p-3 rounded-lg space-y-1.5 text-xs">
            <div className="flex justify-between text-[var(--apex-text-3)]">
              <span>Project ID:</span>
              <span className="font-mono text-[var(--apex-text)]">{meta.id}</span>
            </div>
            <div className="flex justify-between text-[var(--apex-text-3)]">
              <span>Project Format Version:</span>
              <span className="font-mono text-[var(--apex-text)]">{meta.version ? `v${meta.version}` : 'Unknown'}</span>
            </div>
            <div className="flex justify-between text-[var(--apex-text-3)]">
              <span>Offline Backup Status:</span>
              <span className={`font-mono ${backupTone}`}>{backupStatus}</span>
            </div>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
};
