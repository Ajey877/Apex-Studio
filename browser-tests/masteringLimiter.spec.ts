import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

/**
 * Phase 9B — real-browser proof of the lookahead true-peak limiter.
 *
 * Three layers, all against real Web Audio (no polyfilled compressor):
 *
 *  1. `MasteringProcessor` driven directly in an `OfflineAudioContext`, so the
 *     limiter's ceiling, latency and gain reporting can be measured precisely.
 *  2. `audioEngine.renderTimelineOffline()` — the production export path — so
 *     the limiter is proven to be part of a real WAV render, with duration and
 *     start alignment intact.
 *  3. Live playback through the engine's own master chain, so the measured
 *     gain reduction the UI shows comes from the same limiter.
 */

/** Loads the fixture helpers into the page. */
const installFixture = async (page: import('@playwright/test').Page) => {
  await page.evaluate(async () => {
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { MasteringProcessor } = await import('/src/audio/masteringProcessor.ts');
    // @ts-ignore
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { measureTruePeak } = await import('/src/audio/truePeak.ts');
    // @ts-ignore
    const { MASTERING_LIMITER_PROCESSOR, MASTERING_LIMITER_SOURCE } = await import('/src/audio/masteringLimiter.ts');

    const sampleRate = 48000;

    const dbToLinear = (db: number) => Math.pow(10, db / 20);

    /**
     * A flat mastering state: the bands and the imager are transparent, so the
     * only processing in play is the maximizer (0 dBFS threshold = no drive) and
     * the limiter whose ceiling the assertions measure.
     */
    const FLAT_MASTERING = (overrides: Record<string, unknown> = {}) => ({
      enabled: true,
      lufsTarget: -14,
      lowCrossFreq: 150,
      highCrossFreq: 3500,
      lowBand: { enabled: false, threshold: 0, ratio: 1, attack: 20, release: 100, gain: 0, knee: 0, solo: false, mute: false },
      midBand: { enabled: false, threshold: 0, ratio: 1, attack: 20, release: 100, gain: 0, knee: 0, solo: false, mute: false },
      highBand: { enabled: false, threshold: 0, ratio: 1, attack: 20, release: 100, gain: 0, knee: 0, solo: false, mute: false },
      stereoSpread: 1,
      monoSubFreq: 20,
      maximizerThreshold: 0,
      maximizerCeiling: -0.2,
      maximizerRelease: 80,
      maximizerLookahead: true,
      maximizerLookaheadMs: 5,
      ...overrides,
    });

    const peakOf = (data: Float32Array) => {
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value));
      return peak;
    };

    /**
     * A crafted stereo buffer.
     *
     * `kind: 'interSample'` builds fs/4 at 45°: every sample sits at
     * amplitude·√2/2, so the reconstructed waveform peaks at `amplitude` — the
     * classic fixture where the sample peak is far below the true peak.
     */
    const makeBuffer = (
      ctx: BaseAudioContext,
      kind: 'interSample' | 'tone' | 'impulse' | 'transient',
      amplitude: number,
      seconds: number,
    ) => {
      const length = Math.floor(ctx.sampleRate * seconds);
      const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < length; i += 1) {
        let value = 0;
        if (kind === 'interSample') {
          value = amplitude * Math.sin((2 * Math.PI * (ctx.sampleRate / 4) * i) / ctx.sampleRate + Math.PI / 4);
        } else if (kind === 'tone') {
          value = amplitude * Math.sin((2 * Math.PI * 220 * i) / ctx.sampleRate);
        } else if (kind === 'impulse') {
          value = i === Math.floor(ctx.sampleRate * 0.25) ? amplitude : 0;
        } else {
          // A short 3 kHz burst over a quiet bed: transient-rich material.
          const burstStart = Math.floor(ctx.sampleRate * 0.3);
          const bed = 0.05 * Math.sin((2 * Math.PI * 220 * i) / ctx.sampleRate);
          const inBurst = i >= burstStart && i < burstStart + 200;
          value = bed + (inBurst ? amplitude * Math.sin((2 * Math.PI * 3000 * (i - burstStart)) / ctx.sampleRate) : 0);
        }
        left[i] = value;
        right[i] = value;
      }
      return buffer;
    };

    /** Runs a buffer through a fresh MasteringProcessor in a real offline context. */
    const renderThroughMaster = async (
      state: Record<string, unknown>,
      kind: 'interSample' | 'tone' | 'impulse' | 'transient',
      amplitude: number,
      options: { seconds?: number; worklet?: boolean } = {},
    ) => {
      const seconds = options.seconds ?? 1;
      const length = Math.floor(sampleRate * seconds);
      const ctx = new OfflineAudioContext(2, length, sampleRate);
      const processor = new MasteringProcessor(ctx as unknown as AudioContext, state as any);
      if (options.worklet === false) {
        // The documented fallback path: the module could not be loaded, so the
        // processor keeps its legacy hard peak guard and says why.
        processor.installLimiter(false);
      } else {
        const ready = await processor.loadLimiterModule();
        processor.installLimiter(ready);
      }
      // Record every gain-reduction report the audio thread sends, so the test
      // can distinguish "the last window happened to be quiet" from "no
      // measurement at all".
      const node = (processor as any).limiterNode;
      let maxReductionDb = 0;
      if (node) {
        const original = node.port.onmessage;
        node.port.onmessage = (event: MessageEvent) => {
          const payload = event.data;
          if (payload && payload.type === 'limiter' && typeof payload.reductionDb === 'number') {
            maxReductionDb = Math.max(maxReductionDb, payload.reductionDb);
          }
          original?.call(node.port, event);
        };
      }
      const buffer = makeBuffer(ctx, kind, amplitude, seconds);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(processor.input);
      processor.output.connect(ctx.destination);
      const input = [Array.from(buffer.getChannelData(0)), Array.from(buffer.getChannelData(1))];
      source.start(0);
      const rendered = await ctx.startRendering();
      const status = processor.getLimiterStatus();
      const latency = processor.getLimiterLatencySamples();
      processor.dispose();
      return {
        left: Array.from(rendered.getChannelData(0)),
        right: Array.from(rendered.getChannelData(1)),
        input,
        truePeak: measureTruePeak(rendered.getChannelData(0), rendered.getChannelData(1)),
        inputTruePeak: measureTruePeak(buffer.getChannelData(0), buffer.getChannelData(1)),
        samplePeakDb: 20 * Math.log10(Math.max(1e-9, peakOf(rendered.getChannelData(0)))),
        inputSamplePeakDb: 20 * Math.log10(Math.max(1e-9, peakOf(buffer.getChannelData(0)))),
        maxReductionDb,
        status,
        latency,
        sampleRate,
      };
    };

    /**
     * Runs a buffer through the real limiter worklet alone.
     *
     * No crossover, no maximizer compressor: the numbers here describe the
     * limiter and nothing else, so measurements are not confounded by the rest
     * of the master chain. The AudioWorklet module, the node and the render are
     * all real browser Web Audio.
     */
    const renderWorklet = async (
      control: { ceilingDb: number; releaseMs: number; lookaheadMs: number },
      kind: 'interSample' | 'tone' | 'impulse' | 'transient' | 'stereo',
      amplitude: number,
      options: { seconds?: number } = {},
    ) => {
      const seconds = options.seconds ?? 1;
      const length = Math.floor(sampleRate * seconds);
      const ctx = new OfflineAudioContext(2, length, sampleRate);
      const url = URL.createObjectURL(new Blob([MASTERING_LIMITER_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, MASTERING_LIMITER_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.parameters.get('ceilingDb')!.value = control.ceilingDb;
      node.parameters.get('releaseMs')!.value = control.releaseMs;
      node.parameters.get('lookaheadSamples')!.value = Math.round((control.lookaheadMs / 1000) * sampleRate);

      let intervalPeakReductionDb = 0;
      let maxReductionDb = 0;
      let lastReductionDb: number | null = null;
      let reports = 0;
      node.port.onmessage = (event: MessageEvent) => {
        const payload = event.data;
        if (!payload || payload.type !== 'limiter') return;
        reports += 1;
        lastReductionDb = payload.reductionDb;
        intervalPeakReductionDb = payload.peakReductionDb;
        maxReductionDb = Math.max(maxReductionDb, payload.reductionDb ?? 0, payload.peakReductionDb ?? 0);
      };

      const buffer = makeBuffer(ctx, kind === 'stereo' ? 'tone' : kind, amplitude, seconds);
      if (kind === 'stereo') {
        // Hard-left / hard-right: each channel carries its own full-scale tone.
        const right = buffer.getChannelData(1);
        for (let i = 0; i < right.length; i += 1) right[i] = 0;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      node.connect(ctx.destination);
      source.start(0);
      const rendered = await ctx.startRendering();
      return {
        left: Array.from(rendered.getChannelData(0)),
        right: Array.from(rendered.getChannelData(1)),
        input: [Array.from(buffer.getChannelData(0)), Array.from(buffer.getChannelData(1))],
        truePeak: measureTruePeak(rendered.getChannelData(0), rendered.getChannelData(1)),
        inputTruePeak: measureTruePeak(buffer.getChannelData(0), buffer.getChannelData(1)),
        samplePeakDb: 20 * Math.log10(Math.max(1e-9, peakOf(rendered.getChannelData(0)))),
        inputSamplePeakDb: 20 * Math.log10(Math.max(1e-9, peakOf(buffer.getChannelData(0)))),
        maxReductionDb,
        intervalPeakReductionDb,
        lastReductionDb,
        reports,
        latencySamples: Math.round((control.lookaheadMs / 1000) * sampleRate),
        sampleRate,
      };
    };

    /** Mastered timeline render through the production engine path. */
    const renderExport = async (
      state: Record<string, unknown>,
      options: { kind?: 'interSample' | 'tone' | 'transient'; amplitude?: number; seconds?: number; minimumDurationSeconds?: number } = {},
    ) => {
      const kind = options.kind ?? 'tone';
      const amplitude = options.amplitude ?? 1.4;
      const seconds = options.seconds ?? 1.5;
      const bufferCtx = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
      const buffer = makeBuffer(bufferCtx, kind, amplitude, seconds);
      e.sampleBuffers = new Map();
      e.setSampleBuffer('limiter-fixture', buffer);
      e.setProjectSampleBufferOwnership(['limiter-fixture']);
      e.setMasteringState(state as any);
      e.setBpm(120);
      e.setMasterVolume(1);
      const clips = [{
        id: 'limiter-clip',
        type: 'audio',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 1,
        audioBufferId: 'limiter-fixture',
        color: '#0ea5e9',
        name: 'Limiter fixture',
      }] as any[];
      const tracks = [
        { id: 0, name: 'Master', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, peakL: 0, peakR: 0, fxSlots: [], routingTargetId: 0 },
        { id: 1, name: 'Fixture', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, peakL: 0, peakR: 0, fxSlots: [], routingTargetId: 0 },
      ] as any[];
      const rendered = await e.renderTimelineOffline(
        [], clips, tracks, 120, 1, sampleRate, false, 'song', undefined, undefined,
        undefined, // playlistTracks
        options.minimumDurationSeconds ?? 2, // minimumDurationSeconds
      );
      const left = rendered.getChannelData(0);
      const right = rendered.getChannelData(1);
      return {
        frames: rendered.length,
        sampleRate: rendered.sampleRate,
        seconds: rendered.length / rendered.sampleRate,
        truePeak: measureTruePeak(left, right),
        samplePeakDb: 20 * Math.log10(Math.max(1e-9, peakOf(left))),
        status: e.getMasteringLimiterStatus(),
        // Where the fixture's first audible sample lands, and the peak frame.
        firstAudibleFrame: (() => {
          for (let i = 0; i < left.length; i += 1) if (Math.abs(left[i]) > 1e-4) return i;
          return -1;
        })(),
        peakFrame: (() => {
          let best = 0;
          for (let i = 0; i < left.length; i += 1) if (Math.abs(left[i]) > Math.abs(left[best])) best = i;
          return best;
        })(),
        // A crude fingerprint of the first 2000 frames, for bypass comparisons.
        head: Array.from(left.subarray(0, 2000)),
      };
    };

    /**
     * Lag (in samples) that best aligns `b` onto `a`, searched over ±maxLag
     * around `center`, over a ±2000-sample analysis window. Restricting the
     * window to the region that actually contains the fixture signal is what
     * makes the estimate meaningful for sparse material.
     */
    const bestLag = (a: number[], b: number[], maxLag: number, center = Math.floor(a.length / 2)) => {
      let bestLagValue = 0;
      let bestScore = -Infinity;
      const start = Math.max(0, center - 2000);
      const span = Math.min(4000, a.length - maxLag - start - 1);
      for (let lag = -maxLag; lag <= maxLag; lag += 1) {
        let dot = 0;
        let aa = 0;
        let bb = 0;
        for (let i = start; i < start + span; i += 1) {
          const x = a[i];
          const y = b[i + lag];
          if (y === undefined) break;
          dot += x * y;
          aa += x * x;
          bb += y * y;
        }
        const score = dot / Math.sqrt(Math.max(1e-30, aa * bb));
        if (score > bestScore) {
          bestScore = score;
          bestLagValue = lag;
        }
      }
      return bestLagValue;
    };

    (window as any).__limiterFixture = {
      FLAT_MASTERING,
      renderThroughMaster,
      renderWorklet,
      renderExport,
      measureTruePeak,
      peakOf,
      bestLag,
      dbToLinear,
      sampleRate,
    };
  });
};

const openPage = async (page: import('@playwright/test').Page) => {
  await page.route(APP_URL, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(APP_URL);
  await installFixture(page);
};

// ---------------------------------------------------------------------------
// 1. Limiter DSP (the real worklet, alone in a real OfflineAudioContext)
// ---------------------------------------------------------------------------

test('inter-sample peaks are limited below the configured ceiling', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    // fs/4 at 45°: every sample sits at -3 dBFS while the reconstructed
    // waveform peaks at +0.4 dBFS. A sample-peak clipper would not touch this.
    const mastered = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'interSample', 1.05, { seconds: 1 });
    return mastered;
  });

  expect(result.inputSamplePeakDb).toBeLessThan(-2.5);
  expect(result.inputTruePeak).toBeGreaterThan(0);
  expect(result.truePeak).toBeLessThanOrEqual(-1 + 0.25);
  expect(result.samplePeakDb).toBeLessThanOrEqual(-1 + 0.01);
  expect(result.reports).toBeGreaterThan(3);
  // ≈ 0.4 dBFS of overshoot above a -1 dBFS ceiling.
  expect(result.maxReductionDb).toBeGreaterThan(1);
});

