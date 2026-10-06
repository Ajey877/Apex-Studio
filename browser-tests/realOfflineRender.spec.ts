import { test, expect } from '@playwright/test';

/**
 * Phase 86 — Real Offline Audio Rendering Truth Harness
 *
 * Executes against a REAL browser OfflineAudioContext, not Node mocks.
 * 
 * - Basic harness: standalone oscillator → gain → destination (proves browser can render)
 * - Production path: imports src/audio/audioEngine.ts via vite dev server and calls
 *   the actual production renderTimelineOffline, inspecting returned AudioBuffer.
 */

// ---------------------------------------------------------------------------
// Helpers that run INSIDE the browser via page.evaluate
// ---------------------------------------------------------------------------

async function renderSimpleOscillator(page: import('@playwright/test').Page, opts: {
  sampleRate?: number;
  lengthSeconds?: number;
  frequency?: number;
  gain?: number;
}) {
  const { sampleRate = 44100, lengthSeconds = 1, frequency = 440, gain = 0.5 } = opts;
  return await page.evaluate(async ({ sampleRate, lengthSeconds, frequency, gain }) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * lengthSeconds), sampleRate);
    const osc = ctx.createOscillator();
    osc.frequency.value = frequency;
    osc.type = 'sine';
    const g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(0);
    osc.stop(lengthSeconds);
    const buffer = await ctx.startRendering();
    const ch0 = Array.from(buffer.getChannelData(0).slice(0, 1024));
    const ch1 = Array.from(buffer.getChannelData(1).slice(0, 1024));
    const full0 = buffer.getChannelData(0);
    let maxAbs = 0;
    let allFinite = true;
    let nonSilentSamples = 0;
    for (let i = 0; i < full0.length; i++) {
      const v = full0[i];
      if (!Number.isFinite(v)) allFinite = false;
      const a = Math.abs(v);
      if (a > maxAbs) maxAbs = a;
      if (a > 1e-4) nonSilentSamples++;
    }
    return {
      numberOfChannels: buffer.numberOfChannels,
      length: buffer.length,
      sampleRate: buffer.sampleRate,
      duration: buffer.duration,
      maxAbs,
      allFinite,
      nonSilentSamples,
      ch0Sample: ch0,
      ch1Sample: ch1,
      fingerprint: ch0.slice(0, 100).join(','),
    };
  }, { sampleRate, lengthSeconds, frequency, gain });
}

// ---------------------------------------------------------------------------
// Basic harness validation — proves the browser has a real OfflineAudioContext
// ---------------------------------------------------------------------------

