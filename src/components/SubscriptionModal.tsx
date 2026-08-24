import React from 'react';
import { 
  Crown, 
  Check, 
  X, 
  Sparkles, 
  ShieldCheck, 
  Zap, 
  Cpu, 
  Music, 
  Cloud 
} from 'lucide-react';

interface SubscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  isProUser: boolean;
  onTogglePro: () => void;
}

export const SubscriptionModal: React.FC<SubscriptionModalProps> = ({
  isOpen,
  onClose,
  isProUser,
  onTogglePro
}) => {
  if (!isOpen) return null;

  return (
    <div id="subscription-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0]">
        {/* Header */}
        <div className="px-6 py-4 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <Crown className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">APEX STUDIO — 100% FREE & UNLOCKED FOR ALL</h3>
              <p className="text-[10px] text-[#00ff88] font-bold">Community Access: All Studio Features, Stems & Plugins are 100% Free</p>
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
        <div className="p-6 space-y-5">
          {/* Active Status Badge */}
          <div className="flex items-center justify-between bg-gradient-to-r from-[#1a1a1d] to-[#252219] p-4 rounded-lg border border-[#ffaa00]/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40">
                  FREE ACCESS ACTIVE
                </span>
                <span className="text-xs text-[#aaa]">Community Edition</span>
              </div>
              <div className="text-sm font-bold text-white pt-1">
                ⭐ ALL PRO STUDIO TOOLS UNLOCKED ($0.00 / FREE FOR EVERYONE)
              </div>
              <p className="text-[11px] text-[#888] pt-0.5">
                Enjoy unlimited stems, audio tracks, wavetable synths, mastering suites, and Windows desktop standalone exports.
              </p>
            </div>

            <div className="px-3 py-1.5 bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40 rounded-lg text-xs font-bold font-mono">
              UNLIMITED PRO
            </div>
          </div>

          {/* Feature Showcase Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="bg-[#18181c] border border-[#28282e] rounded-lg p-3.5 space-y-2">
              <span className="text-[11px] font-bold text-[#ffaa00] flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5" />
                <span>Production & Arrangement</span>
              </span>
              <ul className="space-y-1.5 text-[11px] text-[#ccc]">
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>Unlimited Playlist & Step Sequencer Tracks</span></li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>Advanced Piano Roll with Scale & Chord Stamps</span></li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>Multi-Zone DirectWave Sample Keymapper</span></li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>3D Wavetable Morphing Synthesizer</span></li>
              </ul>
            </div>

            <div className="bg-[#18181c] border border-[#28282e] rounded-lg p-3.5 space-y-2">
              <span className="text-[11px] font-bold text-[#00e5ff] flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" />
                <span>Mixing & Mastering Suite</span>
              </span>
              <ul className="space-y-1.5 text-[11px] text-[#ccc]">
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>32-bit Float Multi-Stem ZIP & WAV Export</span></li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>3-Band Linear Phase Mastering Limiter with LUFS</span></li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>Gross Beat 36 Time & Volume Pattern Gates</span></li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-[#00ff88]" /><span>Native Windows .EXE Desktop Launcher</span></li>
              </ul>
            </div>
          </div>

          <div className="p-3 bg-[#141418] rounded-lg border border-[#26262a] text-[11px] text-[#777] flex items-center justify-between">
            <span>💡 All features are free and ready to use in your browser and on desktop. Optional hosted team storage can be linked in the future.</span>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold rounded text-xs transition"
            >
              Start Creating
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
