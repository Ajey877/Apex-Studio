import React, { useState, useEffect } from 'react';
import { RotateCw, Smartphone, Maximize2, X, Sparkles, Sliders } from 'lucide-react';

interface OrientationLockModalProps {
  onForceDismiss?: () => void;
}

export const OrientationLockModal: React.FC<OrientationLockModalProps> = ({ onForceDismiss }) => {
  const [isPortrait, setIsPortrait] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [isMobileDevice, setIsMobileDevice] = useState(false);

  useEffect(() => {
    const checkOrientation = () => {
      // Detect if device has touch capability or is mobile screen
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const isMobile = isTouch || window.innerWidth < 768;
      setIsMobileDevice(isMobile);

      // In portrait if height > width
      const portrait = window.innerHeight > window.innerWidth;
      setIsPortrait(portrait);
    };

    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);

    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, []);

  const handleRequestFullscreenAndLandscape = async () => {
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      // Attempt screen orientation lock if available in browser
      if (screen.orientation && 'lock' in screen.orientation) {
        // @ts-ignore
        await screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (e) {
      console.log('Fullscreen/orientation lock not supported or denied', e);
    }
    setDismissed(true);
    if (onForceDismiss) onForceDismiss();
  };

  const handleDismiss = () => {
    setDismissed(true);
    if (onForceDismiss) onForceDismiss();
  };

  // Only show if mobile / narrow touch device and oriented vertically
  if (!isPortrait || dismissed || !isMobileDevice) {
    return null;
  }

  return (
    <div 
      id="fl-orientation-lock-overlay"
      className="fixed inset-0 z-50 bg-[#0a0a0b]/98 backdrop-blur-xl flex flex-col items-center justify-center p-6 text-center select-none animate-fadeIn text-white"
    >
      {/* Decorative Audio Waves Glow */}
      <div className="absolute inset-0 bg-radial from-[#ff6e00]/10 via-transparent to-transparent pointer-events-none" />

      {/* Dismiss Button in corner */}
      <button
        onClick={handleDismiss}
        className="absolute top-4 right-4 p-2 text-[#777] hover:text-white bg-[#1a1a1d] hover:bg-[#26262b] border border-[#333336] rounded-full transition"
        title="Dismiss lock screen"
      >
        <X className="w-4 h-4" />
      </button>

      {/* Main Animated Graphic */}
      <div className="relative mb-6 flex items-center justify-center">
        {/* Glowing Pulsing Circle */}
        <div className="w-28 h-28 rounded-full bg-[#ff6e00]/10 border border-[#ff6e00]/30 animate-pulse flex items-center justify-center">
          <div className="w-20 h-20 rounded-full bg-[#ff6e00]/20 border border-[#ff6e00]/40 flex items-center justify-center">
            {/* Phone rotating graphic */}
            <div className="relative">
              <div className="w-12 h-20 bg-[#1e1e24] border-2 border-[#ff6e00] rounded-xl flex flex-col items-center justify-between p-1.5 shadow-2xl animate-[spin_6s_ease-in-out_infinite]">
                <div className="w-4 h-1 bg-[#ff6e00] rounded-full" />
                <div className="flex gap-0.5 items-end h-8">
                  <div className="w-1 h-3 bg-[#00ff00] rounded-xs" />
                  <div className="w-1 h-6 bg-[#ff6e00] rounded-xs" />
                  <div className="w-1 h-4 bg-[#ff6e00] rounded-xs" />
                  <div className="w-1 h-7 bg-[#ff0000] rounded-xs" />
                </div>
                <div className="w-2 h-2 bg-[#ff6e00] rounded-full" />
              </div>

              {/* Rotation Arrow Icon */}
              <div className="absolute -top-3 -right-3 w-7 h-7 bg-[#ff6e00] rounded-full flex items-center justify-center text-black shadow-lg">
                <RotateCw className="w-4 h-4 animate-spin-slow" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Brand & Badge */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#ff6e00]/15 border border-[#ff6e00]/40 rounded-full text-[#ff6e00] text-[11px] font-mono font-bold tracking-wide uppercase mb-3">
        <Sliders className="w-3.5 h-3.5" />
        <span>FL STUDIO MOBILE • LANDSCAPE MODE ONLY</span>
      </div>

      {/* Title */}
      <h1 className="text-2xl font-black tracking-tight text-white mb-2">
        ROTATE DEVICE TO LANDSCAPE
      </h1>

      {/* Explanation */}
      <p className="text-xs text-[#999] max-w-sm leading-relaxed mb-6">
        Phantom Mobile is precision-engineered for widescreen landscape orientation to provide full access to the 16-step sequencer, multi-octave piano roll, and 8-channel mixer.
      </p>

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-xs">
        <button
          onClick={handleRequestFullscreenAndLandscape}
          className="w-full py-3 px-4 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs uppercase tracking-wider rounded-lg shadow-lg flex items-center justify-center gap-2 transition active:scale-95 cursor-pointer"
        >
          <Maximize2 className="w-4 h-4" />
          <span>Rotate & Fullscreen</span>
        </button>

        <button
          onClick={handleDismiss}
          className="w-full py-2.5 px-4 bg-[#1a1a1d] hover:bg-[#25252a] text-[#888] hover:text-white border border-[#333336] text-[11px] font-semibold rounded-lg transition cursor-pointer"
        >
          Continue Anyway
        </button>
      </div>

      {/* Hint */}
      <div className="mt-6 text-[10px] text-[#555] font-mono flex items-center gap-1.5">
        <span>TIP: Turn off Portrait Orientation Lock in your device control center.</span>
      </div>
    </div>
  );
};
