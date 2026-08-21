import React, { useState } from 'react';
import { 
  Music, 
  Disc, 
  Radio, 
  Sparkles, 
  Cpu, 
  Sliders, 
  Volume2, 
  Layers, 
  Play, 
  Flame, 
  Activity
} from 'lucide-react';
import { Channel, SynthParameters, InstrumentType } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface InstrumentRackProps {
  channel: Channel;
  allChannels: Channel[];
  onSelectChannel: (channelId: string) => void;
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

const SYNTH_PRESETS = [
  {
    name: 'Grand Concert Piano',
    type: 'grand_piano',
    params: { osc1Type: 'triangle', osc2Type: 'sine', filterCutoff: 6500, filterResonance: 1.2, attack: 0.003, decay: 1.2, sustain: 0.2, release: 0.4 }
  },
  {
    name: 'Vintage Rhodes MK1',
    type: 'rhodes_epiano',
    params: { osc1Type: 'sine', osc2Type: 'sine', filterCutoff: 4800, filterResonance: 1.0, attack: 0.005, decay: 0.9, sustain: 0.3, release: 0.3 }
  },
  {
    name: 'Hammond B3 Organ',
    type: 'hammond_organ',
    params: { osc1Type: 'sine', osc2Type: 'sine', filterCutoff: 8000, filterResonance: 1.0, attack: 0.001, decay: 0.1, sustain: 0.9, release: 0.1 }
  },
  {
    name: 'Orchestral Strings',
    type: 'strings_ensemble',
    params: { osc1Type: 'sawtooth', osc2Type: 'sawtooth', osc1Detune: -8, osc2Detune: 8, filterCutoff: 5500, filterResonance: 1.5, attack: 0.25, decay: 0.8, sustain: 0.85, release: 0.6 }
  },
  {
    name: 'Pizzicato Pluck',
    type: 'pizzicato_strings',
    params: { osc1Type: 'sawtooth', filterCutoff: 3200, filterResonance: 3.5, attack: 0.002, decay: 0.3, sustain: 0.0, release: 0.15 }
  },
  {
    name: 'Nylon Guitar Pluck',
    type: 'nylon_guitar',
    params: { osc1Type: 'sawtooth', osc2Type: 'triangle', filterCutoff: 4200, filterResonance: 2.0, attack: 0.002, decay: 0.6, sustain: 0.1, release: 0.25 }
  },
  {
    name: 'Cinematic Brass Section',
    type: 'cinematic_brass',
    params: { osc1Type: 'sawtooth', osc2Type: 'square', filterCutoff: 4800, filterResonance: 4.0, attack: 0.06, decay: 0.7, sustain: 0.75, release: 0.3 }
  },
  {
    name: '808 Saturated Sub',
    type: 'sub_808',
    params: { osc1Type: 'sine', osc2Type: 'triangle', osc1Mix: 1.0, osc2Mix: 0.2, filterCutoff: 450, filterResonance: 3.5, decay: 0.6, sustain: 0.3, release: 0.4 }
  },
  {
    name: 'Acid 303 Resonant Bass',
    type: 'acid_303',
    params: { osc1Type: 'sawtooth', osc1Mix: 1.0, osc2Mix: 0, filterCutoff: 900, filterResonance: 12.0, filterEnvAmount: 0.8, decay: 0.2, sustain: 0.2, release: 0.1 }
  },
  {
    name: 'Neuro Reese Bass',
    type: 'reese_bass',
    params: { osc1Type: 'sawtooth', osc2Type: 'sawtooth', osc1Detune: -15, osc2Detune: 15, filterCutoff: 1100, filterResonance: 3.0, attack: 0.02, decay: 0.5, sustain: 0.8, release: 0.2 }
  },
  {
    name: 'JP-8000 Supersaw Lead',
    type: 'supersaw_lead',
    params: { osc1Type: 'sawtooth', osc2Type: 'sawtooth', osc1Detune: -14, osc2Detune: 14, filterCutoff: 7800, filterResonance: 2.5, attack: 0.01, decay: 0.4, sustain: 0.7, release: 0.3 }
  },
  {
    name: 'Dreamy Ambient Pad',
    type: 'ambient_pad',
    params: { osc1Type: 'sawtooth', osc2Type: 'triangle', filterCutoff: 1800, attack: 0.4, decay: 0.9, sustain: 0.8, release: 0.9, lfoRate: 2, lfoDepth: 0.25, lfoTarget: 'filter' }
  },
  {
    name: 'Vocal Choir Formant',
    type: 'vox_choir',
    params: { osc1Type: 'sawtooth', filterCutoff: 2400, filterResonance: 5.0, attack: 0.1, decay: 0.5, sustain: 0.8, release: 0.4 }
  },
  {
    name: 'Marimba Wood Mallet',
    type: 'marimba_bell',
    params: { osc1Type: 'sine', filterCutoff: 3800, filterResonance: 1.0, attack: 0.002, decay: 0.45, sustain: 0.0, release: 0.2 }
  },
  {
    name: '8-Bit Retro GameBoy',
    type: 'chiptune_8bit',
    params: { osc1Type: 'square', filterCutoff: 12000, filterResonance: 1.0, attack: 0.001, decay: 0.2, sustain: 0.4, release: 0.05 }
  },
  {
    name: 'Dark FM Bell Pluck',
    type: 'fmsynth',
    params: { fmCarrierMultiplier: 1.0, fmModulatorMultiplier: 3.5, fmModulationIndex: 260, decay: 0.4 }
  }
];

export const InstrumentRack: React.FC<InstrumentRackProps> = ({
  channel,
  allChannels,
  onSelectChannel,
  onUpdateChannel
}) => {
  const p = channel.synthParams || audioEngine.getDefaultSynthParams();

  const handleUpdateParams = (updates: Partial<SynthParameters>) => {
    onUpdateChannel(channel.id, {
      synthParams: { ...p, ...updates }
    });
  };

  const handleApplyPreset = (preset: typeof SYNTH_PRESETS[0]) => {
    onUpdateChannel(channel.id, {
      synthParams: { ...p, ...preset.params } as any
    });
  };

  const handleTriggerVirtualKey = (midiNote: number) => {
    audioEngine.playNote(channel, {
      id: `live-${midiNote}`,
      pitch: midiNote,
      start: 0,
      duration: 1.2,
      velocity: 0.9
    });
  };

  return (
    <div id="fl-instrument-rack" className="flex flex-col h-full bg-[#121214] select-none text-[#b0b0b0]">
      {/* Top Bar with Channel Switcher & Preset Selector */}
      <div className="h-9 bg-[#1e1e20] border-b border-[#333336] flex items-center justify-between px-4 shrink-0 gap-4">
        {/* Active Instrument Title */}
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span className="text-[10px] font-bold text-white uppercase tracking-wider">
            VST GENERATOR: <span style={{ color: channel.color }}>{channel.name}</span>
          </span>

          <select
            value={channel.id}
            onChange={(e) => onSelectChannel(e.target.value)}
            className="bg-[#121214] text-[#ff6e00] font-bold text-xs px-2 py-0.5 rounded border border-[#333336] focus:outline-none cursor-pointer ml-2"
          >
            {allChannels.map((ch) => (
              <option key={ch.id} value={ch.id}>{ch.name}</option>
            ))}
          </select>
        </div>

        {/* Quick Synth Presets */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <span className="text-[9px] text-[#777] uppercase font-bold">PRESETS:</span>
          {SYNTH_PRESETS.map((pre, idx) => (
            <button
              key={idx}
              onClick={() => handleApplyPreset(pre)}
              className="px-2 py-0.5 bg-[#121214] hover:bg-[#ff6e00] hover:text-black text-white text-[10px] font-semibold rounded border border-[#333336] transition whitespace-nowrap"
            >
              {pre.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main Synthesizer & Sound Design Dashboard */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        {/* Synth Engine Sections */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Section 1: Dual Oscillators (Sound Generation) */}
          <div className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between border-b border-[#333336] pb-1.5">
              <span className="text-xs font-bold text-white uppercase tracking-tight flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>OSCILLATORS 1 & 2</span>
              </span>
              <span className="text-[9px] text-[#ff6e00] font-mono font-bold">SUBTRACTIVE / FM</span>
            </div>

            {/* Osc 1 */}
            <div className="space-y-1.5 bg-[#121214] p-2.5 rounded border border-[#333336]">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white font-bold">OSC 1 (Waveform)</span>
                <select
                  value={p.osc1Type}
                  onChange={(e) => handleUpdateParams({ osc1Type: e.target.value as OscillatorType })}
                  className="bg-[#222225] text-white text-xs px-2 py-0.5 rounded border border-[#333336]"
                >
                  <option value="sawtooth">Sawtooth</option>
                  <option value="square">Square / Pulse</option>
                  <option value="sine">Pure Sine</option>
                  <option value="triangle">Triangle</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[10px] text-[#777] pt-1">
                <div>
                  <div className="flex justify-between"><span>DETUNE</span><span className="text-[#ff6e00]">{p.osc1Detune}c</span></div>
                  <input
                    type="range"
                    min="-50"
                    max="50"
                    value={p.osc1Detune}
                    onChange={(e) => handleUpdateParams({ osc1Detune: Number(e.target.value) })}
                    className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                  />
                </div>
                <div>
                  <div className="flex justify-between"><span>MIX</span><span className="text-[#ff6e00]">{Math.round(p.osc1Mix * 100)}%</span></div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={p.osc1Mix}
                    onChange={(e) => handleUpdateParams({ osc1Mix: parseFloat(e.target.value) })}
                    className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                  />
                </div>
              </div>
            </div>

            {/* Osc 2 */}
            <div className="space-y-1.5 bg-[#121214] p-2.5 rounded border border-[#333336]">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white font-bold">OSC 2 (Layer)</span>
                <select
                  value={p.osc2Type}
                  onChange={(e) => handleUpdateParams({ osc2Type: e.target.value as OscillatorType })}
                  className="bg-[#222225] text-white text-xs px-2 py-0.5 rounded border border-[#333336]"
                >
                  <option value="sawtooth">Sawtooth</option>
                  <option value="square">Square / Pulse</option>
                  <option value="sine">Pure Sine</option>
                  <option value="triangle">Triangle</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[10px] text-[#777] pt-1">
                <div>
                  <div className="flex justify-between"><span>DETUNE</span><span className="text-[#ff6e00]">{p.osc2Detune}c</span></div>
                  <input
                    type="range"
                    min="-50"
                    max="50"
                    value={p.osc2Detune}
                    onChange={(e) => handleUpdateParams({ osc2Detune: Number(e.target.value) })}
                    className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                  />
                </div>
                <div>
                  <div className="flex justify-between"><span>MIX</span><span className="text-[#ff6e00]">{Math.round(p.osc2Mix * 100)}%</span></div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={p.osc2Mix}
                    onChange={(e) => handleUpdateParams({ osc2Mix: parseFloat(e.target.value) })}
                    className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Analog Ladder Filter & LFO */}
          <div className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between border-b border-[#333336] pb-1.5">
              <span className="text-xs font-bold text-white uppercase tracking-tight flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>STATE VARIABLE FILTER</span>
              </span>
              <span className="text-[9px] text-[#ff6e00] font-mono font-bold">24dB LADDER</span>
            </div>

            <div className="space-y-3 bg-[#121214] p-3 rounded border border-[#333336]">
              {/* Cutoff */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-semibold">CUTOFF FREQUENCY</span>
                  <span className="text-[#ff6e00] font-mono">{Math.round(p.filterCutoff)} Hz</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="16000"
                  step="20"
                  value={p.filterCutoff}
                  onChange={(e) => handleUpdateParams({ filterCutoff: Number(e.target.value) })}
                  className="w-full h-1.5 accent-[#ff6e00] bg-[#333336] rounded"
                />
              </div>

              {/* Resonance */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-semibold">RESONANCE (Q-FACTOR)</span>
                  <span className="text-[#ff6e00] font-mono">{p.filterResonance.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="18"
                  step="0.5"
                  value={p.filterResonance}
                  onChange={(e) => handleUpdateParams({ filterResonance: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[#ff6e00] bg-[#333336] rounded"
                />
              </div>

              {/* LFO Modulation Rate & Target */}
              <div className="pt-2 border-t border-[#333336] space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[#777] font-bold text-[10px]">LFO MOD DESTINATION</span>
                  <select
                    value={p.lfoTarget}
                    onChange={(e) => handleUpdateParams({ lfoTarget: e.target.value as any })}
                    className="bg-[#222225] text-white text-[10px] px-2 py-0.5 rounded border border-[#333336]"
                  >
                    <option value="none">Off (No Mod)</option>
                    <option value="filter">Filter Cutoff (Wah)</option>
                    <option value="pitch">Vibrato Pitch</option>
                    <option value="volume">Tremolo Amplitude</option>
                  </select>
                </div>

                <div className="flex justify-between text-[10px] text-[#777]">
                  <span>RATE: {p.lfoRate} Hz</span>
                  <input
                    type="range"
                    min="0.1"
                    max="15"
                    step="0.5"
                    value={p.lfoRate}
                    onChange={(e) => handleUpdateParams({ lfoRate: parseFloat(e.target.value) })}
                    className="w-24 h-1 accent-[#ff6e00] bg-[#333336] rounded"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: ADSR Amplitude Envelope */}
          <div className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between border-b border-[#333336] pb-1.5">
              <span className="text-xs font-bold text-white uppercase tracking-tight flex items-center gap-1.5">
                <Flame className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>ADSR AMPLITUDE ENVELOPE</span>
              </span>
              <span className="text-[9px] text-[#ff6e00] font-mono font-bold">SHAPE</span>
            </div>

            <div className="bg-[#121214] p-3 rounded border border-[#333336] space-y-2.5">
              {/* Attack */}
              <div className="space-y-0.5 text-xs">
                <div className="flex justify-between text-[10px] text-[#777]">
                  <span>ATTACK TIME</span>
                  <span className="text-[#ff6e00] font-mono">{(p.attack * 1000).toFixed(0)} ms</span>
                </div>
                <input
                  type="range"
                  min="0.005"
                  max="1.5"
                  step="0.01"
                  value={p.attack}
                  onChange={(e) => handleUpdateParams({ attack: parseFloat(e.target.value) })}
                  className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                />
              </div>

              {/* Decay */}
              <div className="space-y-0.5 text-xs">
                <div className="flex justify-between text-[10px] text-[#777]">
                  <span>DECAY TIME</span>
                  <span className="text-[#ff6e00] font-mono">{(p.decay * 1000).toFixed(0)} ms</span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="2.0"
                  step="0.05"
                  value={p.decay}
                  onChange={(e) => handleUpdateParams({ decay: parseFloat(e.target.value) })}
                  className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                />
              </div>

              {/* Sustain */}
              <div className="space-y-0.5 text-xs">
                <div className="flex justify-between text-[10px] text-[#777]">
                  <span>SUSTAIN LEVEL</span>
                  <span className="text-[#ff6e00] font-mono">{Math.round(p.sustain * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1.0"
                  step="0.05"
                  value={p.sustain}
                  onChange={(e) => handleUpdateParams({ sustain: parseFloat(e.target.value) })}
                  className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                />
              </div>

              {/* Release */}
              <div className="space-y-0.5 text-xs">
                <div className="flex justify-between text-[10px] text-[#777]">
                  <span>RELEASE TIME</span>
                  <span className="text-[#ff6e00] font-mono">{(p.release * 1000).toFixed(0)} ms</span>
                </div>
                <input
                  type="range"
                  min="0.02"
                  max="3.0"
                  step="0.05"
                  value={p.release}
                  onChange={(e) => handleUpdateParams({ release: parseFloat(e.target.value) })}
                  className="w-full h-1 accent-[#ff6e00] bg-[#333336] rounded"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Live Touch Synthesizer Keyboard (2 Octaves: C3 to C5) */}
        <div className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-white tracking-wider text-[10px] uppercase">LIVE TOUCH SYNTHESIZER KEYBOARD</span>
            <span className="text-[10px] text-[#777]">Trigger live with mouse, touch, or computer keys (A-K)</span>
          </div>

          <div className="flex h-28 bg-[#121214] p-1.5 rounded border border-[#333336] overflow-x-auto select-none">
            {[48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72].map((midiNote) => {
              const isBlack = [1, 3, 6, 8, 10].includes(midiNote % 12);
              const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
              const octave = Math.floor(midiNote / 12) - 1;
              const label = `${noteNames[midiNote % 12]}${octave}`;

              return (
                <button
                  key={midiNote}
                  onMouseDown={() => handleTriggerVirtualKey(midiNote)}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    handleTriggerVirtualKey(midiNote);
                  }}
                  className={`flex-1 min-w-[28px] sm:min-w-[34px] rounded-sm transition active:scale-95 flex flex-col justify-end items-center pb-2 text-[8px] font-mono font-bold mx-0.5 select-none ${
                    isBlack
                      ? 'bg-[#0a0a0b] text-[#777] hover:bg-[#1a1a1d] active:bg-[#ff6e00] active:text-black border border-[#222225] h-3/4 z-10 -mx-2.5 shadow'
                      : 'bg-[#222225] text-white hover:bg-[#2d2d30] active:bg-[#ff6e00] active:text-black border border-[#333336] h-full shadow-sm'
                  }`}
                >
                  <span className={midiNote % 12 === 0 ? 'text-[#ff6e00] font-bold' : ''}>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
