import React, { useEffect, useRef, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Layers, 
  X, 
  Plus, 
  Trash2, 
  Sparkles, 
  Volume2, 
  Sliders, 
  Music, 
  Play, 
  Scissors,
  FolderOpen
} from 'lucide-react';
import { Channel, SampleZone } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { isImplicitDefaultSingleZone } from '../audio/sampleZones';

interface MultiZoneSamplerModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  selectedChannelId?: string;
  sampleLibrary: NonNullable<Channel['customSample']>[];
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

interface KeyZone extends SampleZone {
  name: string;
  color: string;
}

/**
 * UI-03M — zone identity palette.
 *
 * `KeyZone.color` never reaches the project document: `commitZones` strips
 * `name` and `color` before publishing `SampleZone` records, and `SampleZone`
 * has no colour field. These four hues are therefore decorative chrome, not
 * stored user data, so they resolve through the semantic tokens instead of the
 * legacy neon literals. Each entry replaces the hue it stood for
 * (`#ff6e00` -> gold, `#00ff88` -> success, `#00e5ff` -> cyan, `#a855f7` -> aux)
 * and every one clears WCAG 1.4.11 3:1 as a zone border on all four surfaces it
 * is painted on, in both palettes.
 */
const ZONE_IDENTITY_COLORS = [
  'var(--apex-gold)',
  'var(--apex-success)',
  'var(--apex-cyan-text)',
  'var(--apex-aux-text)',
] as const;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  return `${name}${octave}`;
}

/**
 * The editable view of a channel that carries a `customSample` but no authored
 * key map. This zone is *not* project data: it is the full-range projection of
 * the channel's sample, and playback resolves that sample from `customSample`
 * directly (`isImplicitDefaultSingleZone` / `updateChannelInProjectState`).
 */
const buildSeedZone = (channel: Channel): KeyZone | null => {
  const sample = channel.customSample;
  if (!sample?.id) return null;
  return {
    id: 'zone-' + channel.id,
    name: sample.name || 'Sample Zone',
    lowNote: 0,
    highNote: 127,
    rootNote: sample.rootPitch ?? 60,
    lowVelocity: 0,
    highVelocity: 127,
    sampleId: sample.id,
    tuneSemitones: 0,
    trimStart: sample.trimStart,
    trimEnd: sample.trimEnd,
    reverse: sample.reverse,
    loop: channel.synthParams.sampleLoop,
    color: ZONE_IDENTITY_COLORS[0],
  };
};

/**
 * True when the zone is still the untouched seed above.
 *
 * Persisting that seed as `userAuthored` would turn a view of `customSample`
 * into an explicit full-range mapping: it shadows every zone added after it
 * (`findSampleZone` is first-match) and it survives later sample assignment
 * (the mutation boundary only clears a *single* implicit zone), so the
 * channel would keep playing the old sample no matter what the user selects.
 * Zone names/colours are deliberately ignored: they are UI decoration and are
 * stripped before publication.
 */
const isUntouchedImplicitSeedZone = (zone: KeyZone, channel: Channel | undefined): boolean => {
  const sample = channel?.customSample;
  if (!channel || !sample?.id) return false;
  if (zone.userAuthored) return false;
  if (zone.id !== `zone-${channel.id}` || zone.sampleId !== sample.id) return false;
  return (
    zone.lowNote === 0 &&
    zone.highNote === 127 &&
    (zone.lowVelocity ?? 0) === 0 &&
    (zone.highVelocity ?? 127) === 127 &&
    (zone.tuneSemitones ?? 0) === 0 &&
    zone.rootNote === (sample.rootPitch ?? 60) &&
    (zone.trimStart ?? 0) === (sample.trimStart ?? 0) &&
    (zone.trimEnd ?? 1) === (sample.trimEnd ?? 1) &&
    Boolean(zone.reverse) === Boolean(sample.reverse) &&
    Boolean(zone.loop) === Boolean(channel.synthParams?.sampleLoop)
  );
};

