import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import {
  Layers,
  X,
  Scissors,
  Check,
  AlertTriangle,
  GitMerge,
  Trash2,
  RotateCcw,
  Star,
} from 'lucide-react';
import type { PlaylistClip, TakeCompRegion } from '../types/daw';
import {
  getTakeGroupIds,
  getTakeGroupClips,
  resolveActiveTakeIndex,
  selectActiveTake
} from '../audio/takeLaneManager';
import {
  DEFAULT_COMP_CROSSFADE_BARS,
  MIN_COMP_REGION_BARS,
  createInitialCompRegions,
  normalizeCompRegions,
  removeCompRegion,
  resolveCanonicalCompRegions,
  resolveTakeCompPlan,
  resizeCompRegionEnd,
  moveCompRegionStart,
  setCompRegionCrossfade,
  setCompRegionTake,
  splitCompRegionAtBar,
} from '../audio/takeCompRegions';

interface TakeCompingModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlistClips: PlaylistClip[];
  onSelectActiveTake: (takeGroupId: string, takeIndex: number) => void;
  /**
   * Phase 10A: publishes a draft comp into project state *without* touching
   * history, so the shared playback engine auditions exactly what the editor
   * shows (`null` = whole take). Called on every edit and on discard.
   */
  onAuditionCompRegions?: (takeGroupId: string, regions: TakeCompRegion[] | null) => void;
  /** Phase 10A: commits a comp as one undoable project edit (`null` = whole take). */
  onCommitCompRegions?: (takeGroupId: string, regions: TakeCompRegion[] | null) => void;
}

interface CompDraft {
  /** The persisted comp when this draft started; discard restores exactly it. */
  base: TakeCompRegion[];
  regions: TakeCompRegion[];
}

const signatureOf = (regions: readonly TakeCompRegion[] | null | undefined): string =>
  (regions ?? [])
    .map(region => `${region.id}@${region.startBar}:${region.lengthBars}:${region.takeIndex}:${region.crossfadeBars}`)
    .join('|');

/**
 * Phase 10A: Take Comping UI — phrase regions on top of the Phase 1M
 * whole-take selector.
 *
 * The whole-take selector is unchanged and still first: a group with no comp
 * regions keeps its `activeTakeIndex` selection, and "Revert to whole take"
 * returns to it. Comping adds an explicit region model:
 *
 *   - each phrase is a real span of the group's timeline in bars, with its own
 *     take and its own trailing crossfade;
 *   - the timeline strip shows the phases, the gaps between them, the crossfade
 *     spans and which phrases cannot sound (missing take / missing asset);
 *   - boundaries are moved and trimmed with pointer drags *and* with numeric
 *     bar fields, so the editor is usable without a mouse;
 *   - every edit is audited through project state (not a private audio path),
 *     `Apply` commits one undoable edit, `Discard` restores the persisted comp.
 *
 * No waveform is invented: the take rows draw `audioWaveform`, which only exists
 * for audio that was really recorded or imported.
 */
