import React, { useState, useRef } from 'react';
import { Download, Upload, Sparkles, FolderArchive, X } from 'lucide-react';
import JSZip from 'jszip';
import { ProjectState } from '../types/daw';
import { normalizeProjectState } from '../state/projectState';
import { getPersistedAudioClip, persistAudioClip } from '../audio/audioPersistence';

interface ProjectBundleZipModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectState: ProjectState;
  onLoadProjectState: (state: ProjectState) => void;
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

const getReferencedAudioIds = (projectState: ProjectState): string[] => {
  const ids = new Set<string>();
  projectState.playlistClips.forEach(clip => {
    if (clip.type === 'audio' && clip.audioBufferId) ids.add(clip.audioBufferId);
  });
  projectState.channels.forEach(channel => {
    if (channel.customSample?.id) ids.add(channel.customSample.id);
  });
  projectState.recordings.forEach(recording => ids.add(`recording-${recording.id}`));
  return [...ids];
};

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
        for (const audioId of getReferencedAudioIds(projectState)) {
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
            const blob = await entry.async('blob');
            await persistAudioClip(audioFile.id, blob.type ? blob : new Blob([blob], { type: audioFile.mimeType || 'application/octet-stream' }));
            restoredAudioCount += 1;
          }
        }
      }

      onLoadProjectState(loadedState);
      setIsImporting(false);
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
    <div id="fl-project-zip-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#ffaa00]/40 rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ffaa00] to-[#ff6600] flex items-center justify-center text-black shadow-md font-bold"><FolderArchive className="w-5 h-5" /></div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">PROJECT ZIP ARCHIVE BUNDLER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40">PORTABLE .ZIP</span>
              </div>
              <p className="text-[10px] text-[#777]">Package project state plus persisted audio assets for portable sharing</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"><X className="w-5 h-5" /></button>
        </div>

        {statusMessage && (
          <div className="bg-[#ffaa00] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5"><Sparkles className="w-4 h-4" /><span>{statusMessage}</span></div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4 text-xs">
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
            <span className="text-xs font-bold text-white uppercase block">EXPORT COMPLETE PROJECT ZIP</span>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-[#888] font-bold block mb-1">ARCHIVE FILE NAME</label>
                <input type="text" value={bundleName} onChange={(e) => setBundleName(e.target.value)} className="w-full bg-[#121214] text-white px-3 py-1.5 rounded border border-[#333] font-mono text-xs focus:border-[#ffaa00] focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <label className="flex items-center gap-2 cursor-pointer bg-[#121214] p-2 rounded border border-[#26262a]">
                  <input type="checkbox" checked={includeMidiFiles} onChange={(e) => setIncludeMidiFiles(e.target.checked)} className="accent-[#ffaa00]" />
                  <span className="text-white font-bold text-[11px]">Include Pattern JSONs</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer bg-[#121214] p-2 rounded border border-[#26262a]">
                  <input type="checkbox" checked={includeSamples} onChange={(e) => setIncludeSamples(e.target.checked)} className="accent-[#ffaa00]" />
                  <span className="text-white font-bold text-[11px]">Include Audio Assets</span>
                </label>
              </div>
            </div>
            <button onClick={handleExportZip} disabled={isExporting} className="w-full py-2 bg-gradient-to-r from-[#ffaa00] to-[#ff7700] hover:opacity-90 disabled:opacity-50 text-black font-bold rounded-lg transition shadow flex items-center justify-center gap-2">
              <Download className="w-4 h-4" /><span>{isExporting ? 'Packaging Audio + Project...' : 'Download Portable .ZIP Bundle'}</span>
            </button>
          </div>

          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
            <span className="text-xs font-bold text-white uppercase block">IMPORT EXISTING PROJECT ZIP</span>
            <p className="text-[11px] text-[#777]">Restore project state and rehydrate bundled audio assets into local storage before loading the session.</p>
            <button onClick={() => fileInputRef.current?.click()} disabled={isImporting} className="w-full py-2 bg-[#25252a] hover:bg-[#333338] disabled:opacity-50 text-white border border-[#444] font-bold rounded-lg transition shadow flex items-center justify-center gap-2">
              <Upload className="w-4 h-4 text-[#ffaa00]" /><span>{isImporting ? 'Unpacking Archive...' : 'Choose .ZIP File to Import'}</span>
            </button>
            <input type="file" ref={fileInputRef} onChange={handleImportZip} accept=".zip,application/zip" className="hidden" />
          </div>
        </div>

        <div className="px-5 py-3 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Apex Studio Portable Bundle v2</span>
          <button onClick={onClose} className="px-4 py-1.5 bg-[#25252a] hover:bg-[#333338] text-white font-bold rounded transition">Close</button>
        </div>
      </div>
    </div>
  );
};
