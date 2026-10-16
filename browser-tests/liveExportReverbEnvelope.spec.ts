import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

/**
 * Live ↔ export reverb-tail energy envelope — real Chromium `ConvolverNode`.
 *
 * The Node harness (web-audio-engine) cannot check reverb: its `ConvolverNode`
 * is a pass-through, so no tail is ever convolved. This spec runs in a real
 * browser, where the convolver is real.
 *
 * Both paths carry the same deterministic source: a seeded 20 ms broadband
 * noise burst played as an audio clip on mixer track 1 with a reverb insert
 * (mix 1.0). Broadband input makes the rendered tail follow the impulse
 * response's energy envelope, so the comparison measures the impulse's decay
 * rather than the source's pitch content.
 *
 *   • LIVE   — the live FX chain built with `updateMixerTrack` /
 *              `syncMixerRouting` on an `OfflineAudioContext`, driven through
 *              `triggerCurrentStep`. The live reverb impulse is `createImpulse`
 *              (Math.random), so each live seed gives a different impulse.
 *              Math.random is stubbed with a seeded PRNG during the build only,
 *              and restored in `finally`.
 *   • EXPORT — the production `renderTimelineOffline`, whose reverb impulse is
 *              seeded inside the engine (`buildReverbImpulse`, seed 0x10a4eb).
 *
 * ── Fidelity limits ───────────────────────────────────────────────────────
 * - NOT REALTIME. The live reference is a simulation on an OfflineAudioContext.
 *   It does not exercise the transport clock, the `onStep` scheduler, or a
 *   realtime AudioContext; it is not evidence of hardware real-time parity.
 * - The two paths draw different impulse realisations by design (live is
 *   random, export is seeded), so the test never compares samples across
 *   paths. It compares 100 ms energy windows in dB.
 *
 * ── Tolerance (measured, not assumed) ─────────────────────────────────────
 * Window rule: a 100 ms window is compared when EITHER path is above -60 dB.
 * Measured in Chromium with this fixture:
 *   - live vs export, seeds 1–5 (this spec): max 0.32–0.71 dB, mean 0.11–0.15 dB;
 *   - live vs live over 10 seeds (45 pairs, earlier probe, one-sided window
 *     rule): max 0.50 dB, mean ≤ 0.17 dB; the 5 seeds above are identical
 *     under the spec's rule;
 *   - export seeded vs export unseeded: 0 dB (the export is deterministic).
 * Sensitivity to a decay mismatch (export decay vs live seed 1, same rule):
 *   2.05 → 0.82 / 0.29 dB;  2.10 → 1.38 / 0.48;  2.15 → 1.94 / 0.67;
 *   2.20 → 2.51 / 0.86;  2.50 → 5.92 / 2.01;  3.00 → 11.69 / 4.01  (max / mean).
 * MAX_WINDOW_DEVIATION_DB = 1.5 is about 2× the worst measured noise (0.71);
 * MEAN_WINDOW_DEVIATION_DB = 0.5 is about 3× the worst measured mean (0.15).
 * A decay mismatch is flagged from about 2.15 upward. A 2.10 mismatch is
 * borderline (max 1.38, mean 0.48) and is not reliably flagged. The 2.5
 * control in the second test is flagged on both bounds.
 */

const MAX_WINDOW_DEVIATION_DB = 1.5;
const MEAN_WINDOW_DEVIATION_DB = 0.5;
const LIVE_SEEDS = [1, 2, 3, 4, 5];
const MISMATCH_DECAY = 2.5;

type EnvelopeCompare = { max: number; mean: number; n: number };
type Measurement = {
  liveVsExport: Array<{ seed: number } & EnvelopeCompare>;
  exportPeakDb: number;
  exportWindows: number;
  mismatchVsLive1: EnvelopeCompare;
};

