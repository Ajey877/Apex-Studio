/**
 * Phase 10B — the *polyphonic mode* entry point for Audio-to-MIDI.
 *
 * `audioToMidi.ts` stays exactly what it was: the monophonic YIN pipeline with
 * its own refusals. This module is the second, explicitly selected mode. It
 * reuses everything that is not pitch analysis — the same clip-window resolution
 * (`describeClipTimeline`: source offset, `lengthBars`, rate, pitch shift), the
 * same control defaults, the same note-duration policy and the same project-step
 * quantisation — and swaps in the multi-pitch analyzer.
 *
 * Keeping the mode split here (rather than a branch inside the monophonic
 * pipeline) is deliberate: a monophonic analysis can never accidentally take a
 * polyphonic path, and the pinned monophonic option contract stays untouched.
 */
import type { PlaylistClip } from '../types/daw';
import {
  AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS,
  AUDIO_TO_MIDI_MIN_WINDOW_SECONDS,
  AudioToMidiError,
  describeClipTimeline,
  normalizeAudioToMidiOptions,
  type AnalysableBuffer,
  type AudioToMidiOptions,
  type AudioToMidiTimingContext,
  type ClipTimelinePlan,
} from './audioToMidi';
import {
  POLY_FFT_SIZE,
  transcribePolyphonicPcm,
  type PolyphonicAnalysis,
} from './polyphonicTranscription';

export interface PolyphonicClipAnalysis {
  analysis: PolyphonicAnalysis;
  /** The resolved clip window/transform plan the analysis actually used. */
  plan: ClipTimelinePlan;
  settings: { minNoteSteps: number; quantizeSteps: number };
}

/**
 * Analyses the audible window of a real clip with the polyphonic analyzer.
 *
 * The window is resolved exactly as the monophonic path resolves it, then the
 * analyser only ever sees those samples — so a trimmed, rate-changed or
 * pitch-shifted clip is transcribed as it actually sounds, and notes land on the
 * timeline where the audio plays. Nothing here mutates project state; refusals
 * come back as `analysis.status === 'rejected'` with `notes: []`.
 *
 * Throws `AudioToMidiError` only for clips that cannot be analysed at all
 * (missing source, window too short, window longer than the analysis budget) —
 * the same typed errors the monophonic path throws, so the UI handles both.
 */
export const analyseAudioClipForPolyphonicMidi = (
  clip: PlaylistClip,
  buffer: AnalysableBuffer,
  timing: AudioToMidiTimingContext,
  options?: AudioToMidiOptions | null,
): PolyphonicClipAnalysis => {
  const settings = normalizeAudioToMidiOptions(options);
  if (!buffer || typeof buffer.getChannelData !== 'function') {
    throw new AudioToMidiError(
      'source-unavailable',
      'The source audio for this clip is not available in memory or in the project audio store, so nothing was analysed.'
    );
  }
  const plan = describeClipTimeline(clip, timing, buffer.duration);
  const totalSamples = buffer.getChannelData(0).length;
  const offsetSamples = Math.round(plan.sourceOffsetSeconds * buffer.sampleRate);
  const windowSamples = Math.min(
    Math.max(0, totalSamples - offsetSamples),
    Math.round(plan.sourceWindowSeconds * buffer.sampleRate)
  );
  if (
    windowSamples < POLY_FFT_SIZE * 2 ||
    windowSamples / buffer.sampleRate < AUDIO_TO_MIDI_MIN_WINDOW_SECONDS
  ) {
    throw new AudioToMidiError(
      'source-too-short',
      `The audible part of this clip is ${(windowSamples / buffer.sampleRate).toFixed(3)} s — too short for a polyphonic analysis. Nothing was transcribed.`
    );
  }
  if (windowSamples / buffer.sampleRate > AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS) {
    throw new AudioToMidiError(
      'clip-too-long',
      `This clip's audible window is ${(windowSamples / buffer.sampleRate).toFixed(1)} s. Polyphonic Audio-to-MIDI analyses up to ${AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS} s per clip; trim or split the clip and analyse the section you need. Nothing was transcribed.`
    );
  }

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch).subarray(offsetSamples, offsetSamples + windowSamples));
  }

  const analysis = transcribePolyphonicPcm({
    channels,
    sampleRate: buffer.sampleRate,
    plan: {
      playbackRate: plan.playbackRate,
      pitchOffsetSemitones: plan.pitchOffsetSemitones,
      stepsPerSecond: plan.stepsPerSecond,
      timelineSeconds: plan.timelineSeconds,
    },
    options: {
      minNoteSteps: settings.minNoteSteps,
      quantizeSteps: settings.quantizeSteps,
    },
  });

  return {
    analysis,
    plan,
    settings: { minNoteSteps: settings.minNoteSteps, quantizeSteps: settings.quantizeSteps },
  };
};

export {
  POLY_MAX_VOICES,
  POLY_MIN_MIDI,
  POLY_MAX_MIDI,
  POLY_MAX_ANALYSIS_SECONDS,
} from './polyphonicTranscription';
export type { PolyphonicAnalysis, PolyphonicNote } from './polyphonicTranscription';
