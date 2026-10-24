import type { PlaylistClip, ProjectState } from '../types/daw';
import { beatsPerBar, resolveProjectTimeSignature } from '../music/musicalTime';
import { captureCurrentPlaylistAudioPublicationToken, isCurrentPlaylistAudioPublication, type PlaylistAudioPublicationToken } from '../state/playlistAudioPublication';
import { hydrateAudioClip, deletePersistedAudioClip } from './audioPersistence';
import { waitForSampleBufferPersistence } from './sampleBufferPersistence';
import { computeStretchWaveformPeaks } from './wsolaTimeStretch';
import { copyPcmRange, validatePcm, type BufferFactory } from './waveformEditing';

export interface WaveformEditorEngine {
  getSampleBuffer(id: string): AudioBuffer | undefined;
  loadAudioFile(file: File | Blob, id: string): Promise<unknown>;
  getContext(): AudioContext;
  setSampleBuffer(id: string, buffer: AudioBuffer): void;
  discardUnpublishedSampleBuffer(id: string, buffer: AudioBuffer): void;
}
export interface WaveformSession {
  clip: PlaylistClip;
  buffer: AudioBuffer;
  secondsPerBar: number;
  rate: number;
  bpm: number;
  meter: string;
  token: PlaylistAudioPublicationToken;
}
export function assertEditableClip(clip: PlaylistClip): void {
  if (!clip || clip.type !== 'audio' || !clip.audioBufferId) throw new Error('Select a real audio clip in the Playlist first.');
  if (clip.takeGroupId || clip.compRegions?.length) throw new Error('Flatten/bounce the take comp to a standalone audio clip before waveform editing.');
  if (clip.pitchShiftSemitones) throw new Error('Reset Repitch pitch to 0 in Warp, or bounce the pitched clip before sample-exact editing.');
  if (!Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0 || !Number.isFinite(clip.offsetSteps ?? 0) || (clip.offsetSteps ?? 0) < 0 ||
    !Number.isFinite(clip.timeStretchRate ?? 1) || (clip.timeStretchRate ?? 1) <= 0) throw new Error('Clip timing is invalid. Nothing was edited.');
}
export async function openWaveformSession(clip: PlaylistClip, bpm: number, timeSignature: unknown, engine: WaveformEditorEngine, signal?: AbortSignal): Promise<WaveformSession> {
  assertEditableClip(clip);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('Project tempo must be 20–300 BPM.');
  const token = captureCurrentPlaylistAudioPublicationToken();
  const captured = structuredClone(clip);
  const check = () => { if (signal?.aborted || !isCurrentPlaylistAudioPublication(token)) throw new Error('Editor cancelled or playlist/project changed. Reopen the selected clip.'); };
  let source = engine.getSampleBuffer(clip.audioBufferId!);
  if (!source) { await hydrateAudioClip(engine, clip.audioBufferId!); source = engine.getSampleBuffer(clip.audioBufferId!); }
  check();
  if (!source) throw new Error('Source audio is missing from memory and persisted assets. Relink/import the audio before editing.');
  validatePcm(source);
  const meter = resolveProjectTimeSignature({ timeSignature });
  const secondsPerBar = beatsPerBar(meter) * 60 / bpm;
  const rate = clip.timeStretchRate ?? 1;
  const start = Math.round((clip.offsetSteps ?? 0) * 60 / bpm / 4 * rate * source.sampleRate);
  const end = Math.min(source.length, start + Math.round(clip.lengthBars * secondsPerBar * rate * source.sampleRate));
  const buffer = copyPcmRange(source, { start, end }, (c, n, sr) => engine.getContext().createBuffer(c, n, sr));
  check();
  return { clip: captured, buffer, secondsPerBar, rate, bpm, meter: JSON.stringify(meter), token };
}
export function isWaveformSessionCurrent(session: WaveformSession, project: ProjectState): boolean {
  const current = project.playlistClips.find(clip => clip.id === session.clip.id);
  return isCurrentPlaylistAudioPublication(session.token) && JSON.stringify(current) === JSON.stringify(session.clip) &&
    project.meta.bpm === session.bpm && JSON.stringify(resolveProjectTimeSignature(project.meta)) === session.meter;
}
/** Pure selected-ID mutation, used by the App and integration tests. Never targets array[0]. */
export function publishWaveformClip(project: ProjectState, session: WaveformSession, clip: PlaylistClip): ProjectState {
  if (!isWaveformSessionCurrent(session, project) || clip.id !== session.clip.id) throw new Error('Stale editor: selected clip/project changed. No edit was published.');
  return { ...project, playlistClips: project.playlistClips.map(item => item.id === clip.id ? clip : item) };
}
export interface WaveformCommitOptions {
  signal?: AbortSignal;
  isCurrent(): boolean;
  /** Must publish synchronously through the existing project/history mutation. */
  publish(clip: PlaylistClip): void;
}
export async function commitWaveformSession(session: WaveformSession, working: AudioBuffer, engine: WaveformEditorEngine, options: WaveformCommitOptions): Promise<PlaylistClip> {
  const check = () => {
    if (options.signal?.aborted || !isCurrentPlaylistAudioPublication(session.token) || !options.isCurrent()) throw new Error('Editor cancelled or target/project changed. Nothing was committed.');
  };
  check(); validatePcm(working);
  if (working.sampleRate !== session.buffer.sampleRate || working.numberOfChannels !== session.buffer.numberOfChannels) throw new Error('Editor must preserve source sample rate and channel count.');
  const create: BufferFactory = (c, n, sr) => engine.getContext().createBuffer(c, n, sr);
  // Snapshot the draft before the durability await. Preview buffers never become project assets.
  const committed = copyPcmRange(working, { start: 0, end: working.length }, create);
  const id = `waveform-edit-${crypto.randomUUID()}`;
  const lengthBars = committed.length / committed.sampleRate / session.rate / session.secondsPerBar;
  const clip: PlaylistClip = { ...session.clip, audioBufferId: id, audioName: `${session.clip.name} (edited)`, audioUnavailable: false,
    audioWaveform: computeStretchWaveformPeaks(Array.from({ length: committed.numberOfChannels }, (_, c) => committed.getChannelData(c))), offsetSteps: 0, lengthBars,
    fadeInBars: Math.min(session.clip.fadeInBars ?? 0, lengthBars / 2), fadeOutBars: Math.min(session.clip.fadeOutBars ?? 0, lengthBars / 2) };
  try {
    engine.setSampleBuffer(id, committed);
    await waitForSampleBufferPersistence(engine, id);
    check();
    options.publish(clip);
    return clip;
  } catch (error) {
    engine.discardUnpublishedSampleBuffer(id, committed);
    // The fresh UUID has never been published. Do not remove any shared source asset.
    await deletePersistedAudioClip(id).catch(() => {});
    throw error;
  }
}

/** Audition owns its own nodes and generation; never changes mixer/channel/project state. */
export class WaveformAudition {
  private generation = 0;
  private source?: AudioBufferSourceNode;
  private gain?: GainNode;
  stop() {
    this.generation++;
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch { /* already ended */ } this.source.disconnect(); }
    this.gain?.disconnect(); this.source = undefined; this.gain = undefined;
  }
  async play(context: AudioContext, buffer: AudioBuffer, start: number, end: number, onEnded?: () => void) {
    this.stop();
    const generation = this.generation;
    const { validateSelection } = await import('./waveformEditing');
    validateSelection(buffer, { start, end });
    if (context.state === 'suspended') await context.resume();
    if (generation !== this.generation || context.state === 'closed') return;
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; gain.gain.value = 0.8;
    source.connect(gain); gain.connect(context.destination);
    this.source = source; this.gain = gain;
    source.onended = () => { if (this.source === source) { this.stop(); onEnded?.(); } };
    source.start(context.currentTime, start / buffer.sampleRate, (end - start) / buffer.sampleRate);
  }
}
