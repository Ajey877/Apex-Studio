import React, { useMemo, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Layers, 
  X, 
  Scissors, 
  Play, 
  Check, 
  Star
} from 'lucide-react';
import type { PlaylistClip } from '../types/daw';
import { 
  getTakeGroupIds, 
  getTakeGroupClips, 
  resolveActiveTakeIndex,
  selectActiveTake 
} from '../audio/takeLaneManager';

interface TakeCompingModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlistClips: PlaylistClip[];
  onSelectActiveTake: (takeGroupId: string, takeIndex: number) => void;
}

/**
 * Phase 1M: Take Comping UI
 * 
 * Displays all take groups in the project and allows the user to select
 * which take is active in each group. The selection is persisted through
 * the parent's onSelectActiveTake callback.
 */
export const TakeCompingModal: React.FC<TakeCompingModalProps> = ({
  isOpen,
  onClose,
  playlistClips,
  onSelectActiveTake,
}) => {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const takeGroups = useMemo(() => {
    const groupIds = getTakeGroupIds(playlistClips);
    return groupIds.map(groupId => {
      const clips = getTakeGroupClips(playlistClips, groupId);
      const activeIndex = resolveActiveTakeIndex(clips, groupId);
      return { groupId, clips, activeIndex };
    });
  }, [playlistClips]);

  if (!isOpen) return null;

  const handleSelectTake = (groupId: string, takeIndex: number) => {
    onSelectActiveTake(groupId, takeIndex);
  };

  const selectedGroup = takeGroups.find(g => g.groupId === selectedGroupId);

  return (
    <ModalFrame id="fl-take-comping-modal" labelledBy="fl-take-comping-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/* UI-03N: every chrome surface, border, text and interaction state below
          consumes the existing `--apex-*` semantic tokens. The comping tool's
          cyan identity (tile, panel edge, selected group border, active-take
          fill, Check glyph and the Done CTA) stays on the `--apex-cyan`
          family — the same token the audio-recorder and vocal-tuner
          identities use. The dead `bg-black/85` scrim is gone — ModalFrame
          supplies the shared themed `--apex-modal-overlay`.

          Group/take selection is UI state, not persisted data: the selected
          group card takes a themed `--apex-surface-3` step, its identity
          border and a `--apex-accent-strong` ring, so selection never depends
          on a single colour alone. */}
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-cyan)_40%,transparent)] rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-cyan)] to-[var(--apex-cyan-strong)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h2 id="fl-take-comping-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">TAKE COMPING</h2>
              <p className="text-[10px] text-[var(--apex-text-3)]">Select the active take for each recording group</p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close take comping"
            className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {takeGroups.length === 0 ? (
            <div className="bg-[var(--apex-canvas)] p-8 rounded-xl border border-[var(--apex-border)] text-center">
              <Layers className="w-12 h-12 mx-auto mb-3 text-[var(--apex-text-3)]" />
              <p className="text-sm text-[var(--apex-text-2)]">No take groups found</p>
              <p className="text-xs text-[var(--apex-text-3)] mt-2">Record multiple takes on the same track to create take groups</p>
            </div>
          ) : (
            <div className="space-y-4">
              {takeGroups.map(group => {
                const isSelected = selectedGroupId === group.groupId;
                const refClip = group.clips[0];
                
                return (
                  <div
                    key={group.groupId}
                    className={`bg-[var(--apex-surface-2)] rounded-xl border p-4 transition cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--apex-surface-3)] border-[var(--apex-cyan)] ring-2 ring-[var(--apex-accent-strong)] shadow-lg'
                        : 'border-[var(--apex-border)] hover:border-[var(--apex-grid-line-strong)]'
                    }`}
                    onClick={() => setSelectedGroupId(isSelected ? null : group.groupId)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="text-sm font-bold text-[var(--apex-text)]">
                          Track {refClip.trackIndex + 1} · Bars {Math.floor(refClip.startBar) + 1}–{Math.floor(refClip.startBar + refClip.lengthBars)}
                        </div>
                        <div className="text-xs text-[var(--apex-text-2)] mt-0.5">
                          {group.clips.length} take{group.clips.length !== 1 ? 's' : ''} · Active: Take {(group.activeIndex ?? 0) + 1}
                        </div>
                      </div>
                      <div className="text-xs text-[var(--apex-text-3)]">
                        {group.clips.length} <Layers className="w-4 h-4 inline" />
                      </div>
                    </div>

                    {isSelected && (
                      <div className="space-y-2 mt-4">
                        <div className="text-xs text-[var(--apex-text-2)] font-bold mb-2">SELECT ACTIVE TAKE:</div>
                        {group.clips.map(clip => {
                          const isActive = clip.takeIndex === group.activeIndex;
                          return (
                            <button
                              key={clip.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectTake(group.groupId, clip.takeIndex ?? 0);
                              }}
                              className={`w-full text-left px-3 py-2 rounded-lg border transition ${
                                isActive
                                  ? 'bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)] border-[var(--apex-cyan)] text-[var(--apex-text)]'
                                  : 'bg-[var(--apex-canvas)] border-[var(--apex-border)] text-[var(--apex-text-2)] hover:border-[var(--apex-grid-line-strong)] hover:bg-[var(--apex-surface-3)]'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  {isActive && <Check className="w-4 h-4 text-[var(--apex-cyan)]" />}
                                  <span className="text-sm font-bold">Take {(clip.takeIndex ?? 0) + 1}</span>
                                </div>
                                <div className="text-xs text-[var(--apex-text-2)]">
                                  {clip.audioName || 'Audio Take'}
                                </div>
                              </div>
                              <div className="text-xs text-[var(--apex-text-3)] mt-1 ml-6">
                                Duration: {clip.lengthBars.toFixed(1)} bars · Buffer: {clip.audioBufferId?.slice(0, 12) || 'N/A'}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <div className="text-[var(--apex-text-3)]">
            {takeGroups.length} take group{takeGroups.length !== 1 ? 's' : ''} · {takeGroups.reduce((sum, g) => sum + g.clips.length, 0)} total takes
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-cyan)] hover:bg-[var(--apex-cyan-strong)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