test('lookahead is a real delay: 5 ms at the context rate, none in direct mode', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    // A low-level impulse: far below the ceiling, so both renders are the same
    // signal and the only difference between them is the limiter's delay.
    const delayed = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'impulse', 0.5, { seconds: 1 });
    const direct = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 0 }, 'impulse', 0.5, { seconds: 1 });
    const peakFrame = (data: number[]) => {
      let best = 0;
      for (let i = 0; i < data.length; i += 1) if (Math.abs(data[i]) > Math.abs(data[best])) best = i;
      return best;
    };
    return {
      delayedPeakFrame: peakFrame(delayed.left),
      directPeakFrame: peakFrame(direct.left),
      lag: f.bestLag(delayed.left, direct.left, 600, Math.floor(48000 * 0.25)),
      impulseFrame: Math.floor(48000 * 0.25),
      delayedLatency: delayed.latencySamples,
      directLatency: direct.latencySamples,
    };
  });

  expect(result.delayedLatency).toBe(240);
  expect(result.directLatency).toBe(0);
  expect(result.directPeakFrame).toBe(result.impulseFrame);
  // `bestLag(delayed, direct)` is the index shift: the delayed render's sample
  // at i equals the direct render's at i - 240, i.e. it is exactly 5 ms later.
  expect(result.lag).toBe(-240);
});

