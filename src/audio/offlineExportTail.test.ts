/**
 * Phase 6C (issue #56) — Song-master export tail handling.
 *
 * Defect proven and fixed here: `renderTimelineOffline` sized its render
 * window to exactly the song end (`max(minimumDuration, totalBars × bar)`),
 * so the release/reverb/delay remainder of the FINAL musical events was
 * hard-truncated at the song boundary. Reproduced on pre-fix main (033dc29)
 * with this exact fixture: a pad note whose note-off lands at the song end
 * with a 2 s release was cut mid-envelope — the exported WAV's final samples
 * sat at |0.495| (sustain level), an audible click/abrupt ending, while the
 * same render with a manually widened window proved the tail rings to
 * 10.049 s and decays to silence.
 *
 * The fix renders a bounded tail region (OFFLINE_RENDER_TAIL_SECONDS) past
 * the song end for Song-master exports whose caller did not pin an explicit
 * duration floor, then trims the returned buffer back to where the audio
 * actually decayed below OFFLINE_TAIL_SILENCE_THRESHOLD — never shorter than
 * the song window, never longer than song + cap.
 *
 * Fidelity notes (same harness as liveExportParity.insertFx.test.ts):
 * real DSP via the web-audio-engine polyfill, production
 * `renderTimelineOffline` call path, mastering disabled (polyfill fidelity
 * limit; the preroll+tail combination is exercised by the browser specs in
 * real Chromium). ConvolverNode is a pass-through in the polyfill, so the
 * tail fixture uses the synth release envelope, which the subtractive
 * renderer fully pre-schedules (ramp to 1e-4 + osc stop) — deterministic
 * acoustic evidence without convolution.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAMPLE_RATE = 44100;
const BPM = 120;
const BARS = 4;
const SONG_SECONDS = 8; // 4 bars × 2 s at 120 BPM
const SONG_FRAMES = Math.ceil(SAMPLE_RATE * SONG_SECONDS);
const TAIL_CAP_SECONDS = 4; // mirrors OFFLINE_RENDER_TAIL_SECONDS
const SILENCE = 1e-4; // mirrors OFFLINE_TAIL_SILENCE_THRESHOLD

const track = (id: number, name: string): MixerTrack => ({
  id, name, color: '#10b981', volume: 1, pan: 0, mute: false, solo: false,
  fxSlots: [], peakL: 0, peakR: 0,
}) as MixerTrack;

/** Pad channel whose note-off lands exactly at the song end with a 2 s release. */
const makePadChannel = (): Channel => ({
  id: 'ch-pad',
  name: 'Pad',
  color: '#10b981',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 0.9,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: Array(16).fill(false),
  // Clip below spans only the last bar; step 14 + 2-step gate ⇒ note-off at 8.0 s.
  notes: [{ id: 'n-pad', pitch: 60, start: 14, duration: 2, velocity: 0.9 }],
  synthParams: { ...engine.getDefaultSynthParams(), attack: 0.01, decay: 0.1, sustain: 0.8, release: 2.0 },
}) as unknown as Channel;

const makeLastBarClip = (): PlaylistClip => ({
  id: 'c-pad',
  trackIndex: 0,
  startBar: 3,
  lengthBars: 1,
  type: 'pattern',
  channelId: 'ch-pad',
  color: '#10b981',
  name: 'Pad Bar',
}) as unknown as PlaylistClip;

