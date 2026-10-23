/**
 * Phase 8C — resolving the REAL source audio of the selected playlist clip for
 * Audio-to-MIDI.
 *
 * The transcription itself is pure (`audioToMidi.ts`). This module owns the one
 * thing that is not: getting the actual PCM of a clip out of the running app.
 * It uses the same two-step resolution the Vocal Tuner's offline correction and
 * the Warp stretches use — engine memory first, the persisted asset store
 * second — and the same injectable dependency shape, so it is exercised in Node
 * against real rendered PCM and a fake asset store rather than a mocked graph.
 *
 * Nothing here mutates: no asset is written, no project state is touched, and a
 * failure leaves every caller's state exactly as it was.
 */
import type { PlaylistClip } from '../types/daw';
import {
  AudioToMidiError,
  analyseAudioClipForMidi,
  type AudioToMidiAnalysis,
  type AudioToMidiOptions,
  type AudioToMidiTimingContext,
} from './audioToMidi';

export interface AudioToMidiSourceDeps {
  /** In-memory lookup (`audioEngine.getSampleBuffer`). */
  getSourceBuffer: (id: string) => AudioBuffer | undefined;
  /** Persisted-asset fallback (`audioPersistence.hydrateAudioClip` → boolean). */
  hydrateSource: (id: string) => Promise<boolean>;
}

/** A clip is transcribable only when it is a real audio clip with a real asset. */
export const assertTranscribableClip = (clip: PlaylistClip | null | undefined): PlaylistClip => {
  if (!clip || clip.type !== 'audio') {
    throw new AudioToMidiError(
      'not-audio-clip',
      'Audio-to-MIDI reads audio clips only — select the recorded or imported audio clip you want to transcribe.'
    );
  }
  if (!clip.audioBufferId) {
    throw new AudioToMidiError(
      'no-source-audio',
      'This audio clip has no source audio asset, so there is nothing to analyse.'
    );
  }
  return clip;
};

/** The real PCM behind a clip: engine memory first, persisted store second. */
export const resolveAudioToMidiSource = async (
  clip: PlaylistClip,
  deps: AudioToMidiSourceDeps
): Promise<AudioBuffer> => {
  const assetId = assertTranscribableClip(clip).audioBufferId as string;
  let source = deps.getSourceBuffer(assetId);
  if (!source) {
    let hydrated = false;
    try {
      hydrated = await deps.hydrateSource(assetId);
    } catch {
      hydrated = false;
    }
    if (hydrated) source = deps.getSourceBuffer(assetId);
  }
  if (!source) {
    throw new AudioToMidiError(
      'source-unavailable',
      'The source audio for this clip is not available (it was not found in memory or in the project audio store), so nothing was analysed. Nothing in the project was changed.'
    );
  }
  return source;
};

export interface AudioToMidiClipAnalysis {
  analysis: AudioToMidiAnalysis;
  sourceBuffer: AudioBuffer;
}

/**
 * Analyse the selected clip without touching the project. The returned verdict
 * is what the user reviews: either the transcribed notes (with the real
 * measurements behind them) or a typed refusal explaining why nothing was
 * transcribed.
 */
export const analyseSelectedClipForMidi = async (
  clip: PlaylistClip,
  timing: AudioToMidiTimingContext,
  options: AudioToMidiOptions | null | undefined,
  deps: AudioToMidiSourceDeps
): Promise<AudioToMidiClipAnalysis> => {
  const sourceBuffer = await resolveAudioToMidiSource(clip, deps);
  const analysis = analyseAudioClipForMidi(clip, sourceBuffer, timing, options);
  return { analysis, sourceBuffer };
};