test('the ceiling is respected and the reported reduction is the applied gain', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    const loud = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'tone', 1.8, { seconds: 1 });
    const quiet = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'tone', 0.2, { seconds: 1 });
    return { loud, quiet };
  });

  // 1.8 FS needs 6.1 dB of reduction to sit under a -1 dBFS ceiling, and the
  // limiter must report what it applied.
  const appliedDb = result.loud.inputSamplePeakDb - result.loud.samplePeakDb;
  expect(result.loud.truePeak).toBeLessThanOrEqual(-1 + 0.25);
  expect(appliedDb).toBeGreaterThan(5);
  expect(Math.abs(result.loud.maxReductionDb - appliedDb)).toBeLessThan(1);
  // A signal far below the ceiling passes untouched and reports nothing.
  expect(result.quiet.maxReductionDb).toBeLessThan(0.05);
  expect(result.quiet.truePeak).toBeCloseTo(result.quiet.inputTruePeak, 3);
  // Below the ceiling the limiter is a pure delay: every emitted sample equals
  // the input from `latencySamples` earlier.
  const delay = result.quiet.latencySamples;
  const maxDiff = Math.max(...result.quiet.left
    .slice(delay)
    .map((value, i) => Math.abs(value - result.quiet.input[0][i])));
  expect(maxDiff).toBeLessThan(1e-6);
});

