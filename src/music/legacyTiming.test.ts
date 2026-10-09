import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { createDefaultProjectState } from '../state/projectState';
import { normalizePatternLengthSteps, getPatternLengthBars } from '../state/patternLength';
import { resolvePatternLoopLengthSteps, resolvePlayableContentLengthSteps, noteOnsetOffsetSteps } from '../audio/audioEngine';
import { AudioClockTransport } from '../audio/transport';
import { getOfflineRenderPlan } from '../audio/offlineProjectRenderer';
import { getRecordingLengthBars } from '../audio/recordingPipeline';
import { swingOffsetSecondsForStep, swingOffsetTicksForStep } from '../audio/parameterScaling';
import { splitPlaylistClip, resizePlaylistClipLeft } from '../components/playlistClipOperations';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { MidiParser } from '../utils/midiParser';
import type { Channel, PlaylistClip } from '../types/daw';
import { beatsToSeconds, stepsToBeats, barsToBeats, LEGACY_TIME_SIGNATURE } from './musicalTime';

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const channel = (): Channel => ({
  ...createDefaultProjectState().channels[0], id: 'timing-ch', name: 'Timing fixture',
  steps: Array.from({ length: 32 }, (_, i) => [0, 7, 20, 31].includes(i)),
  notes: [1.04, 4.25, 31.75, 40.5].map((start, i) => ({
    id: `n${i}`, pitch: 60 + i, start, duration: [0.25, 2, 0.5, 1.25][i], velocity: 0.8,
  })),
});
const clip = (): PlaylistClip => ({
  id: 'timing-clip', type: 'pattern', channelId: 'timing-ch', trackIndex: 0,
  startBar: 0.25, lengthBars: 6, offsetSteps: 3.5, name: 'Timing fixture', color: '#fff',
});

// Original fingerprints were captured before musicalTime consumers changed.
// The six Standard MIDI fingerprints (pattern/song at three tempos) are
// intentionally refreshed for Phase 1I's newly supported 7/8, 14-step bar.
// Piano-export fingerprints and all unrelated timing contracts stay pinned.
const MIDI_SHA256: Record<string, string> = {
  '60-pattern': '7f9b24bbe5148223fb9970678f81889d3eb44545d4a3791ba8054e57e24385fa',
  '60-song': '46cff5dce714ebe3b4b580513d0c7f073bc6fe5fa84e864fcb8e2f80d18c0684',
  '60-piano': 'eb459ea51d9f84a572331a610a182b14369797a5bbd0157c8b66ef9382e25b24',
  '120-pattern': '162341353fd7342bc04b8ec0748abb16248fc7db7e82cfbddaaf677bd77b8d51',
  '120-song': 'ea3706892d3cca0b9cb6656d1348c14528091213cdfaec667329c14909fdbfd5',
  '120-piano': '1787d0d83bbbb795e4d3cd3ffa7cc4bc096fc594926481bb2d7aa6a33cc8340e',
  '240-pattern': 'df2c7dad2cb8ef36a233588cdd276896e097bc06d6da1c71b9bedc3a38e21f31',
  '240-song': '9c26875b6a0b003c4acac03de14fd0007fa346eb2dc37f44a2e9b4148ef415e9',
  '240-piano': '4cad4bfa2d54bc038eec0f80667179e1bc6b0f72a5899fcf05fa8fb0ad9c3abd',
};
const hash = async (blob: Blob): Promise<string> =>
  createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');