export const TakeCompingModal: React.FC<TakeCompingModalProps> = ({
  isOpen,
  onClose,
  playlistClips,
  onSelectActiveTake,
  onAuditionCompRegions,
  onCommitCompRegions,
}) => {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CompDraft>>({});
  const [selectedRegionByGroup, setSelectedRegionByGroup] = useState<Record<string, string>>({});
  const [splitBarByGroup, setSplitBarByGroup] = useState<Record<string, string>>({});
  const publishedRef = useRef<Map<string, string>>(new Map());
  const stripRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const takeGroups = useMemo(() => {
    const groupIds = getTakeGroupIds(playlistClips);
    return groupIds.map(groupId => {
      const clips = getTakeGroupClips(playlistClips, groupId);
      const activeIndex = resolveActiveTakeIndex(clips, groupId);
      const persisted = resolveCanonicalCompRegions(clips).regions;
      const plan = resolveTakeCompPlan({ clips: playlistClips, takeGroupId: groupId });
      const lengthBars = Math.max(
        1 / 64,
        ...clips.map(clip => (Number.isFinite(clip.lengthBars) && clip.lengthBars > 0 ? clip.lengthBars : 0)),
      );
      return { groupId, clips, activeIndex, persisted, plan, lengthBars };
    });
  }, [playlistClips]);

  // External project changes (undo/redo, project load, a commit from elsewhere)
  // reset the draft. Changes this editor published itself do not, because the
  // draft is already the truth they describe.
  useEffect(() => {
    setDrafts(previous => {
      let changed = false;
      const next: Record<string, CompDraft> = { ...previous };
      for (const group of takeGroups) {
        const persistedSignature = signatureOf(group.persisted);
        const published = publishedRef.current.get(group.groupId);
        const draft = previous[group.groupId];
        if (!draft) {
          if (group.persisted.length === 0) continue;
          next[group.groupId] = { base: group.persisted, regions: group.persisted };
          changed = true;
          continue;
        }
        const baseSignature = signatureOf(draft.base);
        if (persistedSignature !== baseSignature && persistedSignature !== published) {
          next[group.groupId] = { base: group.persisted, regions: group.persisted };
          publishedRef.current.set(group.groupId, persistedSignature);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [takeGroups]);

  const publish = useCallback((groupId: string, regions: TakeCompRegion[]) => {
    publishedRef.current.set(groupId, signatureOf(regions));
    onAuditionCompRegions?.(groupId, regions.length > 0 ? regions : null);
  }, [onAuditionCompRegions]);

  const editDraft = useCallback((groupId: string, base: TakeCompRegion[], regions: TakeCompRegion[]) => {
    const normalized = normalizeCompRegions(regions).regions;
    setDrafts(previous => ({ ...previous, [groupId]: { base, regions: normalized } }));
    publish(groupId, normalized);
  }, [publish]);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const auditionRef = useRef(onAuditionCompRegions);
  auditionRef.current = onAuditionCompRegions;

  // Uncommitted comp edits never survive a close: when the modal shuts, every
  // dirty group is restored to its persisted comp through the same
  // project-state path audition uses. This runs on close, not on the close
  // *call*, so `onClose` stays exactly the parent's handler (and a project
  // swap that unmounts the modal cannot leave an auditioned comp behind).
  useEffect(() => {
    if (!isOpen) return undefined;
    return () => {
      for (const [groupId, draft] of Object.entries(draftsRef.current)) {
        if (signatureOf(draft.regions) !== signatureOf(draft.base)) {
          auditionRef.current?.(groupId, draft.base.length > 0 ? draft.base : null);
        }
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelectTake = (groupId: string, takeIndex: number) => {
    onSelectActiveTake(groupId, takeIndex);
  };

  const selectedGroup = takeGroups.find(g => g.groupId === selectedGroupId);

  const draftFor = (group: { groupId: string; persisted: TakeCompRegion[] }): CompDraft =>
    drafts[group.groupId] ?? { base: group.persisted, regions: group.persisted };

  const barFromPointer = (groupId: string, lengthBars: number, clientX: number): number => {
    const element = stripRefs.current.get(groupId);
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0)) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(lengthBars, Math.max(0, ratio * lengthBars));
  };

  const beginBoundaryDrag = (
    event: React.PointerEvent<HTMLElement>,
    groupId: string,
    lengthBars: number,
    dragStartRegions: TakeCompRegion[],
    persistedBase: TakeCompRegion[],
    regionId: string,
    edge: 'start' | 'end',
  ) => {
    event.stopPropagation();
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const bar = barFromPointer(groupId, lengthBars, moveEvent.clientX);
      // Every move is resolved against the geometry at drag start, so the
      // handle tracks the pointer exactly instead of accumulating rounding.
      const next = edge === 'start'
        ? moveCompRegionStart(dragStartRegions, regionId, bar)
        : resizeCompRegionEnd(dragStartRegions, regionId, bar);
      editDraft(groupId, persistedBase, next);
    };
    const onUp = () => {
      target.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
          on a single colour alone.

          Phase 10A adds the phrase editor: regions carry the take clip's own
          recorded colour (runtime data, never a hard-coded palette) and every
          chrome element keeps resolving through the same semantic tokens. */}
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-cyan)_40%,transparent)] rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-cyan)] to-[var(--apex-cyan-strong)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h2 id="fl-take-comping-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">TAKE COMPING</h2>
              <p className="text-[10px] text-[var(--apex-text-3)]">
                Select the active take for each recording group · or draw phrase regions to comp a performance
              </p>
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
                const draft = draftFor(group);
                const compActive = draft.regions.length > 0;
                const dirty = signatureOf(draft.regions) !== signatureOf(draft.base);
                const selectedRegionId = selectedRegionByGroup[group.groupId] ?? draft.regions[0]?.id ?? '';
                const selectedRegion = draft.regions.find(region => region.id === selectedRegionId) ?? null;
                const takeColor = (takeIndex: number): string => {
                  const clip = group.clips.find(candidate => (candidate.takeIndex ?? 0) === takeIndex);
                  return clip?.color || 'var(--apex-cyan)';
                };
                // The strip, the gaps and the issue list describe the *draft*, not
                // the last committed comp, so the editor always shows what it is
                // about to apply. (Auditioning already publishes the same regions to
                // project state, which is what the engine plays.)
                const plan = isSelected && draft.regions.length > 0
                  ? resolveTakeCompPlan({
                      clips: playlistClips.map(clip =>
                        clip.takeGroupId === group.groupId ? { ...clip, compRegions: draft.regions } : clip),
                      takeGroupId: group.groupId,
                    })
                  : group.plan;
                const issues = plan?.issues ?? [];
                const segments = plan?.segments ?? [];
                const audibleRegions = new Set(segments.flatMap(segment => segment.regionIds));

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

                    {draft.regions.length > 0 && (
                      <div className="flex items-center gap-2 text-[10px] text-[var(--apex-text-3)] mb-2">
                        <GitMerge className="w-3.5 h-3.5 text-[var(--apex-cyan)]" />
                        <span className="font-bold text-[var(--apex-text-2)]">
                          {draft.regions.length} comp phrase{draft.regions.length !== 1 ? 's' : ''}
                        </span>
                        <span>· {segments.length} audible span{segments.length !== 1 ? 's' : ''}</span>
                        {issues.length > 0 && (
                          <span className="text-[var(--apex-text-2)]">· {issues.length} issue{issues.length !== 1 ? 's' : ''}</span>
                        )}
                        {dirty && <span className="text-[var(--apex-text-2)]">· uncommitted</span>}
                      </div>
                    )}

                    {isSelected && (
                      <div className="space-y-2 mt-4">
                        <div className="text-xs text-[var(--apex-text-2)] font-bold mb-2">SELECT ACTIVE TAKE:</div>
                        {compActive && (
                          <p className="text-[10px] text-[var(--apex-text-3)] mb-2">
                            A comp is active for this group, so playback follows its phrase regions. The whole-take
                            selection below is what &quot;Revert to whole take&quot; returns to.
                          </p>
                        )}
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
                              {clip.audioUnavailable && (
                                <div className="flex items-center gap-1 text-[10px] text-[var(--apex-text-2)] mt-1 ml-6">
                                  <AlertTriangle className="w-3 h-3" />
                                  Audio asset unavailable — this take cannot sound
                                </div>
                              )}
                              {Array.isArray(clip.audioWaveform) && clip.audioWaveform.length > 0 && (
                                <div className="flex items-end gap-px h-6 mt-1.5 ml-6" aria-hidden="true">
                                  {clip.audioWaveform.map((peak, index) => (
                                    <div
                                      key={index}
                                      className="flex-1 bg-[var(--apex-cyan)] opacity-60 rounded-sm"
                                      style={{ height: `${Math.max(4, Math.min(100, Math.abs(peak) * 100))}%` }}
                                    />
                                  ))}
                                </div>
                              )}
                            </button>
                          );
                        })}

                        {/* Phase 10A — phrase regions */}
                        <div className="mt-4 pt-3 border-t border-[var(--apex-border)] space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="text-xs text-[var(--apex-text-2)] font-bold">PHRASE REGIONS:</div>
                            <div className="flex items-center gap-1.5">
                              {draft.regions.length === 0 ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const initial = createInitialCompRegions(group.clips, group.activeIndex ?? 0);
                                    editDraft(group.groupId, draft.base, initial);
                                    setSelectedRegionByGroup(previous => ({ ...previous, [group.groupId]: initial[0]?.id ?? '' }));
                                  }}
                                  className="px-2.5 py-1 text-[10px] font-bold rounded bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)] border border-[var(--apex-cyan)] text-[var(--apex-text)] hover:bg-[var(--apex-surface-3)] transition"
                                >
                                  Start comp
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    editDraft(group.groupId, draft.base, []);
                                  }}
                                  className="px-2.5 py-1 text-[10px] font-bold rounded bg-[var(--apex-canvas)] border border-[var(--apex-border)] text-[var(--apex-text-2)] hover:border-[var(--apex-grid-line-strong)] hover:bg-[var(--apex-surface-3)] transition"
                                >
                                  Revert to whole take
                                </button>
                              )}
                            </div>
                          </div>

                          {draft.regions.length > 0 && (
                            <>
                              <div
                                ref={element => { stripRefs.current.set(group.groupId, element); }}
                                className="relative h-12 rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-border)] overflow-hidden"
                                role="group"
                                aria-label={`Comp phrases for track ${refClip.trackIndex + 1}`}
                              >
                                {draft.regions.map(region => {
                                  const left = (region.startBar / group.lengthBars) * 100;
                                  const width = (region.lengthBars / group.lengthBars) * 100;
                                  const isRegionSelected = region.id === selectedRegionId;
                                  return (
                                    <button
                                      key={region.id}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedRegionByGroup(previous => ({ ...previous, [group.groupId]: region.id }));
                                      }}
                                      aria-label={`Phrase ${region.id}: take ${region.takeIndex + 1}, bars ${region.startBar.toFixed(2)} to ${(region.startBar + region.lengthBars).toFixed(2)}${audibleRegions.has(region.id) ? '' : ', silent'}`}
                                      aria-pressed={isRegionSelected}
                                      className={`absolute top-1 bottom-1 rounded border text-[9px] font-bold overflow-hidden flex items-center justify-center ${
                                        isRegionSelected
                                          ? 'border-[var(--apex-cyan)] text-[var(--apex-text)]'
                                          : 'border-[var(--apex-border)] text-[var(--apex-text-2)]'
                                      } ${audibleRegions.has(region.id) ? '' : 'border-dashed opacity-60'}`}
                                      style={{
                                        left: `${left}%`,
                                        width: `${Math.max(width, 0.5)}%`,
                                        backgroundColor: `color-mix(in srgb, ${takeColor(region.takeIndex)} 35%, var(--apex-canvas))`,
                                      }}
                                    >
                                      {audibleRegions.has(region.id) ? region.takeIndex + 1 : '—'}
                                    </button>
                                  );
                                })}
                                {segments.filter(segment => segment.fadeOutBars > 0).map(segment => {
                                  const start = (segment.endBar - segment.fadeOutBars) / group.lengthBars;
                                  const width = segment.fadeOutBars / group.lengthBars;
                                  return (
                                    <div
                                      key={`fade-${segment.regionIds[0]}`}
                                      aria-hidden="true"
                                      className="absolute top-1 bottom-1 bg-[var(--apex-cyan)] opacity-30 pointer-events-none"
                                      style={{ left: `${start * 100}%`, width: `${Math.max(width * 100, 0.4)}%` }}
                                    />
                                  );
                                })}
                                {(plan?.gaps ?? []).map((gap, index) => (
                                  <div
                                    key={`gap-${index}`}
                                    aria-hidden="true"
                                    className="absolute top-1 bottom-1 border border-dashed border-[var(--apex-border)] pointer-events-none"
                                    style={{
                                      left: `${(gap.startBar / group.lengthBars) * 100}%`,
                                      width: `${(gap.lengthBars / group.lengthBars) * 100}%`,
                                    }}
                                  />
                                ))}
                                {draft.regions.map(region => (
                                  <React.Fragment key={`edge-${region.id}`}>
                                    <div
                                      role="separator"
                                      aria-label={`Move start of phrase ${region.id}`}
                                      className="absolute top-0 bottom-0 w-1.5 cursor-ew-resize bg-[var(--apex-cyan)] opacity-70 z-10"
                                      style={{ left: `calc(${(region.startBar / group.lengthBars) * 100}% - 3px)` }}
                                      onPointerDown={event => beginBoundaryDrag(event, group.groupId, group.lengthBars, draft.regions, draft.base, region.id, 'start')}
                                    />
                                    <div
                                      role="separator"
                                      aria-label={`Trim end of phrase ${region.id}`}
                                      className="absolute top-0 bottom-0 w-1.5 cursor-ew-resize bg-[var(--apex-cyan)] opacity-70 z-10"
                                      style={{ left: `calc(${((region.startBar + region.lengthBars) / group.lengthBars) * 100}% - 3px)` }}
                                      onPointerDown={event => beginBoundaryDrag(event, group.groupId, group.lengthBars, draft.regions, draft.base, region.id, 'end')}
                                    />
                                  </React.Fragment>
                                ))}
                              </div>

                              <div className="flex items-center gap-2 text-[10px] text-[var(--apex-text-3)]">
                                <span>bars {group.lengthBars.toFixed(2)}</span>
                                <span>·</span>
                                <span>{plan?.gaps.length ? `${plan.gaps.length} silent gap(s)` : 'no silent gaps'}</span>
                                <span>·</span>
                                <span>drag a boundary or type exact bars</span>
                              </div>

                              {selectedRegion && (
                                <div className="rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-border)] p-2.5 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-[10px] font-bold text-[var(--apex-text-2)]">
                                      Phrase {draft.regions.indexOf(selectedRegion) + 1}
                                    </div>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        editDraft(group.groupId, draft.base, removeCompRegion(draft.regions, selectedRegion.id));
                                      }}
                                      aria-label={`Remove phrase ${selectedRegion.id}`}
                                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-[var(--apex-border)] text-[var(--apex-text-2)] hover:border-[var(--apex-grid-line-strong)] hover:bg-[var(--apex-surface-3)] transition"
                                    >
                                      <Trash2 className="w-3 h-3" /> Remove
                                    </button>
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-[10px] text-[var(--apex-text-3)]">Take:</span>
                                    {group.clips.map(clip => {
                                      const takeIndex = clip.takeIndex ?? 0;
                                      const isCurrent = selectedRegion.takeIndex === takeIndex;
                                      return (
                                        <button
                                          key={`region-take-${clip.id}`}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            editDraft(group.groupId, draft.base, setCompRegionTake(draft.regions, selectedRegion.id, takeIndex));
                                          }}
                                          aria-pressed={isCurrent}
                                          className={`px-2 py-0.5 text-[10px] font-bold rounded border transition ${
                                            isCurrent
                                              ? 'bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)] border-[var(--apex-cyan)] text-[var(--apex-text)]'
                                              : 'bg-[var(--apex-surface)] border-[var(--apex-border)] text-[var(--apex-text-2)] hover:border-[var(--apex-grid-line-strong)]'
                                          }`}
                                        >
                                          {takeIndex + 1}
                                        </button>
                                      );
                                    })}
                                  </div>

                                  <div className="grid grid-cols-3 gap-2">
                                    <label className="text-[10px] text-[var(--apex-text-3)]">
                                      Start (bar)
                                      <input
                                        type="number"
                                        step={0.0625}
                                        min={0}
                                        value={Number(selectedRegion.startBar.toFixed(4))}
                                        onClick={e => e.stopPropagation()}
                                        onChange={(e) => {
                                          const value = Number(e.target.value);
                                          if (!Number.isFinite(value)) return;
                                          editDraft(group.groupId, draft.base, moveCompRegionStart(draft.regions, selectedRegion.id, value));
                                        }}
                                        className="mt-0.5 w-full bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--apex-text)] focus:border-[var(--apex-cyan)] outline-none"
                                      />
                                    </label>
                                    <label className="text-[10px] text-[var(--apex-text-3)]">
                                      Length (bar)
                                      <input
                                        type="number"
                                        step={0.0625}
                                        min={MIN_COMP_REGION_BARS}
                                        value={Number(selectedRegion.lengthBars.toFixed(4))}
                                        onClick={e => e.stopPropagation()}
                                        onChange={(e) => {
                                          const value = Number(e.target.value);
                                          if (!Number.isFinite(value)) return;
                                          editDraft(
                                            group.groupId,
                                            draft.base,
                                            resizeCompRegionEnd(draft.regions, selectedRegion.id, selectedRegion.startBar + value),
                                          );
                                        }}
                                        className="mt-0.5 w-full bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--apex-text)] focus:border-[var(--apex-cyan)] outline-none"
                                      />
                                    </label>
                                    <label className="text-[10px] text-[var(--apex-text-3)]">
                                      Crossfade (bar)
                                      <input
                                        type="number"
                                        step={0.0625}
                                        min={0}
                                        value={Number(selectedRegion.crossfadeBars.toFixed(4))}
                                        onClick={e => e.stopPropagation()}
                                        onChange={(e) => {
                                          const value = Number(e.target.value);
                                          if (!Number.isFinite(value)) return;
                                          editDraft(group.groupId, draft.base, setCompRegionCrossfade(draft.regions, selectedRegion.id, value));
                                        }}
                                        className="mt-0.5 w-full bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--apex-text)] focus:border-[var(--apex-cyan)] outline-none"
                                      />
                                    </label>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <label className="text-[10px] text-[var(--apex-text-3)] flex-1">
                                      Split at bar
                                      <input
                                        type="number"
                                        step={0.0625}
                                        min={0}
                                        max={group.lengthBars}
                                        value={splitBarByGroup[group.groupId] ?? (selectedRegion.startBar + selectedRegion.lengthBars / 2).toFixed(3)}
                                        onClick={e => e.stopPropagation()}
                                        onChange={e => setSplitBarByGroup(previous => ({ ...previous, [group.groupId]: e.target.value }))}
                                        className="mt-0.5 w-full bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--apex-text)] focus:border-[var(--apex-cyan)] outline-none"
                                      />
                                    </label>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const raw = splitBarByGroup[group.groupId] ?? String(selectedRegion.startBar + selectedRegion.lengthBars / 2);
                                        const bar = Number(raw);
                                        if (!Number.isFinite(bar)) return;
                                        const next = splitCompRegionAtBar(draft.regions, bar, { crossfadeBars: DEFAULT_COMP_CROSSFADE_BARS });
                                        editDraft(group.groupId, draft.base, next);
                                      }}
                                      className="mt-3 flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)] border border-[var(--apex-cyan)] text-[var(--apex-text)] hover:bg-[var(--apex-surface-3)] transition"
                                    >
                                      <Scissors className="w-3 h-3" /> Split
                                    </button>
                                  </div>
                                </div>
                              )}

                              {issues.length > 0 && (
                                <ul className="space-y-1">
                                  {issues.map((issue, index) => (
                                    <li key={`${issue.code}-${index}`} className="flex items-start gap-1.5 text-[10px] text-[var(--apex-text-2)]">
                                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                      <span>{issue.message}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}

                              <div className="flex items-center justify-between pt-1">
                                <div className="text-[10px] text-[var(--apex-text-3)]">
                                  {dirty ? 'Uncommitted comp — playback is auditioning it' : 'Comp matches the saved project'}
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      publishedRef.current.set(group.groupId, signatureOf(draft.base));
                                      onAuditionCompRegions?.(group.groupId, draft.base.length > 0 ? draft.base : null);
                                      setDrafts(previous => ({ ...previous, [group.groupId]: { base: draft.base, regions: draft.base } }));
                                    }}
                                    disabled={!dirty}
                                    className="px-2.5 py-1 text-[10px] font-bold rounded bg-[var(--apex-canvas)] border border-[var(--apex-border)] text-[var(--apex-text-2)] hover:border-[var(--apex-grid-line-strong)] hover:bg-[var(--apex-surface-3)] transition disabled:opacity-40"
                                  >
                                    <RotateCcw className="w-3 h-3 inline mr-1" />Discard
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const regions = draft.regions;
                                      publishedRef.current.set(group.groupId, signatureOf(regions));
                                      onCommitCompRegions?.(group.groupId, regions.length > 0 ? regions : null);
                                      setDrafts(previous => ({ ...previous, [group.groupId]: { base: regions, regions } }));
                                    }}
                                    disabled={!dirty}
                                    className="px-2.5 py-1 text-[10px] font-bold rounded bg-[var(--apex-cyan)] hover:bg-[var(--apex-cyan-strong)] text-[var(--apex-state-playing-fg)] transition disabled:opacity-40"
                                  >
                                    <Star className="w-3 h-3 inline mr-1" />Apply comp
                                  </button>
                                </div>
                              </div>

                              {compActive && (
                                <p className="text-[10px] text-[var(--apex-text-3)]">
                                  Playback, WAV export and stems all read this comp from project state — the same regions the
                                  engine schedules.
                                </p>
                              )}
                            </>
                          )}
                        </div>
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
            {Object.values(drafts).some(draft => signatureOf(draft.regions) !== signatureOf(draft.base)) && (
              <span className="ml-2 text-[var(--apex-text-2)]">· uncommitted comp changes are discarded on close</span>
            )}
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