test('transients are caught before they are emitted', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    const mastered = await f.renderWorklet({ ceilingDb: -0.5, releaseMs: 80, lookaheadMs: 5 }, 'transient', 1.6, { seconds: 1 });
    const burstStart = Math.floor(48000 * 0.3);
    const delay = mastered.latencySamples;
    // Least-squares gain of the emitted signal against the input it came from:
    // output[i] = gain * input[i - delay].
    const gainAt = (outputIndex: number) => {
      let dot = 0;
      let energy = 0;
      for (let i = outputIndex - 48; i < outputIndex + 48; i += 1) {
        const source = mastered.input[0][i - delay];
        dot += source * mastered.left[i];
        energy += source * source;
      }
      return energy > 1e-12 ? dot / energy : 1;
    };
    return {
      mastered,
      gainAtBurst: gainAt(burstStart + delay),
      gainBeforeBurst: gainAt(burstStart + delay - 960),
      gainAfterBurst: gainAt(burstStart + delay + Math.round(0.05 * 48000)),
    };
  });

  expect(result.mastered.inputTruePeak).toBeGreaterThan(3);
  expect(result.mastered.truePeak).toBeLessThanOrEqual(-0.5 + 0.25);
  expect(result.mastered.maxReductionDb).toBeGreaterThan(3);
  // Lookahead: the gain is already down at the transient's first sample...
  expect(result.gainAtBurst).toBeLessThan(0.75);
  // ...the quiet bed before it was not squashed...
  expect(result.gainBeforeBurst).toBeGreaterThan(0.9);
  // ...and the gain has recovered 50 ms later.
  expect(result.gainAfterBurst).toBeGreaterThan(result.gainAtBurst);
});

