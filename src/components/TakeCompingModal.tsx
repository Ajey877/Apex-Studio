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
    <ModalFrame id="fl-take-comping-modal" labelledBy="fl-take-comping-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00e5ff]/40 rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00e5ff] to-[#0077ff] flex items-center justify-center text-black shadow-md font-bold">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h2 id="fl-take-comping-modal-title" className="text-sm font-bold text-white tracking-wide">TAKE COMPING</h2>
              <p className="text-[10px] text-[#777]">Select the active take for each recording group</p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close take comping"
            className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {takeGroups.length === 0 ? (
            <div className="bg-[#0b0b0d] p-8 rounded-xl border border-[#33333e] text-center">
              <Layers className="w-12 h-12 mx-auto mb-3 text-[#555]" />
              <p className="text-sm text-[#888]">No take groups found</p>
              <p className="text-xs text-[#666] mt-2">Record multiple takes on the same track to create take groups</p>
            </div>
          ) : (
            <div className="space-y-4">
              {takeGroups.map(group => {
                const isSelected = selectedGroupId === group.groupId;
                const refClip = group.clips[0];
                
                return (
                  <div
                    key={group.groupId}
                    className={`bg-[#18181c] rounded-xl border p-4 transition cursor-pointer ${
                      isSelected ? 'border-[#00e5ff] bg-[#1a1a20]' : 'border-[#2e2e34] hover:border-[#444]'
                    }`}
                    onClick={() => setSelectedGroupId(isSelected ? null : group.groupId)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="text-sm font-bold text-white">
                          Track {refClip.trackIndex + 1} · Bars {Math.floor(refClip.startBar) + 1}–{Math.floor(refClip.startBar + refClip.lengthBars)}
                        </div>
                        <div className="text-xs text-[#888] mt-0.5">
                          {group.clips.length} take{group.clips.length !== 1 ? 's' : ''} · Active: Take {(group.activeIndex ?? 0) + 1}
                        </div>
                      </div>
                      <div className="text-xs text-[#666]">
                        {group.clips.length} <Layers className="w-4 h-4 inline" />
                      </div>
                    </div>

                    {isSelected && (
                      <div className="space-y-2 mt-4">
                        <div className="text-xs text-[#888] font-bold mb-2">SELECT ACTIVE TAKE:</div>
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
                                  ? 'bg-[#00e5ff]/20 border-[#00e5ff] text-white'
                                  : 'bg-[#0b0b0d] border-[#2e2e34] text-[#b0b0b0] hover:border-[#444] hover:bg-[#16161c]'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  {isActive && <Check className="w-4 h-4 text-[#00e5ff]" />}
                                  <span className="text-sm font-bold">Take {(clip.takeIndex ?? 0) + 1}</span>
                                </div>
                                <div className="text-xs text-[#888]">
                                  {clip.audioName || 'Audio Take'}
                                </div>
                              </div>
                              <div className="text-xs text-[#666] mt-1 ml-6">
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
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <div className="text-[#666]">
            {takeGroups.length} take group{takeGroups.length !== 1 ? 's' : ''} · {takeGroups.reduce((sum, g) => sum + g.clips.length, 0)} total takes
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#00e5ff] hover:bg-[#33edff] text-black font-bold rounded transition shadow"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
