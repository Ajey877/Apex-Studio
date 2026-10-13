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
    // UI-03O: the rotate-device lock screen is fully themed through the existing
    // `--apex-*` tokens, without adopting the shared dialog frame or any dialog —
    // this overlay is a full-screen page state, not a dismissible dialog, and the
    // shell suite pins that it stays that way. The near-opaque veil keeps its
    // character through a themed `--apex-bg` wash, the illustration and CTAs keep
    // their accent identity on `--apex-accent` (the token the UI-1C compatibility
    // layer already resolved these `#ff6e00` literals to, so the rendered hue is
    // unchanged), and the meter bars keep `--apex-success` / `--apex-danger`.
    <div 
      id="fl-orientation-lock-overlay"
      className="fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--apex-bg)_96%,transparent)] backdrop-blur-xl flex flex-col items-center justify-center p-6 text-center select-none animate-fadeIn text-[var(--apex-text)]"
    >
      {/* Decorative Audio Waves Glow */}
      <div className="absolute inset-0 bg-radial from-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] via-transparent to-transparent pointer-events-none" />

      {/* Dismiss Button in corner */}
      <button
        onClick={handleDismiss}
        className="absolute top-4 right-4 p-2 text-[var(--apex-text-3)] hover:text-[var(--apex-text)] bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] border border-[var(--apex-border)] rounded-full transition"
        title="Dismiss lock screen"
      >
        <X className="w-4 h-4" />
      </button>

      {/* Main Animated Graphic */}
      <div className="relative mb-6 flex items-center justify-center">
        {/* Glowing Pulsing Circle */}
        <div className="w-28 h-28 rounded-full bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] animate-pulse flex items-center justify-center">
          <div className="w-20 h-20 rounded-full bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] flex items-center justify-center">
            {/* Phone rotating graphic */}
            <div className="relative">
              <div className="w-12 h-20 bg-[var(--apex-surface-3)] border-2 border-[var(--apex-accent)] rounded-xl flex flex-col items-center justify-between p-1.5 shadow-2xl animate-[spin_6s_ease-in-out_infinite]">
                <div className="w-4 h-1 bg-[var(--apex-accent)] rounded-full" />
                <div className="flex gap-0.5 items-end h-8">
                  <div className="w-1 h-3 bg-[var(--apex-success)] rounded-xs" />
                  <div className="w-1 h-6 bg-[var(--apex-accent)] rounded-xs" />
                  <div className="w-1 h-4 bg-[var(--apex-accent)] rounded-xs" />
                  <div className="w-1 h-7 bg-[var(--apex-danger)] rounded-xs" />
                </div>
                <div className="w-2 h-2 bg-[var(--apex-accent)] rounded-full" />
              </div>

              {/* Rotation Arrow Icon */}
              <div className="absolute -top-3 -right-3 w-7 h-7 bg-[var(--apex-accent)] rounded-full flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-lg">
                <RotateCw className="w-4 h-4 animate-spin-slow" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Brand & Badge */}
      {/* UI-03O: the identity pill keeps its accent wash and edge; the label
          follows `--apex-text` because accent-on-accent-wash measures 4.10:1 in
          Light for this 11px label (Dark measures 5.18:1), below the 4.5:1 AA
          floor. */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded-full text-[var(--apex-text)] text-[11px] font-mono font-bold tracking-wide uppercase mb-3">
        <Sliders className="w-3.5 h-3.5" />
        <span>APEX STUDIO • LANDSCAPE MODE ONLY</span>
      </div>

      {/* Title */}
      <h1 className="text-2xl font-black tracking-tight text-[var(--apex-text)] mb-2">ROTATE DEVICE TO LANDSCAPE</h1>

      {/* Explanation */}
      <p className="text-xs text-[var(--apex-text-2)] max-w-sm leading-relaxed mb-6">
        Apex Studio is precision-engineered for widescreen landscape orientation to provide full access to the 16-step sequencer, multi-octave piano roll, and
        8-channel mixer.
      </p>

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-xs">
        <button
          onClick={handleRequestFullscreenAndLandscape}
          className="w-full py-3 px-4 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-xs uppercase tracking-wider rounded-lg shadow-lg flex items-center justify-center gap-2 transition active:scale-95 cursor-pointer"
        >
          <Maximize2 className="w-4 h-4" />
          <span>Rotate & Fullscreen</span>
        </button>

        <button
          onClick={handleDismiss}
          className="w-full py-2.5 px-4 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)] border border-[var(--apex-border)] text-[11px] font-semibold rounded-lg transition cursor-pointer"
        >
          Continue Anyway
        </button>
      </div>

      {/* Hint */}
      <div className="mt-6 text-[10px] text-[var(--apex-text-3)] font-mono flex items-center gap-1.5">
        <span>TIP: Turn off Portrait Orientation Lock in your device control center.</span>
      </div>
    </div>
  );
};
