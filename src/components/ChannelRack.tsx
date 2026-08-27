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

interface ChannelRackProps {
  channels: Channel[];
  patterns: Pattern[];
  selectedPatternId: string;
  onSelectPattern: (id: string) => void;
  onAddPattern: () => void;
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
}

export const ChannelRack: React.FC<ChannelRackProps> = ({
  channels,
  patterns,
  selectedPatternId,
  onSelectPattern,
  onAddPattern,
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
  onUpdateSwing
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [stepLength, setStepLength] = useState<16 | 32>(16);

  const selectedPattern = patterns.find(p => p.id === selectedPatternId) || patterns[0];

  const handleStepClick = (channel: Channel, stepIndex: number) => {
    const newSteps = [...channel.steps];
    while (newSteps.length <= stepIndex) {
      newSteps.push(false);
    }
    const nextState = !newSteps[stepIndex];
    newSteps[stepIndex] = nextState;

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
    const newSteps = Array(stepLength).fill(false);
    for (let i = 0; i < stepLength; i += interval) {
      newSteps[i] = true;
    }
    onUpdateChannel(channel.id, { steps: newSteps });
  };

  const handleClearSteps = (channel: Channel) => {
    onUpdateChannel(channel.id, { steps: Array(stepLength).fill(false) });
  };

  return (
    <div id="fl-channel-rack" className="flex flex-col h-full bg-[#121214] select-none text-[#b0b0b0]">
      {/* Top Rack Header */}
      <div className="h-9 bg-[#1e1e20] border-b border-[#333336] flex items-center justify-between px-4 shrink-0 gap-4">
        {/* Pattern Ribbon */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white font-bold bg-[#333336] px-2 py-0.5 rounded">STEP SEQUENCER</span>
          <div className="flex items-center gap-1 bg-[#121214] border border-[#333336] p-0.5 rounded">
            {patterns.map((pat) => (
              <button
                key={pat.id}
                id={`pattern-tab-${pat.id}`}
                onClick={() => onSelectPattern(pat.id)}
                className={`px-2.5 py-0.5 rounded-sm text-[11px] font-bold font-mono transition ${
                  pat.id === selectedPatternId
                    ? 'bg-[#ff6e00] text-black shadow-sm'
                    : 'text-[#777] hover:text-white hover:bg-[#222225]'
                }`}
              >
                {pat.name.toUpperCase()}
              </button>
            ))}
            <button
              id="add-pattern-btn"
              onClick={onAddPattern}
              className="p-1 text-[#777] hover:text-white hover:bg-[#222225] rounded transition"
              title="Add New Pattern"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Controls: Swing, Step count, Add Channel */}
        <div className="flex items-center gap-4">
          {/* Swing Slider */}
          <div className="flex items-center gap-1.5 bg-[#121214] border border-[#333336] px-2 py-0.5 rounded">
            <span className="text-[9px] font-bold uppercase text-[#777]">SWING</span>
            <input
              id="fl-swing-slider"
              type="range"
              min="0"
              max="0.5"
              step="0.05"
              value={swing}
              onChange={(e) => onUpdateSwing(parseFloat(e.target.value))}
              className="w-14 h-1 accent-[#ff6e00] bg-[#333336] rounded cursor-pointer"
            />
            <span className="text-[9px] text-[#ff6e00] font-mono font-bold w-5 text-right">
              {Math.round(swing * 200)}%
            </span>
          </div>

          {/* 16 / 32 steps */}
          <div className="flex items-center gap-0.5 bg-[#121214] border border-[#333336] p-0.5 rounded text-[10px] font-bold">
            <button
              onClick={() => setStepLength(16)}
              className={`px-2 py-0.5 rounded-sm transition ${stepLength === 16 ? 'bg-[#ff6e00] text-black' : 'text-[#777] hover:text-white'}`}
            >
              16 STEPS
            </button>
            <button
              onClick={() => setStepLength(32)}
              className={`px-2 py-0.5 rounded-sm transition ${stepLength === 32 ? 'bg-[#ff6e00] text-black' : 'text-[#777] hover:text-white'}`}
            >
              32 STEPS
            </button>
          </div>

          {/* Add Channel */}
          <div className="relative">
            <button
              id="fl-add-channel-btn"
              onClick={() => setShowAddMenu(!showAddMenu)}
              className="flex items-center gap-1 px-2.5 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-[11px] rounded transition active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>ADD GENERATOR</span>
            </button>

            {showAddMenu && (
              <div 
                id="add-channel-dropdown"
                className="absolute right-0 mt-1 w-64 bg-[#1a1a1d] border border-[#333336] rounded-md shadow-2xl z-50 py-1 text-xs text-[#b0b0b0] max-h-96 overflow-y-auto custom-scrollbar"
              >
                <div className="px-3 py-1.5 text-[9px] font-bold text-[#ff6e00] uppercase tracking-wider border-b border-[#333336] bg-[#141416]">
                  Studio Instrument Library
                </div>

                {/* Section: Keyboards & Pianos */}
                <div className="px-3 py-1 text-[8px] font-bold text-[#666] uppercase tracking-wider bg-[#161618]">
                  Keys & Acoustic
                </div>
                <button
                  onClick={() => {
                    onAddChannel('grand_piano', 'Grand Concert Piano', '#e0e0e0');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Grand Concert Piano</span>
                  <span className="text-[9px] text-[#888]">Acoustic</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('rhodes_epiano', 'Vintage Rhodes MK1', '#e67e22');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Vintage Rhodes E-Piano</span>
                  <span className="text-[9px] text-[#888]">Tine Keys</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('hammond_organ', 'Hammond B3 Drawbar', '#d35400');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Hammond B3 Organ</span>
                  <span className="text-[9px] text-[#888]">Leslie Rotary</span>
                </button>

                {/* Section: Plucks, Strings & Brass */}
                <div className="px-3 py-1 text-[8px] font-bold text-[#666] uppercase tracking-wider bg-[#161618]">
                  Orchestral & Strings
                </div>
                <button
                  onClick={() => {
                    onAddChannel('strings_ensemble', 'Orchestral Strings', '#9b59b6');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Orchestral Strings</span>
                  <span className="text-[9px] text-[#888]">Ensemble</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('pizzicato_strings', 'Pizzicato Strings', '#8e44ad');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Pizzicato Staccato</span>
                  <span className="text-[9px] text-[#888]">Pluck</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('nylon_guitar', 'Nylon Pluck Guitar', '#27ae60');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Nylon Acoustic Guitar</span>
                  <span className="text-[9px] text-[#888]">Physical</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('cinematic_brass', 'Cinematic Brass Section', '#f39c12');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Cinematic Horns & Brass</span>
                  <span className="text-[9px] text-[#888]">Brass</span>
                </button>

                {/* Section: Bass & 808 */}
                <div className="px-3 py-1 text-[8px] font-bold text-[#666] uppercase tracking-wider bg-[#161618]">
                  Bass & Low-End
                </div>
                <button
                  onClick={() => {
                    onAddChannel('sub_808', 'Sub Bass 808 Tuned', '#ff5722');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">808 Tuned Sub Bass</span>
                  <span className="text-[9px] text-[#888]">Sub</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('acid_303', 'Acid 303 Resonant', '#2ecc71');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">TB-303 Acid Bassline</span>
                  <span className="text-[9px] text-[#888]">Diode Res</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('reese_bass', 'Neuro Reese Bass', '#c0392b');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Reese Heavy Detune</span>
                  <span className="text-[9px] text-[#888]">DnB/Neuro</span>
                </button>

                {/* Section: Synths, Leads & Pads */}
                <div className="px-3 py-1 text-[8px] font-bold text-[#666] uppercase tracking-wider bg-[#161618]">
                  Synths & Vocals
                </div>
                <button
                  onClick={() => {
                    onAddChannel('supersaw_lead', 'JP-8000 Supersaw', '#00d2d3');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Hypersaw 7-Osc Lead</span>
                  <span className="text-[9px] text-[#888]">Trance</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('ambient_pad', 'Deep Space Ambient Pad', '#54a0ff');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Atmospheric Space Pad</span>
                  <span className="text-[9px] text-[#888]">Pad</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('vox_choir', 'Vocal Choir Formant', '#ff9ff3');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Vocal Choir Formant</span>
                  <span className="text-[9px] text-[#888]">Vowels</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('marimba_bell', 'Marimba / Kalimba', '#1dd1a1');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Wooden Marimba & Bell</span>
                  <span className="text-[9px] text-[#888]">Mallet</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('chiptune_8bit', 'GameBoy 8-Bit Synth', '#feca57');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">8-Bit Retro Chiptune</span>
                  <span className="text-[9px] text-[#888]">Square</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('minisynth', 'MiniSynth 3xOsc', '#9c27b0');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">MiniSynth Subtractive</span>
                  <span className="text-[9px] text-[#888]">3-Osc</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('fmsynth', 'Toxic FM 4-Op Synth', '#00bcd4');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">Toxic FM Modulator</span>
                  <span className="text-[9px] text-[#888]">DX FM</span>
                </button>

                {/* Section: Drums & Sampler */}
                <div className="px-3 py-1 text-[8px] font-bold text-[#666] uppercase tracking-wider bg-[#161618]">
                  Drums & Samples
                </div>
                <button
                  onClick={() => {
                    onAddChannel('drumpad', '808 Drum Sampler', '#ff5722');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">808 Drum Machine Kit</span>
                  <span className="text-[9px] text-[#888]">MPC</span>
                </button>
                <button
                  onClick={() => {
                    onAddChannel('sampler', 'DirectWave Sampler', '#4caf50');
                    setShowAddMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2d2d30] hover:text-white flex items-center justify-between"
                >
                  <span className="font-semibold">DirectWave Sampler</span>
                  <span className="text-[9px] text-[#888]">Sample</span>
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
                  ? 'bg-[#1a1a1d] border-[#ff6e00]/50' 
                  : 'bg-[#141416] border-[#333336] hover:border-[#444]'
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
                      ? 'bg-[#00ff00] border-[#00ff00]' 
                      : 'bg-[#333336] border-[#444]'
                  }`}
                  title={ch.mute ? 'Unmute' : 'Mute'}
                />

                {/* Pan & Volume Mini Knobs */}
                <div className="flex items-center gap-1.5 text-[9px]">
                  <div className="flex flex-col items-center">
                    <span className="text-[#777] text-[8px]">VOL</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={ch.volume}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onUpdateChannel(ch.id, { volume: parseFloat(e.target.value) })}
                      className="w-10 h-1 accent-[#ff6e00] bg-[#333336] rounded cursor-pointer"
                    />
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-[#777] text-[8px]">PAN</span>
                    <input
                      type="range"
                      min="-1"
                      max="1"
                      step="0.1"
                      value={ch.pan}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onUpdateChannel(ch.id, { pan: parseFloat(e.target.value) })}
                      className="w-8 h-1 accent-[#777] bg-[#333336] rounded cursor-pointer"
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
                  className="text-left font-bold text-xs truncate max-w-[120px] transition hover:text-white uppercase tracking-tight"
                  style={{ color: ch.color || '#fff' }}
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
                          ? 'bg-[#ff6e00] text-black shadow-sm'
                          : 'bg-[#222225] hover:bg-[#2d2d30] text-[#777] hover:text-white'
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
                      className={`px-1 py-0.5 rounded text-[8px] font-mono font-bold transition ${
                        ch.customSample
                          ? 'bg-[#00ff88] text-black'
                          : 'bg-[#222225] hover:bg-[#2d2d30] text-[#777] hover:text-white'
                      }`}
                      title="DirectWave Sample Loader & Waveform Slicer"
                    >
                      SMPL
                    </button>
                  )}

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPianoRoll(ch.id);
                    }}
                    className="p-1 text-[#777] hover:text-[#ff6e00] rounded hover:bg-[#222225] text-[10px] font-mono font-semibold"
                    title="Open in Piano Roll"
                  >
                    🎹
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFillSteps(ch, 4);
                    }}
                    className="px-1 py-0.5 bg-[#222225] hover:bg-[#2d2d30] text-[#777] hover:text-white rounded text-[8px] font-mono"
                    title="Fill every 4 steps"
                  >
                    /4
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClearSteps(ch);
                    }}
                    className="px-1 py-0.5 bg-[#222225] hover:bg-[#2d2d30] text-[#777] hover:text-red-400 rounded text-[8px] font-mono"
                    title="Clear steps"
                  >
                    CLR
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
                              ? 'ring-2 ring-white z-10 scale-105'
                              : ''
                          } ${
                            isActive
                              ? 'bg-[#ff6e00] border-[#ff7d1a] shadow-[0_0_8px_rgba(255,110,0,0.5)]'
                              : groupIdx % 2 === 0
                                ? 'bg-[#222225] border-[#333336] hover:bg-[#2d2d30]'
                                : 'bg-[#18181b] border-[#2d2d30] hover:bg-[#242428]'
                          }`}
                          title={`Step ${stepIdx + 1}`}
                        >
                          {isActive && <div className="w-1 h-2 bg-white/60 rounded-xs" />}
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
          className="mt-4 border border-dashed border-[#333336] hover:border-[#ff6e00]/50 rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer bg-[#141416]/50 hover:bg-[#1a1a1d] transition text-center"
        >
          <div className="text-3xl mb-1 opacity-70">🎹</div>
          <div className="text-[11px] text-[#777] font-bold uppercase tracking-widest">
            Switch to Piano Roll Editor for Polyphonic Melody & Chord Writing
          </div>
          <span className="text-[10px] text-[#ff6e00] mt-1">Press Space to play • Click here or select Piano Roll tab</span>
        </div>
      </div>
    </div>
  );
};
