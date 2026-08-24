import React, { useState, useRef, useEffect } from 'react';
import { 
  Pencil, 
  Paintbrush, 
  Scissors, 
  Eraser, 
  MousePointer, 
  Volume2, 
  Music, 
  Sparkles, 
  Maximize2, 
  ZoomIn, 
  ZoomOut,
  Layers,
  Wand2,
  Trash2,
  Eye,
  Sliders,
  Radio,
  ChevronDown,
  CircleDot,
  Zap,
  Upload,
  Download
} from 'lucide-react';
import { Channel, Note, MusicalScale, ChordStampType } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { MidiParser } from '../utils/midiParser';

interface PianoRollProps {
  channel: Channel;
  allChannels: Channel[];
  onSelectChannel: (channelId: string) => void;
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
  currentStep: number;
  isPlaying: boolean;
}

type ToolType = 'draw' | 'paint' | 'slice' | 'erase' | 'select';

const SCALE_PRESETS = [
  { id: 'minor', name: 'Natural Minor (Aeolian)', notes: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'major', name: 'Major (Ionian)', notes: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'harmonic_minor', name: 'Harmonic Minor', notes: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic_minor', name: 'Melodic Minor', notes: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', name: 'Dorian', notes: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', notes: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', notes: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', notes: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'pentatonic_minor', name: 'Minor Pentatonic', notes: [0, 3, 5, 7, 10] },
  { id: 'pentatonic_major', name: 'Major Pentatonic', notes: [0, 2, 4, 7, 9] },
  { id: 'blues', name: 'Blues Scale', notes: [0, 3, 5, 6, 7, 10] },
  { id: 'japanese_hirajoshi', name: 'Japanese Hirajoshi', notes: [0, 2, 3, 7, 8] },
  { id: 'arabic_double_harmonic', name: 'Arabic Double Harmonic', notes: [0, 1, 4, 5, 7, 8, 11] },
  { id: 'whole_tone', name: 'Whole Tone', notes: [0, 2, 4, 6, 8, 10] }
];

const ROOT_KEYS = [
  { name: 'C', val: 0 },
  { name: 'C#', val: 1 },
  { name: 'D', val: 2 },
  { name: 'D#', val: 3 },
  { name: 'E', val: 4 },
  { name: 'F', val: 5 },
  { name: 'F#', val: 6 },
  { name: 'G', val: 7 },
  { name: 'G#', val: 8 },
  { name: 'A', val: 9 },
  { name: 'A#', val: 10 },
  { name: 'B', val: 11 },
];

const CHORD_VOICINGS = [
  { id: 'root', name: 'Root Position' },
  { id: 'inversion1', name: '1st Inversion' },
  { id: 'inversion2', name: '2nd Inversion' },
  { id: 'drop2', name: 'Drop-2 Jazz Voicing' },
  { id: 'open_spread', name: 'Open Spread' }
];

const CHORD_STAMPS = [
  { name: 'Single Note', offsets: [0] },
  { name: 'Major Triad', offsets: [0, 4, 7] },
  { name: 'Minor Triad', offsets: [0, 3, 7] },
  { name: 'Dominant 7th', offsets: [0, 4, 7, 10] },
  { name: 'Major 7th', offsets: [0, 4, 7, 11] },
  { name: 'Minor 7th', offsets: [0, 3, 7, 10] },
  { name: 'Dominant 9th', offsets: [0, 4, 7, 10, 14] },
  { name: 'Major 9th', offsets: [0, 4, 7, 11, 14] },
  { name: 'Minor 9th', offsets: [0, 3, 7, 10, 14] },
  { name: 'Neo-Soul 11th', offsets: [0, 3, 7, 10, 14, 17] },
  { name: 'Suspended 2nd', offsets: [0, 2, 7] },
  { name: 'Suspended 4th', offsets: [0, 5, 7] },
  { name: 'Diminished 7th', offsets: [0, 3, 6, 9] },
  { name: 'Augmented Triad', offsets: [0, 4, 8] },
  { name: 'Octave Doubler', offsets: [0, 12] },
  { name: 'Power Chord 5th', offsets: [0, 7, 12] }
];

export const PianoRoll: React.FC<PianoRollProps> = ({
  channel,
  allChannels,
  onSelectChannel,
  onUpdateChannel,
  currentStep,
  isPlaying
}) => {
  const [currentTool, setCurrentTool] = useState<ToolType>('draw');
  const [rootKey, setRootKey] = useState<number>(0); // C
  const [selectedScaleIndex, setSelectedScaleIndex] = useState(0); // Natural Minor
  const [selectedChordStamp, setSelectedChordStamp] = useState(0); // Single Note
  const [selectedVoicing, setSelectedVoicing] = useState<string>('root');
  const [showGhostNotes, setShowGhostNotes] = useState(true);
  const [showVelocityDrawer, setShowVelocityDrawer] = useState(true);
  const [strumMs, setStrumMs] = useState(25);
  const [totalSteps, setTotalSteps] = useState(32);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Pitch range C2 (36) to C6 (84) = 49 keys
  const minPitch = 36;
  const maxPitch = 84;
  const pitchRange: number[] = [];
  for (let p = maxPitch; p >= minPitch; p--) {
    pitchRange.push(p);
  }

  const notes = channel.notes || [];

  const getNoteName = (pitch: number) => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(pitch / 12) - 1;
    return `${names[pitch % 12]}${octave}`;
  };

  const isBlackKey = (pitch: number) => {
    const mod = pitch % 12;
    return [1, 3, 6, 8, 10].includes(mod);
  };

  const isRootNote = (pitch: number) => {
    return (pitch % 12) === rootKey;
  };

  const isInScale = (pitch: number) => {
    const scaleOffsets = SCALE_PRESETS[selectedScaleIndex].notes;
    const relPitch = (pitch - rootKey + 12) % 12;
    return scaleOffsets.includes(relPitch);
  };

  const handleAuditionKey = (pitch: number) => {
    audioEngine.playNote(channel, {
      id: `aud-${pitch}`,
      pitch,
      start: 0,
      duration: 1.5,
      velocity: 0.9
    });
  };

  const handleGridClick = (pitch: number, step: number) => {
    const existingIndex = notes.findIndex(n => n.pitch === pitch && Math.abs(n.start - step) < 0.5);

    if (currentTool === 'erase') {
      if (existingIndex >= 0) {
        const newNotes = [...notes];
        newNotes.splice(existingIndex, 1);
        onUpdateChannel(channel.id, { notes: newNotes });
      }
      return;
    }

    if (existingIndex >= 0) {
      if (currentTool === 'select') {
        setSelectedNoteId(notes[existingIndex].id);
      } else {
        const newNotes = [...notes];
        newNotes.splice(existingIndex, 1);
        onUpdateChannel(channel.id, { notes: newNotes });
      }
      return;
    }

    // Add note or chord stamp with voicing
    const stamp = CHORD_STAMPS[selectedChordStamp];
    let pitchesToStamp = stamp.offsets.map(o => pitch + o);
    pitchesToStamp = audioEngine.applyChordVoicing(pitchesToStamp, selectedVoicing);

    const newNotes = [...notes];
    pitchesToStamp.forEach((targetPitch, idx) => {
      if (targetPitch <= maxPitch && targetPitch >= minPitch) {
        const strumOffset = (idx * (strumMs / 1000) * 4); // micro fractional step offset
        const newNote: Note = {
          id: `note-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 5)}`,
          pitch: targetPitch,
          start: Math.max(0, step + strumOffset),
          duration: 2,
          velocity: Math.max(0.6, 0.88 - (idx * 0.03))
        };
        newNotes.push(newNote);
        audioEngine.playNote(channel, newNote);
      }
    });

    onUpdateChannel(channel.id, { notes: newNotes });
  };

  const handleStrumNotes = () => {
    // Group notes by starting beat step
    const stepGroups = new Map<number, Note[]>();
    notes.forEach(n => {
      const stepFloor = Math.round(n.start * 2) / 2;
      if (!stepGroups.has(stepFloor)) stepGroups.set(stepFloor, []);
      stepGroups.get(stepFloor)!.push(n);
    });

    const newNotes: Note[] = [];
    stepGroups.forEach((groupNotes, step) => {
      // Sort pitch ascending
      const sorted = [...groupNotes].sort((a, b) => a.pitch - b.pitch);
      sorted.forEach((n, idx) => {
        const offset = idx * 0.04; // 40ms micro strum
        newNotes.push({
          ...n,
          start: step + offset,
          velocity: Math.max(0.4, Math.min(1.0, (n.velocity || 0.8) + (Math.random() * 0.1 - 0.05)))
        });
      });
    });

    onUpdateChannel(channel.id, { notes: newNotes });
    setStatusMessage('Strum & humanize applied to chords!');
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleExtractBassline = () => {
    const bassNotes = audioEngine.extractBassNotesFromChords(notes);
    if (bassNotes.length === 0) {
      setStatusMessage('No chord notes found to extract root bassline.');
      setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    // Look for a bass channel (808, reese, sub, or second channel)
    const bassChannel = allChannels.find(c => 
      c.id !== channel.id && (c.instrumentType.includes('bass') || c.instrumentType.includes('808') || c.name.toLowerCase().includes('bass') || c.name.toLowerCase().includes('808'))
    ) || allChannels.find(c => c.id !== channel.id);

    if (bassChannel) {
      onUpdateChannel(bassChannel.id, { notes: bassNotes });
      setStatusMessage(`Root bassline extracted to "${bassChannel.name}"!`);
      setTimeout(() => setStatusMessage(null), 3000);
    } else {
      setStatusMessage('Extracted root notes! Please create a bass track.');
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleHumanizeVelocities = () => {
    const newNotes = notes.map(n => ({
      ...n,
      velocity: Math.min(1.0, Math.max(0.3, 0.75 + (Math.random() * 0.35 - 0.15)))
    }));
    onUpdateChannel(channel.id, { notes: newNotes });
    setStatusMessage('Velocities randomized with natural dynamics');
    setTimeout(() => setStatusMessage(null), 2000);
  };

  const handleQuantizeNotes = () => {
    const newNotes = notes.map(n => ({
      ...n,
      start: Math.round(n.start),
      duration: Math.max(1, Math.round(n.duration))
    }));
    onUpdateChannel(channel.id, { notes: newNotes });
  };

  const handleClearAllNotes = () => {
    onUpdateChannel(channel.id, { notes: [] });
  };

  const handleExportMidi = () => {
    if (!notes || notes.length === 0) {
      setStatusMessage('No notes to export in this channel.');
      setTimeout(() => setStatusMessage(null), 3000);
      return;
    }
    const blob = MidiParser.exportNotesToMidi(notes, 130, channel.name);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${channel.name.toLowerCase().replace(/\s+/g, '_')}_midi.mid`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatusMessage(`Exported ${notes.length} notes as standard .mid file!`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleImportMidi = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsedTracks = await MidiParser.parseMidiFile(file);
      if (parsedTracks.length === 0 || parsedTracks[0].notes.length === 0) {
        setStatusMessage('No note events found in MIDI file.');
        setTimeout(() => setStatusMessage(null), 3000);
        return;
      }

      const importedNotes: Note[] = parsedTracks[0].notes.map((pn, idx) => ({
        id: `midi-imp-${Date.now()}-${idx}`,
        pitch: pn.pitch,
        start: pn.startStep,
        duration: pn.durationSteps,
        velocity: pn.velocity
      }));

      onUpdateChannel(channel.id, { notes: [...notes, ...importedNotes] });
      setStatusMessage(`Imported ${importedNotes.length} notes from ${file.name}!`);
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: any) {
      console.error(err);
      setStatusMessage('Failed to parse MIDI file.');
      setTimeout(() => setStatusMessage(null), 3000);
    }
    // reset input
    e.target.value = '';
  };

  const handleVelocityChange = (noteId: string, newVel: number) => {
    const clamped = Math.max(0.05, Math.min(1.0, newVel));
    const newNotes = notes.map(n => (n.id === noteId ? { ...n, velocity: clamped } : n));
    onUpdateChannel(channel.id, { notes: newNotes });
  };

  // Other channels' notes for Ghost Channel rendering
  const ghostNotes = showGhostNotes
    ? allChannels
        .filter(c => c.id !== channel.id)
        .flatMap(c => (c.notes || []).map(n => ({ ...n, channelColor: c.color, channelName: c.name })))
    : [];

  return (
    <div id="piano-roll-container" className="h-full flex flex-col bg-[#141416] text-[#b0b0b0] select-none overflow-hidden">
      {/* Top Toolbar */}
      <div className="h-10 px-3 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between gap-2 shrink-0 overflow-x-auto custom-scrollbar">
        {/* Left: Active Channel Selector */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 text-xs">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: channel.color }}></span>
            <select
              value={channel.id}
              onChange={(e) => onSelectChannel(e.target.value)}
              className="bg-[#121214] text-white font-bold text-xs px-2 py-1 rounded border border-[#333336] focus:outline-none cursor-pointer"
            >
              {allChannels.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.instrumentType})
                </option>
              ))}
            </select>
          </div>

          <div className="h-4 w-px bg-[#333]" />

          {/* Tools */}
          <div className="flex items-center gap-1 bg-[#121214] p-0.5 rounded border border-[#333336]">
            <button
              onClick={() => setCurrentTool('draw')}
              className={`p-1 rounded transition ${currentTool === 'draw' ? 'bg-[#ff6e00] text-black font-bold' : 'text-[#777] hover:text-white'}`}
              title="Draw Note (Pencil)"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setCurrentTool('paint')}
              className={`p-1 rounded transition ${currentTool === 'paint' ? 'bg-[#ff6e00] text-black font-bold' : 'text-[#777] hover:text-white'}`}
              title="Paint Notes (Brush)"
            >
              <Paintbrush className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setCurrentTool('erase')}
              className={`p-1 rounded transition ${currentTool === 'erase' ? 'bg-[#ff0000] text-white font-bold' : 'text-[#777] hover:text-white'}`}
              title="Erase Note (Eraser)"
            >
              <Eraser className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Middle: Scale Highlighting & Chord Stamper */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Root Key & Scale */}
          <div className="flex items-center gap-1 text-[11px] bg-[#121214] px-2 py-0.5 rounded border border-[#333336]">
            <span className="text-[#ff6e00] font-bold text-[10px]">KEY:</span>
            <select
              value={rootKey}
              onChange={(e) => setRootKey(Number(e.target.value))}
              className="bg-transparent text-white font-bold text-xs focus:outline-none cursor-pointer"
            >
              {ROOT_KEYS.map(k => (
                <option key={k.val} value={k.val}>{k.name}</option>
              ))}
            </select>
            <select
              value={selectedScaleIndex}
              onChange={(e) => setSelectedScaleIndex(Number(e.target.value))}
              className="bg-transparent text-[#aaa] text-xs focus:outline-none cursor-pointer max-w-[140px] truncate"
            >
              {SCALE_PRESETS.map((scale, idx) => (
                <option key={idx} value={idx}>{scale.name}</option>
              ))}
            </select>
          </div>

          {/* Chord Stamp & Voicing */}
          <div className="flex items-center gap-1.5 text-[11px] bg-[#121214] px-2 py-0.5 rounded border border-[#333336]">
            <span className="text-[#00bcd4] font-bold text-[10px]">STAMP:</span>
            <select
              value={selectedChordStamp}
              onChange={(e) => setSelectedChordStamp(Number(e.target.value))}
              className="bg-transparent text-white font-bold text-xs focus:outline-none cursor-pointer"
            >
              {CHORD_STAMPS.map((stamp, idx) => (
                <option key={idx} value={idx}>{stamp.name}</option>
              ))}
            </select>

            <span className="text-[#ff9800] font-bold text-[10px] ml-1">VOICING:</span>
            <select
              value={selectedVoicing}
              onChange={(e) => setSelectedVoicing(e.target.value)}
              className="bg-transparent text-[#ddd] text-xs focus:outline-none cursor-pointer"
            >
              {CHORD_VOICINGS.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Right: Ghost Notes, Velocity Drawer, Humanize, Strum, Extract Bass */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Strum Chords Button */}
          <button
            onClick={handleStrumNotes}
            className="flex items-center gap-1 px-2 py-1 bg-[#1e1e24] hover:bg-[#282830] text-[#00bcd4] hover:text-white rounded text-[10px] font-semibold border border-[#00bcd4]/30 transition shadow-sm"
            title="Strum chord notes with micro-timing offset"
          >
            <Music className="w-3 h-3" />
            <span>Strum Chords</span>
          </button>

          {/* Extract Root Bassline */}
          <button
            onClick={handleExtractBassline}
            className="flex items-center gap-1 px-2 py-1 bg-[#2e1a12] hover:bg-[#3d2419] text-[#ff9800] hover:text-white rounded text-[10px] font-bold border border-[#ff9800]/40 transition shadow-sm"
            title="Auto-extract lowest root notes to 808/Bassline channel"
          >
            <Zap className="w-3 h-3 text-[#ff6e00]" />
            <span>Extract 808 Bass</span>
          </button>

          {/* Ghost Notes Toggle */}
          <button
            onClick={() => setShowGhostNotes(!showGhostNotes)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition ${
              showGhostNotes
                ? 'bg-[#2a2a2e] text-[#2ecc71] border-[#2ecc71]/40'
                : 'bg-[#121214] text-[#666] border-[#333]'
            }`}
            title="Toggle Ghost Notes from other channels"
          >
            <Eye className="w-3 h-3" />
            <span>Ghost</span>
          </button>

          {/* Velocity Drawer Toggle */}
          <button
            onClick={() => setShowVelocityDrawer(!showVelocityDrawer)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition ${
              showVelocityDrawer
                ? 'bg-[#ff6e00]/15 text-[#ff6e00] border-[#ff6e00]/40'
                : 'bg-[#121214] text-[#666] border-[#333]'
            }`}
            title="Toggle Note Velocity Editor"
          >
            <Sliders className="w-3 h-3" />
            <span>Velocities</span>
          </button>

          <button
            onClick={handleHumanizeVelocities}
            className="flex items-center gap-1 px-2 py-1 bg-[#222225] hover:bg-[#2d2d30] text-[#b0b0b0] hover:text-white rounded text-[10px] font-semibold border border-[#333336]"
            title="Humanize velocities with natural swing"
          >
            <Wand2 className="w-3 h-3 text-[#ff6e00]" />
            <span>Humanize</span>
          </button>

          {/* MIDI Import (.mid) */}
          <label
            className="flex items-center gap-1 px-2 py-1 bg-[#1e1e24] hover:bg-[#282830] text-[#00bcd4] hover:text-white rounded text-[10px] font-semibold border border-[#00bcd4]/30 transition cursor-pointer"
            title="Import Standard MIDI File (.mid)"
          >
            <Upload className="w-3 h-3" />
            <span>Import .mid</span>
            <input
              type="file"
              accept=".mid,.midi"
              onChange={handleImportMidi}
              className="hidden"
            />
          </label>

          {/* MIDI Export (.mid) */}
          <button
            onClick={handleExportMidi}
            className="flex items-center gap-1 px-2 py-1 bg-[#1e1e24] hover:bg-[#282830] text-[#2ecc71] hover:text-white rounded text-[10px] font-semibold border border-[#2ecc71]/30 transition"
            title="Export Channel Notes to Standard MIDI File (.mid)"
          >
            <Download className="w-3 h-3" />
            <span>Export .mid</span>
          </button>

          <button
            onClick={handleClearAllNotes}
            className="p-1.5 bg-[#222225] hover:bg-red-500/20 text-[#777] hover:text-red-400 rounded text-[10px] border border-[#333336]"
            title="Clear all notes"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Action Toast Feedback */}
      {statusMessage && (
        <div className="bg-[#ff6e00] text-black font-bold text-xs px-3 py-1 flex items-center justify-between shadow-md transition-all">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black text-xs">✕</button>
        </div>
      )}

      {/* Main Piano Roll Matrix: Left Keys & Right Step Grid */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Interactive Virtual Piano Keys Strip */}
        <div className="w-16 sm:w-20 bg-[#141416] border-r border-[#333336] flex flex-col overflow-y-auto custom-scrollbar shrink-0 select-none">
          {pitchRange.map((pitch) => {
            const isBlack = isBlackKey(pitch);
            const inScale = isInScale(pitch);
            const isRoot = isRootNote(pitch);
            const noteName = getNoteName(pitch);

            return (
              <button
                key={pitch}
                id={`piano-key-${pitch}`}
                onMouseDown={() => handleAuditionKey(pitch)}
                onTouchStart={(e) => {
                  e.preventDefault();
                  handleAuditionKey(pitch);
                }}
                className={`h-6 border-b flex items-center justify-between px-1.5 text-[9px] font-mono font-bold transition active:bg-[#ff6e00] active:text-black select-none relative ${
                  isBlack
                    ? 'bg-[#0a0a0b] text-[#777] border-[#222225] hover:bg-[#1a1a1d]'
                    : 'bg-[#1a1a1d] text-white border-[#333336] hover:bg-[#242428]'
                } ${inScale ? '' : 'opacity-40'}`}
              >
                <div className="flex items-center space-x-1">
                  {isRoot && <span className="w-1.5 h-1.5 rounded-full bg-[#ff6e00]" />}
                  <span>{noteName}</span>
                </div>
                {pitch % 12 === 0 && <span className="text-[7px] text-[#ff6e00]">OCT</span>}
              </button>
            );
          })}
        </div>

        {/* Right: Note Grid Timeline */}
        <div className="flex-1 overflow-auto custom-scrollbar bg-[#0e0e10] relative flex flex-col">
          {/* Header Bars Step Numbers */}
          <div className="h-6 bg-[#1a1a1d] border-b border-[#333336] sticky top-0 z-20 flex min-w-[896px]">
            {Array.from({ length: totalSteps }).map((_, stepIdx) => {
              const isBarStart = stepIdx % 4 === 0;
              const isCurrentStep = isPlaying && (currentStep % totalSteps) === stepIdx;

              return (
                <div
                  key={stepIdx}
                  className={`w-7 h-full flex items-center justify-center font-mono text-[8px] border-r ${
                    isBarStart ? 'border-[#444] text-white font-bold bg-[#222225]' : 'border-[#222225] text-[#555]'
                  } ${isCurrentStep ? 'bg-[#ff6e00]/20 text-[#ff6e00]' : ''}`}
                >
                  {isBarStart ? `${Math.floor(stepIdx / 4) + 1}` : ''}
                </div>
              );
            })}
          </div>

          {/* Grid Rows for each pitch */}
          <div className="min-w-[896px] flex-1">
            {pitchRange.map((pitch) => {
              const isBlack = isBlackKey(pitch);
              const inScale = isInScale(pitch);
              const isRoot = isRootNote(pitch);

              return (
                <div
                  key={pitch}
                  className={`h-6 border-b flex relative ${
                    isRoot
                      ? 'bg-[#ff6e00]/10 border-[#ff6e00]/30'
                      : isBlack
                      ? 'bg-[#0e0e10] border-[#1c1c20]'
                      : 'bg-[#121214] border-[#202024]'
                  } ${inScale ? '' : 'opacity-60'}`}
                >
                  {/* Grid cells */}
                  {Array.from({ length: totalSteps }).map((_, stepIdx) => {
                    const isBarStart = stepIdx % 4 === 0;
                    const isCurrent = isPlaying && (currentStep % totalSteps) === stepIdx;

                    return (
                      <div
                        key={stepIdx}
                        onClick={() => handleGridClick(pitch, stepIdx)}
                        className={`w-7 h-full border-r cursor-pointer transition-colors ${
                          isBarStart ? 'border-[#333336]' : 'border-[#1a1a1d]'
                        } ${isCurrent ? 'bg-white/5' : 'hover:bg-white/10'}`}
                      />
                    );
                  })}

                  {/* Render Ghost Notes from other channels */}
                  {ghostNotes.filter(n => n.pitch === pitch).map((gn, idx) => (
                    <div
                      key={`ghost-${idx}`}
                      style={{
                        left: `${gn.start * 28}px`,
                        width: `${Math.max(24, gn.duration * 28 - 3)}px`
                      }}
                      className="absolute top-1 bottom-1 bg-[#ffffff]/10 border border-[#ffffff]/20 rounded-xs pointer-events-none z-5 flex items-center px-1"
                    >
                      <span className="text-[7px] text-[#888] truncate">{gn.channelName}</span>
                    </div>
                  ))}

                  {/* Render Notes placed on this pitch line */}
                  {notes.filter(n => n.pitch === pitch).map((n) => {
                    const isSelected = n.id === selectedNoteId;

                    return (
                      <div
                        key={n.id}
                        id={`note-block-${n.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (currentTool === 'erase') {
                            const newNotes = notes.filter(item => item.id !== n.id);
                            onUpdateChannel(channel.id, { notes: newNotes });
                          } else {
                            setSelectedNoteId(n.id);
                            audioEngine.playNote(channel, n);
                          }
                        }}
                        style={{
                          left: `${n.start * 28}px`,
                          width: `${Math.max(24, n.duration * 28 - 3)}px`,
                          opacity: 0.4 + (n.velocity || 0.8) * 0.6
                        }}
                        className={`absolute top-0.5 bottom-0.5 rounded-sm border shadow flex items-center justify-between px-1 text-[8px] text-black font-bold overflow-hidden cursor-pointer active:scale-95 z-10 ${
                          isSelected
                            ? 'bg-[#ffffff] border-[#ffffff] text-black ring-2 ring-[#ff6e00]'
                            : 'bg-[#ff6e00] border-[#ff7d1a] text-black'
                        }`}
                      >
                        <span className="truncate">{getNoteName(pitch)}</span>
                        <div className="w-1 h-3 bg-black/40 rounded-xs" />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Velocity Stalks Editor Drawer */}
          {showVelocityDrawer && (
            <div className="h-20 bg-[#121214] border-t border-[#2e2e32] min-w-[896px] sticky bottom-0 z-20 flex flex-col">
              <div className="px-3 py-1 bg-[#18181b] border-b border-[#28282b] flex items-center justify-between text-[9px] text-[#888]">
                <span className="font-bold uppercase tracking-wider text-white">Note Velocity Stalks (Dynamics)</span>
                <span>Click & drag stalk heights to adjust loudness</span>
              </div>
              <div className="flex-1 relative flex">
                {Array.from({ length: totalSteps }).map((_, stepIdx) => {
                  const isBarStart = stepIdx % 4 === 0;
                  const stepNotes = notes.filter(n => Math.floor(n.start) === stepIdx);

                  return (
                    <div
                      key={`vel-${stepIdx}`}
                      className={`w-7 h-full border-r relative flex items-end justify-center pb-1 ${
                        isBarStart ? 'border-[#333336]' : 'border-[#1a1a1d]'
                      }`}
                    >
                      {stepNotes.map(n => {
                        const velHeight = Math.round((n.velocity || 0.8) * 100);

                        return (
                          <div
                            key={`vel-stalk-${n.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                              if (rect) {
                                const clickY = e.clientY - rect.top;
                                const newVel = (rect.height - clickY) / rect.height;
                                handleVelocityChange(n.id, newVel);
                              }
                            }}
                            className="w-2 bg-[#ff6e00] hover:bg-white rounded-t cursor-ns-resize transition-all relative group"
                            style={{ height: `${velHeight}%` }}
                          >
                            <span className="hidden group-hover:block absolute -top-5 left-1/2 -translate-x-1/2 bg-black px-1 rounded text-[8px] text-white font-mono z-30">
                              {Math.round((n.velocity || 0.8) * 127)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