async function measureEnvelopes(page: import('@playwright/test').Page, mismatchDecay: number): Promise<Measurement> {
  return await page.evaluate(async ({ liveSeeds, mismatchDecay }) => {
    // @ts-ignore — browser-side import of a Vite-served module (same convention as realOfflineRender.spec.ts)
    const mod: any = await import('/src/audio/audioEngine.ts');
    // @ts-ignore — browser-side import of a Vite-served module (same convention as realOfflineRender.spec.ts)
    const ms: any = await import('/src/audio/masteringState.ts');
    // @ts-ignore — browser-side import of a Vite-served module (same convention as realOfflineRender.spec.ts)
    const mp: any = await import('/src/audio/masteringProcessor.ts');
    const e: any = mod.audioEngine;
    const SR = 44100;
    const FRAMES = Math.ceil(SR * 4);
    const SECONDS_PER_STEP = 60 / 120 / 4;
    const TOTAL_STEPS = Math.ceil(4 / SECONDS_PER_STEP);
    e.setMasteringState({ ...ms.DEFAULT_MASTERING_SUITE_STATE, enabled: false });

    const mulberry = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    // Same deterministic 20 ms broadband burst on both paths.
    const burstLen = Math.round(SR * 0.02);
    const burstData = new Float32Array(burstLen);
    const burstRng = mulberry(7);
    for (let i = 0; i < burstLen; i += 1) burstData[i] = (burstRng() * 2 - 1) * 0.5;
    const burst = new AudioBuffer({ length: burstLen, sampleRate: SR, numberOfChannels: 1 });
    burst.copyToChannel(burstData, 0);
    e.sampleBuffers = new Map([['burst', burst]]);

    const clip: any = {
      id: 'burst-clip', trackIndex: 0, startBar: 0, lengthBars: 2, type: 'audio',
      audioBufferId: 'burst', color: '#10b981', name: 'Burst', mute: false,
    };
    const master = { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 };
    const tracks = (fxSlots: any[]) => [master, { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, fxSlots, peakL: 0, peakR: 0 }];
    const reverb = [{ id: 'fx-verb', type: 'reverb', name: 'Reverb', enabled: true, mix: 1.0, params: {} }];

    /** LIVE reference — mirrors the export's setup block (see audioEngine.renderTimelineOffline). */
    const renderLive = (seed: number): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext(2, FRAMES, SR);
      const mixerTracks = tracks(reverb);
      e.ctx = ctx;
      e.liveCtx = ctx;
      e.isOfflineRendering = false;
      e.offlineRenderLeaseHeld = false;
      e.offlineRenderOperationDepth = 0;
      e.masterGain = ctx.createGain();
      e.grossBeatNode = ctx.createGain();
      e.masterAnalyser = ctx.createAnalyser();
      e.masteringProcessor = new mp.MasteringProcessor(ctx, e.masteringState);
      e.masterGain.connect(e.grossBeatNode);
      e.grossBeatNode.connect(e.masteringProcessor.input);
      e.masteringProcessor.output.connect(e.masterAnalyser);
      e.masterAnalyser.connect(ctx.destination);
      e.mixerChannels = new Map();
      e.channelPanners = new Map();
      e.mixerRoutingAdapter = null;
      e.mixerRoutingChannelMap = null;
      e.impulseResponses = new Map();
      e.__fxSlotEffectMaps = new Map();
      e.activeVoices = new Map();
      e.activeVoiceChannelVolumes = new Map();
      e.activeDrumPadVoices = new Map();
      e.activeClipSources = new Set();
      e.activeClipSourceLanes = new Map();
      e.activeClipSourceChannels = new Map();
      e.activeClipChannelVolumes = new Map();
      e.activeChannels = [];
      e.activeClips = structuredClone([clip]);
      e.refreshInaudibleTakeClipIds();
      e.playbackProjectChannels = [];
      e.playbackProjectMixerTracks = structuredClone(mixerTracks);
      e.activeMixerTracks = structuredClone(mixerTracks);
      e.activePlayMode = 'song';
      e.activePatternId = undefined;
      e.activePatternLengthSteps = undefined;
      e.playlistLaneMutes = new Set();
      e.isPlaying = true;
      e.currentStep = 0;
      e.currentBar = 1;
      e.bpm = 120;
      e.metronome = false;

      const realRandom = Math.random;
      Math.random = mulberry(seed);
      try {
        e.updateMixerTrack(mixerTracks[0]);
        e.updateMixerTrack(mixerTracks[1]);
        e.syncMixerRouting(mixerTracks);
      } finally {
        Math.random = realRandom;
      }
      for (let s = 0; s < TOTAL_STEPS; s += 1) {
        e.currentStep = s % e.currentStepsPerBar;
        e.currentBar = Math.floor(s / e.currentStepsPerBar) + 1;
        e.triggerCurrentStep(s * SECONDS_PER_STEP);
      }
      return ctx.startRendering().then((b: AudioBuffer) => b.getChannelData(0).slice());
    };

    /** EXPORT — the production path. `decayOverride` only instruments the engine's own impulse builder for the control render. */
    const originalBuild = e.buildReverbImpulse;
    let decayOverride: number | undefined;
    e.buildReverbImpulse = function (duration: number, decay: number, options: any) {
      return originalBuild.call(this, duration, decayOverride ?? decay, options);
    };
    const renderExport = async (decay?: number): Promise<Float32Array> => {
      decayOverride = decay;
      try {
        const buffer: AudioBuffer = await e.renderTimelineOffline([], [clip], tracks(reverb), 120, 2, SR, true, 'song', undefined, undefined, 4);
        return buffer.getChannelData(0).slice();
      } finally {
        decayOverride = undefined;
      }
    };

    const WINDOW = Math.round(SR * 0.1);
    const toWindowDb = (x: Float32Array): number[] => {
      const out: number[] = [];
      for (let w = 0; w + WINDOW <= x.length; w += WINDOW) {
        let sum = 0;
        for (let i = w; i < w + WINDOW; i += 1) sum += x[i] * x[i];
        out.push(10 * Math.log10(sum / WINDOW + 1e-30));
      }
      return out;
    };
    /**
     * Compare windows where EITHER path is above -60 dB. Symmetric on purpose:
     * a tail that ends early or runs long is audible on one side only, and a
     * reference-only floor would skip exactly that window.
     */
    const FLOOR_DB = -60;
    const compare = (candidate: number[], reference: number[]) => {
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < reference.length; i += 1) {
        if (Math.max(candidate[i], reference[i]) < FLOOR_DB) continue;
        const d = Math.abs(candidate[i] - reference[i]);
        max = Math.max(max, d);
        sum += d;
        n += 1;
      }
      return { max: Number(max.toFixed(3)), mean: Number((sum / Math.max(1, n)).toFixed(3)), n };
    };

    const exportDb = toWindowDb(await renderExport());
    const liveVsExport: Array<{ seed: number } & EnvelopeCompare> = [];
    let live1Db: number[] = [];
    for (const seed of liveSeeds) {
      const liveDb = toWindowDb(await renderLive(seed));
      if (seed === liveSeeds[0]) live1Db = liveDb;
      liveVsExport.push({ seed, ...compare(liveDb, exportDb) });
    }
    const mismatchDb = toWindowDb(await renderExport(mismatchDecay));
    return {
      liveVsExport,
      exportPeakDb: Number(Math.max(...exportDb).toFixed(2)),
      exportWindows: exportDb.filter(v => v >= FLOOR_DB).length,
      mismatchVsLive1: compare(live1Db, mismatchDb),
    };
  }, { liveSeeds: LIVE_SEEDS, mismatchDecay });
}

