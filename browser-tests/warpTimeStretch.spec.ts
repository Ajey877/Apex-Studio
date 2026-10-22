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

  test('Phase 7B: fits audio to the LIVE project tempo (transport BPM) and refuses out-of-bounds fits', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForTimeout(2000);
    // The authoritative project tempo, read from the live transport UI — the
    // same value the App feeds the Warp modal as its fit target.
    const transportBpm = parseFloat(await page.locator('#fl-bpm-input').inputValue());
    expect(Number.isFinite(transportBpm)).toBe(true);
    expect(transportBpm).toBeGreaterThan(0);

    const result = await page.evaluate(async ({ SR, transportBpm }) => {
      // @ts-ignore — browser-side imports of Vite-served production modules
      const engineMod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const commitMod: any = await import('/src/audio/warpTimeStretchCommit.ts');
      // @ts-ignore
      const persistMod: any = await import('/src/audio/audioPersistence.ts');
      // @ts-ignore
      const bufferPersistMod: any = await import('/src/audio/sampleBufferPersistence.ts');
      const engine = engineMod.audioEngine;
      if (!bufferPersistMod.getSampleBufferPersistenceController(engine)) {
        bufferPersistMod.installSampleBufferPersistence(engine);
      }

      // Fit computation on the live tempo: source = 3/4 of the project tempo
      // → ratio 0.75 (audio shorter after the fit).
      const sourceBpm = Math.round(transportBpm * 0.75 * 100) / 100;
      const ratio: number = commitMod.computeFitToTempoRatio(String(sourceBpm), transportBpm);

      // Out-of-bounds refusal: 0.1× is below the 0.25× WSOLA floor for ANY
      // positive project tempo — must throw typed, never clamp.
      let refusal: { failure: string; message: string } | null = null;
      try {
        commitMod.computeFitToTempoRatio(String(transportBpm * 0.1), transportBpm);
      } catch (error: any) {
        refusal = { failure: String(error?.failure ?? ''), message: String(error?.message ?? '') };
      }

      // Real commit of the fit through the production pipeline.
      const ctx = engine.getContext();
      const srcBuf: AudioBuffer = ctx.createBuffer(2, Math.round(0.75 * SR), SR);
      for (let ch = 0; ch < 2; ch += 1) {
        const data = srcBuf.getChannelData(ch);
        for (let i = 0; i < data.length; i += 1) data[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      const sourceId = `spec-fit-src-${Date.now()}`;
      engine.setSampleBuffer(sourceId, srcBuf);
      await bufferPersistMod.waitForSampleBufferPersistence(engine, sourceId);

      const clip = {
        id: 'spec-fit-clip',
        trackIndex: 0,
        startBar: 2,
        lengthBars: 0.375,
        type: 'audio',
        audioBufferId: sourceId,
        name: 'Spec Fit Tone',
        color: '#00ff88',
      };

      const commit = await commitMod.commitWarpTimeStretch(clip, ratio, {
        getSourceBuffer: (id: string) => engine.getSampleBuffer(id),
        hydrateSource: (id: string) => persistMod.hydrateAudioClip(engine, id),
        registerAsset: (id: string, b: AudioBuffer) => engine.setSampleBuffer(id, b),
        waitForAsset: (id: string) => bufferPersistMod.waitForSampleBufferPersistence(engine, id),
        createBuffer: (c: number, l: number, s: number) => engine.getContext().createBuffer(c, l, s),
        now: () => Date.now(),
      });

      const persistedBlob: Blob | null = await persistMod.getPersistedAudioClip(commit.stretchedAssetId);
      return {
        ratio,
        sourceBpm,
        refusalFailure: refusal ? refusal.failure : null,
        refusalMessage: refusal ? refusal.message : null,
        lengthBars: commit.clip.lengthBars as number,
        startBar: commit.clip.startBar as number,
        srcLen: srcBuf.length,
        newLen: commit.stretchedBuffer.length,
        clipReferencesNewAsset: commit.clip.audioBufferId === commit.stretchedAssetId,
        newAssetIsNotSource: commit.stretchedAssetId !== sourceId,
        sourceIntact: engine.getSampleBuffer(sourceId) === srcBuf,
        persistedSize: persistedBlob ? persistedBlob.size : 0,
      };
    }, { SR, transportBpm });

    // The fit ratio equals source ÷ project exactly (the source BPM field is
    // 2-decimal, so the ideal 0.75 holds within that rounding), and the
    // committed clip scales its length by precisely that ratio with the start
    // bar preserved.
    expect(result.ratio).toBeCloseTo(result.sourceBpm / transportBpm, 12);
    expect(result.ratio).toBeCloseTo(0.75, 3);
    expect(result.lengthBars).toBeCloseTo(0.375 * result.ratio, 10);
    expect(result.startBar).toBe(2);
    expect(result.newLen).toBe(Math.ceil(result.srcLen * result.ratio));
    expect(result.clipReferencesNewAsset).toBe(true);
    expect(result.newAssetIsNotSource).toBe(true);
    expect(result.sourceIntact).toBe(true);
    // Durable write in the real browser store (~0.56 s stereo float WAV).
    expect(result.persistedSize).toBeGreaterThan(50000);
    // Out-of-bounds fits are refused with the typed, actionable error.
    expect(result.refusalFailure).toBe('ratio-out-of-range');
    expect(result.refusalMessage ?? '').toContain('never silently clamped');
  });

  test('Phase 7C: fits audio to an EXACT musical length of the LIVE project grid (transport BPM + resolved meter)', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForTimeout(2000);
    // The authoritative project grid, read from the live transport UI — the
    // same values the App feeds the Warp modal (bpm input + resolved meter).
    const transportBpm = parseFloat(await page.locator('#fl-bpm-input').inputValue());
    const transportMeter = (await page.locator('#fl-meter-readout').getAttribute('data-meter')) ?? '';
    expect(Number.isFinite(transportBpm)).toBe(true);
    expect(transportBpm).toBeGreaterThan(0);
    expect(transportMeter).toMatch(/^\d+\/\d+$/);

    const result = await page.evaluate(async ({ SR, transportBpm, transportMeter }) => {
      // @ts-ignore — browser-side imports of Vite-served production modules
      const engineMod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const commitMod: any = await import('/src/audio/warpTimeStretchCommit.ts');
      // @ts-ignore
      const persistMod: any = await import('/src/audio/audioPersistence.ts');
      // @ts-ignore
      const bufferPersistMod: any = await import('/src/audio/sampleBufferPersistence.ts');
      const engine = engineMod.audioEngine;
      if (!bufferPersistMod.getSampleBufferPersistenceController(engine)) {
        bufferPersistMod.installSampleBufferPersistence(engine);
      }

      // The live grid from the authoritative values — the same math the modal
      // and pipeline perform (beats are quarter notes).
      const meterParts = transportMeter.split('/').map(Number);
      const beatsPerBar = (meterParts[0] * 4) / meterParts[1];
      const secondsPerBar = (beatsPerBar * 60) / transportBpm;

      // 0.5 s of real audio. One bar fits inside the WSOLA bounds at the
      // fresh-app grid (128 BPM 4/4 → 3.75×); slower live tempos fall back to
      // a half-bar target so the spec never depends on a hardcoded ratio.
      const sourceSeconds = 0.5;
      const target = secondsPerBar / sourceSeconds <= 4
        ? { bars: 1, beats: 0 }
        : { bars: 0, beats: beatsPerBar / 2 };
      const targetSeconds = target.bars * secondsPerBar + (target.beats * 60) / transportBpm;

      const ctx = engine.getContext();
      const srcBuf: AudioBuffer = ctx.createBuffer(2, Math.round(sourceSeconds * SR), SR);
      for (let ch = 0; ch < 2; ch += 1) {
        const data = srcBuf.getChannelData(ch);
        for (let i = 0; i < data.length; i += 1) data[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      const sourceId = `spec-lenfit-src-${Date.now()}`;
      engine.setSampleBuffer(sourceId, srcBuf);
      await bufferPersistMod.waitForSampleBufferPersistence(engine, sourceId);

      const clip = {
        id: 'spec-lenfit-clip',
        trackIndex: 0,
        startBar: 2,
        // The clip window consumes exactly the source (whole-buffer heard).
        lengthBars: sourceSeconds / secondsPerBar,
        type: 'audio',
        audioBufferId: sourceId,
        name: 'Spec Length Fit',
        color: '#00ff88',
      };
      const fitCtx = { bpm: transportBpm, timeSignature: meterParts };
      const deps = {
        getSourceBuffer: (id: string) => engine.getSampleBuffer(id),
        hydrateSource: (id: string) => persistMod.hydrateAudioClip(engine, id),
        registerAsset: (id: string, b: AudioBuffer) => engine.setSampleBuffer(id, b),
        waitForAsset: (id: string) => bufferPersistMod.waitForSampleBufferPersistence(engine, id),
        createBuffer: (c: number, l: number, s: number) => engine.getContext().createBuffer(c, l, s),
        now: () => Date.now(),
      };

      const commit = await commitMod.commitWarpTimeStretchToLength(clip, target, fitCtx, deps);

      // Refusals must be typed and change nothing.
      let rangeRefusal: { failure: string; message: string } | null = null;
      try {
        // 15 bars needs ≥ 7.2× at ANY project tempo — always out of range.
        await commitMod.commitWarpTimeStretchToLength({ ...clip, id: 'spec-lenfit-refused' }, { bars: 15, beats: 0 }, fitCtx, deps);
      } catch (error: any) {
        rangeRefusal = { failure: String(error?.failure ?? ''), message: String(error?.message ?? '') };
      }
      let offsetRefusal: { failure: string; message: string } | null = null;
      try {
        await commitMod.commitWarpTimeStretchToLength({ ...clip, offsetSteps: 2 }, target, fitCtx, deps);
      } catch (error: any) {
        offsetRefusal = { failure: String(error?.failure ?? ''), message: String(error?.message ?? '') };
      }

      const persistedBlob: Blob | null = await persistMod.getPersistedAudioClip(commit.stretchedAssetId);
      const originalBlob: Blob | null = await persistMod.getPersistedAudioClip(sourceId);
      const planMeter = (commit.plan.resolvedMeter as number[]).join('/');
      const newId = commit.stretchedAssetId as string;
      return {
        target,
        targetSeconds,
        ratio: commit.plan.ratio as number,
        planWindow: commit.plan.targetWindowSeconds as number,
        planMeter,
        lengthBars: commit.clip.lengthBars as number,
        startBar: commit.clip.startBar as number,
        srcLen: srcBuf.length,
        newLen: commit.stretchedBuffer.length,
        newDuration: commit.stretchedBuffer.duration,
        newId,
        sourceId,
        clipReferencesNewAsset: commit.clip.audioBufferId === newId,
        sourceIntact: engine.getSampleBuffer(sourceId) === srcBuf,
        persistedSize: persistedBlob ? persistedBlob.size : 0,
        originalPersistedSize: originalBlob ? originalBlob.size : 0,
        rangeRefusal,
        offsetRefusal,
      };
    }, { SR, transportBpm, transportMeter });

    // The committed clip occupies EXACTLY the requested musical destination
    // under the live meter — bars + beats/beatsPerBar, no drift.
    const [meterNum, meterDen] = transportMeter.split('/').map(Number);
    const meterBeats = (meterNum * 4) / meterDen;
    expect(result.lengthBars).toBeCloseTo(result.target.bars + result.target.beats / meterBeats, 12);
    // The plan used the transport's resolved meter and window exactly.
    expect(result.planMeter).toBe(transportMeter);
    expect(result.planWindow).toBeCloseTo(result.targetSeconds, 9);
    // ratio = intended output duration ÷ ACTUAL source duration (0.5 s).
    expect(result.ratio).toBeCloseTo(result.targetSeconds / 0.5, 9);
    // Real processed PCM: exact WSOLA frame count, and its duration fills the
    // target window within one output frame.
    expect(result.newLen).toBe(Math.ceil(result.srcLen * result.ratio));
    expect(Math.abs(result.newDuration - result.targetSeconds)).toBeLessThanOrEqual(1 / SR);
    // startBar is unchanged; a NEW durable asset backs the clip; source intact.
    expect(result.startBar).toBe(2);
    expect(result.newId.startsWith('wsola-stretch-spec-lenfit-clip-')).toBe(true);
    expect(result.newId).not.toBe(result.sourceId);
    expect(result.clipReferencesNewAsset).toBe(true);
    expect(result.sourceIntact).toBe(true);
    // Durable write in the real browser store (≥1.875 s stereo float WAV at
    // the fresh-app grid ≈ 660 kB — anything near that proves a real write).
    expect(result.persistedSize).toBeGreaterThan(100000);
    expect(result.originalPersistedSize).toBeGreaterThan(40000);
    // Refusals are typed, actionable and never clamp.
    expect(result.rangeRefusal?.failure).toBe('ratio-out-of-range');
    expect(result.rangeRefusal?.message ?? '').toContain('never silently clamped');
    expect(result.offsetRefusal?.failure).toBe('unsupported-offset');
  });
  test('Phase 7D: the transient-aware strategy commits REAL TAW PCM under a taw-stretch asset while the WSOLA default stays byte-identical', async ({ page }) => {
    await page.goto('http://localhost:3000');
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
      // @ts-ignore
      const tawMod: any = await import('/src/audio/transientAwareStretch.ts');
      // @ts-ignore
      const wsolaMod: any = await import('/src/audio/wsolaTimeStretch.ts');
      const engine = engineMod.audioEngine;
      if (!bufferPersistMod.getSampleBufferPersistenceController(engine)) {
        bufferPersistMod.installSampleBufferPersistence(engine);
      }

      // 0.5 s of REAL transient material: deterministic noise floor plus a
      // sharp decaying click at 0.25 s — the browser renders both strategies
      // over real PCM, no mocks, no silence.
      const ctx = engine.getContext();
      const srcBuf: AudioBuffer = ctx.createBuffer(2, Math.round(0.5 * SR), SR);
      let seed = 20260122 >>> 0;
      const noise = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 0xffffffff) * 2 - 1;
      };
      for (let ch = 0; ch < 2; ch += 1) {
        const data = srcBuf.getChannelData(ch);
        for (let i = 0; i < data.length; i += 1) data[i] = 0.12 * noise();
        const at = Math.round(0.25 * SR);
        for (let i = 0; i < Math.round(0.02 * SR); i += 1) {
          data[at + i] += 0.9 * Math.exp(-i / Math.round(0.003 * SR)) * (i % 2 === 0 ? 1 : -1);
        }
      }
      const sourceId = `spec-taw-src-${Date.now()}`;
      engine.setSampleBuffer(sourceId, srcBuf);
      await bufferPersistMod.waitForSampleBufferPersistence(engine, sourceId);

      const deps = {
        getSourceBuffer: (id: string) => engine.getSampleBuffer(id),
        hydrateSource: (id: string) => persistMod.hydrateAudioClip(engine, id),
        registerAsset: (id: string, b: AudioBuffer) => engine.setSampleBuffer(id, b),
        waitForAsset: (id: string) => bufferPersistMod.waitForSampleBufferPersistence(engine, id),
        createBuffer: (c: number, l: number, s: number) => engine.getContext().createBuffer(c, l, s),
        now: () => Date.now(),
      };
      const ratio = 2;
      const mkClip = (id: string) => ({
        id,
        trackIndex: 0,
        startBar: 2,
        lengthBars: 0.25,
        type: 'audio',
        audioBufferId: sourceId,
        name: 'Spec TAW',
        color: '#00ff88',
      });

      // Default commit (no strategy argument) — the pre-7D path.
      const wsolaCommit = await commitMod.commitWarpTimeStretch(mkClip('spec-taw-wsola'), ratio, deps);
      // Explicit transient-aware commit — same pipeline, user-selected strategy.
      const tawCommit = await commitMod.commitWarpTimeStretch(mkClip('spec-taw-transient'), ratio, deps, 'transient');

      // Reference renders straight from the DSP modules (browser Float math).
      const channels = [srcBuf.getChannelData(0), srcBuf.getChannelData(1)];
      const tawRef = tawMod.tawStretchChannels(channels, ratio);
      const wsolaRef = wsolaMod.wsolaStretchAudioBuffer(srcBuf, ratio, deps.createBuffer);

      const firstDiff = (a: Float32Array, b: Float32Array): number => {
        for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return i;
        return a.length === b.length ? -1 : Math.min(a.length, b.length);
      };

      const tawBlob: Blob | null = await persistMod.getPersistedAudioClip(tawCommit.stretchedAssetId);
      const wsolaBlob: Blob | null = await persistMod.getPersistedAudioClip(wsolaCommit.stretchedAssetId);
      return {
        wsolaId: wsolaCommit.stretchedAssetId as string,
        wsolaStrategy: wsolaCommit.strategy as string,
        tawId: tawCommit.stretchedAssetId as string,
        tawStrategy: tawCommit.strategy as string,
        srcLen: srcBuf.length,
        tawLen: tawCommit.stretchedBuffer.length as number,
        wsolaLen: wsolaCommit.stretchedBuffer.length as number,
        tawMatchesRef: firstDiff(tawCommit.stretchedBuffer.getChannelData(0), tawRef.channels[0]) === -1,
        tawDiffersFromWsola: firstDiff(tawCommit.stretchedBuffer.getChannelData(0), wsolaCommit.stretchedBuffer.getChannelData(0)) >= 0,
        wsolaMatchesRef: firstDiff(wsolaCommit.stretchedBuffer.getChannelData(0), wsolaRef.getChannelData(0)) === -1,
        tawLengthBars: tawCommit.clip.lengthBars as number,
        tawClipReferencesNewAsset: tawCommit.clip.audioBufferId === tawCommit.stretchedAssetId,
        sourceIntact: engine.getSampleBuffer(sourceId) === srcBuf,
        tawPersistedSize: tawBlob ? tawBlob.size : 0,
        wsolaPersistedSize: wsolaBlob ? wsolaBlob.size : 0,
      };
    }, { SR });

    // Strategy self-documents in the result and the asset identity.
    expect(result.wsolaStrategy).toBe('wsola');
    expect(result.wsolaId.startsWith('wsola-stretch-spec-taw-wsola-')).toBe(true);
    expect(result.tawStrategy).toBe('transient');
    expect(result.tawId.startsWith('taw-stretch-spec-taw-transient-')).toBe(true);
    // Real processed PCM in the live browser: exact frames for both, the TAW
    // commit equals the browser's own TAW render and DIFFERS from the WSOLA
    // render (a relabeled WSOLA would fail here), while the default commit
    // stays byte-identical to the Phase 7A renderer.
    expect(result.tawLen).toBe(Math.ceil(result.srcLen * 2));
    expect(result.wsolaLen).toBe(result.tawLen);
    expect(result.tawMatchesRef).toBe(true);
    expect(result.tawDiffersFromWsola).toBe(true);
    expect(result.wsolaMatchesRef).toBe(true);
    // Same clip contract: scaled length, new asset reference, source intact.
    expect(result.tawLengthBars).toBeCloseTo(0.5, 12);
    expect(result.tawClipReferencesNewAsset).toBe(true);
    expect(result.sourceIntact).toBe(true);
    // BOTH processed assets are durable in the real browser store
    // (~1 s stereo float WAV ≈ 350 kB — anything near that proves real writes).
    expect(result.tawPersistedSize).toBeGreaterThan(50000);
    expect(result.wsolaPersistedSize).toBeGreaterThan(50000);
  });
});