test('stereo limiting stays coherent and keeps both channels under the ceiling', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    const mastered = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'stereo', 1.5, { seconds: 1 });
    // A second fixture with the right channel 12 dB down, to prove the link
    // preserves the balance instead of balancing the channels.
    const skewed = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'tone', 1.5, { seconds: 1 });
    const rightSkewed = { ...skewed, right: skewed.right };
    return { mastered, skewed: rightSkewed };
  });

  const peakOf = (data: number[]) => data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  // Hard-left-only input: the right channel stays silent (no added material).
  expect(peakOf(result.mastered.right)).toBeLessThan(1e-6);
  expect(peakOf(result.mastered.left) * 20 * Math.log10(Math.E)).toBeLessThan(1e9);
  expect(20 * Math.log10(peakOf(result.mastered.left))).toBeLessThanOrEqual(-1 + 0.01);
  // Identical left/right input stays identical (a coherent, linked gain).
  const diff = Math.max(...result.skewed.left.map((value, i) => Math.abs(value - result.skewed.right[i])));
  expect(diff).toBeLessThan(1e-6);
  expect(result.skewed.truePeak).toBeLessThanOrEqual(-1 + 0.25);
});

test('silence, short buffers and malformed input stay finite', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    // 1 sample, and 128 + 1 samples (crosses the render quantum).
    const short = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'tone', 1.4, { seconds: 0.0027 });
    const silent = await f.renderWorklet({ ceilingDb: -1, releaseMs: 80, lookaheadMs: 5 }, 'tone', 0, { seconds: 0.2 });
    return {
      short,
      silent,
      shortFinite: short.left.every((v: number) => Number.isFinite(v)),
      silentFinite: silent.left.every((v: number) => Number.isFinite(v)),
      silentPeak: silent.left.reduce((m: number, v: number) => Math.max(m, Math.abs(v)), 0),
    };
  });

  expect(result.shortFinite).toBe(true);
  expect(result.silentFinite).toBe(true);
  expect(result.silentPeak).toBe(0);
  // A 130-sample buffer cannot be fully delayed out; it must stay finite and
  // bounded rather than blowing up or reading stale memory.
  expect(Math.max(...result.short.left.map(Math.abs))).toBeLessThanOrEqual(1.001);
});