export const MultiZoneSamplerModal: React.FC<MultiZoneSamplerModalProps> = ({
  isOpen,
  onClose,
  channels,
  selectedChannelId: propSelectedChannelId,
  sampleLibrary,
  onUpdateChannel
}) => {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(propSelectedChannelId || channels[0]?.id || '');
  const [zones, setZones] = useState<KeyZone[]>([]);

  useEffect(() => {
    if (propSelectedChannelId && channels.some(channel => channel.id === propSelectedChannelId)) {
      setSelectedChannelId(propSelectedChannelId);
    } else if (!channels.some(channel => channel.id === selectedChannelId) && channels[0]?.id) {
      setSelectedChannelId(channels[0].id);
    }
  }, [propSelectedChannelId, channels]);

  const selectedChannel = channels.find(channel => channel.id === selectedChannelId) || channels[0];

  const stripZoneDecoration = (zone: KeyZone): SampleZone => ((({ name, color, ...z }) => z)(zone));

  const commitZones = (rawUpdated: KeyZone[]) => {
    if (!selectedChannel) return;
    // Only zones the user actually authored are project data. The untouched
    // seed stays a local view of `customSample`, so adding a split (or any
    // other zone edit) cannot pin the current sample into the key map.
    const updated = rawUpdated.map(zone =>
      isUntouchedImplicitSeedZone(zone, selectedChannel) ? zone : { ...zone, userAuthored: true }
    );
    setZones(updated);
    const persisted = updated.filter(zone => !isUntouchedImplicitSeedZone(zone, selectedChannel));
    const hadPersistedZones = (selectedChannel.sampleZones?.length ?? 0) > 0;
    // Nothing to publish when the channel has no authored zones and never had
    // any: writing `sampleZones: []` would be a no-op history-wise, but keeping
    // the mutation boundary quiet matches the "no automatic edits" contract.
    if ((persisted.length === 0 && !hadPersistedZones) || !persisted.every(zone => Boolean(stripZoneDecoration(zone).id))) {
      return;
    }
    onUpdateChannel(selectedChannel.id, { sampleZones: persisted.map(({ name, color, ...zone }) => zone) });
  };

  useEffect(() => {
    if (!selectedChannel) return;
    const persisted = selectedChannel.sampleZones || [];
    const hasAuthoritativePersistedZones =
      persisted.length > 0 &&
      !(selectedChannel.customSample?.id && isImplicitDefaultSingleZone(selectedChannel, persisted[0], sampleLibrary));
    if (hasAuthoritativePersistedZones) {
      const hydrated = persisted.map((zone, index) => ({ ...zone, name: 'Zone ' + (index + 1), color: ZONE_IDENTITY_COLORS[index % ZONE_IDENTITY_COLORS.length] }));
      setZones(hydrated);
      setSelectedZoneId(persisted[0].id);
    } else if (selectedChannel.customSample?.id) {
      const zone = buildSeedZone(selectedChannel)!;
      setZones([zone]);
      setSelectedZoneId(zone.id);
    } else {
      setZones([]);
    }
  }, [
    selectedChannelId,
    selectedChannel?.id,
    selectedChannel?.customSample?.id,
    selectedChannel?.customSample?.rootPitch,
    selectedChannel?.customSample?.trimStart,
    selectedChannel?.customSample?.trimEnd,
    selectedChannel?.customSample?.reverse,
    selectedChannel?.synthParams?.sampleLoop,
    selectedChannel?.sampleZones,
  ]);

  const [selectedZoneId, setSelectedZoneId] = useState<string>('zone-2');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!isOpen) return null;

  const selectedZone = zones.find(z => z.id === selectedZoneId) || zones[0];

  const handleAddZone = () => {
    const newZone: KeyZone = {
      id: `zone-${Date.now()}`,
      name: `Multi-Zone ${zones.length + 1}`,
      lowNote: 60,
      highNote: 72,
      rootNote: 60,
      lowVelocity: 0,
      highVelocity: 127,
      sampleId: selectedChannel?.customSample?.id || sampleLibrary[0]?.id || '',
      tuneSemitones: 0,
      color: ZONE_IDENTITY_COLORS[3]
    };
    commitZones([...zones, newZone]);
    setSelectedZoneId(newZone.id);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatusMessage(`Created new Multi-Sample Zone!`);
    statusTimerRef.current = setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleDeleteZone = (id: string) => {
    const remaining = zones.filter(z => z.id !== id);
    // The untouched seed is a view of `customSample`, so it cannot be removed.
    // An authored zone can be: deleting the last one returns the channel to its
    // body sample. A channel with no `customSample` keeps the Phase 1M rule
    // that the last zone is not deletable — there would be nothing left to play.
    const canFallBackToCustomSample = Boolean(selectedChannel?.customSample?.id);
    if (
      remaining.length === 0 &&
      (!canFallBackToCustomSample ||
        zones.every(zone => Boolean(selectedChannel && isUntouchedImplicitSeedZone(zone, selectedChannel))))
    ) {
      return;
    }
    commitZones(remaining);
    if (selectedZoneId === id) {
      setSelectedZoneId(remaining[0]?.id || '');
    }
  };

  const handleAuditionZone = (zone: KeyZone) => {
    const targetChannel = channels.find(c => c.id === selectedChannelId) || channels[0];
    if (targetChannel) {
      audioEngine.playNote(targetChannel, { id: `zone-aud-${Date.now()}`, pitch: zone.rootNote, start: 0, duration: 2, velocity: 0.9 });
    }
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatusMessage(`Auditioning ${zone.name} (Root ${midiToNoteName(zone.rootNote)})`);
    statusTimerRef.current = setTimeout(() => setStatusMessage(null), 2000);
  };

  return (
    <ModalFrame id="fl-multizone-sampler-modal" labelledBy="fl-multizone-sampler-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/* UI-03M: chrome moves onto the existing `--apex-*` semantic tokens. The
          sampler's warm orange identity is kept through `--apex-gold` (the same
          mapping UI-03J/UI-03K chose for Gross Beat and the Arpeggiator) and the
          root-pitch green stays on `--apex-success`. Zone identity colours are
          local decoration, not project data, so they follow the theme too. The
          dead `bg-black/85` scrim is gone — ModalFrame supplies the shared
          themed `--apex-modal-overlay`. */}
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-gold)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-multizone-sampler-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">APEX MULTI-SAMPLE KEYMAPPER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)]">
                  MULTI-ZONE
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Map distinct audio samples across MIDI key ranges C0 - B8 with velocity splits</p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close multi-zone sampler"
            className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} aria-label="Dismiss status message" className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Visual 128-Key Multi-Zone Mapping Canvas */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-[var(--apex-gold)]" />
                <span>KEYBOARD SPLIT ZONE MAP (MIDI C1 - C7)</span>
              </span>
              <button
                onClick={handleAddZone}
                className="px-2 py-0.5 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-[10px] rounded transition flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                <span>Add Zone Split</span>
              </button>
            </div>

            {/* Piano Roll Map Visualizer */}
            <div className="relative h-20 bg-[var(--apex-chrome-inset)] rounded-lg border border-[var(--apex-border)] overflow-hidden flex items-end">
              {/* Grid lanes */}
              {Array.from({ length: 8 }).map((_, oct) => (
                <div 
                  key={oct} 
                  style={{ left: `${(oct / 8) * 100}%` }}
                  className="absolute top-0 bottom-0 border-l border-[color-mix(in_srgb,var(--apex-text)_12%,transparent)] text-[8px] font-mono text-[var(--apex-text-3)] pl-1"
                >
                  C{oct}
                </div>
              ))}

              {/* Zone Blocks */}
              {zones.map((zone) => {
                const leftPct = (zone.lowNote / 127) * 100;
                const widthPct = ((zone.highNote - zone.lowNote + 1) / 127) * 100;
                const isSel = zone.id === selectedZoneId;

                return (
                  <div
                    key={zone.id}
                    onClick={() => setSelectedZoneId(zone.id)}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      backgroundColor: `color-mix(in srgb, ${zone.color} 22%, transparent)`,
                      borderColor: zone.color
                    }}
                    className={`absolute top-2 bottom-6 border-2 rounded p-1 flex flex-col justify-between cursor-pointer transition ${
                      isSel ? 'ring-2 ring-[var(--apex-accent-strong)] shadow-lg brightness-125' : 'opacity-80 hover:opacity-100'
                    }`}
                  >
                    {/* The zone hue stays on the border and the wash. Labels use
                        the theme text scale: a same-hue label on its own wash
                        measures 3.36:1 in Light (gold) and cannot clear AA. */}
                    <div className="flex items-center justify-between text-[9px] font-bold text-[var(--apex-text)] truncate">
                      <span className="truncate">{zone.name}</span>
                      <span className="font-mono text-[8px] text-[var(--apex-text)]">
                        {midiToNoteName(zone.rootNote)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[8px] font-mono text-[var(--apex-text-2)]">
                      <span>{midiToNoteName(zone.lowNote)}</span>
                      <span>{midiToNoteName(zone.highNote)}</span>
                    </div>
                  </div>
                );
              })}

              {/* Piano keys base row */}
              <div className="w-full h-4 bg-[var(--apex-piano-key-accidental)] flex border-t border-[var(--apex-border)]">
                {Array.from({ length: 48 }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 border-r border-[var(--apex-border)] ${[1,3,6,8,10].includes(i % 12) ? 'bg-[var(--apex-piano-key-accidental)]' : 'bg-[var(--apex-piano-key-natural)]'}`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Selected Zone Inspector */}
          {selectedZone && (
            <div className="bg-[var(--apex-panel-header)] p-4 rounded-xl border border-[var(--apex-border)] space-y-4">
              <div className="flex items-center justify-between border-b border-[var(--apex-border)] pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedZone.color }} />
                  <span className="text-xs font-bold text-[var(--apex-text)] uppercase">
                    EDITING ZONE: {selectedZone.name}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAuditionZone(selectedZone)}
                    className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Play className="w-3 h-3 text-[var(--apex-success)]" />
                    <span>Audition</span>
                  </button>

                  <button
                    onClick={() => handleDeleteZone(selectedZone.id)}
                    aria-label={`Delete zone ${selectedZone.name}`}
                    className="p-1 text-[var(--apex-text-3)] hover:text-[var(--apex-danger)] rounded hover:bg-[var(--apex-state-hover)] transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                {/* Low Note */}
                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-3)] mb-1">
                    <span>Lowest Key Range</span>
                    <span className="font-mono text-[var(--apex-text)] font-bold">{midiToNoteName(selectedZone.lowNote)} ({selectedZone.lowNote})</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={selectedZone.highNote}
                    value={selectedZone.lowNote}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, lowNote: Number(e.target.value) } : z);
                      commitZones(updated);
                    }}
                    className="w-full accent-[var(--apex-gold)]"
                  />
                </div>

                {/* High Note */}
                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-3)] mb-1">
                    <span>Highest Key Range</span>
                    <span className="font-mono text-[var(--apex-text)] font-bold">{midiToNoteName(selectedZone.highNote)} ({selectedZone.highNote})</span>
                  </div>
                  <input
                    type="range"
                    min={selectedZone.lowNote}
                    max="127"
                    value={selectedZone.highNote}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, highNote: Number(e.target.value) } : z);
                      commitZones(updated);
                    }}
                    className="w-full accent-[var(--apex-gold)]"
                  />
                </div>

                {/* Root Note Tuning */}
                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-3)] mb-1">
                    <span>Root Key Pitch Center</span>
                    <span className="font-mono text-[var(--apex-success)] font-bold">{midiToNoteName(selectedZone.rootNote)}</span>
                  </div>
                  <input
                    type="range"
                    min={selectedZone.lowNote}
                    max={selectedZone.highNote}
                    value={selectedZone.rootNote}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, rootNote: Number(e.target.value) } : z);
                      commitZones(updated);
                    }}
                    className="w-full accent-[var(--apex-success)]"
                  />
                </div>
              </div>

              {/* Sample Source Selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs border-t border-[var(--apex-border)] pt-3">
                <div>
                  <label className="text-[10px] text-[var(--apex-text-3)] font-bold block mb-1">ASSIGNED SAMPLE AUDIO BUFFER</label>
                  <select
                    value={selectedZone.sampleId}
                    onChange={(e) => {
                      const pickedSample = sampleLibrary.find(s => s.id === e.target.value);
                      const updated = zones.map(z =>
                        z.id === selectedZone.id
                          ? {
                              ...z,
                              sampleId: e.target.value,
                              ...(pickedSample
                                ? {
                                    trimStart: pickedSample.trimStart,
                                    trimEnd: pickedSample.trimEnd,
                                    reverse: pickedSample.reverse,
                                  }
                                : {}),
                            }
                          : z
                      );
                      commitZones(updated);
                    }}
                    className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] p-2 rounded border border-[var(--apex-border)]"
                  >
                    {sampleLibrary.map(sample => (
                      <option key={sample.id} value={sample.id}>
                        {sample.name || sample.id}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] text-[var(--apex-text-3)] font-bold block mb-1">ZONE NAME</label>
                  <input
                    type="text"
                    value={selectedZone.name}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, name: e.target.value } : z);
                      commitZones(updated);
                    }}
                    className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] p-1.5 rounded border border-[var(--apex-border)]"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Zone selection, tuning, trims and loop points are applied to playback</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow"
          >
            Apply Keymapping
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
