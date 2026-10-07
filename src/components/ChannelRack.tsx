import React, { useState } from 'react';
import { 
  Plus, 
  Volume2, 
  Trash2, 
  Copy, 
  Sliders, 
  Music, 
  Disc, 
  Cpu, 
  MoreVertical,
  Activity,
  Play
} from 'lucide-react';
import { Channel, Pattern, InstrumentType } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { describeMissingAudioSample, isChannelSampleAudioUnavailable } from '../state/audioAssetAvailability';
import { PATTERN_LENGTH_CHOICES } from '../state/patternLength';
import {
  clearChannelSteps,
  fillChannelSteps,
  getChannelRackStepLength,
  toggleChannelStep
} from './channelRackOperations';

interface ChannelRackProps {
  channels: Channel[];
  patterns: Pattern[];
  selectedPatternId: string;
  onSelectPattern: (id: string) => void;
  onAddPattern: () => void;
  /**
   * Writes the selected pattern's declared length (`Pattern.lengthSteps`) through
   * project mutations/history. The rack owns no length state of its own.
   */
  onUpdatePatternLength: (lengthSteps: number) => void;
  selectedChannelId: string;
  onSelectChannel: (id: string) => void;
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
  onAddChannel: (type: InstrumentType, name: string, color: string) => void;
  onDeleteChannel: (channelId: string) => void;
  onOpenPianoRoll: (channelId: string) => void;
  onOpenInstrument: (channelId: string) => void;
  onOpenArp?: (channelId: string) => void;
  onOpenSampleManager?: (channelId: string) => void;
  currentStep: number;
  isPlaying: boolean;
  swing: number;
  onUpdateSwing: (swing: number) => void;
  onInteractionStart?: (label?: string) => void;
  onInteractionEnd?: (label?: string) => void;
}

