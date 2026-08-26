import React, { useRef } from 'react';
import { 
  FolderOpen, 
  Save, 
  Upload, 
  Download, 
  X, 
  Music, 
  Cloud, 
  ShieldCheck, 
  Clock, 
  Sparkles, 
  Plus 
} from 'lucide-react';
import { ProjectState, ProjectMetadata } from '../types/daw';
import { PRESET_PROJECTS } from '../audio/presets';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';

interface ProjectManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentState: ProjectState;
  onLoadProject: (state: ProjectState) => void;
  onUpdateMeta: (meta: Partial<ProjectMetadata>) => void;
}

export const ProjectManagerModal: React.FC<ProjectManagerModalProps> = ({
  isOpen,
  onClose,
  currentState,
  onLoadProject,
  onUpdateMeta
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const handleExportProjectJson = () => {
    const jsonStr = JSON.stringify(currentState, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentState.meta.name.toLowerCase().replace(/\s+/g, '_')}.flmp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        const normalized = normalizeProjectState(parsed);
        onLoadProject(normalized);
        onClose();
      } catch (err) {
        console.error('Could not load project file.', err);
        window.alert(err instanceof Error ? err.message : 'Could not load project file.');
      }
    };
    reader.readAsText(file);
  };

  const handleCreateBlankProject = () => {
    onLoadProject(createDefaultProjectState());
    onClose();
  };

  return (
    <div id="project-manager-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <FolderOpen className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">STUDIO PROJECT HUB & DEMO TEMPLATES</h3>
              <p className="text-[10px] text-[#777]">Open Demos, Backup to Disk (.flmp), or Start a New Beat</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          {/* Quick Actions Row */}
          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={handleCreateBlankProject}
              className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00] rounded-lg text-left transition flex flex-col space-y-1"
            >
              <Plus className="w-4 h-4 text-[#ff6e00]" />
              <div className="text-xs font-bold text-white">New Session</div>
              <div className="text-[9px] text-[#777]">Initialize clean 128 BPM grid</div>
            </button>

            <button
              onClick={handleExportProjectJson}
              className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00] rounded-lg text-left transition flex flex-col space-y-1"
            >
              <Download className="w-4 h-4 text-[#00ff00]" />
              <div className="text-xs font-bold text-white">Backup Project</div>
              <div className="text-[9px] text-[#777]">Save offline (.flmp JSON)</div>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00] rounded-lg text-left transition flex flex-col space-y-1"
            >
              <Upload className="w-4 h-4 text-cyan-400" />
              <div className="text-xs font-bold text-white">Open .flmp File</div>
              <div className="text-[9px] text-[#777]">Import from device storage</div>
            </button>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImportFile}
            accept=".json,.flmp"
            className="hidden"
          />

          {/* Current Project Details */}
          <div className="p-3.5 bg-[#1a1a1d] border border-[#333336] rounded-lg space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Active Project Details</div>
            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={currentState.meta.name}
                onChange={(e) => onUpdateMeta({ name: e.target.value })}
                className="flex-1 bg-[#121214] border border-[#333336] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#ff6e00] font-bold"
                placeholder="Project title..."
              />
              <div className="text-[10px] text-[#777] font-mono bg-[#121214] px-2.5 py-1.5 rounded border border-[#333336]">
                {currentState.meta.bpm} BPM
              </div>
            </div>
          </div>

          {/* Demo Project Templates */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#777]">
              Studio Demo Templates & Genre Starters
            </div>

            <div className="space-y-2">
              {PRESET_PROJECTS.map((proj) => (
                <div
                  key={proj.id}
                  className="p-3 bg-[#1a1a1d] hover:bg-[#222225] border border-[#333336] hover:border-[#ff6e00]/50 rounded-lg flex items-center justify-between transition cursor-pointer"
                  onClick={() => {
                    onLoadProject(structuredClone(proj.state));
                    onClose();
                  }}
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center text-[#ff6e00] font-bold text-xs font-mono">
                      {proj.bpm}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-white">{proj.name}</div>
                      <div className="text-[9px] text-[#777]">
                        Producer: {proj.state.meta.author} • {proj.state.channels.length} Instruments • {proj.state.playlistClips?.length || 0} Arranged Clips
                      </div>
                    </div>
                  </div>

                  <button
                    className="px-3 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition"
                  >
                    LOAD
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