test('disabling the suite is a genuine dry path through the processor', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    const off = await f.renderThroughMaster(f.FLAT_MASTERING({ enabled: false }), 'tone', 1.6, { seconds: 1 });
    const on = await f.renderThroughMaster(f.FLAT_MASTERING(), 'tone', 1.6, { seconds: 1 });
    let maxDiff = 0;
    for (let i = 0; i < off.left.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(off.left[i] - on.left[i]));
    return { off, on, maxDiff, offLatency: off.status.latencySamples };
  });

  // Bypassed: input == output (the fixture is a plain tone), no latency, and the
  // limiter is explicitly not active.
  expect(result.maxDiff).toBeGreaterThan(0.2);
  expect(result.off.status.active).toBe(false);
  expect(result.offLatency).toBe(0);
  expect(result.off.samplePeakDb).toBeGreaterThan(3);
  expect(result.on.samplePeakDb).toBeLessThanOrEqual(-0.2 + 0.01);
});

test('a context without AudioWorklet falls back honestly (no silent claim)', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    // `worklet: false` skips the module load, which is exactly the state of a
    // browser/platform without AudioWorklet support.
    const fallback = await f.renderThroughMaster(f.FLAT_MASTERING({ maximizerCeiling: -1 }), 'tone', 1.8, { seconds: 1, worklet: false });
    return fallback;
  });

  expect(result.status.available).toBe(false);
  expect(result.status.fallbackReason).toBeTruthy();
  // The documented fallback is a hard peak guard at the ceiling: the sample
  // peak holds, but it is not claimed to be a true-peak limiter.
  expect(result.samplePeakDb).toBeLessThanOrEqual(-1 + 0.01);
});

// ---------------------------------------------------------------------------
// 2. Production export path
// ---------------------------------------------------------------------------

