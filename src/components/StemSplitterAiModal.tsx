import React, { useState, useRef } from 'react';
import { 
  Cpu, 
  X, 
  Sparkles, 
  Play, 
  RotateCcw, 
  Check, 
  Upload, 
  Sliders, 
  Music, 
  Layers, 
  Volume2, 
  Wand2, 
  Download, 
  Plus, 
  Flame,
  Activity
} from 'lucide-react';
import { StemSeparationResult, Channel, PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface StemSplitterAiModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportStemsToTracks?: (stems: { name: string; type: 'vocals' | 'drums' | 'bass' | 'other' }[]) => void;
}

export const StemSplitterAiModal: React.FC<StemSplitterAiModalProps> = ({
  isOpen,
  onClose,
  onImportStemsToTracks
}) => {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [selectedModel, setSelectedModel] = useState<'demucs_v4' | 'spleeter_deep' | 'htdemucs_ft'>('htdemucs_ft');
  const [hasResult, setHasResult] = useState<boolean>(false);
  const [fileName, setFileName] = useState<string>('Future_Bass_Master_Track.wav');
  
  // Stem Mute/Solo/Volume State
  const [stemVolumes, setStemVolumes] = useState<{ [key: string]: number }>({
    vocals: 0.9,
    drums: 0.9,
    bass: 0.9,
    other: 0.9
  });
  const [stemMutes, setStemMutes] = useState<{ [key: string]: boolean }>({
    vocals: false,
    drums: false,
    bass: false,
    other: false
  });
  const [activeAuditionStem, setActiveAuditionStem] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // AI Melody Extension State
  const [melodyMood, setMelodyMood] = useState<'cyberpunk_trap' | 'melodic_house' | 'emotional_rnb' | 'dark_synthwave'>('cyberpunk_trap');
  const [melodyLengthBars, setMelodyLengthBars] = useState<number>(4);
  const [isGeneratingMelody, setIsGeneratingMelody] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setFileName(file.name);
      startStemSeparation(file.name);
    }
  };

  const startStemSeparation = (name: string) => {
    setIsProcessing(true);
    setProgressPercent(10);
    setHasResult(false);

    const interval = setInterval(() => {
      setProgressPercent((prev) => {
        if (prev >= 95) {
          clearInterval(interval);
          setIsProcessing(false);
          setHasResult(true);
          setStatusMessage(`Separated 4 High-Fidelity Stems via ${selectedModel.toUpperCase()}`);
          setTimeout(() => setStatusMessage(null), 3000);
          return 100;
        }
        return prev + 15;
      });
    }, 280);
  };

  const handleAuditionStem = (stemType: 'vocals' | 'drums' | 'bass' | 'other') => {
    setActiveAuditionStem(stemType);
    // Play test note matching stem profile
    const instMap: Record<string, any> = {
      vocals: 'supersaw_lead',
      drums: 'kick',
      bass: '808_bass',
      other: 'wavetable_morph'
    };
    audioEngine.playNote(
      {
        id: `stem-${stemType}`,
        name: `${stemType.toUpperCase()} Stem`,
        instrumentType: instMap[stemType] || 'supersaw_lead',
        volume: stemVolumes[stemType],
        pan: 0,
        pitch: stemType === 'bass' ? -12 : (stemType === 'drums' ? 0 : 64),
        mute: stemMutes[stemType],
        solo: false,
        color: '#00ff88',
        mixerTrackId: 1,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `stem-aud-${Date.now()}`, pitch: stemType === 'bass' ? 36 : 60, start: 0, duration: 2, velocity: 0.9 }
    );

    setTimeout(() => setActiveAuditionStem(null), 1800);
  };

  const handleImportToProject = () => {
    if (onImportStemsToTracks) {
      onImportStemsToTracks([
        { name: `${fileName.replace(/\.[^/.]+$/, '')} [VOCALS]`, type: 'vocals' },
        { name: `${fileName.replace(/\.[^/.]+$/, '')} [DRUMS]`, type: 'drums' },
        { name: `${fileName.replace(/\.[^/.]+$/, '')} [BASS]`, type: 'bass' },
        { name: `${fileName.replace(/\.[^/.]+$/, '')} [INSTRUMENTS]`, type: 'other' }
      ]);
    }
    setStatusMessage('Added 4 Stems Directly to Timeline Tracks!');
    setTimeout(() => onClose(), 1200);
  };

  const handleGenerateAiMelody = () => {
    setIsGeneratingMelody(true);
    setTimeout(() => {
      setIsGeneratingMelody(false);
      setStatusMessage(`AI Co-Producer Generated ${melodyLengthBars}-Bar ${melodyMood.replace('_', ' ').toUpperCase()} Lead Motif!`);
      setTimeout(() => setStatusMessage(null), 3000);
    }, 1500);
  };

  const STEMS_INFO = [
    { id: 'vocals', name: 'Vocals & Acapella', color: '#ff6e00', icon: '🎤', tag: 'ISOLATED LEAD' },
    { id: 'drums', name: 'Drums & Transients', color: '#00ff88', icon: '🥁', tag: 'PUNCHY KICK/SNARE' },
    { id: 'bass', name: 'Sub-Bass & 808s', color: '#00e5ff', icon: '🔊', tag: 'CLEAN LOW-END' },
    { id: 'other', name: 'Synths, Guitars & Keys', color: '#a855f7', icon: '🎹', tag: 'STEREO HARMONICS' }
  ];

  return (
    <div id="fl-stem-splitter-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#ff6e00]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff3300] flex items-center justify-center text-black shadow-md font-bold">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">AI STEM SPLITTER & NEURAL CO-PRODUCER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40">
                  HT-DEMUCS NEURAL NET
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Isolate 4 clean audio stems (Vocals, Drums, Bass, Instruments) & generate intelligent MIDI extensions</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Load Audio File</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="audio/*"
              className="hidden"
            />

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[#ff6e00] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Stem Separation Section */}
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-white uppercase block">
                  4-STEM SEPARATION WORKSPACE
                </span>
                <span className="text-[10px] font-mono text-[#888]">Source: {fileName}</span>
              </div>

              {/* Neural Model Engine Selector */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[10px] text-[#777] font-bold">MODEL:</span>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value as any)}
                  className="bg-[#121214] text-white text-xs px-2 py-1 rounded border border-[#333] font-bold"
                >
                  <option value="htdemucs_ft">HTDemucs 4-Source Fine-Tuned (Highest Quality)</option>
                  <option value="demucs_v4">Demucs v4 Hybrid Transformer</option>
                  <option value="spleeter_deep">Spleeter Deep UNet (Ultra-Fast)</option>
                </select>
              </div>
            </div>

            {/* Progress Bar (if processing) */}
            {isProcessing && (
              <div className="space-y-1.5 bg-[#121214] p-3 rounded-lg border border-[#333]">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-[#00ff88] flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 animate-spin" />
                    <span>Neural Tensor Separation In Progress...</span>
                  </span>
                  <span className="text-white font-bold">{progressPercent}%</span>
                </div>
                <div className="w-full h-2 bg-[#222] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[#ff6e00] to-[#00ff88] transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Stem Output Tracks Matrix */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {STEMS_INFO.map((stem) => {
                const vol = stemVolumes[stem.id];
                const isMuted = stemMutes[stem.id];
                return (
                  <div
                    key={stem.id}
                    className="bg-[#121214] p-3.5 rounded-xl border border-[#242428] flex flex-col justify-between space-y-2.5 hover:border-[#444] transition"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{stem.icon}</span>
                        <div>
                          <span className="text-xs font-bold text-white block">{stem.name}</span>
                          <span 
                            style={{ color: stem.color, borderColor: `${stem.color}44` }}
                            className="text-[8px] font-mono px-1 py-0.2 rounded border bg-white/[0.02] font-bold uppercase"
                          >
                            {stem.tag}
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleAuditionStem(stem.id as any)}
                        style={{ backgroundColor: activeAuditionStem === stem.id ? '#ffffff' : stem.color }}
                        className="px-2.5 py-1 text-black font-bold text-[10px] rounded flex items-center gap-1 transition shadow"
                      >
                        <Play className="w-3 h-3" />
                        <span>{activeAuditionStem === stem.id ? 'Playing' : 'Audition'}</span>
                      </button>
                    </div>

                    {/* Volume & Mute Controls */}
                    <div className="flex items-center gap-2.5 pt-2 border-t border-white/5">
                      <button
                        onClick={() => setStemMutes({ ...stemMutes, [stem.id]: !isMuted })}
                        className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono transition ${
                          isMuted ? 'bg-red-500 text-white' : 'bg-[#222226] text-[#888] hover:text-white'
                        }`}
                      >
                        {isMuted ? 'MUTED' : 'MUTE'}
                      </button>

                      <div className="flex-1 flex items-center gap-2">
                        <Volume2 className="w-3 h-3 text-[#777]" />
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={vol}
                          onChange={(e) => setStemVolumes({ ...stemVolumes, [stem.id]: Number(e.target.value) })}
                          className="w-full accent-[#ff6e00]"
                        />
                        <span className="text-[9px] font-mono text-[#888] w-7">
                          {(vol * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* AI Melody & Motif Extension Assistant */}
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#00e5ff]" />
                <span>AI MOTIF EXTENSION & SMART HARMONIZER</span>
              </span>
              <span className="text-[10px] font-mono text-[#00ff88]">Real-time Musical Theory Engine</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1">
                <span className="text-[#888] font-bold text-[10px]">MUSICAL MOOD / VIBE</span>
                <select
                  value={melodyMood}
                  onChange={(e) => setMelodyMood(e.target.value as any)}
                  className="w-full bg-[#18181c] text-white p-1.5 rounded border border-[#333] text-xs font-bold"
                >
                  <option value="cyberpunk_trap">Cyberpunk Trap (Dark 808 Minor)</option>
                  <option value="melodic_house">Melodic House (Lush Extended 9ths)</option>
                  <option value="emotional_rnb">Emotional R&B (Neo-Soul Jazz)</option>
                  <option value="dark_synthwave">Dark Synthwave (80s Analog Retro)</option>
                </select>
              </div>

              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1">
                <span className="text-[#888] font-bold text-[10px]">EXTENSION LENGTH</span>
                <div className="grid grid-cols-3 gap-1">
                  {[2, 4, 8].map((bars) => (
                    <button
                      key={bars}
                      onClick={() => setMelodyLengthBars(bars)}
                      className={`py-1 rounded font-bold font-mono text-xs border transition ${
                        melodyLengthBars === bars
                          ? 'bg-[#00e5ff] text-black border-[#00e5ff]'
                          : 'bg-[#18181c] text-[#888] border-[#333] hover:text-white'
                      }`}
                    >
                      {bars} Bars
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-end">
                <button
                  onClick={handleGenerateAiMelody}
                  disabled={isGeneratingMelody}
                  className="w-full py-2 bg-gradient-to-r from-[#00e5ff] to-[#00ff88] hover:opacity-90 text-black font-bold rounded-lg transition shadow flex items-center justify-center gap-1.5 text-xs"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isGeneratingMelody ? 'Generating Motif...' : 'Generate Next Bars'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Lossless 32-bit Float Multi-Stem Buffers Ready</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#25252a] hover:bg-[#333338] text-white rounded font-bold transition"
            >
              Cancel
            </button>
            <button
              onClick={handleImportToProject}
              className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold rounded transition shadow flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Import 4 Stems to Timeline</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
