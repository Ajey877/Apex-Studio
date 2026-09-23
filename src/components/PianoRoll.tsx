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
import { normalizePatternLengthSteps } from '../state/patternLength';
import {
  DEFAULT_GRID_STEPS,
  DEFAULT_MIN_NOTE_DURATION,
  DEFAULT_MIN_PITCH,
  DEFAULT_MAX_PITCH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_STEP_WIDTH,
  MARQUEE_DRAG_THRESHOLD_PX,
  MarqueeSelectionMode,
  NoteBounds,
  cloneNote,
  deleteNotes,
  duplicateNotes,
  hasExceededDragThreshold,
  moveNote,
  moveNotes,
  normalizeRect,
  nudgeNotes,
  resizeNoteLeft,
  resizeNoteRight,
  resizeNotesLeft,
  resizeNotesRight,
  selectNotesInMarquee,
  transposeNotes,
  updateNoteInNotes
} from './pianoRollOperations';

const STEP_WIDTH = DEFAULT_STEP_WIDTH;
const ROW_HEIGHT = DEFAULT_ROW_HEIGHT;

interface MarqueeInteraction {
  pointerId: number;
  originClientX: number;
  originClientY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  mode: MarqueeSelectionMode;
  initialSelection: Set<string>;
  hasDragged: boolean;
}

type NoteInteraction =
  | {
      kind: 'move';
      anchorNoteId: string;
      selectedIds: Set<string>;
      initialNotes: Note[];
      currentNotes: Note[];
      pointerId: number;
      originX: number;
      originY: number;
    }
  | {
      kind: 'resize-right';
      anchorNoteId: string;
      selectedIds: Set<string>;
      initialNotes: Note[];
      currentNotes: Note[];
      pointerId: number;
      originX: number;
      originY: number;
    }
  | {
      kind: 'resize-left';
      anchorNoteId: string;
      selectedIds: Set<string>;
      initialNotes: Note[];
      currentNotes: Note[];
      pointerId: number;
      originX: number;
      originY: number;
    };

interface PianoRollProps {
  channel: Channel;
  allChannels: Channel[];
  onSelectChannel: (channelId: string) => void;
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
  currentStep: number;
  isPlaying: boolean;
  /**
   * Declared `Pattern.lengthSteps` of the selected pattern. The Piano Roll stays
   * the fixed-width editor it always was; this only guarantees the grid is never
   * narrower than the pattern being edited.
   */
  patternLengthSteps?: number;
}

/**
 * Historical Piano Roll width in steps (two bars). It is a floor, not a pattern
 * length: notes written past a 16-step declaration stay visible and preserved;
 * Pattern Mode/export ignore them until the declared length is extended again.
 */