export const ChannelRack: React.FC<ChannelRackProps> = ({
  channels,
  patterns,
  selectedPatternId,
  onSelectPattern,
  onAddPattern,
  onUpdatePatternLength,
  selectedChannelId,
  onSelectChannel,
  onUpdateChannel,
  onAddChannel,
  onDeleteChannel,
  onOpenPianoRoll,
  onOpenInstrument,
  onOpenArp,
  onOpenSampleManager,
  currentStep,
  isPlaying,
  swing,
  onUpdateSwing,
  onInteractionStart,
  onInteractionEnd
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false);

  /**
   * Phase 9D: the grid width is the selected pattern's declared length, read
   * from project state. It used to be a component-local `useState<16 | 32>(16)`,
   * which made the 16/32 control look like pattern state while `Pattern.lengthSteps`
   * (playback, persistence and export) stayed at 16.
   */
  const stepLength = getChannelRackStepLength(patterns, selectedPatternId);

  const handlePatternLengthChange = (lengthSteps: number) => {
    if (lengthSteps === stepLength) return;
    onUpdatePatternLength(lengthSteps);
  };

  const handleStepClick = (channel: Channel, stepIndex: number) => {
    const newSteps = toggleChannelStep(channel, stepIndex);
    const nextState = newSteps[stepIndex];

    onUpdateChannel(channel.id, { steps: newSteps });

    // Audition sound if activated
    if (nextState) {
      audioEngine.playNote(channel, {
        id: `aud-${Date.now()}`,
        pitch: channel.instrumentType === 'drumpad' ? 36 : 60,
        start: stepIndex,
        duration: 1,
        velocity: 0.85
      });
    }
  };

  const handleFillSteps = (channel: Channel, interval: number) => {
    onUpdateChannel(channel.id, { steps: fillChannelSteps(channel, interval, stepLength) });
  };

  const handleClearSteps = (channel: Channel) => {
    onUpdateChannel(channel.id, { steps: clearChannelSteps(channel, stepLength) });
  };

  return (
    <div id="fl-channel-rack" className="flex flex-col h-full bg-[var(--apex-chrome-inset)] select-none text-[var(--apex-text-2)]">
      {/* Top Rack Header */}
      <div className="h-9 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between px-4 shrink-0 gap-4">
        {/* Pattern Ribbon */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--apex-text)] font-bold bg-[var(--apex-surface-3)] px-2 py-0.5 rounded">STEP SEQUENCER</span>
          <div className="flex items-center gap-1 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] p-0.5 rounded">
            {patterns.map((pat) => (
              <button
                key={pat.id}
                id={`pattern-tab-${pat.id}`}
                onClick={() => onSelectPattern(pat.id)}
                className={`px-2.5 py-0.5 rounded-sm text-[11px] font-bold font-mono transition ${
                  pat.id === selectedPatternId
                    ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow-sm'
                    : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)]'
                }`}
              >
                {pat.name.toUpperCase()}
              </button>
            ))}
            <button
              id="add-pattern-btn"
              onClick={onAddPattern}
              className="p-1 text-[var(--apex-text-3)] hover:text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)] rounded transition"
              title="Add New Pattern"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Controls: Swing, Step count, Add Channel */}
        <div className="flex items-center gap-4">
          {/* Swing Slider */}
          <div className="flex items-center gap-1.5 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] px-2 py-0.5 rounded">
            <span className="text-[9px] font-bold uppercase text-[var(--apex-text-3)]">SWING</span>
            <input
              id="fl-swing-slider"
              type="range"
              min="0"
              max="0.5"
              step="0.05"
              value={swing}
              onPointerDown={() => onInteractionStart?.('Change swing')}
              onPointerUp={() => onInteractionEnd?.('Change swing')}
              onChange={(e) => onUpdateSwing(parseFloat(e.target.value))}
              className="w-14 h-1 accent-[var(--apex-accent)] bg-[var(--apex-surface-3)] rounded cursor-pointer"
            />
            <span className="text-[9px] text-[var(--apex-accent)] font-mono font-bold w-5 text-right">
              {Math.round(swing * 200)}%
            </span>
          </div>

          {/* Pattern length: writes Pattern.lengthSteps of the selected pattern */}
          <div
            id="pattern-length-selector"
            className="flex items-center gap-0.5 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] p-0.5 rounded text-[10px] font-bold"
            title={`Pattern length: ${stepLength} steps`}
          >
            {PATTERN_LENGTH_CHOICES.map(choice => (
              <button
                key={choice}
                id={`pattern-length-${choice}`}
                onClick={() => handlePatternLengthChange(choice)}
                aria-pressed={stepLength === choice}
                className={`px-2 py-0.5 rounded-sm transition ${stepLength === choice ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)]' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'}`}
              >
                {choice} STEPS
              </button>
            ))}
          </div>

          {/* Add Channel */}
          <div className="relative">
            <button
              id="fl-add-channel-btn"
              onClick={() => setShowAddMenu(!showAddMenu)}
              className="flex items-center gap-1 px-2.5 py-1 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-[11px] rounded transition active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>ADD GENERATOR</span>
            </button>

            {showAddMenu && (
              <div 
                id="add-channel-dropdown"
                className="absolute right-0 mt-1 w-64 bg-[var(--apex-panel)] border border-[var(--apex-border)] rounded-md shadow-2xl z-50 py-1 text-xs text-[var(--apex-text-2)] max-h-96 overflow-y-auto custom-scrollbar"
              >
                <div className="px-3 py-1.5 text-[9px] font-bold text-[var(--apex-accent)] uppercase tracking-wider border-b border-[var(--apex-border)] bg-[var(--apex-panel)]">
                  Studio Instrument Library
                </div>

                {/* Section: Keyboards & Pianos */}
                <div className="px-3 py-1 text-[8px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider bg-[var(--apex-panel-header)]">
                  Keys & Acoustic
                </div>
                <button
                  onClick={() => {
                    onAddChannel('grand_piano', 'Grand Concert Piano', '#e0e0e0');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Grand Concert Piano</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Acoustic</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('rhodes_epiano', 'Vintage Rhodes MK1', '#e67e22');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Vintage Rhodes E-Piano</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Tine Keys</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('hammond_organ', 'Hammond B3 Drawbar', '#d35400');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Hammond B3 Organ</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Leslie Rotary</span>
                </button>

                {/* Section: Plucks, Strings & Brass */}
                <div className="px-3 py-1 text-[8px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider bg-[var(--apex-panel-header)]">
                  Orchestral & Strings
                </div>
                <button
                  onClick={() => {
                    onAddChannel('strings_ensemble', 'Orchestral Strings', '#9b59b6');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Orchestral Strings</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Ensemble</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('pizzicato_strings', 'Pizzicato Strings', '#8e44ad');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Pizzicato Staccato</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Pluck</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('nylon_guitar', 'Nylon Pluck Guitar', '#27ae60');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Nylon Acoustic Guitar</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Physical</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('cinematic_brass', 'Cinematic Brass Section', '#f39c12');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Cinematic Horns & Brass</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Brass</span>
                </button>

                {/* Section: Independent / Extensible */}
                <div className="px-3 py-1 text-[8px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider bg-[var(--apex-panel-header)]">
                  Independent Voice
                </div>
                <button
                  onClick={() => {
                    onAddChannel('independent_pluck', 'Apex Independent Pluck', '#ff6e00');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Apex Independent Pluck</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Registry</span>
                </button>

                {/* Section: Bass & 808 */}
                <div className="px-3 py-1 text-[8px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider bg-[var(--apex-panel-header)]">
                  Bass & Low-End
                </div>
                <button
                  onClick={() => {
                    onAddChannel('sub_808', 'Sub Bass 808 Tuned', '#ff5722');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">808 Tuned Sub Bass</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Sub</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('acid_303', 'Acid 303 Resonant', '#2ecc71');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">TB-303 Acid Bassline</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Diode Res</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('reese_bass', 'Neuro Reese Bass', '#c0392b');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Reese Heavy Detune</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">DnB/Neuro</span>
                </button>

                {/* Section: Synths, Leads & Pads */}
                <div className="px-3 py-1 text-[8px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider bg-[var(--apex-panel-header)]">
                  Synths & Vocals
                </div>
                <button
                  onClick={() => {
                    onAddChannel('supersaw_lead', 'JP-8000 Supersaw', '#00d2d3');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Hypersaw 7-Osc Lead</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Trance</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('ambient_pad', 'Deep Space Ambient Pad', '#54a0ff');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Atmospheric Space Pad</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Pad</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('vox_choir', 'Vocal Choir Formant', '#ff9ff3');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Vocal Choir Formant</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Vowels</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('marimba_bell', 'Marimba / Kalimba', '#1dd1a1');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Wooden Marimba & Bell</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Mallet</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('chiptune_8bit', 'GameBoy 8-Bit Synth', '#feca57');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">8-Bit Retro Chiptune</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Square</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('minisynth', 'MiniSynth 3xOsc', '#9c27b0');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">MiniSynth Subtractive</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">3-Osc</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('fmsynth', 'Toxic FM 4-Op Synth', '#00bcd4');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Toxic FM Modulator</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">DX FM</span>
                </button>

                {/* Section: Drums & Sampler */}
                <div className="px-3 py-1 text-[8px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider bg-[var(--apex-panel-header)]">
                  Drums & Samples
                </div>
                <button
                  onClick={() => {
                    onAddChannel('drumpad', '808 Drum Sampler', '#ff5722');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">808 Drum Machine Kit</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">MPC</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('sampler', 'Apex Sampler', '#4caf50');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--apex-state-hover)] hover:text-[var(--apex-text)] flex items-center justify-between"
                >
                  <span className="font-semibold">Apex Sampler</span>
                  <span className="text-[9px] text-[var(--apex-text-muted)]">Sample</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Step Sequencer List */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
        {channels.map((ch) => {
          const isSelected = ch.id === selectedChannelId;

          return (
            <div
              key={ch.id}
              id={`channel-row-${ch.id}`}
              onClick={() => onSelectChannel(ch.id)}
              className={`flex items-center gap-3 p-2 rounded-md border transition ${
                isSelected 
                  ? 'bg-[var(--apex-panel)] border-[var(--apex-state-selected-border)]'
                  : 'bg-[var(--apex-panel)] border-[var(--apex-border)] hover:border-[var(--apex-grid-line-strong)]'
              }`}
            >
              {/* Channel Selector Dot & Mute/Solo */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateChannel(ch.id, { mute: !ch.mute });
                  }}
                  className={`w-2.5 h-2.5 rounded-full border transition ${
                    !ch.mute 
                      ? 'bg-[var(--apex-success)] border-[var(--apex-success)]'
                      : 'bg-[var(--apex-surface-3)] border-[var(--apex-border)]'
                  }`}
                  title={ch.mute ? 'Unmute' : 'Mute'}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateChannel(ch.id, { solo: !ch.solo });
                  }}
                  aria-label={ch.solo ? `Unsolo ${ch.name}` : `Solo ${ch.name}`}
                  className={`w-4 h-4 rounded text-[8px] font-bold border transition flex items-center justify-center ${
                    ch.solo
                      ? 'bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)] border-[var(--apex-gold)]'
                      : 'bg-[var(--apex-panel)] text-[var(--apex-text-3)] border-[var(--apex-border)] hover:text-[var(--apex-text)]'
                  }`}
                  title={ch.solo ? 'Unsolo Channel' : 'Solo Channel'}
                >
                  S
                </button>

                {/* Pan & Volume Mini Knobs */}
                <div className="flex items-center gap-1.5 text-[9px]">
                  <div className="flex flex-col items-center">
                    <span className="text-[var(--apex-text-3)] text-[8px]">VOL</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={ch.volume}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={() => onInteractionStart?.('Change channel volume')}
                      onPointerUp={() => onInteractionEnd?.('Change channel volume')}
                      onChange={(e) => onUpdateChannel(ch.id, { volume: parseFloat(e.target.value) })}
                      className="w-10 h-1 accent-[var(--apex-accent)] bg-[var(--apex-surface-3)] rounded cursor-pointer"
                    />
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-[var(--apex-text-3)] text-[8px]">PAN</span>
                    <input
                      type="range"
                      min="-1"
                      max="1"
                      step="0.1"
                      value={ch.pan}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={() => onInteractionStart?.('Change channel pan')}
                      onPointerUp={() => onInteractionEnd?.('Change channel pan')}
                      onChange={(e) => onUpdateChannel(ch.id, { pan: parseFloat(e.target.value) })}
                      className="w-8 h-1 accent-[var(--apex-text-muted)] bg-[var(--apex-surface-3)] rounded cursor-pointer"
                    />
                  </div>
                </div>
              </div>

              {/* Channel Name & Quick Actions */}
              <div className="w-32 md:w-44 flex items-center justify-between shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInstrument(ch.id);
                  }}
                  className="text-left font-bold text-xs truncate max-w-[120px] transition hover:text-[var(--apex-text)] uppercase tracking-tight"
                  style={{ color: ch.color || 'var(--apex-text)' }}
                  title="Click to open Instrument Synth Rack"
                >
                  {ch.name}
                </button>

                <div className="flex items-center gap-1">
                  {/* Arp Button */}
                  {onOpenArp && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenArp(ch.id);
                      }}
                      className={`px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition flex items-center gap-0.5 ${
                        ch.arp?.enabled
                          ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow-sm'
                          : 'bg-[var(--apex-surface-2)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
                      }`}
                      title="Arpeggiator & Euclidean Rhythm Engine"
                    >
                      ARP
                    </button>
                  )}

                  {/* Custom Sample Button */}
                  {onOpenSampleManager && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenSampleManager(ch.id);
                      }}
                      data-audio-unavailable={isChannelSampleAudioUnavailable(ch) ? 'true' : undefined}
                      className={`px-1 py-0.5 rounded text-[8px] font-mono font-bold transition ${
                        isChannelSampleAudioUnavailable(ch)
                          ? 'bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)]'
                          : ch.customSample
                            ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)]'
                            : 'bg-[var(--apex-surface-2)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
                      }`}
                      title={isChannelSampleAudioUnavailable(ch) && ch.customSample
                        ? describeMissingAudioSample(ch.customSample, ch.name)
                        : 'Sample loader & waveform slicer'}
                    >
                      SMPL
                    </button>
                  )}

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPianoRoll(ch.id);
                    }}
                    className="p-1 text-[var(--apex-text-3)] hover:text-[var(--apex-accent)] rounded hover:bg-[var(--apex-state-hover)] text-[10px] font-mono font-semibold"
                    title="Open in Piano Roll"
                  >
                    🎹
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFillSteps(ch, 4);
                    }}
                    className="px-1 py-0.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)] rounded text-[8px] font-mono"
                    title="Fill every 4 steps"
                  >
                    /4
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClearSteps(ch);
                    }}
                    className="px-1 py-0.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-red-400 rounded text-[8px] font-mono"
                    title="Clear steps"
                  >
                    CLR
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChannel(ch.id);
                    }}
                    disabled={channels.length <= 1}
                    className="px-1 py-0.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-red-400 rounded disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
                    title={
                      channels.length <= 1
                        ? 'Cannot delete the last channel'
                        : 'Delete channel'
                    }
                    aria-label={`Delete ${ch.name}`}
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>

              {/* Step Sequencer Grid (4-Beat Groups) */}
              <div className="flex-1 flex items-center overflow-x-auto custom-scrollbar py-1">
                {Array.from({ length: Math.ceil(stepLength / 4) }).map((_, groupIdx) => (
                  <div key={groupIdx} className={`flex gap-1 ${groupIdx > 0 ? 'ml-3' : ''}`}>
                    {Array.from({ length: 4 }).map((_, stepOffset) => {
                      const stepIdx = groupIdx * 4 + stepOffset;
                      const isActive = ch.steps?.[stepIdx] || false;
                      const isCurrentStep = isPlaying && (currentStep % stepLength) === stepIdx;

                      return (
                        <button
                          key={stepIdx}
                          id={`step-${ch.id}-${stepIdx}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStepClick(ch, stepIdx);
                          }}
                          className={`w-5 h-7 rounded-sm border transition-all duration-75 flex items-center justify-center ${
                            isCurrentStep
                              ? 'ring-2 ring-[var(--apex-accent-strong)] z-10 scale-105'
                              : ''
                          } ${
                            isActive
                              ? 'apex-step-active'
                              : groupIdx % 2 === 0
                                ? 'bg-[var(--apex-surface-2)] border-[var(--apex-border)] hover:bg-[var(--apex-state-hover)]'
                                : 'bg-[var(--apex-panel)] border-[var(--apex-border)] hover:bg-[var(--apex-state-hover)]'
                          }`}
                          title={`Step ${stepIdx + 1}`}
                        >
                          {isActive && <div className="w-1 h-2 bg-[var(--apex-state-playing-fg)]/60 rounded-xs" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* Piano Roll Jump Banner in Channel Rack */}
        <div 
          onClick={() => onOpenPianoRoll(selectedChannelId)}
          className="mt-4 border border-dashed border-[var(--apex-border)] hover:border-[var(--apex-state-selected-border)] rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer bg-[color-mix(in_srgb,var(--apex-panel)_50%,transparent)] hover:bg-[var(--apex-state-hover)] transition text-center"
        >
          <div className="text-3xl mb-1 opacity-70">🎹</div>
          <div className="text-[11px] text-[var(--apex-text-3)] font-bold uppercase tracking-widest">
            Switch to Piano Roll Editor for Polyphonic Melody & Chord Writing
          </div>
          <span className="text-[10px] text-[var(--apex-accent)] mt-1">Press Space to play • Click here or select Piano Roll tab</span>
        </div>
      </div>
    </div>
  );
};
