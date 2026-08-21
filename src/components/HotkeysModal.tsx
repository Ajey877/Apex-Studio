import React from 'react';
import { Keyboard, X, Sparkles, Command } from 'lucide-react';

interface HotkeysModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUT_GROUPS = [
  {
    category: 'Playback & Transport',
    items: [
      { key: 'Space', desc: 'Play / Pause' },
      { key: 'L', desc: 'Switch Pattern / Song Mode' },
      { key: 'R', desc: 'Arm / Disarm Recording' },
      { key: 'Home / 0', desc: 'Return to Bar 1' },
      { key: 'M', desc: 'Toggle Metronome Click' }
    ]
  },
  {
    category: 'View & Navigation',
    items: [
      { key: 'F6 / 1', desc: 'Open Step Sequencer (Channel Rack)' },
      { key: 'F7 / 2', desc: 'Open Piano Roll Editor' },
      { key: 'F5 / 3', desc: 'Open Playlist Arranger' },
      { key: 'F9 / 4', desc: 'Open Studio Mixer & FX' },
      { key: 'F8 / 5', desc: 'Open VST Instrument Rack' }
    ]
  },
  {
    category: 'Editing & Tools',
    items: [
      { key: 'Ctrl + Z', desc: 'Undo Action' },
      { key: 'Ctrl + Y', desc: 'Redo Action' },
      { key: 'Ctrl + S', desc: 'Save & Sync Project' },
      { key: 'Ctrl + E', desc: 'Open Master Render Engine' },
      { key: 'B / P', desc: 'Draw / Paint Tool' },
      { key: 'D / E', desc: 'Delete / Erase Tool' }
    ]
  },
  {
    category: 'Live Performance & MIDI',
    items: [
      { key: 'A - K', desc: 'Trigger White Piano Keys (C3 - E4)' },
      { key: 'W, E, T, Y, U', desc: 'Trigger Black Piano Keys (C# - D#)' },
      { key: '1 - 9 (Numpad)', desc: 'Trigger Drum Pad MPC Samples' },
      { key: 'Z / X', desc: 'Octave Shift Down / Up' }
    ]
  }
];

export const HotkeysModal: React.FC<HotkeysModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div id="hotkeys-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <Keyboard className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">STUDIO KEYBOARD SHORTCUTS & HOTKEYS</h3>
              <p className="text-[10px] text-[#777]">Desktop & Hardware Controller Keybindings</p>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {SHORTCUT_GROUPS.map((group, gIdx) => (
              <div key={gIdx} className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-3 space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-[#ff6e00] border-b border-[#333336] pb-1">
                  {group.category}
                </div>
                <div className="space-y-1.5">
                  {group.items.map((item, iIdx) => (
                    <div key={iIdx} className="flex items-center justify-between text-[11px]">
                      <span className="text-[#b0b0b0]">{item.desc}</span>
                      <kbd className="px-2 py-0.5 bg-[#121214] border border-[#333336] rounded text-white font-mono text-[10px] font-semibold">
                        {item.key}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="p-3 bg-[#121214] border border-[#333336] rounded-lg flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2 text-[#777]">
              <Command className="w-4 h-4 text-[#ff6e00]" />
              <span>Tip: All shortcuts are active globally without taking focus away from knobs.</span>
            </div>
            <button
              onClick={onClose}
              className="px-3 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