const PIANO_ROLL_MIN_STEPS = 32;

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
  isPlaying,
  patternLengthSteps
}) => {
  const [currentTool, setCurrentTool] = useState<ToolType>('select');
  const [rootKey, setRootKey] = useState<number>(0); // C
  const [selectedScaleIndex, setSelectedScaleIndex] = useState(0); // Natural Minor
  const [selectedChordStamp, setSelectedChordStamp] = useState(0); // Single Note
  const [selectedVoicing, setSelectedVoicing] = useState<string>('root');
  const [showGhostNotes, setShowGhostNotes] = useState(true);
  const [showVelocityDrawer, setShowVelocityDrawer] = useState(true);
  const [strumMs, setStrumMs] = useState(25);
  // Phase 9D: the editor width follows the pattern model without ever shrinking
  // below its historical two-bar default, so a declared 64-step pattern is fully
  // editable and notes past a 16-step declaration are never hidden or lost.
  const totalSteps = Math.max(PIANO_ROLL_MIN_STEPS, normalizePatternLengthSteps(patternLengthSteps));
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const selectedNoteIdsRef = useRef<Set<string>>(new Set());
  selectedNoteIdsRef.current = selectedNoteIds;
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<NoteInteraction | null>(null);
  const interactionRef = useRef<NoteInteraction | null>(null);
  const didMoveRef = useRef(false);
  const lastAuditionedPitchRef = useRef<number | null>(null);

  const [marquee, setMarquee] = useState<MarqueeInteraction | null>(null);
  const marqueeRef = useRef<MarqueeInteraction | null>(null);
  const didMarqueeDragRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // Pitch range C2 (36) to C6 (84) = 49 keys
  const minPitch = DEFAULT_MIN_PITCH;
  const maxPitch = DEFAULT_MAX_PITCH;
  const pitchRange: number[] = [];
  for (let p = maxPitch; p >= minPitch; p--) {
    pitchRange.push(p);
  }

  const notes = channel.notes || [];

  const bounds: NoteBounds = {
    minPitch,
    maxPitch,
    maxSteps: totalSteps,
    minDuration: DEFAULT_MIN_NOTE_DURATION,
    gridSteps: DEFAULT_GRID_STEPS
  };

  const displayNotes = interaction ? interaction.currentNotes : notes;

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
    if (didMarqueeDragRef.current) {
      didMarqueeDragRef.current = false;
      return;
    }

    const existingIndex = notes.findIndex(n => n.pitch === pitch && Math.abs(n.start - step) < 0.5);

    if (currentTool === 'erase') {
      if (existingIndex >= 0) {
        const erasedId = notes[existingIndex].id;
        const newNotes = [...notes];
        newNotes.splice(existingIndex, 1);
        onUpdateChannel(channel.id, { notes: newNotes });
        setSelectedNoteIds(prev => {
          if (!prev.has(erasedId)) return prev;
          const next = new Set(prev);
          next.delete(erasedId);
          return next;
        });
      }
      return;
    }

    if (existingIndex >= 0) {
      const existingNote = notes[existingIndex];
      if (currentTool === 'select') {
        setSelectedNoteIds(new Set([existingNote.id]));
      } else {
        const newNotes = [...notes];
        newNotes.splice(existingIndex, 1);
        onUpdateChannel(channel.id, { notes: newNotes });
        setSelectedNoteIds(prev => {
          if (!prev.has(existingNote.id)) return prev;
          const next = new Set(prev);
          next.delete(existingNote.id);
          return next;
        });
      }
      return;
    }

    // Clicked empty grid
    if (currentTool === 'select') {
      // In select mode, clicking empty grid clears selection
      setSelectedNoteIds(new Set());
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

  const beginMove = (event: React.PointerEvent, note: Note) => {
    if (marqueeRef.current) return;
    if (currentTool === 'erase') return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    didMoveRef.current = false;
    lastAuditionedPitchRef.current = note.pitch;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser or detached target fallback
    }

    let currentSelection = selectedNoteIdsRef.current;
    if (event.shiftKey) {
      const next = new Set(currentSelection);
      if (next.has(note.id)) {
        next.delete(note.id);
      } else {
        next.add(note.id);
      }
      currentSelection = next;
      setSelectedNoteIds(next);
    } else if (!currentSelection.has(note.id)) {
      currentSelection = new Set([note.id]);
      setSelectedNoteIds(currentSelection);
    }

    const next: NoteInteraction = {
      kind: 'move',
      anchorNoteId: note.id,
      selectedIds: new Set(currentSelection),
      initialNotes: notes.map(cloneNote),
      currentNotes: notes.map(cloneNote),
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY
    };
    interactionRef.current = next;
    setInteraction(next);
  };

  const beginResize = (event: React.PointerEvent, note: Note, direction: 'right' | 'left') => {
    if (marqueeRef.current) return;
    if (currentTool === 'erase') return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    didMoveRef.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser or detached target fallback
    }

    let currentSelection = selectedNoteIdsRef.current;
    if (!currentSelection.has(note.id)) {
      currentSelection = new Set([note.id]);
      setSelectedNoteIds(currentSelection);
    }

    const next: NoteInteraction = {
      kind: direction === 'right' ? 'resize-right' : 'resize-left',
      anchorNoteId: note.id,
      selectedIds: new Set(currentSelection),
      initialNotes: notes.map(cloneNote),
      currentNotes: notes.map(cloneNote),
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY
    };
    interactionRef.current = next;
    setInteraction(next);
  };

  const updateInteraction = (clientX: number, clientY: number) => {
    const active = interactionRef.current;
    if (!active) return;

    const deltaX = clientX - active.originX;
    const deltaY = clientY - active.originY;

    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      didMoveRef.current = true;
    }

    const deltaSteps = deltaX / STEP_WIDTH;
    const deltaPitch = -deltaY / ROW_HEIGHT;

    try {
      if (active.kind === 'move') {
        const movedNotes = moveNotes(
          active.initialNotes,
          active.selectedIds,
          deltaSteps,
          deltaPitch,
          DEFAULT_GRID_STEPS,
          bounds
        );

        const movedAnchor = movedNotes.find(n => n.id === active.anchorNoteId);
        if (movedAnchor && movedAnchor.pitch !== lastAuditionedPitchRef.current) {
          lastAuditionedPitchRef.current = movedAnchor.pitch;
          audioEngine.playNote(channel, movedAnchor);
        }

        const updated: NoteInteraction = {
          ...active,
          currentNotes: movedNotes
        };
        interactionRef.current = updated;
        setInteraction(updated);
      } else if (active.kind === 'resize-right') {
        const resizedNotes = resizeNotesRight(
          active.initialNotes,
          active.selectedIds,
          deltaSteps,
          DEFAULT_GRID_STEPS,
          DEFAULT_MIN_NOTE_DURATION,
          bounds
        );
        const updated: NoteInteraction = {
          ...active,
          currentNotes: resizedNotes
        };
        interactionRef.current = updated;
        setInteraction(updated);
      } else {
        const resizedNotes = resizeNotesLeft(
          active.initialNotes,
          active.selectedIds,
          deltaSteps,
          DEFAULT_GRID_STEPS,
          DEFAULT_MIN_NOTE_DURATION,
          bounds
        );
        const updated: NoteInteraction = {
          ...active,
          currentNotes: resizedNotes
        };
        interactionRef.current = updated;
        setInteraction(updated);
      }
    } catch (error) {
      console.warn('Piano roll interaction rejected by operation layer', error);
    }
  };

  const endInteraction = (event?: React.PointerEvent | PointerEvent) => {
    const active = interactionRef.current;
    if (!active) return;

    try {
      if (
        event &&
        'currentTarget' in event &&
        event.currentTarget &&
        typeof (event.currentTarget as any).hasPointerCapture === 'function'
      ) {
        const target = event.currentTarget as HTMLElement;
        if (target.hasPointerCapture(active.pointerId)) {
          target.releasePointerCapture(active.pointerId);
        }
      }
    } catch {
      // Pointer capture already released
    }

    const didMove = didMoveRef.current;
    interactionRef.current = null;
    setInteraction(null);

    if (!didMove) return;

    const hasChanged = active.currentNotes.some(cn => {
      const init = active.initialNotes.find(inNote => inNote.id === cn.id);
      return !init || init.start !== cn.start || init.pitch !== cn.pitch || init.duration !== cn.duration;
    });

    if (hasChanged) {
      try {
        onUpdateChannel(channel.id, { notes: active.currentNotes });
      } catch (err) {
        console.error(`Failed to commit ${active.kind} update`, err);
      }
    }
  };

  const cancelInteraction = () => {
    interactionRef.current = null;
    setInteraction(null);
    didMoveRef.current = false;
  };

  const handleDuplicateSelected = () => {
    if (interactionRef.current || marqueeRef.current) return;
    const currentSelection = selectedNoteIdsRef.current;
    if (currentSelection.size === 0) return;

    try {
      const { updatedNotes, duplicatedNotes } = duplicateNotes(
        notes,
        currentSelection,
        undefined,
        undefined,
        bounds
      );

      if (duplicatedNotes.length === 0) return;

      onUpdateChannel(channel.id, { notes: updatedNotes });
      setSelectedNoteIds(new Set(duplicatedNotes.map(n => n.id)));
    } catch {
      setStatusMessage('Duplicate cannot fit within pattern bounds.');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  };

  const handleTransposeSelected = (semitones: number) => {
    if (interactionRef.current || marqueeRef.current) return;
    const currentSelection = selectedNoteIdsRef.current;
    if (currentSelection.size === 0) return;

    const updatedNotes = transposeNotes(notes, currentSelection, semitones, bounds);
    const hasChanged = updatedNotes.some((n, idx) => n.pitch !== notes[idx].pitch);
    if (hasChanged) {
      onUpdateChannel(channel.id, { notes: updatedNotes });
    }
  };

  const handleNudgeSelected = (deltaSteps: number) => {
    if (interactionRef.current || marqueeRef.current) return;
    const currentSelection = selectedNoteIdsRef.current;
    if (currentSelection.size === 0) return;

    const updatedNotes = nudgeNotes(notes, currentSelection, deltaSteps, bounds);
    const hasChanged = updatedNotes.some((n, idx) => n.start !== notes[idx].start);
    if (hasChanged) {
      onUpdateChannel(channel.id, { notes: updatedNotes });
    }
  };

  const handleDeleteSelected = () => {
    const currentSelection = selectedNoteIdsRef.current;
    if (currentSelection.size === 0) return;
    const remainingNotes = deleteNotes(notes, currentSelection);
    if (remainingNotes.length !== notes.length) {
      onUpdateChannel(channel.id, { notes: remainingNotes });
    }
    setSelectedNoteIds(new Set());
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (interactionRef.current) {
          cancelInteraction();
          return;
        }
        setSelectedNoteIds(new Set());
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedNoteIds(new Set(notes.map(n => n.id)));
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        e.stopPropagation();
        handleDuplicateSelected();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNoteIdsRef.current.size > 0) {
          e.preventDefault();
          handleDeleteSelected();
        }
        return;
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          if (!interactionRef.current && !marqueeRef.current) {
            handleTransposeSelected(e.shiftKey ? 12 : 1);
          }
          return;
        }

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          if (!interactionRef.current && !marqueeRef.current) {
            handleTransposeSelected(e.shiftKey ? -12 : -1);
          }
          return;
        }

        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          if (!interactionRef.current && !marqueeRef.current) {
            const stepDelta = e.shiftKey ? 4 : (bounds.gridSteps ?? DEFAULT_GRID_STEPS);
            handleNudgeSelected(stepDelta);
          }
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          if (!interactionRef.current && !marqueeRef.current) {
            const stepDelta = e.shiftKey ? -4 : -(bounds.gridSteps ?? DEFAULT_GRID_STEPS);
            handleNudgeSelected(stepDelta);
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [notes, channel.id, totalSteps]);

  useEffect(() => {
    if (!interaction) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      const active = interactionRef.current;
      if (active && e.pointerId === active.pointerId) {
        updateInteraction(e.clientX, e.clientY);
      }
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      const active = interactionRef.current;
      if (active && e.pointerId === active.pointerId) {
        endInteraction(e);
      }
    };

    const handleWindowPointerCancel = (e: PointerEvent) => {
      const active = interactionRef.current;
      if (active && e.pointerId === active.pointerId) {
        cancelInteraction();
      }
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
    };
  }, [interaction]);

  const marqueeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (marqueeCleanupRef.current) {
        marqueeCleanupRef.current();
      }
    };
  }, []);

  const handleGridPointerDown = (event: React.PointerEvent) => {
    if (currentTool !== 'select') return;
    if (event.button !== 0) return;
    if (interactionRef.current) return;
    if (marqueeRef.current) return;
    const gridEl = gridRef.current;
    if (!gridEl) return;

    event.preventDefault();
    didMarqueeDragRef.current = false;

    try {
      gridEl.setPointerCapture(event.pointerId);
    } catch {
      try {
        (event.target as HTMLElement)?.setPointerCapture?.(event.pointerId);
      } catch {
        // Browser or detached target fallback
      }
    }

    const rect = gridEl.getBoundingClientRect();
    const startX = Math.round(event.clientX - rect.left);
    const startY = Math.round(event.clientY - rect.top);

    let mode: MarqueeSelectionMode = 'replace';
    if (event.shiftKey) {
      mode = 'add';
    } else if (event.ctrlKey || event.metaKey) {
      mode = 'toggle';
    }

    const initialSelection = new Set<string>(selectedNoteIdsRef.current);

    const nextMarquee: MarqueeInteraction = {
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originClientY: event.clientY,
      startX,
      startY,
      currentX: startX,
      currentY: startY,
      mode,
      initialSelection,
      hasDragged: false
    };

    marqueeRef.current = nextMarquee;

    const handleWindowPointerMove = (e: PointerEvent) => {
      const active = marqueeRef.current;
      if (active && e.pointerId === active.pointerId) {
        updateMarquee(e.clientX, e.clientY);
      }
    };

    const cleanupListeners = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
      marqueeCleanupRef.current = null;
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      const active = marqueeRef.current;
      if (active && e.pointerId === active.pointerId) {
        cleanupListeners();
        endMarquee(e);
      }
    };

    const handleWindowPointerCancel = (e: PointerEvent) => {
      const active = marqueeRef.current;
      if (active && e.pointerId === active.pointerId) {
        cleanupListeners();
        cancelMarquee();
      }
    };

    marqueeCleanupRef.current = cleanupListeners;
    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);
  };

  const updateMarquee = (clientX: number, clientY: number) => {
    const active = marqueeRef.current;
    if (!active) return;
    const gridEl = gridRef.current;
    if (!gridEl) return;

    const rect = gridEl.getBoundingClientRect();
    const currentX = Math.round(clientX - rect.left);
    const currentY = Math.round(clientY - rect.top);

    const exceeded = hasExceededDragThreshold(active.originClientX, active.originClientY, clientX, clientY);
    const hasDragged = active.hasDragged || exceeded;

    if (!hasDragged) {
      marqueeRef.current = {
        ...active,
        currentX,
        currentY,
        hasDragged: false
      };
      return;
    }

    didMarqueeDragRef.current = true;

    const updated: MarqueeInteraction = {
      ...active,
      currentX,
      currentY,
      hasDragged: true
    };
    marqueeRef.current = updated;
    setMarquee(updated);

    const normRect = normalizeRect(active.startX, active.startY, currentX, currentY);
    const nextSelection = selectNotesInMarquee(
      notes,
      normRect,
      active.initialSelection,
      active.mode,
      STEP_WIDTH,
      ROW_HEIGHT,
      maxPitch
    );
    setSelectedNoteIds(nextSelection);
  };

  const endMarquee = (event: PointerEvent) => {
    const active = marqueeRef.current;
    if (!active) return;

    try {
      if (gridRef.current && typeof gridRef.current.releasePointerCapture === 'function') {
        if (gridRef.current.hasPointerCapture(active.pointerId)) {
          gridRef.current.releasePointerCapture(active.pointerId);
        }
      }
    } catch {
      // Pointer capture release fallback
    }

    marqueeRef.current = null;
    setMarquee(null);

    if (!active.hasDragged) {
      if (active.mode === 'replace') {
        setSelectedNoteIds(new Set());
      } else {
        didMarqueeDragRef.current = true;
        setSelectedNoteIds(active.initialSelection);
      }
      return;
    }

    const gridEl = gridRef.current;
    const currentX = gridEl ? Math.round(event.clientX - gridEl.getBoundingClientRect().left) : active.currentX;
    const currentY = gridEl ? Math.round(event.clientY - gridEl.getBoundingClientRect().top) : active.currentY;
    const normRect = normalizeRect(active.startX, active.startY, currentX, currentY);

    const finalSelection = selectNotesInMarquee(
      notes,
      normRect,
      active.initialSelection,
      active.mode,
      STEP_WIDTH,
      ROW_HEIGHT,
      maxPitch
    );
    setSelectedNoteIds(finalSelection);
  };

  const cancelMarquee = () => {
    const active = marqueeRef.current;
    if (!active) return;

    try {
      if (gridRef.current && typeof gridRef.current.releasePointerCapture === 'function') {
        if (gridRef.current.hasPointerCapture(active.pointerId)) {
          gridRef.current.releasePointerCapture(active.pointerId);
        }
      }
    } catch {
      // Pointer capture release fallback
    }

    marqueeRef.current = null;
    setMarquee(null);
    didMarqueeDragRef.current = false;
    setSelectedNoteIds(active.initialSelection);
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
    setSelectedNoteIds(new Set());
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
              id="piano-tool-select"
              onClick={() => setCurrentTool('select')}
              className={`p-1 rounded transition ${currentTool === 'select' ? 'bg-[#ff6e00] text-black font-bold' : 'text-[#777] hover:text-white'}`}
              title="Select Tool (Marquee / Multi-Select)"
            >
              <MousePointer className="w-3.5 h-3.5" />
            </button>
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
          <div
            ref={gridRef}
            onPointerDown={handleGridPointerDown}
            style={{ touchAction: 'none' }}
            className="min-w-[896px] flex-1 relative select-none"
          >
            {/* Active Marquee Selection Box */}
            {marquee?.hasDragged && (() => {
              const r = normalizeRect(marquee.startX, marquee.startY, marquee.currentX, marquee.currentY);
              return (
                <div
                  className="absolute pointer-events-none border border-[#ff6e00] bg-[#ff6e00]/20 z-30 rounded-xs shadow-sm"
                  style={{
                    left: `${r.x}px`,
                    top: `${r.y}px`,
                    width: `${r.width}px`,
                    height: `${r.height}px`
                  }}
                />
              );
            })()}

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
                  {displayNotes.filter(n => n.pitch === pitch).map((n) => {
                    const isSelected = selectedNoteIds.has(n.id);
                    const isInteractingThis = Boolean(interaction?.selectedIds.has(n.id));

                    return (
                      <div
                        key={n.id}
                        id={`note-block-${n.id}`}
                        onPointerDown={(e) => beginMove(e, n)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (didMoveRef.current) {
                            didMoveRef.current = false;
                            return;
                          }
                          if (currentTool === 'erase') {
                            const newNotes = notes.filter(item => item.id !== n.id);
                            onUpdateChannel(channel.id, { notes: newNotes });
                            setSelectedNoteIds(prev => {
                              if (!prev.has(n.id)) return prev;
                              const next = new Set(prev);
                              next.delete(n.id);
                              return next;
                            });
                          } else {
                            if (e.shiftKey) {
                              setSelectedNoteIds(prev => {
                                const next = new Set(prev);
                                if (next.has(n.id)) next.delete(n.id);
                                else next.add(n.id);
                                return next;
                              });
                            } else {
                              setSelectedNoteIds(new Set([n.id]));
                            }
                            audioEngine.playNote(channel, n);
                          }
                        }}
                        style={{
                          left: `${n.start * STEP_WIDTH}px`,
                          width: `${Math.max(16, n.duration * STEP_WIDTH - 3)}px`,
                          opacity: 0.4 + (n.velocity || 0.8) * 0.6,
                          touchAction: 'none'
                        }}
                        className={`absolute top-0.5 bottom-0.5 rounded-sm border shadow flex items-center justify-between px-1 text-[8px] text-black font-bold overflow-hidden cursor-grab active:cursor-grabbing z-10 select-none ${
                          isSelected
                            ? 'bg-[#ffffff] border-[#ffffff] text-black ring-2 ring-[#ff6e00]'
                            : 'bg-[#ff6e00] border-[#ff7d1a] text-black'
                        } ${isInteractingThis ? 'ring-2 ring-white shadow-xl opacity-90 brightness-110' : ''}`}
                      >
                        {/* Left resize handle */}
                        <div
                          role="separator"
                          aria-label="Resize note start"
                          onPointerDown={(e) => beginResize(e, n, 'left')}
                          className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-black/20 z-20"
                          style={{ touchAction: 'none' }}
                        />

                        <span className="truncate pointer-events-none">{getNoteName(pitch)}</span>

                        {/* Right resize handle */}
                        <div
                          role="separator"
                          aria-label="Resize note end"
                          onPointerDown={(e) => beginResize(e, n, 'right')}
                          className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-black/20 flex items-center justify-center z-20"
                          style={{ touchAction: 'none' }}
                        >
                          <div className="w-0.5 h-3 bg-black/40 rounded-xs pointer-events-none" />
                        </div>
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
                  const stepNotes = displayNotes.filter(n => Math.floor(n.start) === stepIdx);

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
