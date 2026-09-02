import React, { useEffect, useState } from 'react';
import { Download, FolderArchive, Sparkles, X } from 'lucide-react';
import JSZip from 'jszip';
import { Channel, PlaylistClip, ProjectMetadata } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { renderProjectTimelineOffline } from '../audio/offlineProjectRenderer';
import { buildStandardMidiFile, getProjectRenderBars } from '../utils/exportUtils';
import type { ExportScope } from '../utils/exportUtils';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  clips: PlaylistClip[];
  meta: ProjectMetadata;
}

type ExportFormat = 'wav24' | 'wav16' | 'wav32' | 'midi' | 'stems';

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, channels, clips, meta }) => {
  const [format, setFormat] = useState<ExportFormat>('wav24');
  const [scope, setScope] = useState<ExportScope>('song');
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('Ready to render');
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const base = meta.name.toLowerCase().replace(/\s+/g, '_');
    setDownloadUrl(null);
    setFileName(`${base}_master.wav`);
    setStatusText('Ready to render');
    setRenderProgress(0);
  }, [isOpen, meta.name]);

  useEffect(() => () => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  if (!isOpen) return null;

  const handleFormatChange = (next: ExportFormat) => {
    setFormat(next);
    const base = meta.name.toLowerCase().replace(/\s+/g, '_');
    if (next === 'stems') setFileName(`${base}_stems_bpm${meta.bpm}.zip`);
    else if (next === 'midi') setFileName(`${base}.mid`);
    else setFileName(`${base}_master.wav`);
    setDownloadUrl(null);
    setStatusText('Ready to render');
    setRenderProgress(0);
  };

  const handleStartExport = async () => {
    setIsRendering(true);
    setRenderProgress(10);
    setDownloadUrl(null);
    setStatusText('Preparing deterministic export...');

    try {
      const totalBars = getProjectRenderBars(clips, scope);

      if (format === 'midi') {
        setStatusText(`Writing Standard MIDI (${totalBars} bars)...`);
        setRenderProgress(60);
        const midiBlob = buildStandardMidiFile(channels, clips, meta);
        setDownloadUrl(URL.createObjectURL(midiBlob));
        setRenderProgress(100);
        setStatusText('Standard MIDI export complete.');
      } else {
        let bitDepth: 16 | 24 | 32 = 24;
        if (format === 'wav16') bitDepth = 16;
        if (format === 'wav32') bitDepth = 32;

        if (format === 'stems') {
          setStatusText(`Rendering isolated stems (${totalBars} bars)...`);
          setRenderProgress(35);
          const { stems, master } = await audioEngine.renderProjectStems(channels, clips, meta.bpm, totalBars, bitDepth);
          const zip = new JSZip();
          const folder = zip.folder(`${meta.name.replace(/\s+/g, '_')}_Stems_BPM${meta.bpm}`);
          Object.entries(stems).forEach(([stemName, blob]) => folder?.file(stemName, blob));
          folder?.file('00_Master_Mix.wav', master);
          folder?.file('project_info.txt', [
            `PROJECT: ${meta.name}`,
            `AUTHOR: ${meta.author || 'Studio Producer'}`,
            `TEMPO / BPM: ${meta.bpm}`,
            `TIME SIGNATURE: ${meta.timeSignature?.join('/') ?? '4/4'}`,
            `SWING: ${meta.swing}`,
            `TRACKS COUNT: ${channels.length}`,
            `RENDER BARS: ${totalBars}`,
            `EXPORT DATE: ${new Date().toISOString()}`,
          ].join('\n'));
          setRenderProgress(80);
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          setDownloadUrl(URL.createObjectURL(zipBlob));
          setRenderProgress(100);
          setStatusText('Stem package ready for download.');
        } else {
          setStatusText(`Rendering timeline WAV (${totalBars} bars)...`);
          setRenderProgress(35);
          const renderedBuffer = await renderProjectTimelineOffline({
            channels,
            clips,
            bpm: meta.bpm,
            totalBars,
            getAudioBuffer: id => audioEngine.getSampleBuffer(id),
          });
          setRenderProgress(85);
          const wavBlob = audioEngine.encodeAudioBufferToWav(renderedBuffer, bitDepth);
          setDownloadUrl(URL.createObjectURL(wavBlob));
          setRenderProgress(100);
          setStatusText('Timeline WAV master render complete.');
        }
      }
    } catch (error) {
      console.error('[Apex Studio] Export failed', error);
      setStatusText(error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.');
      setDownloadUrl(null);
    } finally {
      setIsRendering(false);
    }
  };

  const handleDownload = () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatOptions: Array<{ id: ExportFormat; name: string; desc: string }> = [
    { id: 'stems', name: 'All Stems (.zip)', desc: 'Multi-track WAV bundle' },
    { id: 'wav24', name: 'WAV (24-bit)', desc: 'Studio standard' },
    { id: 'wav32', name: 'WAV (32-bit Float)', desc: 'Floating-point master' },
    { id: 'wav16', name: 'WAV (16-bit)', desc: 'CD-compatible PCM' },
    { id: 'midi', name: 'Standard MIDI (.mid)', desc: 'Notes + tempo' },
  ];

  return (
    <div id="export-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[#b0b0b0] max-h-[90vh] flex flex-col">
        <div className="px-4 sm:px-5 py-3 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-bold text-sm text-white tracking-tight">PROJECT EXPORT</h3>
            <p className="text-[10px] text-[#777]">WAV, Standard MIDI, and multi-track stem export</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Output Filename</label>
            <input value={fileName} onChange={e => setFileName(e.target.value)} className="w-full bg-[#121214] border border-[#333336] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#ff6e00] font-mono" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => { setScope('song'); setDownloadUrl(null); }} className={`p-2.5 rounded-lg border text-left transition ${scope === 'song' ? 'bg-[#1a1a1d] border-[#ff6e00] text-white' : 'bg-[#121214] border-[#333336] text-[#777] hover:text-white'}`}>
              <div className="font-bold text-xs">Full Song</div>
              <div className="text-[9px] text-[#777]">Render through the last playlist clip ({getProjectRenderBars(clips, 'song')} bars)</div>
            </button>
            <button onClick={() => { setScope('pattern'); setDownloadUrl(null); }} className={`p-2.5 rounded-lg border text-left transition ${scope === 'pattern' ? 'bg-[#1a1a1d] border-[#ff6e00] text-white' : 'bg-[#121214] border-[#333336] text-[#777] hover:text-white'}`}>
              <div className="font-bold text-xs">Pattern Loop</div>
              <div className="text-[9px] text-[#777]">Export the documented 4-bar loop</div>
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-wider text-[#777]">Format & Quality</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {formatOptions.map(option => (
                <button key={option.id} onClick={() => handleFormatChange(option.id)} className={`p-2 rounded border text-left transition ${format === option.id ? 'bg-[#ff6e00]/15 border-[#ff6e00] text-white' : 'bg-[#121214] border-[#333336] text-[#777] hover:text-white'}`}>
                  <div className="font-bold text-xs text-white">{option.name}</div>
                  <div className="text-[8px] text-[#777]">{option.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t border-[#333336] space-y-3">
            <div className="flex justify-between text-xs font-mono">
              <span className={isRendering ? 'text-[#ff6e00]' : 'text-[#777]'}>{statusText}</span>
              {isRendering && <span className="text-white font-bold">{renderProgress}%</span>}
            </div>
            {isRendering && <div className="w-full h-2 bg-[#121214] rounded-full overflow-hidden border border-[#333336]"><div className="h-full bg-[#ff6e00] transition-all duration-150" style={{ width: `${renderProgress}%` }} /></div>}

            {!downloadUrl ? (
              <button onClick={handleStartExport} disabled={isRendering} className="w-full py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] disabled:opacity-50 text-black font-bold text-xs rounded transition flex items-center justify-center gap-2 shadow">
                {format === 'stems' ? <FolderArchive className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                <span>{isRendering ? 'PROCESSING EXPORT...' : 'START EXPORT'}</span>
              </button>
            ) : (
              <button onClick={handleDownload} className="w-full py-2.5 bg-[#00ff00] hover:bg-emerald-400 text-black font-bold text-xs rounded transition flex items-center justify-center gap-2 shadow">
                <Download className="w-4 h-4" />
                <span>DOWNLOAD {fileName}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