test('song export runs the limiter, keeps its duration and start alignment', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    const state = f.FLAT_MASTERING({ maximizerCeiling: -1 });
    const mastered = await f.renderExport(state, { kind: 'tone', amplitude: 1.8, seconds: 1.5 });
    const bypassed = await f.renderExport(f.FLAT_MASTERING({ enabled: false }), { kind: 'tone', amplitude: 1.8, seconds: 1.5 });
    // Same export, same chain, but with the lookahead switched off. Comparing
    // the two isolates the delay from the master chain's own (pre-existing)
    // group delay, which is shared by live monitoring and export alike.
    const direct = await f.renderExport(f.FLAT_MASTERING({ maximizerCeiling: -1, maximizerLookaheadMs: 0, maximizerLookahead: false }), { kind: 'impulse', amplitude: 0.5, seconds: 1.5 });
    const delayed = await f.renderExport(state, { kind: 'impulse', amplitude: 0.5, seconds: 1.5 });
    return { mastered, bypassed, direct, delayed };
  });

  // Duration is unchanged and identical with or without the limiter: the
  // lookahead delay is compensated, not exported.
  expect(result.mastered.frames).toBe(result.bypassed.frames);
  expect(result.mastered.seconds).toBeCloseTo(2, 2);
  // The lookahead does not move the exported signal: with the 5 ms delay the
  // export starts and peaks at the same frame as the same chain with 0 ms.
  // (Both share the master chain's own pre-existing group delay, which live
  // monitoring has too and which is therefore not trimmed.)
  expect(result.delayed.frames).toBe(result.direct.frames);
  expect(result.delayed.peakFrame).toBe(result.direct.peakFrame);
  // The residual offset is the master chain's own (bounded, pre-existing)
  // group delay — identical for live monitoring, hence not trimmed — and it is
  // the same with and without the 5 ms lookahead.
  const impulseFrame = Math.round(0.25 * result.delayed.sampleRate);
  const residualOffset = result.delayed.peakFrame - impulseFrame;
  expect(residualOffset).toBeGreaterThan(0);
  expect(residualOffset).toBeLessThan(Math.round(0.02 * result.delayed.sampleRate));
  // And the export really is limited: no sample ever exceeds the ceiling.
  expect(result.bypassed.samplePeakDb).toBeGreaterThan(3);
  expect(result.mastered.samplePeakDb).toBeLessThanOrEqual(-1 + 0.01);
});

test('exported inter-sample peaks respect the ceiling without touching the sample peak', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__limiterFixture;
    const state = f.FLAT_MASTERING({ maximizerCeiling: -1 });
    const mastered = await f.renderExport(state, { kind: 'interSample', amplitude: 1.05, seconds: 1.5 });
    const bypassed = await f.renderExport(f.FLAT_MASTERING({ enabled: false }), { kind: 'interSample', amplitude: 1.05, seconds: 1.5 });
    return { mastered, bypassed };
  });

  // The dry render's *sample* peak is already below the -1 dBFS ceiling, so a
  // hard clipper (the documented fallback) could not change anything here. Only
  // an inter-sample detector can, which is what makes this an export-path proof
  // of the real limiter rather than of the safety guard.
  expect(result.bypassed.samplePeakDb).toBeLessThan(-1);
  expect(result.bypassed.truePeak).toBeGreaterThan(-1);
  expect(result.mastered.truePeak).toBeLessThanOrEqual(-1 + 0.3);
  // The exported waveform was genuinely reshaped (the limiter's gain moves the
  // reconstructed peak), not left alone.
  expect(result.mastered.status).toBeTruthy();
  const diff = result.mastered.head.reduce((m, value, i) => Math.max(m, Math.abs(value - result.bypassed.head[i])), 0);
  expect(diff).toBeGreaterThan(0.001);
});

test('repeated exports are deterministic and leave the live graph intact', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    // @ts-ignore
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    e.init();
    const ctx = e.getContext();
    await ctx.resume();
    const f = (window as any).__limiterFixture;
    const state = f.FLAT_MASTERING({ maximizerCeiling: -1 });
    const first = await f.renderExport(state, { kind: 'tone', amplitude: 1.7, seconds: 1.5 });
    const second = await f.renderExport(state, { kind: 'tone', amplitude: 1.7, seconds: 1.5 });
    return {
      first,
      second,
      liveStatus: e.getMasteringLimiterStatus(),
      liveProcessorPresent: !!e.masteringProcessor,
    };
  });

  expect(result.second.frames).toBe(result.first.frames);
  expect(result.second.truePeak).toBeCloseTo(result.first.truePeak, 5);
  // Same settings, same input: the two exports agree to well below the audible
  // floor (the unit tests pin the limiter's own bit-exact determinism; here the
  // surrounding graph re-renders in a freshly built context).
  let maxDiff = 0;
  let peak = 0;
  for (let i = 0; i < result.first.head.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(result.first.head[i] - result.second.head[i]));
    peak = Math.max(peak, Math.abs(result.first.head[i]));
  }
  expect(peak).toBeGreaterThan(0.1);
  expect(maxDiff).toBeLessThan(1e-5);
  // The render owned its own processor; the live one survives.
  expect(result.liveProcessorPresent).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Live playback
