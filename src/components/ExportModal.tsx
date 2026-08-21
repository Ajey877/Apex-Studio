import React, { useState } from 'react';
import { 
  Download, 
  Music, 
  X, 
  Check, 
  Disc, 
  Layers, 
  Sliders, 
  Sparkles,
  Play,
  Pause,
  FolderArchive
} from 'lucide-react';
import JSZip from 'jszip';
import { Channel, PlaylistClip, ProjectMetadata } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  clips: PlaylistClip[];
  meta: ProjectMetadata;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  channels,
  clips,
  meta
}) => {
  const [format, setFormat] = useState<'wav24' | 'wav16' | 'wav32' | 'mp3' | 'midi' | 'stems'>('wav24');
  const [scope, setScope] = useState<'song' | 'pattern'>('song');
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('Ready to render');
  const [fileName, setFileName] = useState(`${meta.name.toLowerCase().replace(/\s+/g, '_')}_master.wav`);

  if (!isOpen) return null;

  const handleStartExport = async () => {
    setIsRendering(true);
    setRenderProgress(10);
    setDownloadUrl(null);
    setStatusText('Initializing offline studio audio matrix...');

    try {
      let bitDepth: 16 | 24 | 32 = 24;
      if (format === 'wav16') bitDepth = 16;
      if (format === 'wav32') bitDepth = 32;

      const totalBars = scope === 'song' ? 16 : 4;

      if (format === 'stems') {
        setStatusText('Rendering isolated channel stems in parallel...');
        setRenderProgress(35);

        const { stems, master } = await audioEngine.renderProjectStems(
          channels,
          clips,
          meta.bpm,
          totalBars,
          bitDepth
        );

        setRenderProgress(70);
        setStatusText('Packaging stems into master studio ZIP archive...');

        const zip = new JSZip();
        const stemsFolder = zip.folder(`${meta.name.replace(/\s+/g, '_')}_Stems_BPM${meta.bpm}`);

        // Add each stem WAV
        Object.entries(stems).forEach(([stemName, blob]) => {
          stemsFolder?.file(stemName, blob);
        });

        // Add Master WAV
        stemsFolder?.file(`00_Master_Mix.wav`, master);

        // Add Studio Project Info Metadata
        const infoTxt = `================================================
PROJECT: ${meta.name}
AUTHOR: ${meta.author || 'Studio Producer'}
TEMPO / BPM: ${meta.bpm} BPM
TIME SIGNATURE: ${meta.timeSignature ? meta.timeSignature.join('/') : '4/4'}
SWING: ${meta.swing}%
TRACKS COUNT: ${channels.length}
EXPORT DATE: ${new Date().toISOString()}
DAW: Web Studio Audio Engine Pro (Studio Tier)
================================================
STEMS INCLUDED:
${channels.map((c, i) => `  - [Stem ${i + 1}] ${c.name} (${c.instrumentType}) -> Track ${c.mixerTrackId}`).join('\n')}
================================================`;
        stemsFolder?.file('project_info.txt', infoTxt);

        setRenderProgress(90);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);

        setFileName(`${meta.name.toLowerCase().replace(/\s+/g, '_')}_stems_bpm${meta.bpm}.zip`);
        setDownloadUrl(url);
        setRenderProgress(100);
        setStatusText('Stem package ready for download!');
      } else {
        setStatusText('Synthesizing 32-bit floating point master...');
        setRenderProgress(50);

        const wavBlob = await audioEngine.renderProjectToWav(
          channels,
          clips,
          meta.bpm,
          totalBars,
          bitDepth
        );

        setRenderProgress(90);
        const url = URL.createObjectURL(wavBlob);
        setDownloadUrl(url);
        setRenderProgress(100);
        setStatusText('Master audio render complete!');
      }

      setIsRendering(false);
    } catch (err) {
      console.error(err);
      setStatusText('Rendering failed: check audio channels');
      setIsRendering(false);
    }
  };

  const handleDownload = () => {
    if (downloadUrl) {
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  return (
    <div id="export-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[#b0b0b0] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <Download className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">COMMERCIAL STEM & MASTER EXPORTER</h3>
              <p className="text-[10px] text-[#777]">Lossless Multi-Track Stem Separation (ZIP) & 32-Bit Float WAV</p>
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
          {/* File Name */}
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Output Filename</label>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full bg-[#121214] border border-[#333336] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#ff6e00] font-mono"
            />
          </div>

          {/* Scope selection */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setScope('song')}
              className={`p-2.5 rounded-lg border text-left transition ${
                scope === 'song' 
                  ? 'bg-[#1a1a1d] border-[#ff6e00] text-white' 
                  : 'bg-[#121214] border-[#333336] text-[#777] hover:text-white'
              }`}
            >
              <div className="font-bold text-xs">Full Song (Playlist)</div>
              <div className="text-[9px] text-[#777]">Render all active arranger timeline bars</div>
            </button>

            <button
              onClick={() => setScope('pattern')}
              className={`p-2.5 rounded-lg border text-left transition ${
                scope === 'pattern' 
                  ? 'bg-[#1a1a1d] border-[#ff6e00] text-white' 
                  : 'bg-[#121214] border-[#333336] text-[#777] hover:text-white'
              }`}
            >
              <div className="font-bold text-xs">Current Pattern Loop</div>
              <div className="text-[9px] text-[#777]">Export seamless 4-bar loop cycle</div>
            </button>
          </div>

          {/* Format selection */}
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Format & Quality</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'stems', name: 'All Stems (.zip)', desc: 'Multi-Track ZIP Bundle' },
                { id: 'wav24', name: 'WAV (24-bit)', desc: 'Studio Standard' },
                { id: 'wav32', name: 'WAV (32-bit Float)', desc: 'Unclipped Master' },
                { id: 'wav16', name: 'WAV (16-bit)', desc: 'CD Standard' },
                { id: 'mp3', name: 'MP3 (320kbps)', desc: 'Stream Quality' },
                { id: 'midi', name: 'Standard MIDI (.mid)', desc: 'Score & Notes' },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setFormat(f.id as any);
                    if (f.id === 'stems') {
                      setFileName(`${meta.name.toLowerCase().replace(/\s+/g, '_')}_stems_bpm${meta.bpm}.zip`);
                    } else {
                      setFileName(`${meta.name.toLowerCase().replace(/\s+/g, '_')}_master.wav`);
                    }
                  }}
                  className={`p-2 rounded border text-left transition ${
                    format === f.id 
                      ? 'bg-[#ff6e00]/15 border-[#ff6e00] text-white' 
                      : 'bg-[#121214] border-[#333336] text-[#777] hover:text-white'
                  }`}
                >
                  <div className="font-bold text-xs text-white">{f.name}</div>
                  <div className="text-[8px] text-[#777]">{f.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Render progress / Download CTA */}
          <div className="pt-2 border-t border-[#333336] space-y-3">
            {isRendering && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-[#ff6e00]">{statusText}</span>
                  <span className="text-white font-bold">{renderProgress}%</span>
                </div>
                <div className="w-full h-2 bg-[#121214] rounded-full overflow-hidden border border-[#333336]">
                  <div 
                    className="h-full bg-[#ff6e00] transition-all duration-150"
                    style={{ width: `${renderProgress}%` }}
                  />
                </div>
              </div>
            )}

            {!downloadUrl ? (
              <button
                onClick={handleStartExport}
                disabled={isRendering}
                className="w-full py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] disabled:opacity-50 text-black font-bold text-xs rounded transition flex items-center justify-center gap-2 shadow"
              >
                {format === 'stems' ? <FolderArchive className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                <span>{isRendering ? 'PROCESSING OFFLINE BOUNCE...' : format === 'stems' ? 'GENERATE MULTI-TRACK STEMS (.ZIP)' : 'START MASTER EXPORT'}</span>
              </button>
            ) : (
              <button
                onClick={handleDownload}
                className="w-full py-2.5 bg-[#00ff00] hover:bg-emerald-400 text-black font-bold text-xs rounded transition flex items-center justify-center gap-2 shadow"
              >
                <Download className="w-4 h-4" />
                <span>DOWNLOAD FILE READY ({fileName})</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

