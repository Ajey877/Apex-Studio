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
              <h3 className="font-bold text-sm text-white tracking-tight">PHANTOM MOBILE PRO MEMBERSHIP TIERS</h3>
              <p className="text-[10px] text-[#777]">Unlock Unlimited Stems, VST Custom Synths & Cloud Sync</p>
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
          <div className="flex items-center justify-between bg-[#1a1a1d] p-3.5 rounded-lg border border-[#333336]">
            <div>
              <span className="text-xs text-[#777]">Current Plan Tier:</span>
              <div className="text-sm font-bold text-[#ff6e00]">
                {isProUser ? '⭐ PRO PRODUCER EDITION (ALL FEATURES UNLOCKED)' : 'FREE HOBBYIST TIER'}
              </div>
            </div>

            <button
              onClick={onTogglePro}
              className={`px-4 py-2 rounded text-xs font-bold transition shadow ${
                isProUser
                  ? 'bg-[#222225] hover:bg-[#2d2d30] text-white border border-[#333336]'
                  : 'bg-[#ff6e00] hover:bg-[#ff7d1a] text-black'
              }`}
            >
              {isProUser ? 'Switch to Free Tier' : '✨ ACTIVATE PRO EDITION'}
            </button>
          </div>

          {/* Pricing Cards Comparison */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Free Tier */}
            <div className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-4 space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-[#777]">HOBBYIST</span>
                <span className="text-lg font-bold text-white">$0 <span className="text-xs text-[#777] font-normal">/ forever</span></span>
              </div>
              <ul className="space-y-2 text-xs text-[#b0b0b0]">
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#00ff00]" /><span>Basic Step Sequencer & MiniSynth</span></li>
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#00ff00]" /><span>808 Drum Machine Sampler</span></li>
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#00ff00]" /><span>WAV 16-bit Standard Export</span></li>
                <li className="flex items-center space-x-2 text-[#555]"><X className="w-3.5 h-3.5" /><span>32-bit Float Multi-Stem ZIP Export</span></li>
                <li className="flex items-center space-x-2 text-[#555]"><X className="w-3.5 h-3.5" /><span>Full VST Plugin Chain</span></li>
              </ul>
            </div>

            {/* Pro Producer */}
            <div className="bg-[#1a1a1d] border-2 border-[#ff6e00] rounded-lg p-4 space-y-3 relative shadow-lg">
              <div className="absolute -top-2.5 right-4 bg-[#ff6e00] text-black px-2 py-0.5 rounded text-[9px] font-bold">
                RECOMMENDED
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-[#ff6e00]">PRO PRODUCER</span>
                <span className="text-lg font-bold text-white">$14.99 <span className="text-xs text-[#777] font-normal">/ mo</span></span>
              </div>
              <ul className="space-y-2 text-xs text-white">
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#ff6e00]" /><span>Unlimited Playlist & Audio Tracks</span></li>
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#ff6e00]" /><span>Studio 32-bit Float & Stem ZIP Export</span></li>
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#ff6e00]" /><span>Full VST FX Racks (EQ 2, Limiter, Reverb)</span></li>
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#ff6e00]" /><span>Real-Time Team Collaboration & E2EE Sync</span></li>
                <li className="flex items-center space-x-2"><Check className="w-3.5 h-3.5 text-[#ff6e00]" /><span>Web MIDI Hardware Controller Mapping</span></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
