/**
 * Phase 10H — Track Freeze / Unfreeze: the orchestration between the engine
 * render, durable audio storage and the project document.
 *
 * Ordering is the whole point of this file:
 *   1. render the channel from its source (nothing in the project changes),
 *   2. make the render durable,
 *   3. only then attach the freeze record, in one undoable project mutation.
 * A failure or a source edit at any point before step 3 leaves the project
 * exactly as it was; the channel keeps playing its instrument.
 */
import type { Channel, ChannelFreeze, Pattern, PlaylistClip, PlaylistTrack, ProjectState } from '../types/daw';
import {
  applyChannelFreeze,
  channelFreezeSourceFromProject,
  computeChannelFreezeFingerprint,
  createChannelFreezeBufferId,
  getChannelFreezeBlocker,
  removeChannelFreeze,
} from '../state/trackFreeze';

export interface ChannelFreezeEngine {
  renderChannelFreeze(
    channel: Channel,
    clips: PlaylistClip[],
    patterns: Pattern[] | undefined,
    playlistTracks: PlaylistTrack[] | undefined,
    bpm: number,
    onProgress?: (progress: number, status: string) => void,
  ): Promise<{ buffer: AudioBuffer; freeze: Omit<ChannelFreeze, 'audioBufferId'>; peak: number }>;
  setSampleBuffer(id: string, buffer: AudioBuffer): void;
  discardUnpublishedSampleBuffer(id: string, expected: AudioBuffer): void;
}

export interface ChannelFreezePorts {
  engine: ChannelFreezeEngine;
  getState(): ProjectState;
  /** Resolves when the asset is durable; rejects when it is not or the project was replaced. */
  waitForPersistence(audioBufferId: string): Promise<void>;
  /** One undoable project mutation. */
  mutate(updater: (state: ProjectState) => ProjectState, label: string): void;
  onProgress?: (progress: number, status: string) => void;
  createBufferId?: (channelId: string) => string;
}

export type ChannelFreezeResult =
  | { status: 'frozen'; freeze: ChannelFreeze; tailDecayed: boolean }
  | { status: 'rejected'; reason: string };

const SOURCE_CHANGED =
  'The channel or its clips changed while it was being frozen, so the render was discarded. Nothing was changed; freeze it again.';

const currentFingerprint = (state: ProjectState, channelId: string): string | null => {
  const channel = state.channels.find(candidate => candidate.id === channelId);
  return channel ? computeChannelFreezeFingerprint(channel, channelFreezeSourceFromProject(state)) : null;
};

export async function freezeChannel(ports: ChannelFreezePorts, channelId: string): Promise<ChannelFreezeResult> {
  const state = ports.getState();
  const channel = state.channels.find(candidate => candidate.id === channelId);
  if (!channel) return { status: 'rejected', reason: 'That channel no longer exists.' };
  const blocker = getChannelFreezeBlocker(channel, channelFreezeSourceFromProject(state));
  if (blocker) return { status: 'rejected', reason: blocker };

  let rendered: Awaited<ReturnType<ChannelFreezeEngine['renderChannelFreeze']>>;
  try {
    rendered = await ports.engine.renderChannelFreeze(
      channel, state.playlistClips, state.patterns, state.playlistTracks, state.meta.bpm, ports.onProgress,
    );
  } catch (error) {
    return { status: 'rejected', reason: error instanceof Error ? error.message : 'The freeze render failed.' };
  }

  // The render describes the source as the engine saw it. It is only usable if
  // the project still describes the same source.
  if (currentFingerprint(ports.getState(), channelId) !== rendered.freeze.sourceFingerprint) {
    return { status: 'rejected', reason: SOURCE_CHANGED };
  }

  const audioBufferId = (ports.createBufferId ?? createChannelFreezeBufferId)(channelId);
  ports.engine.setSampleBuffer(audioBufferId, rendered.buffer);
  try {
    await ports.waitForPersistence(audioBufferId);
  } catch (error) {
    ports.engine.discardUnpublishedSampleBuffer(audioBufferId, rendered.buffer);
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'rejected', reason: `The frozen audio could not be saved, so the channel was left unfrozen. (${detail})` };
  }

  if (currentFingerprint(ports.getState(), channelId) !== rendered.freeze.sourceFingerprint) {
    ports.engine.discardUnpublishedSampleBuffer(audioBufferId, rendered.buffer);
    return { status: 'rejected', reason: SOURCE_CHANGED };
  }

  const freeze: ChannelFreeze = { ...rendered.freeze, audioBufferId };
  ports.mutate(current => applyChannelFreeze(current, channelId, freeze), 'Freeze channel');
  return { status: 'frozen', freeze, tailDecayed: freeze.tailDecayed };
}

/** Removes the freeze record. The source was never altered, so there is nothing to restore. */
export function unfreezeChannel(ports: Pick<ChannelFreezePorts, 'getState' | 'mutate'>, channelId: string): boolean {
  const channel = ports.getState().channels.find(candidate => candidate.id === channelId);
  if (!channel?.freeze) return false;
  ports.mutate(current => removeChannelFreeze(current, channelId), 'Unfreeze channel');
  return true;
}
