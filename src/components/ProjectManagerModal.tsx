import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Download, Upload, X, Plus, ArchiveRestore, Trash2, RotateCcw } from 'lucide-react';
import { ProjectState, ProjectMetadata } from '../types/daw';
import { PRESET_PROJECTS } from '../audio/presets';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { deleteProjectBackup, listProjectBackups, restoreProjectBackupState, type ProjectBackupSummary } from '../state/projectBackup';
import type { ProjectReplacementSource } from '../state/projectReplacement';


interface ProjectManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentState: ProjectState;
  /** Resolves false when the user kept the current project (replacement confirmation declined). */
  onLoadProject: (state: ProjectState, options?: { source?: ProjectReplacementSource }) => boolean | void | Promise<boolean | void>;
  onUpdateMeta: (meta: Partial<ProjectMetadata>) => void;
}

const formatBackupTime = (timestamp: number): string => {
  try {
    return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(timestamp).toISOString();
  }
};

export const ProjectManagerModal: React.FC<ProjectManagerModalProps> = ({ isOpen, onClose, currentState, onLoadProject, onUpdateMeta }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [backups, setBackups] = useState<ProjectBackupSummary[]>([]);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [busyBackupId, setBusyBackupId] = useState<string | null>(null);

  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await listProjectBackups());
      setBackupsError(null);
    } catch (error) {
      console.warn('[Apex Studio] Could not list project backups.', error);
      setBackups([]);
      setBackupsError(error instanceof Error ? error.message : 'Backups are unavailable');
    }
  }, []);

  // Backups are written by the replacement flow, so refresh whenever the hub opens.
  useEffect(() => {
    if (!isOpen) return;
    void refreshBackups();
  }, [isOpen, refreshBackups]);

  if (!isOpen) return null;

  const loadProject = async (state: ProjectState, source: ProjectReplacementSource): Promise<boolean> => {
    const replaced = await onLoadProject(state, { source });
    return replaced !== false;
  };

  const handleExportProjectJson = () => {
    const jsonStr = JSON.stringify(currentState, (key, value) => {
      if (key === 'audioBlob' || key === 'audioUrl' || key === 'blob' || key === 'url') return undefined;
      return value;
    }, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentState.meta.name.toLowerCase().replace(/\s+/g, '_')}.flmp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const normalized = normalizeProjectState(parsed);
      if (await loadProject(normalized, 'manifest-import')) onClose();
    } catch (err) {
      console.error('Could not load project file.', err);
      window.alert(err instanceof Error ? err.message : 'Could not load project file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleCreateBlankProject = async () => {
    if (await loadProject(createDefaultProjectState(), 'new-session')) onClose();
  };

  const handleLoadPreset = async (state: ProjectState) => {
    if (await loadProject(structuredClone(state), 'studio-demo')) onClose();
  };

  const handleRestoreBackup = async (backup: ProjectBackupSummary) => {
    setBusyBackupId(backup.id);
    try {
      const state = await restoreProjectBackupState(backup.id);
      if (!state) {
        window.alert('This backup is no longer available.');
        await refreshBackups();
        return;
      }
      if (await loadProject(state, 'backup-restore')) onClose();
    } catch (err) {
      console.error('Could not restore project backup.', err);
      window.alert(err instanceof Error ? err.message : 'Could not restore project backup.');
    } finally {
      setBusyBackupId(null);
    }
  };

  const handleDeleteBackup = async (backup: ProjectBackupSummary) => {
    if (!window.confirm(`Delete the backup of "${backup.name}" from ${formatBackupTime(backup.createdAt)}? Audio used only by this backup will be cleaned up on the next save.`)) return;
    setBusyBackupId(backup.id);
    try {
      await deleteProjectBackup(backup.id);
      await refreshBackups();
    } catch (err) {
      console.error('Could not delete project backup.', err);
      window.alert(err instanceof Error ? err.message : 'Could not delete project backup.');
    } finally {
      setBusyBackupId(null);
    }
  };

  return (
    <div id="project-manager-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] max-h-[90vh] flex flex-col">
        <div className="px-4 sm:px-5 py-3 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center"><FolderOpen className="w-4 h-4 text-[#ff6e00]" /></div>
            <div><h3 className="font-bold text-sm text-white tracking-tight">STUDIO PROJECT HUB & DEMO TEMPLATES</h3><p className="text-[10px] text-[#777]">Open Demos, Backup Project Manifest (.flmp), or Start a New Beat</p></div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          <div className="grid grid-cols-3 gap-3">
            <button onClick={handleCreateBlankProject} className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00] rounded-lg text-left transition flex flex-col space-y-1">
              <Plus className="w-4 h-4 text-[#ff6e00]" /><div className="text-xs font-bold text-white">New Session</div><div className="text-[9px] text-[#777]">Initialize clean 128 BPM grid</div>
            </button>
            <button onClick={handleExportProjectJson} className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00] rounded-lg text-left transition flex flex-col space-y-1">
              <Download className="w-4 h-4 text-[#00ff00]" /><div className="text-xs font-bold text-white">Backup Manifest (.flmp)</div><div className="text-[9px] text-[#777]">Project manifest/state backup (no audio)</div>
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00] rounded-lg text-left transition flex flex-col space-y-1">
              <Upload className="w-4 h-4 text-cyan-400" /><div className="text-xs font-bold text-white">Open Manifest (.flmp)</div><div className="text-[9px] text-[#777]">Loads project state; rehydrates local audio</div>
            </button>
          </div>

          <div className="p-2.5 bg-[#121214] border border-[#222225] rounded-lg text-[10px] text-[#888]">
            <span><strong>Format Guide:</strong> .flmp = project manifest/state backup. For a portable bundle containing audio assets, use <strong>Portable ZIP</strong>. Opening a demo, manifest or bundle replaces the current project after confirmation and keeps an automatic backup below.</span>
          </div>

          <input type="file" ref={fileInputRef} onChange={handleImportFile} accept=".json,.flmp" className="hidden" />

          <div className="p-3.5 bg-[#1a1a1d] border border-[#333336] rounded-lg space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Active Project Details</div>
            <div className="flex items-center space-x-2">
              <input type="text" value={currentState.meta.name} onChange={(e) => onUpdateMeta({ name: e.target.value })} className="flex-1 bg-[#121214] border border-[#333336] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#ff6e00] font-bold" placeholder="Project title..." />
              <div className="text-[10px] text-[#777] font-mono bg-[#121214] px-2.5 py-1.5 rounded border border-[#333336]">{currentState.meta.bpm} BPM</div>
            </div>
          </div>

          <div id="project-recent-backups" className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#777] flex items-center gap-1.5"><ArchiveRestore className="w-3 h-3 text-[#00ff88]" /><span>Recent Backups (auto-saved before a project is replaced)</span></div>
              <button onClick={() => void refreshBackups()} className="text-[9px] font-bold text-[#777] hover:text-white transition flex items-center gap-1" title="Refresh backups"><RotateCcw className="w-3 h-3" /><span>REFRESH</span></button>
            </div>
            {backupsError ? (
              <div className="p-2.5 bg-[#361111] border border-red-500/40 rounded-lg text-[10px] text-red-200">Backups are unavailable: {backupsError}</div>
            ) : backups.length === 0 ? (
              <div className="p-2.5 bg-[#121214] border border-[#222225] rounded-lg text-[10px] text-[#666]">No backups yet. One is created automatically whenever a project with work is replaced.</div>
            ) : (
              <div className="space-y-1.5">
                {backups.map((backup) => (
                  <div key={backup.id} className="p-2.5 bg-[#1a1a1d] border border-[#333336] rounded-lg flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">{backup.name}</div>
                      <div className="text-[9px] text-[#777]">{formatBackupTime(backup.createdAt)} • {backup.channelCount} Instruments • {backup.clipCount} Clips • {backup.recordingCount} Takes • {backup.audioIds.length} Audio Assets</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => void handleRestoreBackup(backup)} disabled={busyBackupId !== null} className="px-2.5 py-1 bg-[#00ff88] hover:bg-[#00e67a] disabled:opacity-40 text-black font-bold text-[10px] rounded transition">{busyBackupId === backup.id ? 'WORKING…' : 'RESTORE'}</button>
                      <button onClick={() => void handleDeleteBackup(backup)} disabled={busyBackupId !== null} className="p-1 rounded hover:bg-[#2d2d30] disabled:opacity-40 text-[#777] hover:text-red-300 transition" title="Delete backup"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Studio Demo Templates & Genre Starters</div>
            <div className="space-y-2">
              {PRESET_PROJECTS.map((proj) => (
                <div key={proj.id} className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00]/50 rounded-lg flex items-center justify-between transition cursor-pointer" onClick={() => void handleLoadPreset(proj.state)}>
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center text-[#ff6e00] font-bold text-xs font-mono">{proj.bpm}</div>
                    <div><div className="text-xs font-bold text-white">{proj.name}</div><div className="text-[9px] text-[#777]">Producer: {proj.state.meta.author} • {proj.state.channels.length} Instruments • {proj.state.playlistClips?.length || 0} Arranged Clips</div></div>
                  </div>
                  <button onClick={(event) => { event.stopPropagation(); void handleLoadPreset(proj.state); }} className="px-3 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition">LOAD</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