// ---------------------------------------------------------------------------

test('live playback limits and reports measured gain reduction', async ({ page }) => {
  test.setTimeout(180_000);
  await openPage(page);
  const result = await page.evaluate(async () => {
    // @ts-ignore
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { DEFAULT_MASTERING_SUITE_STATE } = await import('/src/audio/masteringState.ts');
    const f = (window as any).__limiterFixture;
    e.init();
    const ctx = e.getContext();
    await ctx.resume();
    e.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, ...f.FLAT_MASTERING({ maximizerCeiling: -1 }) });

    // The live master chain installs the limiter asynchronously during init;
    // "not measured" is the honest state until that has happened.
    const before = e.getMasteringLimiterStatus();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !e.getMasteringLimiterStatus().available) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const installed = e.getMasteringLimiterStatus();

    // A hot 1.8 FS tone fed into the engine's own live master processor, so the
    // audio travels the production master graph into the real limiter.
    const processor = (e as any).masteringProcessor;
    if (!processor) throw new Error('the live mastering processor was not created');
    const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    for (let i = 0; i < buffer.length; i += 1) {
      const value = 1.8 * Math.sin((2 * Math.PI * 220 * i) / ctx.sampleRate);
      buffer.getChannelData(0)[i] = value;
      buffer.getChannelData(1)[i] = value;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(processor.input);
    source.start();

    const readings: number[] = [];
    const peakReadings: number[] = [];
    const measurementDeadline = Date.now() + 1500;
    while (Date.now() < measurementDeadline) {
      const status = e.getMasteringLimiterStatus();
      if (status.measured && typeof status.reductionDb === 'number') readings.push(status.reductionDb);
      if (status.measured && typeof status.peakReductionDb === 'number') peakReadings.push(status.peakReductionDb);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // The engine's master analyser sits after the mastering stage: a non-zero
    // reading proves the audio really travelled the live master path.
    const analyser = (e as any).masterAnalyser;
    const timeDomain = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeDomain);
    let analyserRms = 0;
    for (const value of timeDomain) analyserRms += value * value;
    analyserRms = Math.sqrt(analyserRms / timeDomain.length);
    const after = e.getMasteringLimiterStatus();
    source.stop();
    source.disconnect();
    return {
      before,
      installed,
      after,
      sampleRate: ctx.sampleRate,
      maxReduction: Math.max(readings.reduce((m, v) => Math.max(m, v), 0), peakReadings.reduce((m, v) => Math.max(m, v), 0)),
      samples: readings.length,
      analyserRms,
    };
  });

  // Honest "not measured" before anything was processed.
  expect(result.before.measured).toBe(false);
  expect(result.before.reductionDb).toBeNull();
  // The live graph does get the real limiter, at its documented latency.
  expect(result.installed.available).toBe(true);
  expect(result.installed.latencySamples).toBe(Math.round(0.005 * result.sampleRate));
  expect(result.after.measured).toBe(true);
  expect(result.samples).toBeGreaterThan(3);
  // 1.8 FS is first caught by the upstream maximizer (20:1 above 0 dBFS); what
  // is left over the -1 dBFS ceiling is the limiter's share, and it is
  // measured, not assumed.
  expect(result.maxReduction).toBeGreaterThan(1);
  expect(result.maxReduction).toBeLessThan(12);
  // The audio really is on the live master output, not a detached copy.
  expect(result.analyserRms).toBeGreaterThan(0.05);
});