test.describe('Live ↔ export reverb tail energy envelope (real Chromium ConvolverNode)', () => {
  test.setTimeout(180_000);

  test('live and export reverb tails agree within the envelope tolerance for every live impulse seed', async ({ page }, testInfo) => {
    await page.goto(APP_URL);
    const m = await measureEnvelopes(page, MISMATCH_DECAY);
    testInfo.annotations.push({ type: 'envelope-measurement', description: JSON.stringify(m) });

    // Guard against a vacuous pass: the tail must be audible and must cover enough windows.
    expect(m.exportPeakDb, 'export reverb tail must be audible').toBeGreaterThan(-40);
    expect(m.exportWindows, 'enough energy windows above the floor to compare').toBeGreaterThanOrEqual(10);

    for (const row of m.liveVsExport) {
      expect(row.n, `seed ${row.seed}: windows compared`).toBeGreaterThanOrEqual(10);
      expect(row.max, `seed ${row.seed}: max window deviation (dB)`).toBeLessThanOrEqual(MAX_WINDOW_DEVIATION_DB);
      expect(row.mean, `seed ${row.seed}: mean window deviation (dB)`).toBeLessThanOrEqual(MEAN_WINDOW_DEVIATION_DB);
    }
  });

  test(`a ${MISMATCH_DECAY} export decay (control) is flagged by the same tolerance`, async ({ page }) => {
    await page.goto(APP_URL);
    const m = await measureEnvelopes(page, MISMATCH_DECAY);

    // The control must be outside tolerance on both bounds. If it ever falls
    // inside, the envelope check has lost its sensitivity to decay mismatch.
    expect(m.mismatchVsLive1.max, 'control max deviation (dB) must exceed the tolerance').toBeGreaterThan(MAX_WINDOW_DEVIATION_DB);
    expect(m.mismatchVsLive1.mean, 'control mean deviation (dB) must exceed the tolerance').toBeGreaterThan(MEAN_WINDOW_DEVIATION_DB);
  });
});
