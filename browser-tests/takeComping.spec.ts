import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

/**
 * Phase 10A — phrase-level take comping, proven with real Web Audio.
 *
 * Every number below comes out of the production render path
 * (`audioEngine.renderTimelineOffline` — the same call WAV export, stems and
 * bounce-in-place use) or out of a real live `AudioContext` playing through the
 * engine's own scheduler. Nothing here mocks scheduling, fades or buffers:
 *
 *   - take A is a 220 Hz tone, take B is a 880 Hz tone, both registered as real
 *     `AudioBuffer` assets through the engine's own sample store;
 *   - the comp is a persisted region list, exactly the shape the editor writes;
 *   - the exported PCM is measured with a Goertzel probe per phrase, so "the
 *     phrase really plays the take it names" is a measurement, not an assumption;
 *   - the boundary is measured as a genuine equal-power blend: both tones are
 *     present at the seam at ~0.707 of their steady amplitude, the summed power
 *     stays flat (a linear crossfade would dip 3 dB, a hard cut leaves one tone
 *     only), and no sample-to-sample discontinuity appears.
 */

const installFixture = async (page: import('@playwright/test').Page) => {
  await page.addScriptTag({
    type: 'module',
    content: `
      window.__compFixture = (async () => {
        const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
        const { DEFAULT_MASTERING_SUITE_STATE } = await import('/src/audio/masteringState.ts' /* @ts-ignore */);
        const { applyCompRegionsToClips, resolveTakeCompPlan } = await import('/src/audio/takeCompRegions.ts');
        const { createDefaultProjectState } = await import('/src/state/projectState.ts');
        const { audioBufferToWav } = await import('/src/audio/wavEncoder.ts');

        const SR = 48000;
        const SECONDS_PER_BAR = (bpm, meter) => (meter[0] * 60) / bpm;

        /** A stereo asset: silence, then a tone with an optional timed burst. */
        const makeAsset = (ctx, spec) => {
          const length = Math.floor(ctx.sampleRate * spec.seconds);
          const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
          const left = buffer.getChannelData(0);
          const right = buffer.getChannelData(1);
          const amplitude = spec.amplitude ?? 0.5;
          if (spec.frequency) {
            const from = Math.floor((spec.fromSeconds ?? 0) * ctx.sampleRate);
            for (let i = from; i < length; i += 1) {
              const value = amplitude * Math.sin((2 * Math.PI * spec.frequency * (i - from)) / ctx.sampleRate);
              left[i] = value;
              right[i] = value;
            }
          }
          for (const burst of spec.bursts ?? []) {
            const from = Math.floor(burst.fromSeconds * ctx.sampleRate);
            const to = Math.min(length, Math.floor(burst.toSeconds * ctx.sampleRate));
            for (let i = from; i < to; i += 1) {
              const value = (burst.amplitude ?? amplitude) * Math.sin((2 * Math.PI * burst.frequency * (i - from)) / ctx.sampleRate);
              left[i] = value;
              right[i] = value;
            }
          }
          return buffer;
        };

        const clip = (overrides) => ({
          trackIndex: 0,
          startBar: 0,
          lengthBars: 4,
          type: 'audio',
          color: '#00e5ff',
          name: 'Take',
          audioBufferId: 'buf',
          ...overrides,
        });

        /** Two real takes over the same 4-bar region, plus the comp under test. */
        const makeGroup = (regions, overrides = {}) => {
          const clips = [
            clip({ id: 'take-a', name: 'Take A', audioBufferId: 'buf-a', takeGroupId: 'grp', takeIndex: 0, activeTakeIndex: 0 }),
            clip({ id: 'take-b', name: 'Take B', audioBufferId: 'buf-b', takeGroupId: 'grp', takeIndex: 1, activeTakeIndex: 0 }),
          ];
          const patched = clips.map(candidate => ({ ...candidate, ...(overrides[candidate.id] ?? {}) }));
          return regions === null ? patched : applyCompRegionsToClips(patched, 'grp', regions);
        };

        const TWO_PHRASES = [
          { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.1 },
          { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 1, crossfadeBars: 0 },
        ];

        const registerDefaults = (ctx) => {
          const takeA = makeAsset(ctx, { seconds: 40, frequency: 220, amplitude: 0.5 });
          const takeB = makeAsset(ctx, { seconds: 40, frequency: 880, amplitude: 0.5 });
          e.setSampleBuffer('buf-a', takeA);
          e.setSampleBuffer('buf-b', takeB);
          return { takeA, takeB };
        };

        /** The production export path, with mastering bypassed so the PCM is the comp alone. */
        const render = async (clips, options = {}) => {
          const bpm = options.bpm ?? 120;
          const meter = options.meter ?? [4, 4];
          const totalBars = options.totalBars ?? 4;
          e.setTimeSignature(meter);
          e.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
          const minimum = totalBars * SECONDS_PER_BAR(bpm, meter);
          const buffer = await e.renderTimelineOffline(
            [], clips, [], bpm, totalBars, SR, false, 'song', undefined, undefined, undefined, minimum,
          );
          return buffer;
        };

        /** Goertzel amplitude estimate for one frequency inside a time window. */
        const probe = (data, frequency, sampleRate, fromSeconds, toSeconds) => {
          const start = Math.max(0, Math.floor(fromSeconds * sampleRate));
          const end = Math.min(data.length, Math.floor(toSeconds * sampleRate));
          if (end - start < 32) return 0;
          const omega = (2 * Math.PI * frequency) / sampleRate;
          const coefficient = 2 * Math.cos(omega);
          let s1 = 0;
          let s2 = 0;
          for (let i = start; i < end; i += 1) {
            const s0 = data[i] + coefficient * s1 - s2;
            s2 = s1;
            s1 = s0;
          }
          const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
          return (2 * Math.sqrt(Math.max(0, power))) / (end - start);
        };

        const rms = (data, sampleRate, fromSeconds, toSeconds) => {
          const start = Math.max(0, Math.floor(fromSeconds * sampleRate));
          const end = Math.min(data.length, Math.floor(toSeconds * sampleRate));
          let sum = 0;
          for (let i = start; i < end; i += 1) sum += data[i] * data[i];
          return Math.sqrt(sum / Math.max(1, end - start));
        };

        const maxStep = (data, fromSeconds, toSeconds, sampleRate) => {
          const start = Math.max(1, Math.floor(fromSeconds * sampleRate));
          const end = Math.min(data.length, Math.floor(toSeconds * sampleRate));
          let max = 0;
          for (let i = start; i < end; i += 1) max = Math.max(max, Math.abs(data[i] - data[i - 1]));
          return max;
        };

        const spectrum = (buffer, fromSeconds, toSeconds) => {
          const left = buffer.getChannelData(0);
          return {
            a220: probe(left, 220, buffer.sampleRate, fromSeconds, toSeconds),
            b880: probe(left, 880, buffer.sampleRate, fromSeconds, toSeconds),
          };
        };

        e.init();
        registerDefaults(e.getContext());

        return {
          engine: e,
          SR,
          SECONDS_PER_BAR,
          makeAsset,
          makeGroup,
          TWO_PHRASES,
          registerDefaults,
          render,
          probe,
          rms,
          maxStep,
          spectrum,
          resolveTakeCompPlan,
          applyCompRegionsToClips,
          createDefaultProjectState,
          audioBufferToWav,
        };
      })();
    `,
  });
  await page.waitForFunction(() => Boolean((window as unknown as { __compFixture?: unknown }).__compFixture));
};

