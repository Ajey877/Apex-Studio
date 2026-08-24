import React from 'react';

interface StemSplitterAiModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportStemsToTracks?: (stems: { name: string; type: 'vocals' | 'drums' | 'bass' | 'other' }[]) => void;
}

/**
 * AI functionality is intentionally disabled in the current Apex Studio release.
 * This compatibility component remains only so older project state can compile safely.
 */
export const StemSplitterAiModal: React.FC<StemSplitterAiModalProps> = () => null;
