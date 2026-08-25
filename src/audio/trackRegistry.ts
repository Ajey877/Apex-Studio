import {
  type MixerChannelState,
  createMixerChannel,
  setChannelMute,
  setChannelPan,
  setChannelSolo,
  setChannelVolume,
} from './mixerChannel';

export interface TrackRegistrySnapshot {
  readonly tracks: readonly MixerChannelState[];
}

/** Deterministic, UI-agnostic collection for project tracks. */
export class TrackRegistry {
  private readonly tracksById = new Map<number, MixerChannelState>();
  private nextId = 0;

  get size(): number { return this.tracksById.size; }

  create(name?: string): MixerChannelState {
    const id = this.nextId++;
    const track = createMixerChannel(id, name);
    this.tracksById.set(id, track);
    return { ...track };
  }

  add(track: MixerChannelState): void {
    if (this.tracksById.has(track.id)) throw new Error(`Track ID ${track.id} already exists.`);
    this.validateTrack(track);
    this.tracksById.set(track.id, { ...track });
    this.nextId = Math.max(this.nextId, track.id + 1);
  }

  get(id: number): MixerChannelState | undefined {
    const track = this.tracksById.get(id);
    return track ? { ...track } : undefined;
  }

  list(): readonly MixerChannelState[] {
    return [...this.tracksById.values()].map(track => ({ ...track }));
  }

  snapshot(): TrackRegistrySnapshot { return { tracks: this.list() }; }

  remove(id: number): boolean { return this.tracksById.delete(id); }

  rename(id: number, name: string): MixerChannelState {
    const track = this.require(id);
    const normalized = name.trim();
    if (!normalized) throw new Error('Track name cannot be empty.');
    const updated = { ...track, name: normalized };
    this.tracksById.set(id, updated);
    return { ...updated };
  }

  setVolume(id: number, volumeDb: number): MixerChannelState {
    return this.update(id, track => setChannelVolume(track, volumeDb));
  }

  setPan(id: number, pan: number): MixerChannelState {
    return this.update(id, track => setChannelPan(track, pan));
  }

  setMute(id: number, muted: boolean): MixerChannelState {
    return this.update(id, track => setChannelMute(track, muted));
  }

  setSolo(id: number, soloed: boolean): MixerChannelState {
    return this.update(id, track => setChannelSolo(track, soloed));
  }

  clear(): void { this.tracksById.clear(); }

  private update(id: number, updater: (track: MixerChannelState) => MixerChannelState): MixerChannelState {
    const updated = updater(this.require(id));
    this.validateTrack(updated);
    this.tracksById.set(id, updated);
    return { ...updated };
  }

  private require(id: number): MixerChannelState {
    const track = this.tracksById.get(id);
    if (!track) throw new Error(`Track ID ${id} does not exist.`);
    return track;
  }

  private validateTrack(track: MixerChannelState): void {
    if (!Number.isInteger(track.id) || track.id < 0) throw new Error('Track ID must be a non-negative integer.');
    if (!track.name.trim()) throw new Error('Track name cannot be empty.');
    if (!Number.isFinite(track.volumeDb) || track.volumeDb < -60 || track.volumeDb > 12) throw new Error('Track volume must be between -60 dB and +12 dB.');
    if (!Number.isFinite(track.pan) || track.pan < -1 || track.pan > 1) throw new Error('Track pan must be between -1 and +1.');
  }
}