const openPage = async (page: import('@playwright/test').Page) => {
  await page.goto(APP_URL);
  await page.waitForLoadState('domcontentloaded');
  await installFixture(page);
};

test.describe('Phase 10A — phrase-level take comping', () => {
  test('the exported WAV plays take A then take B, in the bars the comp names', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const f = (window as any).__compFixture;
      const fixture = await f;
      const clips = fixture.makeGroup(fixture.TWO_PHRASES);
      const plan = fixture.resolveTakeCompPlan({ clips, takeGroupId: 'grp' });
      const rendered = await fixture.render(clips);
      const left = rendered.getChannelData(0);
      return {
        duration: rendered.duration,
        sampleRate: rendered.sampleRate,
        planSegments: plan.segments.map((segment: any) => [segment.takeClipId, segment.startBar, segment.endBar]),
        phraseOne: fixture.spectrum(rendered, 0.5, 1.5),
        phraseTwo: fixture.spectrum(rendered, 4.5, 5.5),
        earlyTail: fixture.spectrum(rendered, 3.2, 3.6),
        peak: left.reduce((max: number, value: number) => Math.max(max, Math.abs(value)), 0),
      };
    });

    // Exactly the comp the model describes, in timeline order.
    // Phrase 1 runs into the first half of the 0.1-bar blend (group bar 2.05);
    // phrase 2 starts in the second half (bar 1.95) and owns the rest.
    expect(result.planSegments).toEqual([
      ['take-a', 0, 2.05],
      ['take-b', 1.95, 4],
    ]);
    // 4 bars at 120 BPM 4/4 = 8 s, with no preroll (mastering bypassed).
    expect(result.duration).toBeCloseTo(8, 2);
    // Phrase 1 is take A (220 Hz) with no trace of take B.
    expect(result.phraseOne.a220).toBeGreaterThan(0.35);
    expect(result.phraseOne.b880).toBeLessThan(0.02);
    // Phrase 2 is take B (880 Hz) with no trace of take A.
    expect(result.phraseTwo.b880).toBeGreaterThan(0.35);
    expect(result.phraseTwo.a220).toBeLessThan(0.02);
    // Before the boundary the arrangement is still take A.
    expect(result.earlyTail.a220).toBeGreaterThan(0.35);
    expect(result.earlyTail.b880).toBeLessThan(0.02);
    expect(result.peak).toBeGreaterThan(0.3);
    expect(result.peak).toBeLessThan(0.75);
  });

  test('the phrase boundary is a real equal-power crossfade, not a cut or a doubled overlap', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const fixture = await (window as any).__compFixture;
      const rendered = await fixture.render(fixture.makeGroup(fixture.TWO_PHRASES));
      const left = rendered.getChannelData(0);
      const sr = rendered.sampleRate;
      // Crossfade = 0.1 bar = 0.2 s, centred on the bar-2 boundary at 4.0 s.
      return {
        sampleRate: sr,
        before: fixture.spectrum(rendered, 3.6, 3.85),
        seamStart: fixture.spectrum(rendered, 3.9, 4.0),
        seam: fixture.spectrum(rendered, 3.95, 4.05),
        seamEnd: fixture.spectrum(rendered, 4.0, 4.1),
        after: fixture.spectrum(rendered, 4.15, 4.4),
        steadyRms: (fixture.rms(left, sr, 3.0, 3.8) + fixture.rms(left, sr, 4.3, 5.0)) / 2,
        seamRms: fixture.rms(left, sr, 3.9, 4.1),
        steadyStep: Math.max(fixture.maxStep(left, 3.0, 3.8, sr), fixture.maxStep(left, 4.3, 5.0, sr)),
        seamStep: fixture.maxStep(left, 3.7, 4.3, sr),
      };
    });

    // Both takes are audible *inside* the blend ...
    expect(result.seam.a220).toBeGreaterThan(0.15);
    expect(result.seam.b880).toBeGreaterThan(0.15);
    // ... and each side is already partly present before/after the midpoint,
    // which a hard cut can never produce.
    expect(result.seamStart.b880).toBeGreaterThan(0.05);
    expect(result.seamEnd.a220).toBeGreaterThan(0.05);
    // Outside the window only one take sounds again.
    expect(result.before.b880).toBeLessThan(0.03);
    expect(result.after.a220).toBeLessThan(0.03);
    // Equal power, not equal amplitude: the summed level at the seam stays
    // within ~1.5 dB of either side (a linear blend would drop ~3 dB, and two
    // full-level takes summed would rise ~3 dB).
    const ratio = result.seamRms / result.steadyRms;
    expect(ratio).toBeGreaterThan(0.84);
    expect(ratio).toBeLessThan(1.2);
    // No click: the sample-to-sample step through the seam never exceeds the
    // steady material's own maximum step by a meaningful margin.
    expect(result.seamStep).toBeLessThan(result.steadyStep * 1.6 + 0.01);
  });

  test('source offsets and trims map into the rendered timeline', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const fixture = await (window as any).__compFixture;
      const ctx = fixture.engine.getContext();
      // Take B = a 660 Hz burst at 7.0-7.5 s of its own material, silence elsewhere.
      // Take material and the group share a timeline, so untrimmed the burst is heard
      // at 7.0-7.5 s; trimming the take by one bar moves the material one bar earlier
      // and the burst lands at 5.0-5.5 s.
      fixture.engine.setSampleBuffer('buf-b', fixture.makeAsset(ctx, {
        seconds: 40,
        amplitude: 0.4,
        bursts: [{ fromSeconds: 7.0, toSeconds: 7.5, frequency: 660 }],
      }));
      const regions = [
        { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0 },
        { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 1, crossfadeBars: 0 },
      ];
      const plain = await fixture.render(fixture.makeGroup(regions));
      // Trim take B by one bar (16 steps at 4/4): its material now starts one bar later.
      const trimmed = await fixture.render(fixture.makeGroup(regions, { 'take-b': { offsetSteps: 16 } }));
      const probeAt = (buffer: any, from: number, to: number) => ({
        burst: fixture.probe(buffer.getChannelData(0), 660, buffer.sampleRate, from, to),
        other: fixture.probe(buffer.getChannelData(0), 880, buffer.sampleRate, from, to),
      });
      return {
        plainEarly: probeAt(plain, 5.0, 5.5),
        plainLate: probeAt(plain, 7.0, 7.5),
        trimmedEarly: probeAt(trimmed, 5.0, 5.5),
        trimmedLate: probeAt(trimmed, 7.0, 7.5),
      };
    });

    // Untrimmed: phrase 2 reads take B time-aligned, so the burst stays at 7.0-7.5 s.
    expect(result.plainLate.burst).toBeGreaterThan(0.25);
    expect(result.plainEarly.burst).toBeLessThan(0.05);
    // Trimmed by one bar: the take's material starts one bar later, so the same
    // burst is reached one bar earlier in the arrangement, at 5.0-5.5 s.
    expect(result.trimmedEarly.burst).toBeGreaterThan(0.25);
    expect(result.trimmedLate.burst).toBeLessThan(0.05);
    // Nothing leaks through from the other take in either case.
    expect(result.plainLate.other).toBeLessThan(0.05);
    expect(result.trimmedEarly.other).toBeLessThan(0.05);
  });

  test('the same comp keeps its musical timing at another BPM and in 3/4', async ({ page }) => {
    test.setTimeout(180_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const fixture = await (window as any).__compFixture;
      const clips = fixture.makeGroup(fixture.TWO_PHRASES);
      const slow = await fixture.render(clips, { bpm: 90 });
      // 2 bars of 4/4 at 90 BPM = 5.333 s.
      const waltz = await fixture.render(clips, { meter: [3, 4], totalBars: 8 });
      // 2 bars of 3/4 at 120 BPM = 3.0 s.
      return {
        slowBoundaryBefore: fixture.spectrum(slow, 5.0, 5.2),
        slowBoundaryAfter: fixture.spectrum(slow, 5.5, 5.8),
        waltzBoundaryBefore: fixture.spectrum(waltz, 2.6, 2.9),
        waltzBoundaryAfter: fixture.spectrum(waltz, 3.1, 3.4),
        slowDuration: slow.duration,
        waltzDuration: waltz.duration,
      };
    });

    expect(result.slowDuration).toBeCloseTo((4 * 4 * 60) / 90, 1);
    expect(result.slowBoundaryBefore.a220).toBeGreaterThan(0.35);
    expect(result.slowBoundaryBefore.b880).toBeLessThan(0.05);
    expect(result.slowBoundaryAfter.b880).toBeGreaterThan(0.35);
    expect(result.slowBoundaryAfter.a220).toBeLessThan(0.05);

    // 8 bars of 3/4 at 120 BPM = 12 s; the bar-2 boundary is at 3 s, an eighth
    // of the way into a 4/4 arrangement.
    expect(result.waltzDuration).toBeCloseTo(12, 1);
    expect(result.waltzBoundaryBefore.b880).toBeLessThan(0.05);
    expect(result.waltzBoundaryAfter.b880).toBeGreaterThan(0.35);
    expect(result.waltzBoundaryAfter.a220).toBeLessThan(0.05);
  });

  test('changing a phrase’s take changes the rendered audio', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const fixture = await (window as any).__compFixture;
      const allA = await fixture.render(fixture.makeGroup([
        { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.1 },
        { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 0, crossfadeBars: 0 },
      ]));
      const allB = await fixture.render(fixture.makeGroup([
        { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 1, crossfadeBars: 0.1 },
        { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 1, crossfadeBars: 0 },
      ]));
      const swapped = await fixture.render(fixture.makeGroup([
        { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 1, crossfadeBars: 0.1 },
        { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 0, crossfadeBars: 0 },
      ]));
      const differ = (a: any, b: any) => {
        const leftA = a.getChannelData(0);
        const leftB = b.getChannelData(0);
        let max = 0;
        for (let i = 0; i < Math.min(leftA.length, leftB.length); i += 1) {
          max = Math.max(max, Math.abs(leftA[i] - leftB[i]));
        }
        return max;
      };
      return {
        allAFirst: fixture.spectrum(allA, 0.5, 1.5),
        allASecond: fixture.spectrum(allA, 4.5, 5.5),
        allBFirst: fixture.spectrum(allB, 0.5, 1.5),
        allBSecond: fixture.spectrum(allB, 4.5, 5.5),
        swappedFirst: fixture.spectrum(swapped, 0.5, 1.5),
        swappedSecond: fixture.spectrum(swapped, 4.5, 5.5),
        diffAllAAllB: differ(allA, allB),
        diffAllASwapped: differ(allA, swapped),
      };
    });

    expect(result.allAFirst.a220).toBeGreaterThan(0.35);
    expect(result.allASecond.a220).toBeGreaterThan(0.35);
    expect(result.allBFirst.b880).toBeGreaterThan(0.35);
    expect(result.allBSecond.b880).toBeGreaterThan(0.35);
    expect(result.swappedFirst.b880).toBeGreaterThan(0.35);
    expect(result.swappedSecond.a220).toBeGreaterThan(0.35);
    expect(result.diffAllAAllB).toBeGreaterThan(0.3);
    expect(result.diffAllASwapped).toBeGreaterThan(0.3);
  });

  test('live playback schedules exactly the phrases the export renders', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const fixture = await (window as any).__compFixture;
      // @ts-ignore - resolved by the Vite dev server
      const fixtureModule: any = await import('/src/audio/masteringState.ts');
      const DEFAULT_MASTERING_SUITE_STATE_FOR_LIVE = fixtureModule.DEFAULT_MASTERING_SUITE_STATE;
      const engine = fixture.engine;
      const ctx = engine.getContext();
      await ctx.resume();
      engine.setTimeSignature([4, 4]);
      // The live scheduler reads the engine's own tempo; the export below uses
      // the project tempo. Both are 120 BPM here, so the phrases must match.
      engine.setBpm(120);
      engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE_FOR_LIVE, enabled: false });
      fixture.registerDefaults(ctx);
      const clips = fixture.makeGroup(fixture.TWO_PHRASES);

      // Observe the real scheduler: every BufferSource the engine starts is a
      // real node in a real AudioContext. We only record what it was asked to play.
      const calls: Array<{ when: number; offset: number; duration: number; peak: number; length: number }> = [];
      const originalStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function start(when?: number, offset?: number, duration?: number) {
        const buffer = (this as AudioBufferSourceNode).buffer;
        if (buffer) {
          calls.push({
            when: when ?? 0,
            offset: offset ?? 0,
            duration: duration ?? buffer.duration,
            peak: buffer.getChannelData(0)[Math.floor(buffer.length / 2)],
            length: buffer.length,
          });
        }
        return originalStart.call(this, when as number, offset as number, duration as number);
      } as typeof AudioBufferSourceNode.prototype.start;

      try {
        engine.play([], clips, 'song', undefined, [], undefined, []);
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        engine.stop();
      } finally {
        AudioBufferSourceNode.prototype.start = originalStart;
      }

      // The two take sources: 220 Hz material peaks at ~±0.5 on a sine sample,
      // 880 Hz peaks at whatever sample the probe lands on; identify by length +
      // duration instead and report both so the test stays honest.
      const takeSources = calls
        .filter(call => call.duration > 3.5 && call.duration < 4.5)
        .sort((a, b) => a.when - b.when);
      const origin = takeSources.length > 0 ? takeSources[0].when : 0;
      return {
        sampleRate: ctx.sampleRate,
        secondsPerBar: fixture.SECONDS_PER_BAR(120, [4, 4]),
        totalSources: calls.length,
        takeSources: takeSources.map(call => ({
          relativeWhen: Number((call.when - origin).toFixed(3)),
          offset: Number(call.offset.toFixed(3)),
          duration: Number(call.duration.toFixed(3)),
          probe: Number(call.peak.toFixed(3)),
        })),
      };
    });

    // Two phrases, two sources, each exactly one phrase long.
    expect(result.takeSources.length).toBe(2);
    const [first, second] = result.takeSources;
    // One phrase is 2 bars plus its half of the 0.1-bar blend.
    expect(first.duration).toBeCloseTo(2 * result.secondsPerBar + 0.1, 1);
    expect(second.duration).toBeCloseTo(2 * result.secondsPerBar + 0.1, 1);
    // Phrase 2 starts half a blend before the bar-2 downbeat and reads take B
    // from the matching point in its own material.
    expect(second.relativeWhen).toBeCloseTo(2 * result.secondsPerBar - 0.1, 1);
    expect(second.offset).toBeCloseTo(2 * result.secondsPerBar - 0.1, 1);
    expect(first.offset).toBeCloseTo(0, 3);
  });

  test('a missing take is silent and never corrupts the rest of the comp', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page);
    const result = await page.evaluate(async () => {
      const fixture = (window as any).__compFixture;
      const f = await fixture;
      const clips = f.makeGroup([
        { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0 },
        { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 9, crossfadeBars: 0 },
      ]);
      const plan = f.resolveTakeCompPlan({ clips, takeGroupId: 'grp' });
      const rendered = await f.render(clips);

      const unavailable = f.makeGroup([
        { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0 },
        { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 1, crossfadeBars: 0 },
      ], { 'take-b': { audioUnavailable: true } });
      let exportError = '';
      try {
        await f.render(unavailable);
      } catch (error) {
        exportError = String((error as Error).message ?? error);
      }
      return {
        segments: plan.segments.map((segment: any) => [segment.takeIndex, segment.startBar, segment.endBar]),
        issues: plan.issues.map((issue: any) => issue.code),
        phraseOne: f.spectrum(rendered, 0.5, 1.5),
        phraseTwo: f.spectrum(rendered, 4.5, 5.5),
        exportError,
      };
    });

    expect(result.segments).toEqual([[0, 0, 2]]);
    expect(result.issues).toContain('missing-take');
    // The good phrase still plays; the missing one is silence, not the wrong take.
    expect(result.phraseOne.a220).toBeGreaterThan(0.35);
    expect(result.phraseTwo.a220).toBeLessThan(0.02);
    expect(result.phraseTwo.b880).toBeLessThan(0.02);
    // An audible phrase whose asset could not be restored refuses to export
    // rather than rendering a misleading silent WAV.
    expect(result.exportError).toContain('unavailable');
  });

  test('save, cold reopen and re-render preserve the comp and its audio', async ({ page }) => {
    test.setTimeout(180_000);
    await openPage(page);
    const before = await page.evaluate(async () => {
      const f = await (window as any).__compFixture;
      // @ts-ignore - resolved by the Vite dev server
      const audioPersistence: any = await import('/src/audio/audioPersistence.ts');
      // @ts-ignore - resolved by the Vite dev server
      const persistence: any = await import('/src/state/projectPersistence.ts');
      const { persistAudioClip } = audioPersistence;
      const { saveAndReconcileProjectState } = persistence;
      const ctx = f.engine.getContext();
      const assets = f.registerDefaults(ctx);
      // Persist both takes the way the recorder does: real WAV blobs in the
      // app's own audio store, keyed by the ids the clips reference.
      await persistAudioClip('buf-a', f.audioBufferToWav(assets.takeA, 24));
      await persistAudioClip('buf-b', f.audioBufferToWav(assets.takeB, 24));
      const clips = f.makeGroup(f.TWO_PHRASES);
      const base = f.createDefaultProjectState();
      const state = { ...base, totalBars: 4, playlistClips: clips, playlistTracks: base.playlistTracks };
      await saveAndReconcileProjectState(state, { reconcileAudio: false });
      const rendered = await f.render(clips);
      return { first: f.spectrum(rendered, 0.5, 1.5), second: f.spectrum(rendered, 4.5, 5.5) };
    });
    expect(before.first.a220).toBeGreaterThan(0.35);
    expect(before.second.b880).toBeGreaterThan(0.35);

    // A genuinely cold page: new document, new AudioContext, no in-memory state.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await installFixture(page);
    const after = await page.evaluate(async () => {
      const f = await (window as any).__compFixture;
      // @ts-ignore - resolved by the Vite dev server
      const persistence: any = await import('/src/state/projectPersistence.ts');
      const { restorePersistedProjectState } = persistence;
      const restored = await restorePersistedProjectState(f.engine, f.createDefaultProjectState());
      const clips = restored.state.playlistClips;
      const rendered = await f.render(clips);
      return {
        restored: restored.restored,
        hydrated: restored.hydratedAudioIds,
        missing: restored.missingAudioIds,
        regions: clips[0]?.compRegions ?? null,
        regionsSameOnEveryClip: clips.every(
          (clip: any) => JSON.stringify(clip.compRegions) === JSON.stringify(clips[0].compRegions),
        ),
        unavailable: clips.filter((clip: any) => clip.audioUnavailable).length,
        first: f.spectrum(rendered, 0.5, 1.5),
        second: f.spectrum(rendered, 4.5, 5.5),
      };
    });

    expect(after.restored).toBe(true);
    expect(after.regions).toEqual([
      { id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.1 },
      { id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 1, crossfadeBars: 0 },
    ]);
    expect(after.regionsSameOnEveryClip).toBe(true);
    expect(after.hydrated).toEqual(expect.arrayContaining(['buf-a', 'buf-b']));
    expect(after.missing).toEqual([]);
    expect(after.unavailable).toBe(0);
    // The same phrases play the same takes from the restored project.
    expect(after.first.a220).toBeGreaterThan(0.35);
    expect(after.first.b880).toBeLessThan(0.03);
    expect(after.second.b880).toBeGreaterThan(0.35);
    expect(after.second.a220).toBeLessThan(0.03);
  });
});
