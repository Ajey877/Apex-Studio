import React from 'react';

interface StemSplitterAiModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportStemsToTracks?: (stems: { name: string; type: 'vocals' | 'drums' | 'bass' | 'other' }[]) => void;
}

/** AI functionality is intentionally disabled in the current release. */
export const StemSplitterAiModal: React.FC<StemSplitterAiModalProps> = () => null;
