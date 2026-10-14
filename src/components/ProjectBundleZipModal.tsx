import React, { useState, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { Download, Upload, Sparkles, FolderArchive, X } from 'lucide-react';
import JSZip from 'jszip';
import { ProjectState } from '../types/daw';
import { normalizeProjectState } from '../state/projectState';
import { getPersistedAudioClip, persistAudioClip } from '../audio/audioPersistence';
import { getAudioIdsForProject } from '../state/projectPersistence';
import type { ProjectReplacementSource } from '../state/projectReplacement';

interface ProjectBundleZipModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectState: ProjectState;
  /** Resolves false when the user kept the current project (replacement confirmation declined). */
  onLoadProjectState: (state: ProjectState, options?: { source?: ProjectReplacementSource }) => boolean | void | Promise<boolean | void>;
}

interface BundleAudioFile {
  id: string;
  path: string;
  mimeType: string;
  size: number;
}

const sanitizeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'audio';

const buildPortableManifest = (projectState: ProjectState): string => JSON.stringify(projectState, (key, value) => {
  if (key === 'audioBlob' || key === 'blob') return undefined;
  return value;
}, 2);



export const ProjectBundleZipModal: React.FC<ProjectBundleZipModalProps> = ({
  isOpen,
  onClose,
  projectState,
  onLoadProjectState
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [includeSamples, setIncludeSamples] = useState(true);
  const [includeMidiFiles, setIncludeMidiFiles] = useState(true);
  const [bundleName, setBundleName] = useState(
    `${(projectState.meta.name || 'Apex_Project').replace(/\s+/g, '_')}_Bundle_${new Date().toISOString().slice(0, 10)}`
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const handleExportZip = async () => {
    try {
      setIsExporting(true);
      setStatusMessage('Collecting project manifest and audio assets...');

      const zip = new JSZip();
      const portableManifest = buildPortableManifest(projectState);
      zip.file('project_manifest.json', portableManifest);

      const audioFiles: BundleAudioFile[] = [];
      if (includeSamples) {
        const audioFolder = zip.folder('audio');
        for (const audioId of getAudioIdsForProject(projectState)) {
          try {
            const blob = await getPersistedAudioClip(audioId);
            if (!blob || blob.size === 0) continue;
            const path = `audio/${sanitizeFilePart(audioId)}.bin`;
            audioFolder?.file(path.replace('audio/', ''), blob);
            audioFiles.push({ id: audioId, path, mimeType: blob.type || 'application/octet-stream', size: blob.size });
          } catch (error) {
            console.warn(`[Apex Studio] Could not package audio asset ${audioId}`, error);
          }
        }
      }

      zip.file('bundle_manifest.json', JSON.stringify({
        format: 'apex-studio-project-bundle',
        formatVersion: 2,
        projectVersion: projectState.meta.version,
        audioFiles,
        generatedAt: new Date().toISOString(),
      }, null, 2));

      const readmeText = `=== APEX STUDIO DAW PROJECT BUNDLE ===
Project Name: ${projectState.meta.name}
Author: ${projectState.meta.author}
BPM: ${projectState.meta.bpm}
Time Signature: ${projectState.meta.timeSignature ? projectState.meta.timeSignature.join('/') : '4/4'}
Total Patterns: ${projectState.patterns.length}
Total Playlist Clips: ${projectState.playlistClips.length}
Total Mixer Tracks: ${projectState.mixerTracks.length}
Packaged Audio Assets: ${audioFiles.length}
Exported: ${new Date().toUTCString()}

Engine: Apex Studio Digital Audio Workstation
`;
      zip.file('README.txt', readmeText);

      if (includeMidiFiles) {
        const patternsFolder = zip.folder('patterns');
        projectState.patterns.forEach((pat, idx) => {
          const patData = {
            id: pat.id,
            name: pat.name,
            lengthSteps: pat.lengthSteps,
            channels: projectState.channels.map(ch => ({
              id: ch.id,
              name: ch.name,
              instrumentType: ch.instrumentType,
              steps: ch.steps,
              notes: ch.notes
            }))
          };
          patternsFolder?.file(`pattern_${idx + 1}_${sanitizeFilePart(pat.name)}.json`, JSON.stringify(patData, null, 2));
        });
      }

      const mixerFolder = zip.folder('mixer_routing');
      mixerFolder?.file('mixer_tracks.json', JSON.stringify(projectState.mixerTracks, null, 2));

      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${bundleName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      setIsExporting(false);
      setStatusMessage(`Created portable bundle with ${audioFiles.length} audio asset(s).`);
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err) {
      console.error(err);
      setIsExporting(false);
      setStatusMessage('Error creating project ZIP bundle.');
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleImportZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    const file = e.target.files[0];
    try {
      setIsImporting(true);
      setStatusMessage(`Unpacking "${file.name}"...`);

      const zip = await JSZip.loadAsync(file);
      const manifestFile = zip.file('project_manifest.json');
      if (!manifestFile) throw new Error('project_manifest.json not found in ZIP bundle');

      const manifestContent = await manifestFile.async('string');
      const loadedState = normalizeProjectState(JSON.parse(manifestContent));

      const bundleManifestFile = zip.file('bundle_manifest.json');
      let restoredAudioCount = 0;
      if (bundleManifestFile) {
        const bundleManifest = JSON.parse(await bundleManifestFile.async('string')) as { format?: string; formatVersion?: number; audioFiles?: BundleAudioFile[] };
        if (bundleManifest.format === 'apex-studio-project-bundle' && Array.isArray(bundleManifest.audioFiles)) {
          for (const audioFile of bundleManifest.audioFiles) {
            const entry = zip.file(audioFile.path);
            if (!entry || !audioFile.id) continue;
            const rawBlob = await entry.async('blob');
            const typedBlob = rawBlob.type ? rawBlob : new Blob([rawBlob], { type: audioFile.mimeType || 'application/octet-stream' });
            await persistAudioClip(audioFile.id, typedBlob);
            restoredAudioCount += 1;
          }
        }
      }

      const replaced = await onLoadProjectState(loadedState, { source: 'bundle-import' });
      setIsImporting(false);
      if (replaced === false) {
        setStatusMessage('Import cancelled — the current project was kept unchanged.');
        setTimeout(() => setStatusMessage(null), 3500);
        return;
      }
      setStatusMessage(`Imported "${loadedState.meta?.name || 'Project'}" and restored ${restoredAudioCount} audio asset(s).`);
      setTimeout(() => {
        setStatusMessage(null);
        onClose();
      }, 1500);
    } catch (err) {
      console.error(err);
      setIsImporting(false);
      setStatusMessage('Error unpacking ZIP archive. Please ensure it contains a valid Apex Studio bundle.');
      setTimeout(() => setStatusMessage(null), 4000);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <ModalFrame id="fl-project-zip-modal" labelledBy="fl-project-zip-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-accent)] to-[var(--apex-accent-strong)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold"><FolderArchive className="w-5 h-5" /></div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-project-zip-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">PROJECT ZIP ARCHIVE BUNDLER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)]">PORTABLE .ZIP</span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Portable ZIP = project state + audio assets (complete portable archive)</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close project bundler" className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"><X className="w-5 h-5" /></button>
        </div>

        {statusMessage && (
          <div className="bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5"><Sparkles className="w-4 h-4" /><span>{statusMessage}</span></div>
            <button onClick={() => setStatusMessage(null)} aria-label="Dismiss status message" className="text-[color-mix(in_srgb,var(--apex-state-playing-fg)_80%,transparent)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4 text-xs">
          <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] space-y-3">
            <span className="text-xs font-bold text-[var(--apex-text)] uppercase block">EXPORT COMPLETE PROJECT ZIP</span>
            <p className="text-[11px] text-[var(--apex-text-3)]">Portable ZIP bundle = project state + audio assets. Use this format to share sessions with all audio across computers.</p>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-[var(--apex-text-2)] font-bold block mb-1">ARCHIVE FILE NAME</label>
                <input type="text" value={bundleName} onChange={(e) => setBundleName(e.target.value)} className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] px-3 py-1.5 rounded border border-[var(--apex-border)] font-mono text-xs focus:border-[var(--apex-accent)] focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <label className="flex items-center gap-2 cursor-pointer bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                  <input type="checkbox" checked={includeMidiFiles} onChange={(e) => setIncludeMidiFiles(e.target.checked)} className="accent-[var(--apex-accent)]" />
                  <span className="text-[var(--apex-text)] font-bold text-[11px]">Include Pattern JSONs</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer bg-[var(--apex-canvas)] p-2 rounded border border-[var(--apex-border)]">
                  <input type="checkbox" checked={includeSamples} onChange={(e) => setIncludeSamples(e.target.checked)} className="accent-[var(--apex-accent)]" />
                  <span className="text-[var(--apex-text)] font-bold text-[11px]">Include Audio Assets</span>
                </label>
              </div>
            </div>
            <button onClick={handleExportZip} disabled={isExporting} className="w-full py-2 bg-gradient-to-r from-[var(--apex-accent)] to-[var(--apex-accent-strong)] hover:opacity-90 disabled:opacity-50 text-[var(--apex-state-playing-fg)] font-bold rounded-lg transition shadow flex items-center justify-center gap-2">
              <Download className="w-4 h-4" /><span>{isExporting ? 'Packaging Audio + Project...' : 'Download Portable .ZIP Bundle'}</span>
            </button>
          </div>

          <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] space-y-3">
            <span className="text-xs font-bold text-[var(--apex-text)] uppercase block">IMPORT EXISTING PROJECT ZIP</span>
            <p className="text-[11px] text-[var(--apex-text-3)]">Restore project state and unpack bundled audio assets into local storage for canonical session hydration.</p>
            <button onClick={() => fileInputRef.current?.click()} disabled={isImporting} className="w-full py-2 bg-[var(--apex-surface-3)] hover:bg-[var(--apex-state-hover)] disabled:opacity-50 text-[var(--apex-text)] border border-[var(--apex-border)] font-bold rounded-lg transition shadow flex items-center justify-center gap-2">
              <Upload className="w-4 h-4 text-[var(--apex-accent)]" /><span>{isImporting ? 'Unpacking Archive...' : 'Choose .ZIP File to Import'}</span>
            </button>
            <input type="file" ref={fileInputRef} onChange={handleImportZip} accept=".zip,application/zip" className="hidden" />
          </div>
        </div>

        <div className="px-5 py-3 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Apex Studio Portable Bundle v2</span>
          <button onClick={onClose} className="px-4 py-1.5 bg-[var(--apex-surface-3)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text)] font-bold rounded transition">Close</button>
        </div>
      </div>
    </ModalFrame>
  );
};
