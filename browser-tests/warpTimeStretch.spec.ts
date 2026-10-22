import { test, expect } from '@playwright/test';

/**
 * Phase 7A — Pitch-preserving time stretch (WSOLA) in REAL Chromium.
 *
 * The Node suites prove the DSP on real PCM (src/audio/wsolaTimeStretch.test.ts)
 * and the commit pipeline against a fake asset store plus the web-audio-engine
 * offline renderer (src/audio/warpTimeStretchCommit.test.ts). This spec closes
 * the remaining gap with the real browser stack:
 *
 *  1. the production WSOLA runs on a REAL browser AudioBuffer/Float32Array —
 *     exact output length, dominant pitch preserved within the documented ±2 %,
 *     bit-identical repeated runs, source untouched;
 *  2. the production commit pipeline runs against the REAL engine + REAL
 *     IndexedDB persistence: `setSampleBuffer` (wrapped by the persistence
 *     installer) must leave the stretched asset durably stored under a NEW id
 *     while the original asset survives intact — the undo guarantee.
 *
 * No mocked OfflineAudioContext is involved anywhere: assertions read actual
 * rendered sample data and actual persisted blob bytes.
 */

const SR = 44100;

test.describe('Phase 7A: WSOLA pitch-preserving stretch (real browser audio)', () => {
  test('stretches a real AudioBuffer to 2× with pitch preserved, exactly and deterministically', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async ({ SR }) => {
      // @ts-ignore — browser-side import of a Vite-served module (same convention as exportTailHandling.spec.ts)
      const mod: any = await import('/src/audio/wsolaTimeStretch.ts');
      const ctx = new OfflineAudioContext(2, SR * 2, SR);
      const src = ctx.createBuffer(2, Math.round(0.5 * SR), SR);
      const sourceSnapshot = new Float32Array(src.length);
      for (let ch = 0; ch < 2; ch += 1) {
        const data = src.getChannelData(ch);
        for (let i = 0; i < data.length; i += 1) {
          data[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR);
        }
        if (ch === 0) sourceSnapshot.set(data);
      }

      const run = () => mod.wsolaStretchAudioBuffer(src, 2.0, (c: number, l: number, s: number) => ctx.createBuffer(c, l, s));
      const a: AudioBuffer = run();
      const b: AudioBuffer = run();

      // Dominant frequency via autocorrelation over the middle of the output.
      const out = a.getChannelData(0);
      const from = Math.floor(out.length * 0.25);
      const n = 16384;
      const minLag = Math.floor(SR / 1000);
      const maxLag = Math.floor(SR / 60);
      let bestLag = minLag;
      let bestScore = -Infinity;
      for (let lag = minLag; lag <= maxLag; lag += 1) {
        let sum = 0;
        for (let i = 0; i < n - lag; i += 2) sum += out[from + i] * out[from + i + lag];
        if (sum > bestScore) {
          bestScore = sum;
          bestLag = lag;
        }
      }
      const f0 = SR / bestLag;

      let deterministic = a.length === b.length;
      for (let i = 0; deterministic && i < a.length; i += 1) {
        if (a.getChannelData(0)[i] !== b.getChannelData(0)[i]) deterministic = false;
        if (a.getChannelData(1)[i] !== b.getChannelData(1)[i]) deterministic = false;
      }

      let sourceUntouched = src.length === sourceSnapshot.length;
      for (let i = 0; sourceUntouched && i < src.length; i += 1) {
        if (src.getChannelData(0)[i] !== sourceSnapshot[i]) sourceUntouched = false;
      }

      return {
        length: a.length,
        expectedLength: src.length * 2,
        channels: a.numberOfChannels,
        sampleRate: a.sampleRate,
        f0,
        deterministic,
        sourceUntouched,
      };
    }, { SR });

    expect(result.length).toBe(result.expectedLength);
    expect(result.channels).toBe(2);
    expect(result.sampleRate).toBe(SR);
    expect(Math.abs(result.f0 - 220) / 220).toBeLessThanOrEqual(0.02);
    expect(result.deterministic).toBe(true);
    expect(result.sourceUntouched).toBe(true);
  });

  test('commits processed PCM as a new durable asset through the real engine and IndexedDB', async ({ page }) => {
    await page.goto('http://localhost:3000');
    // Let app-startup hydration/publication settle: the production durability
    // gate rejects writes whose playlist-publication token went stale, so the
    // spec must not race the app's own project load.
    await page.waitForTimeout(2000);
    const result = await page.evaluate(async ({ SR }) => {
      // @ts-ignore — browser-side imports of Vite-served production modules
      const engineMod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const commitMod: any = await import('/src/audio/warpTimeStretchCommit.ts');
      // @ts-ignore
      const persistMod: any = await import('/src/audio/audioPersistence.ts');
      // @ts-ignore
      const bufferPersistMod: any = await import('/src/audio/sampleBufferPersistence.ts');
      const engine = engineMod.audioEngine;

      // The running app installs the persistence wrapper; install defensively
      // so the spec never depends on React mount timing (idempotent).
      if (!bufferPersistMod.getSampleBufferPersistenceController(engine)) {
        bufferPersistMod.installSampleBufferPersistence(engine);
      }

      const ctx = engine.getContext();
      const srcBuf: AudioBuffer = ctx.createBuffer(2, Math.round(0.5 * SR), SR);
      for (let ch = 0; ch < 2; ch += 1) {
        const data = srcBuf.getChannelData(ch);
        for (let i = 0; i < data.length; i += 1) data[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      const sourceId = `spec-warp-src-${Date.now()}`;
      engine.setSampleBuffer(sourceId, srcBuf);
      await bufferPersistMod.waitForSampleBufferPersistence(engine, sourceId);

      const clip = {
        id: 'spec-warp-clip',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 0.25,
        type: 'audio',
        audioBufferId: sourceId,
        name: 'Spec Warp Tone',
        color: '#00ff88',
      };

      const commit = await commitMod.commitWarpTimeStretch(clip, 2.0, {
        getSourceBuffer: (id: string) => engine.getSampleBuffer(id),
        hydrateSource: (id: string) => persistMod.hydrateAudioClip(engine, id),
        registerAsset: (id: string, b: AudioBuffer) => engine.setSampleBuffer(id, b),
        waitForAsset: (id: string) => bufferPersistMod.waitForSampleBufferPersistence(engine, id),
        createBuffer: (c: number, l: number, s: number) => engine.getContext().createBuffer(c, l, s),
        now: () => Date.now(),
      });

      const persistedBlob: Blob | null = await persistMod.getPersistedAudioClip(commit.stretchedAssetId);
      const originalBlob: Blob | null = await persistMod.getPersistedAudioClip(sourceId);
      const originalStillRegistered = engine.getSampleBuffer(sourceId) === srcBuf;
      const processedResident = engine.getSampleBuffer(commit.stretchedAssetId) === commit.stretchedBuffer;

      return {
        sourceId,
        newId: commit.stretchedAssetId as string,
        clipBufferId: commit.clip.audioBufferId as string,
        lengthBars: commit.clip.lengthBars as number,
        waveformPeaks: (commit.clip.audioWaveform ?? []).length,
        srcLen: srcBuf.length,
        newLen: commit.stretchedBuffer.length,
        persistedSize: persistedBlob ? persistedBlob.size : 0,
        originalPersistedSize: originalBlob ? originalBlob.size : 0,
        originalStillRegistered,
        processedResident,
      };
    }, { SR });

    // A NEW asset id — never the source — now referenced by the clip.
    expect(result.newId).not.toBe(result.sourceId);
    expect(result.newId.startsWith('wsola-stretch-spec-warp-clip-')).toBe(true);
    expect(result.clipBufferId).toBe(result.newId);
    // Real processed PCM: exactly 2× the source frames.
    expect(result.newLen).toBe(result.srcLen * 2);
    // Clip geometry scaled; waveform recomputed from the processed PCM.
    expect(result.lengthBars).toBeCloseTo(0.5, 6);
    expect(result.waveformPeaks).toBe(64);
    // Durably persisted in the real browser store: ~1 s stereo 32-bit float WAV
    // is ≈176 kB — anything near that proves a real encoded write, not a stub.
    expect(result.persistedSize).toBeGreaterThan(100000);
    // The ORIGINAL asset is untouched: still registered in memory (undo can
    // restore the prior reference and play immediately) and still persisted.
    expect(result.originalStillRegistered).toBe(true);
    expect(result.processedResident).toBe(true);
    expect(result.originalPersistedSize).toBeGreaterThan(40000);
  });
});
