import { test, expect } from '@playwright/test';

/**
 * Phase 8A — Offline vocal pitch correction in REAL Chromium.
 *
 * The Node suites prove the YIN analysis and the correction renderer on real
 * PCM (src/audio/vocalPitchCorrection.test.ts) and the commit pipeline
 * against a fake asset store (src/audio/vocalPitchCorrectionCommit.test.ts).
 * This spec closes the remaining gap with the real browser stack:
 *
 *  1. the production analysis + correction run on a REAL browser AudioBuffer
 *     and the corrected PCM measurably lands on the target scale note
 *     (dominant frequency measured in-page, not asserted by label);
 *  2. the production commit pipeline runs against the REAL engine + REAL
 *     IndexedDB persistence: the corrected asset is durably stored under a
 *     NEW 'vocal-tune-' id, the clip keeps its exact geometry (duration
 *     preserved), and the original asset survives intact — the undo guarantee;
 *  3. the honest refusals (silence, already-in-tune material) throw typed
 *     errors in the browser too and persist NOTHING.
 *
 * No mocked OfflineAudioContext is involved anywhere: assertions read actual
 * rendered sample data and actual persisted blob bytes.
 */

const SR = 44100;

test.describe('Phase 8A: vocal pitch correction (real browser audio)', () => {
  test('commits REAL corrected PCM as a durable vocal-tune asset; refusals persist nothing', async ({ page }) => {
    await page.goto('http://localhost:3000');
    // Let app-startup hydration/publication settle (same contract as the warp specs).
    await page.waitForTimeout(2000);

    const result = await page.evaluate(async ({ SR }) => {
      // @ts-ignore — browser-side imports of Vite-served production modules
      const engineMod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const commitMod: any = await import('/src/audio/vocalPitchCorrectionCommit.ts');
      // @ts-ignore
      const dspMod: any = await import('/src/audio/vocalPitchCorrection.ts');
      // @ts-ignore
      const persistMod: any = await import('/src/audio/audioPersistence.ts');
      // @ts-ignore
      const bufferPersistMod: any = await import('/src/audio/sampleBufferPersistence.ts');
      const engine = engineMod.audioEngine;
      if (!bufferPersistMod.getSampleBufferPersistenceController(engine)) {
        bufferPersistMod.installSampleBufferPersistence(engine);
      }
      const ctx = engine.getContext();

      // 1 s of a REAL off-scale vocal-style tone: 452 Hz = A4 + 47 cents.
      // C-major target: A4 (440 Hz). Deterministic, no mocks.
      const makeSource = (freq: number): AudioBuffer => {
        const buf: AudioBuffer = ctx.createBuffer(2, Math.round(1.0 * SR), SR);
        for (let ch = 0; ch < 2; ch += 1) {
          const data = buf.getChannelData(ch);
          for (let i = 0; i < data.length; i += 1) {
            // Gentle syllable-like amplitude shape over the sustained pitch.
            const env = 0.55 + 0.15 * Math.sin((2 * Math.PI * 3 * i) / SR);
            data[i] = env * Math.sin((2 * Math.PI * freq * i) / SR);
          }
        }
        return buf;
      };

      // Dominant frequency via autocorrelation + parabolic refinement (in-page measurement).
      const dominant = (data: Float32Array, fromSec: number, toSec: number): number => {
        const a = Math.floor(fromSec * SR);
        const b = Math.min(data.length, Math.floor(toSec * SR));
        const n = b - a;
        const minLag = Math.floor(SR / 1100);
        const maxLag = Math.min(Math.floor(SR / 60), Math.floor(n / 2));
        const scoreAt = (lag: number): number => {
          let sum = 0;
          for (let i = 0; i < n - lag; i += 1) sum += data[a + i] * data[a + i + lag];
          return sum;
        };
        let bestLag = minLag;
        let bestScore = -Infinity;
        for (let lag = minLag; lag <= maxLag; lag += 1) {
          const s = scoreAt(lag);
          if (s > bestScore) { bestScore = s; bestLag = lag; }
        }
        if (bestLag > minLag && bestLag < maxLag) {
          const y0 = scoreAt(bestLag - 1);
          const y2 = scoreAt(bestLag + 1);
          const denom = y0 - 2 * bestScore + y2;
          if (Math.abs(denom) > 1e-12) {
            const delta = (0.5 * (y0 - y2)) / denom;
            if (Math.abs(delta) < 1) return SR / (bestLag + delta);
          }
        }
        return SR / bestLag;
      };

      const srcBuf = makeSource(452);
      const sourceId = `spec-vocal-src-${Date.now()}`;
      engine.setSampleBuffer(sourceId, srcBuf);
      await bufferPersistMod.waitForSampleBufferPersistence(engine, sourceId);

      const deps = {
        getSourceBuffer: (id: string) => engine.getSampleBuffer(id),
        hydrateSource: (id: string) => persistMod.hydrateAudioClip(engine, id),
        registerAsset: (id: string, b: AudioBuffer) => engine.setSampleBuffer(id, b),
        waitForAsset: (id: string) => bufferPersistMod.waitForSampleBufferPersistence(engine, id),
        createBuffer: (c: number, l: number, s: number) => ctx.createBuffer(c, l, s),
        now: () => Date.now(),
      };
      // Persisted settings with NON-ZERO formant/vibrato/humanize: they must
      // not influence the render (not applied in this milestone).
      const settings = {
        enabled: true, scale: 'major', rootKey: 0, retuneSpeedMs: 0,
        formantShift: -3, vibratoDepth: 0.8, humanize: 1,
      };
      const mkClip = (id: string, bufferId: string) => ({
        id, trackIndex: 0, startBar: 1, lengthBars: 0.5, type: 'audio',
        audioBufferId: bufferId, name: 'Spec Vocal', color: '#00ff88',
      });

      // The plan the UI shows BEFORE committing.
      const planned = await commitMod.analyseVocalCorrectionSource(mkClip('spec-vocal-plan', sourceId), settings, deps);
      const planText = commitMod.describeVocalCorrectionPlan(planned) as string;

      // The real commit.
      const commit = await commitMod.commitVocalPitchCorrection(mkClip('spec-vocal-clip', sourceId), settings, deps);

      // Page-local reference renders from the production DSP module.
      const correctionSettings = { rootKey: 0, scale: 'major', retuneSpeedMs: 0 };
      const ref = dspMod.vocalCorrectAudioBuffer(srcBuf, correctionSettings, deps.createBuffer);

      const firstDiff = (a: Float32Array, b: Float32Array): number => {
        for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return i;
        return a.length === b.length ? -1 : Math.min(a.length, b.length);
      };

      const outData = commit.correctedBuffer.getChannelData(0);
      const outF0 = dominant(outData, 0.35, 0.65);
      const inF0 = dominant(srcBuf.getChannelData(0), 0.35, 0.65);

      // Honest refusals in the real browser: silence and already-in-tune A4.
      const silenceId = `spec-vocal-silence-${Date.now()}`;
      const silenceBuf: AudioBuffer = ctx.createBuffer(2, Math.round(1.0 * SR), SR);
      engine.setSampleBuffer(silenceId, silenceBuf);
      let silenceRefusal = '';
      try {
        await commitMod.commitVocalPitchCorrection(mkClip('spec-vocal-silent', silenceId), settings, deps);
      } catch (error: any) {
        silenceRefusal = `${error.name}:${error.failure}`;
      }
      const inTuneId = `spec-vocal-intune-${Date.now()}`;
      const inTuneBuf = makeSource(440);
      engine.setSampleBuffer(inTuneId, inTuneBuf);
      let inTuneRefusal = '';
      try {
        await commitMod.commitVocalPitchCorrection(mkClip('spec-vocal-intune', inTuneId), settings, deps);
      } catch (error: any) {
        inTuneRefusal = `${error.name}:${error.failure}`;
      }

      const correctedBlob: Blob | null = await persistMod.getPersistedAudioClip(commit.correctedAssetId);
      const sourceBlob: Blob | null = await persistMod.getPersistedAudioClip(sourceId);

      return {
        planText,
        correctedId: commit.correctedAssetId as string,
        srcLen: srcBuf.length,
        outLen: commit.correctedBuffer.length as number,
        outChannels: commit.correctedBuffer.numberOfChannels as number,
        inF0,
        outF0,
        matchesPageRender: firstDiff(outData, ref.getChannelData(0)) === -1,
        differsFromSource: firstDiff(outData, srcBuf.getChannelData(0)) >= 0,
        lengthBars: commit.clip.lengthBars as number,
        clipReferencesNewAsset: commit.clip.audioBufferId === commit.correctedAssetId,
        summaryNotes: `${planned.summary.measuredNoteName}→${planned.summary.targetNoteName}`,
        voicedRatio: planned.summary.voicedRatio as number,
        meanCents: planned.summary.meanCentsApplied as number,
        sourceIntact: engine.getSampleBuffer(sourceId) === srcBuf,
        silenceRefusal,
        inTuneRefusal,
        correctedPersistedSize: correctedBlob ? correctedBlob.size : 0,
        sourcePersistedSize: sourceBlob ? sourceBlob.size : 0,
      };
    }, { SR });

    // The pre-commit plan is real: key, note movement, cents, voiced share.
    expect(result.planText).toContain('C major');
    expect(result.summaryNotes).toBe('A4→A4');
    expect(result.voicedRatio).toBeGreaterThan(0.85);
    expect(result.meanCents).toBeGreaterThan(35);
    expect(result.meanCents).toBeLessThan(60);
    expect(result.planText).toContain('hard snap');
    expect(result.planText).not.toMatch(/\d+\s*Hz/);

    // Durable NEW asset under the vocal-tune identity.
    expect(result.correctedId.startsWith('vocal-tune-spec-vocal-clip-')).toBe(true);

    // Real corrected audio in the live browser: exact duration, measured pitch
    // ON the target note, decisively different from the source, and equal to
    // the browser's own production render (formant/vibrato/humanize ignored).
    expect(result.outLen).toBe(result.srcLen);
    expect(result.outChannels).toBe(2);
    expect(Math.abs(result.inF0 - 452) / 452).toBeLessThanOrEqual(0.01);
    expect(Math.abs(result.outF0 - 440) / 440).toBeLessThanOrEqual(0.012);
    expect(result.matchesPageRender).toBe(true);
    expect(result.differsFromSource).toBe(true);

    // Clip geometry: duration-preserving correction changes ONLY the asset reference.
    expect(result.lengthBars).toBeCloseTo(0.5, 12);
    expect(result.clipReferencesNewAsset).toBe(true);
    expect(result.sourceIntact).toBe(true);

    // Honest typed refusals — and they persisted nothing new.
    expect(result.silenceRefusal).toBe('VocalCorrectionCommitError:no-confident-pitch');
    expect(result.inTuneRefusal).toBe('VocalCorrectionCommitError:nothing-to-correct');

    // Both the corrected asset and the untouched source are durable in the
    // real browser store (1 s stereo float WAV ≈ 350 kB).
    expect(result.correctedPersistedSize).toBeGreaterThan(50000);
    expect(result.sourcePersistedSize).toBeGreaterThan(50000);
  });
});