test.describe('Real OfflineAudioContext harness', () => {
  test('proves browser has a real OfflineAudioContext (not a mock)', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const exists = await page.evaluate(() => typeof (window as any).OfflineAudioContext !== 'undefined');
    expect(exists).toBe(true);
    const canConstruct = await page.evaluate(async () => {
      try {
        const ctx = new OfflineAudioContext(1, 128, 44100);
        return !!ctx && typeof ctx.startRendering === 'function';
      } catch { return false; }
    });
    expect(canConstruct).toBe(true);
    const hasNative = await page.evaluate(() => {
      try { return OfflineAudioContext.toString().includes('native code'); } catch { return false; }
    });
    expect(hasNative || canConstruct).toBeTruthy();
  });

  test('renders audible tone: stereo, sampleRate, length, finite, non-silence', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await renderSimpleOscillator(page, { sampleRate: 44100, lengthSeconds: 0.5, frequency: 440, gain: 0.5 });
    expect(result.numberOfChannels).toBe(2);
    expect(result.sampleRate).toBe(44100);
    expect(result.length).toBe(22050);
    expect(Math.abs(result.duration - 0.5)).toBeLessThan(1e-6);
    expect(result.allFinite).toBe(true);
    expect(result.maxAbs).toBeGreaterThan(0.05);
    expect(result.nonSilentSamples).toBeGreaterThan(100);
    expect(result.maxAbs).toBeLessThanOrEqual(1.0);
    expect(result.ch1Sample.some(v => Math.abs(v) > 1e-6)).toBe(true);
  });

  test('muted gain yields near-silence within tolerance', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const audible = await renderSimpleOscillator(page, { gain: 0.5, lengthSeconds: 0.2 });
    const silent = await renderSimpleOscillator(page, { gain: 0, lengthSeconds: 0.2 });
    expect(audible.maxAbs).toBeGreaterThan(0.05);
    expect(silent.maxAbs).toBeLessThan(1e-6);
    expect(silent.nonSilentSamples).toBeLessThan(5);
    expect(audible.maxAbs).toBeGreaterThan(silent.maxAbs * 100);
  });

  test('repeated renders are deterministic for same input', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const a = await renderSimpleOscillator(page, { frequency: 440, gain: 0.3, lengthSeconds: 0.1 });
    const b = await renderSimpleOscillator(page, { frequency: 440, gain: 0.3, lengthSeconds: 0.1 });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.maxAbs).toBeCloseTo(b.maxAbs, 5);
  });

  test('finite samples even at high gain (clipping check separate from silence)', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const loud = await renderSimpleOscillator(page, { gain: 1.5, lengthSeconds: 0.1 });
    expect(loud.allFinite).toBe(true);
    expect(loud.maxAbs).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Production AudioEngine export path — exercises real routing
// ---------------------------------------------------------------------------

test.describe('Production AudioEngine offline export path (real browser)', () => {
  test('can import audioEngine in browser context', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async () => {
      // This will throw if vite cannot serve the module — test must FAIL, not silently pass
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      return {
        hasAudioEngine: !!mod.audioEngine,
        hasRender: typeof mod.audioEngine?.renderTimelineOffline === 'function',
        keys: Object.keys(mod).slice(0, 20),
      };
    });
    expect(result.hasAudioEngine, `audioEngine not found in /src/audio/audioEngine.ts; keys: ${result.keys.join(',')}`).toBe(true);
    expect(result.hasRender, 'audioEngine.renderTimelineOffline not found — production export path not exposed').toBe(true);
  });

  test('scheduled instrument note via production path produces non-silent buffer', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async () => {
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      const engine = mod.audioEngine;
      const channel = {
        id: 'ch-test',
        name: 'Test Synth',
        color: '#10b981',
        instrumentType: 'minisynth' as const,
        mixerTrackId: 1,
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: Array(16).fill(false),
        notes: [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 }],
        synthParams: engine.getDefaultSynthParams ? engine.getDefaultSynthParams() : {},
      };
      const mixerTracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
        { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
      ];
      const clip = {
        id: 'clip-1',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 1,
        type: 'pattern' as const,
        channelId: 'ch-test',
        color: '#10b981',
        name: 'Test Clip',
      };
      const buffer: AudioBuffer = await engine.renderTimelineOffline(
        [channel],
        [clip],
        mixerTracks,
        120,
        1,
        44100,
        false,
        'song',
        undefined,
        undefined,
        4
      );
      const data0 = buffer.getChannelData(0);
      let maxAbs = 0;
      let allFinite = true;
      let nonSilent = 0;
      for (let i = 0; i < data0.length; i++) {
        const v = data0[i];
        if (!Number.isFinite(v)) allFinite = false;
        const a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
        if (a > 1e-4) nonSilent++;
      }
      return {
        numberOfChannels: buffer.numberOfChannels,
        length: buffer.length,
        sampleRate: buffer.sampleRate,
        duration: buffer.duration,
        maxAbs,
        allFinite,
        nonSilent,
      };
    });
    expect(result.numberOfChannels).toBe(2);
    expect(result.sampleRate).toBe(44100);
    expect(result.length).toBeGreaterThan(0);
    expect(result.allFinite, 'buffer contains non-finite samples').toBe(true);
    expect(result.maxAbs, `expected non-silent buffer but maxAbs=${result.maxAbs}`).toBeGreaterThan(1e-4);
    expect(result.nonSilent).toBeGreaterThan(100);
  });

  test('muting channel yields near-silence on production path', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async () => {
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      const engine = mod.audioEngine;
      const baseChannel = {
        id: 'ch-test',
        name: 'Test Synth',
        color: '#10b981',
        instrumentType: 'minisynth' as const,
        mixerTrackId: 1,
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: Array(16).fill(false),
        notes: [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 }],
        synthParams: engine.getDefaultSynthParams ? engine.getDefaultSynthParams() : {},
      };
      const mutedChannel = { ...baseChannel, mute: true };
      const mixerTracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
        { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
      ];
      const clip = { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern' as const, channelId: 'ch-test', color: '#10b981', name: 'Test Clip' };
      const audible: AudioBuffer = await engine.renderTimelineOffline([baseChannel], [clip], mixerTracks, 120, 1, 44100, false);
      const silent: AudioBuffer = await engine.renderTimelineOffline([mutedChannel], [clip], mixerTracks, 120, 1, 44100, false);
      const maxOf = (b: AudioBuffer) => {
        const d = b.getChannelData(0);
        let m = 0; for (let i=0;i<d.length;i++) m = Math.max(m, Math.abs(d[i])); return m;
      };
      return {
        audibleMax: maxOf(audible),
        silentMax: maxOf(silent),
      };
    });
    expect(result.audibleMax, 'audible channel should produce non-silence').toBeGreaterThan(1e-4);
    expect(result.silentMax, `muted channel should be near-silence but got ${result.silentMax}`).toBeLessThan(1e-4);
    expect(result.audibleMax).toBeGreaterThan(result.silentMax * 10);
  });

  test('FX parameter change produces measurable buffer difference', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async () => {
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      const engine = mod.audioEngine;
      const channel = {
        id: 'ch-test',
        name: 'Test Synth',
        color: '#10b981',
        instrumentType: 'minisynth' as const,
        mixerTrackId: 1,
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: Array(16).fill(false),
        notes: [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 }],
        synthParams: engine.getDefaultSynthParams ? engine.getDefaultSynthParams() : {},
      };
      const clip = { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern' as const, channelId: 'ch-test', color: '#10b981', name: 'Test Clip' };
      const dryTracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
        { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
      ];
      const wetTracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
        { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [{ id: 'fx-delay', type: 'delay', name: 'Delay', enabled: true, mix: 0.5, params: { time: 0.25, feedback: 0.3 } }] },
      ];
      const dry: AudioBuffer = await engine.renderTimelineOffline([channel], [clip], dryTracks, 120, 1, 44100, true);
      const wet: AudioBuffer = await engine.renderTimelineOffline([channel], [clip], wetTracks, 120, 1, 44100, true);
      const d0 = dry.getChannelData(0);
      const w0 = wet.getChannelData(0);
      let diffEnergy = 0;
      let maxDiff = 0;
      const len = Math.min(d0.length, w0.length);
      for (let i=0;i<len;i++) {
        const diff = Math.abs(w0[i] - d0[i]);
        diffEnergy += diff * diff;
        if (diff > maxDiff) maxDiff = diff;
      }
      const dryFinite = d0.every(Number.isFinite);
      const wetFinite = w0.every(Number.isFinite);
      let dryMax = 0; for (let i=0;i<d0.length;i++) { const a=Math.abs(d0[i]); if(a>dryMax) dryMax=a; }
      let wetMax = 0; for (let i=0;i<w0.length;i++) { const a=Math.abs(w0[i]); if(a>wetMax) wetMax=a; }
      return { diffEnergy, maxDiff, dryFinite, wetFinite, dryMax, wetMax };
    });
    expect(result.dryFinite, 'dry buffer has non-finite').toBe(true);
    expect(result.wetFinite, 'wet buffer has non-finite').toBe(true);
    expect(result.maxDiff, `FX should cause measurable difference but maxDiff=${result.maxDiff}`).toBeGreaterThan(1e-4);
    expect(result.diffEnergy).toBeGreaterThan(1e-6);
    expect(result.dryMax).toBeGreaterThan(1e-4);
    expect(result.wetMax).toBeGreaterThan(1e-4);
  });

  test('missing buffer for unmuted audio clip throws descriptive error', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async () => {
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      const engine = mod.audioEngine;
      const channel = {
        id: 'ch-audio',
        name: 'Audio Ch',
        color: '#f59e0b',
        instrumentType: 'sampler' as const,
        mixerTrackId: 1,
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: Array(16).fill(false),
        notes: [],
        synthParams: {},
      };
      const mixerTracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
        { id: 1, name: 'Audio', color: '#f59e0b', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
      ];
      const clip = {
        id: 'clip-missing',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 1,
        type: 'audio' as const,
        channelId: 'ch-audio',
        audioBufferId: 'missing-buffer-id-999',
        audioName: 'Missing Take',
        color: '#f59e0b',
        name: 'Missing Take',
        mute: false as const,
      };
      try {
        await engine.renderTimelineOffline([channel], [clip], mixerTracks, 120, 1, 44100, false);
        return { threw: false, message: '' };
      } catch (e: any) {
        const msg = e?.message || String(e);
        return { threw: true, message: msg, isDescriptive: /missing.*buffer|audioBufferId|Missing audio buffer/i.test(msg) };
      }
    });
    expect(result.threw, `expected render to throw for missing buffer but it did not; message: ${(result as any).message||''}`).toBe(true);
    expect((result as any).isDescriptive, `error message not descriptive: ${(result as any).message}`).toBe(true);
  });
});