/** Note in the FIRST bar only: everything decays long before the song end. */
const makeFirstBarChannel = (): Channel => ({
  ...makePadChannel(),
  id: 'ch-early',
  notes: [{ id: 'n-early', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
}) as unknown as Channel;

const makeFirstBarClip = (): PlaylistClip => ({
  ...makeLastBarClip(),
  id: 'c-early',
  channelId: 'ch-early',
  startBar: 0,
}) as unknown as PlaylistClip;

const rms = (d: Float32Array, fromSec: number, toSec: number): number => {
  const a = Math.floor(fromSec * SAMPLE_RATE);
  const b = Math.min(d.length, Math.floor(toSec * SAMPLE_RATE));
  let sum = 0;
  for (let i = a; i < b; i += 1) sum += d[i] * d[i];
  return Math.sqrt(sum / Math.max(1, b - a));
};

const maxAbsRange = (d: Float32Array, fromFrame: number, toFrame: number): number => {
  let m = 0;
  for (let i = Math.max(0, fromFrame); i < Math.min(d.length, toFrame); i += 1) m = Math.max(m, Math.abs(d[i]));
  return m;
};

const maxAbsDiff = (a: Float32Array, b: Float32Array, frames: number): number => {
  let worst = 0;
  for (let i = 0; i < frames; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
};

const renderSong = async (
  channel: Channel,
  clip: PlaylistClip,
  options: { scope?: 'song' | 'pattern'; stage?: 'master' | 'pre-master'; minimumDurationSeconds?: number } = {},
): Promise<AudioBuffer> => engine.renderTimelineOffline(
  [channel],
  [clip],
  [track(0, 'Master'), track(1, 'Ch1')],
  BPM,
  BARS,
  SAMPLE_RATE,
  false,
  options.scope ?? 'song',
  undefined,
  undefined,
  undefined,
  options.minimumDurationSeconds,
  undefined,
  options.stage ?? 'master',
);

describe('PHASE 6C: Song-master export renders the natural decay tail instead of truncating at the song boundary', () => {
  const savedGlobals: Record<string, unknown> = {};

  before(() => {
    for (const key of ['OfflineAudioContext', 'webkitOfflineAudioContext'] as const) {
      savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
      (globalThis as Record<string, unknown>)[key] = RealOfflineAudioContext;
    }
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  after(() => {
    for (const key of Object.keys(savedGlobals)) {
      (globalThis as Record<string, unknown>)[key] = savedGlobals[key];
    }
  });

  it('REGRESSION: a note released at the song end rings past the boundary and the export ends in silence (pre-fix it was cut at sustain level)', async () => {
    const rendered = await renderSong(makePadChannel(), makeLastBarClip());
    const data = rendered.getChannelData(0);

    // The export now extends past the song window…
    assert.ok(rendered.length > SONG_FRAMES, `export must include the tail (got ${rendered.length} frames, song window ${SONG_FRAMES})`);
    // …but stays bounded by the tail cap.
    assert.ok(rendered.length <= SONG_FRAMES + Math.ceil(SAMPLE_RATE * TAIL_CAP_SECONDS),
      `export must not exceed song + tail cap (got ${rendered.length})`);

    // The tail is genuinely audible just past the song boundary: pre-fix this
    // audio did not exist at all in the exported file.
    assert.ok(rms(data, 8.0, 8.5) > 1e-3, `release tail must be audible past the song end (RMS ${rms(data, 8.0, 8.5)})`);

    // The envelope is a 2 s exponential release from ~8.0 s: decayed by ~10.05 s.
    const durationSeconds = rendered.length / SAMPLE_RATE;
    assert.ok(Math.abs(durationSeconds - 10.05) < 0.2,
      `trim must land at the actual decay point (~10.05 s), got ${durationSeconds.toFixed(3)} s`);

    // The file now ENDS in silence — pre-fix the final samples sat at |0.495|
    // (mid-sustain hard cut, audible click).
    const finalFramesMax = maxAbsRange(data, rendered.length - 512, rendered.length);
    assert.ok(finalFramesMax <= SILENCE, `final 512 frames must be below the silence threshold (got ${finalFramesMax})`);

    // The song itself is still fully rendered (guard against a vacuous "silence" pass).
    assert.ok(rms(data, 7.5, 8.0) > 0.05, 'the song region must remain audible up to the boundary');
  });

  it('the song region of the tail export is sample-identical to a pinned-window render of the same project', async () => {
    const withTail = (await renderSong(makePadChannel(), makeLastBarClip())).getChannelData(0);
    const pinned = (await renderSong(makePadChannel(), makeLastBarClip(), { minimumDurationSeconds: 12 })).getChannelData(0);

    assert.equal(pinned.length, Math.ceil(12 * SAMPLE_RATE), 'pinned window keeps its exact requested duration');
    const diff = maxAbsDiff(withTail, pinned, SONG_FRAMES);
    assert.ok(diff <= 1e-6, `song-region content must not change when the tail is rendered (max Δ ${diff})`);
  });

  it('a song that already decays before its end keeps the exact historical export duration (no dead air added)', async () => {
    const rendered = await renderSong(makeFirstBarChannel(), makeFirstBarClip());
    assert.equal(rendered.length, SONG_FRAMES,
      `silent tail must trim back to the song window exactly (got ${rendered.length})`);
  });

  it('Pattern-scope loop renders keep the exact bar-aligned window (loops stay seamless)', async () => {
    const rendered = await renderSong(makePadChannel(), makeLastBarClip(), { scope: 'pattern' });
    assert.equal(rendered.length, SONG_FRAMES, 'pattern scope must not grow a tail');
  });

  it('pre-master renders (bounce-in-place crop path) keep the exact caller window', async () => {
    const rendered = await renderSong(makePadChannel(), makeLastBarClip(), { stage: 'pre-master', minimumDurationSeconds: 0 });
    assert.equal(rendered.length, SONG_FRAMES, 'pre-master bounce window must stay exact for PCM cropping');
  });

  it('an explicitly pinned duration floor keeps the exact frame count (parity-measurement contract)', async () => {
    const rendered = await renderSong(makePadChannel(), makeLastBarClip(), { minimumDurationSeconds: SONG_SECONDS });
    assert.equal(rendered.length, SONG_FRAMES,
      'callers that pin minimumDurationSeconds (realtime parity spec, bounce) get exactly that window');
  });
});
