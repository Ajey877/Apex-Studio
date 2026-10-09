/**
 * Phase 1J — REAL audio proof of the metronome.
 *
 * Renders the production click path (`audioEngine.triggerCurrentStep` →
 * `scheduleMetronomeClick`) into a genuine Web Audio graph — the pure-JS
 * `web-audio-engine` OfflineAudioContext already used by
 * scripts/realOfflineRenderNode.mjs — and analyses the rendered PCM:
 * onset times (sample positions), per-click pitch (zero-crossing rate) and
 * peak level. Nothing here is mocked except the transport clock, which is
 * replaced by the exact step times the transport would hand out.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as WebAudioEngine from 'web-audio-engine';
import { audioEngine } from './audioEngine';
import { stepsPerBar, type TimeSignature } from '../music/musicalTime';

const OfflineCtx = (WebAudioEngine as unknown as { OfflineAudioContext: new (c: number, l: number, sr: number) => any }).OfflineAudioContext;
const SR = 44100;
const STEP_120 = 0.125;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;
const KEYS = ['ctx', 'masterGain', 'metronome', 'meter', 'sevenEightGrouping', 'metronomePulseLayout', 'activeMetronomeClicks',
  'currentStep', 'activePlayMode', 'activeChannels', 'grossBeatState', 'grossBeatNode', 'bpm', 'isOfflineRendering', 'offlineRenderLeaseHeld'];
let saved: EngineInternals = {};
beforeEach(() => { saved = {}; for (const k of KEYS) saved[k] = engine[k]; });
afterEach(() => { for (const k of KEYS) engine[k] = saved[k]; });

interface Onset { time: number; peak: number; frequency: number }

/** Onset = first sample above threshold after ≥ 60 ms of silence. */
const analyse = (data: Float32Array): Onset[] => {
  const onsets: Onset[] = [];
  const threshold = 0.02;
  let lastLoud = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) < threshold) continue;
    if (i - lastLoud > 0.06 * SR) {
      // Analyse the first 20 ms of this click.
      const end = Math.min(data.length, i + Math.round(0.02 * SR));
      let peak = 0;
      let crossings = 0;
      for (let j = i; j < end; j++) {
        peak = Math.max(peak, Math.abs(data[j]));
        if (j > i && (data[j - 1] < 0) !== (data[j] < 0)) crossings++;
      }
      onsets.push({ time: i / SR, peak, frequency: crossings / 2 / ((end - i) / SR) });
    }
    lastLoud = i;
  }
  return onsets;
};

const setupEngine = (ctx: any, meter: TimeSignature, grouping?: string) => {
  engine.ctx = ctx;
  const master = ctx.createGain();
  master.connect(ctx.destination);
  engine.masterGain = master;
  engine.activeMetronomeClicks = new Set();
  engine.activePlayMode = 'pat';
  engine.activeChannels = [];
  engine.grossBeatState = { ...(engine.grossBeatState ?? {}), enabled: false };
  engine.bpm = 120;
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.setTimeSignature(meter);
  engine.setSevenEightGrouping(grouping);
  engine.metronome = true;
};

/** Drives the production step trigger for absolute steps [from, to). */
const triggerSteps = (meter: TimeSignature, from: number, to: number) => {
  const bar = stepsPerBar(meter);
  for (let step = from; step < to; step++) {
    engine.currentStep = step % bar; // Song Mode reports the bar-relative step
    engine.triggerCurrentStep(step * STEP_120);
  }
};

const render = async (seconds: number, meter: TimeSignature, grouping: string | undefined, drive: () => void) => {
  const ctx = new OfflineCtx(1, Math.round(seconds * SR), SR);
  setupEngine(ctx, meter, grouping);
  drive();
  const buffer = await ctx.startRendering();
  return analyse(buffer.getChannelData(0));
};

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('Phase 1J — rendered metronome audio', () => {
  it('7/8 (2+2+3) renders 7 clicks per 1.75 s bar at exact eighth-note sample positions, accents by pitch', async () => {
    const meter: TimeSignature = [7, 8];
    const onsets = await render(3.6, meter, '2+2+3', () => triggerSteps(meter, 0, 28));
    assert.equal(onsets.length, 14, `expected 14 rendered clicks, got ${onsets.length}`);
    onsets.forEach((o, i) => assert.ok(near(o.time, i * 0.25, 1 / SR + 1e-9), `click ${i} rendered at ${o.time}s, expected ${i * 0.25}s`));
    const expected = [1400, 880, 1100, 880, 1100, 880, 880];
    onsets.forEach((o, i) => {
      const want = expected[i % 7];
      assert.ok(near(o.frequency, want, want * 0.06), `click ${i} pitch ${o.frequency.toFixed(0)} Hz, expected ≈${want} Hz`);
      assert.ok(o.peak > 0.2 && o.peak <= 0.31, `click ${i} peak ${o.peak}`);
    });
  });

  it('3+2+2 moves the rendered accents to eighths 4 and 6', async () => {
    const meter: TimeSignature = [7, 8];
    const onsets = await render(1.9, meter, '3+2+2', () => triggerSteps(meter, 0, 14));
    const pitches = onsets.map(o => Math.round(o.frequency / 100) * 100);
    assert.deepEqual(pitches, [1400, 900, 900, 1100, 900, 1100, 900]);
  });

  it('4/4 renders the unchanged legacy click (quarter notes, 1400/880 Hz)', async () => {
    const meter: TimeSignature = [4, 4];
    const onsets = await render(2.2, meter, undefined, () => triggerSteps(meter, 0, 16));
    assert.deepEqual(onsets.map(o => Number(o.time.toFixed(4))), [0, 0.5, 1, 1.5]);
    assert.deepEqual(onsets.map(o => Math.round(o.frequency / 100) * 100), [1400, 900, 900, 900]);
  });

  it('cancelling scheduled clicks (stop/seek path) removes them from the rendered audio', async () => {
    const meter: TimeSignature = [7, 8];
    const onsets = await render(3.6, meter, undefined, () => {
      triggerSteps(meter, 0, 14); // bar 1 scheduled…
      engine.stopActivePlaybackAudio(); // …then cancelled (what stop/seek/pause call)
      triggerSteps(meter, 14, 28); // bar 2 scheduled after the cancel
    });
    assert.equal(onsets.length, 7, 'only the bar scheduled after the cancel may sound');
    assert.ok(near(onsets[0].time, 1.75, 1 / SR + 1e-9));
    assert.ok(near(onsets[0].frequency, 1400, 90));
  });
});