describe('Phase 1A/1I — timing contracts and supported 7/8 MIDI fingerprints', () => {
  for (const bpm of [60, 120, 240]) {
    it(`keeps the supported 7/8 MIDI fingerprints stable at ${bpm} BPM`, async () => {
      const ch = channel();
      for (const scope of ['pattern', 'song'] as const) {
        const blob = buildStandardMidiFile([ch], [clip()], { bpm, timeSignature: [7, 8], swing: 0.375 }, {
          scope, patternLengthSteps: 32, totalBars: 8,
        });
        assert.equal(await hash(blob), MIDI_SHA256[`${bpm}-${scope}`]);
      }
      assert.equal(await hash(MidiParser.exportNotesToMidi(ch.notes, bpm, ch.name)), MIDI_SHA256[`${bpm}-piano`]);
    });
  }

  it('retains declared-length rounding and channel-derived Song loop semantics', () => {
    const ch = channel();
    for (const length of [0.25, 16, 17, 32, 40, 64]) {
      const legacy = Math.max(1, Math.ceil(length / 16)) * 16;
      assert.equal(normalizePatternLengthSteps(length), legacy);
      assert.equal(getPatternLengthBars(length), legacy / 16);
      assert.equal(resolvePatternLoopLengthSteps([ch], length), legacy);
    }
    assert.equal(resolvePlayableContentLengthSteps(ch), 48);
    assert.equal(resolvePatternLoopLengthSteps([ch], 16), 16);
    assert.equal(normalizePatternLengthSteps(NaN), 16);
  });

  it('retains fractional onsets and swing offsets across the supported engine BPM range', () => {
    for (const bpm of [20, 60, 97.5, 120, 137, 240, 300]) {
      const stepSeconds = beatsToSeconds(stepsToBeats(1), bpm);
      assert.equal(stepSeconds, (60 / bpm) / 4);
      for (const start of [0, 0.04, 1.25, 4.5, 15.99, 31.75]) {
        const step = Math.floor(start);
        const offset = noteOnsetOffsetSteps(start, step);
        assert.equal(offset, start - step);
        const swing = step % 2 ? swingOffsetSecondsForStep(0.375, stepSeconds) : 0;
        close(step * stepSeconds + swing + offset! * stepSeconds,
          (start + (step % 2 ? 0.3 : 0)) * (60 / bpm / 4));
        assert.equal(noteOnsetOffsetSteps(start, step + 1), null);
      }
      assert.equal(swingOffsetTicksForStep(0.375, 120), 36);
    }
  });

  it('retains recording sizing and offline bar placements, including caller fallbacks', () => {
    for (const bpm of [20, 60, 97.5, 120, 240, 300, NaN, 0]) {
      const recordingBpm = Number.isFinite(bpm) ? Math.max(20, bpm) : 120;
      for (const duration of [0.01, 1, 2, 4, 17.25]) {
        assert.equal(getRecordingLengthBars(duration, bpm), Math.max(1, Math.ceil(duration / (240 / recordingBpm))));
      }
      const renderBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
      const plan = getOfflineRenderPlan([clip()], bpm, 4);
      const secondsPerBar = (60 / renderBpm) * 4;
      assert.deepEqual(plan, [{ clipId: 'timing-clip', type: 'pattern', startSeconds: 0.25 * secondsPerBar, durationSeconds: 3.75 * secondsPerBar }]);
      assert.equal(beatsToSeconds(barsToBeats(1, LEGACY_TIME_SIGNATURE), renderBpm), secondsPerBar);
    }
  });

  it('keeps split and left-trim source offsets on the legacy 16-step bar grid', () => {
    const original = clip();
    const [left, right] = splitPlaylistClip(original, 1.25);
    assert.equal(left.lengthBars, 1);
    assert.equal(right.offsetSteps, 19.5);
    const trimmed = resizePlaylistClipLeft(original, 0.75);
    assert.equal(trimmed.offsetSteps, 11.5);
    assert.equal(trimmed.startBar + trimmed.lengthBars, original.startBar + original.lengthBars);
  });

  it('retains transport 4/4 scheduling; Phase 1J tempo changes keep the musical position', () => {
    const originalWindow = globalThis.window;
    let pending: (() => void) | undefined;
    globalThis.window = { setTimeout: (fn: () => void) => { pending = fn; return 1; }, clearTimeout: () => {} } as unknown as Window & typeof globalThis;
    const context = { currentTime: 0 };
    const transport = new AudioClockTransport(context as AudioContext);
    const events: Array<[number, number, number]> = [];
    try {
      transport.setCallbacks({ onStep: (step, bar, time) => events.push([step, bar, time]) });
      transport.start();
      for (let i = 1; i <= 16; i++) { context.currentTime = i * 0.125; pending!(); }
      assert.deepEqual(events, Array.from({ length: 17 }, (_, i) => [i % 16, Math.floor(i / 16) + 1, i * 0.125]));
      transport.seek(1.5);
      transport.setBpm(60);
      // Phase 1A deliberately left tempo continuity unfixed (step 12 jumped to
      // 6). Phase 1J fixes it: the musical position is preserved.
      assert.equal(transport.getState().step, 12, 'Phase 1J: tempo change preserves the musical position');
      assert.equal(transport.getState().beatsPerBar, 4);
      assert.equal(transport.getState().stepsPerBeat, 4);
    } finally {
      transport.dispose();
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
      else globalThis.window = originalWindow;
    }
  });
});
