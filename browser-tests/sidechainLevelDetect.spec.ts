import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

/**
 * Phase 9A — real-browser proof of level-detected sidechain compression.
 *
 * Everything here runs against the production `AudioEngine` and the browser's
 * own `OfflineAudioContext` / `AudioContext`; nothing is mocked. The measured
 * quantity is the *destination track's own signal* (Goertzel magnitude at its
 * 220 Hz note), so a reduction can only come from audio arriving through the
 * sidechain route.
 */

const installFixture = async (page: import('@playwright/test').Page) => {
  await page.evaluate(async () => {
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { DEFAULT_MASTERING_SUITE_STATE: masteringDefaults } = await import('/src/audio/masteringState.ts');
    // The mastering suite is a level-dependent processor; leaving it on would
    // make a gain measurement of the destination band ambiguous. It is disabled
    // for every render here so the only thing that can change the destination's
    // level is the sidechain route itself.
    e.setMasteringState({ ...masteringDefaults, enabled: false });

    const bpm = 120;
    const destPitch = 57; // A3 = 220 Hz
    const destFrequency = 440 * Math.pow(2, (destPitch - 69) / 12);

    const makeChannel = (id: string, name: string, mixerTrackId: number, notes: any[], volume: number) => ({
      id,
      name,
      color: '#10b981',
      instrumentType: 'sub_808',
      mixerTrackId,
      volume,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: Array(16).fill(false),
      notes,
      synthParams: e.getDefaultSynthParams(),
    });

    // Source: two short high-pitched hits inside the bar (steps 0 and 8 @
    // 120 BPM). Deliberately far above the destination's measured band so the
    // measurement only ever sees the destination track's own signal.
    const sourceNotes = [
      { id: 'src-0', pitch: 88, start: 0, duration: 2, velocity: 1 },
      { id: 'src-1', pitch: 88, start: 8, duration: 2, velocity: 1 },
    ];
    // Destination: one sustained note for the whole bar.
    const destNotes = [{ id: 'dst-0', pitch: destPitch, start: 0, duration: 16, velocity: 0.9 }];

    const sourceChannel = makeChannel('sc-source', 'Sidechain Source', 1, sourceNotes, 0.9);
    const destChannel = makeChannel('sc-dest', 'Ducked Destination', 2, destNotes, 0.9);

    const clips = [
      // @ts-ignore
      { id: 'sc-clip-src', type: 'pattern', channelId: 'sc-source', trackIndex: 0, startBar: 0, lengthBars: 1, color: '#f59e0b', name: 'Source' },
      // @ts-ignore
      { id: 'sc-clip-dst', type: 'pattern', channelId: 'sc-dest', trackIndex: 1, startBar: 0, lengthBars: 1, color: '#10b981', name: 'Dest' },
    ];

    const baseTrack = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      color: '#fff',
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      peakL: 0,
      peakR: 0,
      fxSlots: [],
      routingTargetId: 0,
      ...extra,
    });

    const buildTracks = (options: { sidechain?: any; sourceVolume?: number }) => [
      baseTrack(0, 'Master'),
      baseTrack(1, 'Source', { volume: options.sourceVolume ?? 1 }),
      baseTrack(2, 'Dest', options.sidechain ? { sidechain: options.sidechain } : {}),
    ];

    const goertzelMagnitude = (data: Float32Array, frequency: number, sampleRate: number, from: number, to: number) => {
      const omega = (2 * Math.PI * frequency) / sampleRate;
      const coeff = 2 * Math.cos(omega);
      let s1 = 0;
      let s2 = 0;
      let windowSum = 0;
      const start = Math.max(0, Math.floor(from * sampleRate));
      const end = Math.min(data.length, Math.floor(to * sampleRate));
      const frames = Math.max(1, end - start);
      for (let i = start; i < end; i += 1) {
        // Hann window: without it, the loud source note leaks into this band.
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - start)) / frames);
        windowSum += hann;
        const s0 = data[i] * hann + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const real = s1 - s2 * Math.cos(omega);
      const imaginary = s2 * Math.sin(omega);
      return (2 * Math.sqrt(real * real + imaginary * imaginary)) / Math.max(1, windowSum);
    };

    const db = (value: number) => 20 * Math.log10(Math.max(value, 1e-9));

    const measure = (buffer: AudioBuffer) => {
      const data = buffer.getChannelData(0);
      return {
        // Second source hit starts at 1.0 s; 1.05-1.15 s is fully inside the
        // duck after the attack. 1.6-1.9 s is well past the release.
        hit: db(goertzelMagnitude(data, destFrequency, buffer.sampleRate, 1.05, 1.15)),
        quiet: db(goertzelMagnitude(data, destFrequency, buffer.sampleRate, 1.6, 1.9)),
        firstHit: db(goertzelMagnitude(data, destFrequency, buffer.sampleRate, 0.05, 0.15)),
        peak: data.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
        frames: data.length,
        sampleRate: buffer.sampleRate,
      };
    };

    const renderVariant = async (options: {
      sidechain?: any;
      sourceVolume?: number;
      sourceKind?: 'notes' | 'audioClip' | 'silent';
      durationSeconds?: number;
      minimumDurationSeconds?: number;
    }) => {
      const sourceVolume = options.sourceVolume ?? 1;
      const sourceKind = options.sourceKind ?? 'notes';
      let channels = [sourceChannel, destChannel];
      let renderClips = clips;
      const sampleBuffers = new Map<string, AudioBuffer>();

      if (sourceKind === 'audioClip') {
        // A sustained 110 Hz tone as an audio clip on the source lane, with no
        // note events anywhere on the source track.
        const liveCtx = e.getContext();
        const buffer = liveCtx.createBuffer(1, Math.floor(liveCtx.sampleRate * 1.9), liveCtx.sampleRate);
        const channelData = buffer.getChannelData(0);
        for (let i = 0; i < channelData.length; i += 1) {
          channelData[i] = 0.6 * Math.sin((2 * Math.PI * 110 * i) / liveCtx.sampleRate);
        }
        sampleBuffers.set('sc-source-clip', buffer);
        channels = [
          { ...sourceChannel, notes: [] },
          destChannel,
        ];
        renderClips = [
          // @ts-ignore
          { id: 'sc-audio-clip', type: 'audio', trackIndex: 0, startBar: 0, lengthBars: 1, audioBufferId: 'sc-source-clip', color: '#f59e0b', name: 'Source Clip' },
          clips[1],
        ] as any;
      } else if (sourceKind === 'silent') {
        channels = [{ ...sourceChannel, notes: [] }, destChannel];
        renderClips = [clips[1]] as any;
      }

      e.sampleBuffers = sampleBuffers;
      e.setProjectSampleBufferOwnership([...sampleBuffers.keys()]);
      e.setBpm(bpm);
      e.setMasterVolume(1);
      const buffer = await e.renderTimelineOffline(
        channels,
        renderClips,
        buildTracks({ sidechain: options.sidechain, sourceVolume }),
        bpm,
        1,
        44100,
        false,
        'song',
        undefined,
        undefined,
        undefined,
        options.minimumDurationSeconds ?? 2,
      );
      return measure(buffer);
    };

    const levelSettings = (overrides: Record<string, unknown> = {}) => ({
      enabled: true,
      sourceTrackId: 1,
      amount: 0.9,
      attackMs: 2,
      releaseMs: 80,
      mode: 'level-detected',
      thresholdDb: -30,
      ratio: 8,
      ...overrides,
    });

    (window as any).__sidechainFixture = {
      renderVariant,
      levelSettings,
      measure,
      makeChannels: () => ({ channels: [sourceChannel, destChannel], clips, buildTracks, bpm }),
      destPitch,
      destFrequency,
    };
  });
};

const openFixturePage = async (page: import('@playwright/test').Page) => {
  await page.route(APP_URL, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(APP_URL);
  await installFixture(page);
};

test('master export: source audio really attenuates the destination', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    const fixture = (window as any).__sidechainFixture;
    const baseline = await fixture.renderVariant({});
    const ducked = await fixture.renderVariant({ sidechain: fixture.levelSettings() });
    return { baseline, ducked };
  });

  const hitReductionDb = result.baseline.hit - result.ducked.hit;
  const quietReductionDb = result.baseline.quiet - result.ducked.quiet;
  expect(result.ducked.frames).toBeGreaterThan(0);
  expect(hitReductionDb).toBeGreaterThan(6);
  expect(Math.abs(quietReductionDb)).toBeLessThan(1.5);
});

test('below-threshold source audio causes no material attenuation', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    const fixture = (window as any).__sidechainFixture;
    // A quiet source (-30 dBFS peak range) against a -6 dBFS detector threshold.
    const baseline = await fixture.renderVariant({ sourceVolume: 0.05 });
    const belowThreshold = await fixture.renderVariant({
      sourceVolume: 0.05,
      sidechain: fixture.levelSettings({ thresholdDb: -6, ratio: 20, amount: 1 }),
    });
    return { baseline, belowThreshold };
  });

  expect(Math.abs(result.baseline.hit - result.belowThreshold.hit)).toBeLessThan(1);
});

test('a quieter source ducks less with identical settings', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    const fixture = (window as any).__sidechainFixture;
    const settings = () => fixture.levelSettings({ thresholdDb: -45, ratio: 4 });
    const baselineLoud = await fixture.renderVariant({ sourceVolume: 1 });
    const baselineQuiet = await fixture.renderVariant({ sourceVolume: 0.15 });
    const loud = await fixture.renderVariant({ sidechain: settings(), sourceVolume: 1 });
    const quiet = await fixture.renderVariant({ sidechain: settings(), sourceVolume: 0.15 });
    return { baselineLoud, baselineQuiet, loud, quiet };
  });

  // The detector taps the source track post-fader, so lowering that fader
  // lowers the detected level and therefore the duck depth.
  const loudReduction = result.baselineLoud.hit - result.loud.hit;
  const quietReduction = result.baselineQuiet.hit - result.quiet.hit;
  expect(loudReduction).toBeGreaterThan(3);
  expect(loudReduction).toBeGreaterThan(quietReduction + 2);
});

test('an audio clip with zero note events triggers real ducking', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    const fixture = (window as any).__sidechainFixture;
    const baseline = await fixture.renderVariant({ sourceKind: 'audioClip', sourceVolume: 1 });
    const ducked = await fixture.renderVariant({ sourceKind: 'audioClip', sidechain: fixture.levelSettings() });
    return { baseline, ducked };
  });

  // The audio clip runs from bar start, so the first-hit window is measured.
  expect(result.baseline.firstHit - result.ducked.firstHit).toBeGreaterThan(4);
});

test('a self-routed sidechain leaves the destination untouched', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    const fixture = (window as any).__sidechainFixture;
    const baseline = await fixture.renderVariant({});
    const selfRouted = await fixture.renderVariant({ sidechain: fixture.levelSettings({ sourceTrackId: 2 }) });
    return { baseline, selfRouted };
  });

  expect(Math.abs(result.baseline.hit - result.selfRouted.hit)).toBeLessThan(0.5);
  expect(Math.abs(result.baseline.quiet - result.selfRouted.quiet)).toBeLessThan(0.5);
});

test('repeated exports are deterministic', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    const fixture = (window as any).__sidechainFixture;
    const settings = fixture.levelSettings();
    const first = await fixture.renderVariant({ sidechain: settings });
    const second = await fixture.renderVariant({ sidechain: settings });
    return {
      first,
      second,
      // The export's detector handles live in the render's own context; after
      // the render the live graph must hold none of them.
      leakedDetector: e.hasSidechainDetector(2),
    };
  });

  expect(result.second.hit).toBeCloseTo(result.first.hit, 5);
  expect(result.second.peak).toBeCloseTo(result.first.peak, 5);
  expect(result.leakedDetector).toBe(false);
});

test('live playback attaches a real detector and measures reduction', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    const fixture = (window as any).__sidechainFixture;
    const { channels, clips, buildTracks, bpm } = fixture.makeChannels();
    e.init();
    const liveCtx = e.getContext();
    await liveCtx.resume();
    e.setBpm(bpm);
    e.setMasterVolume(1);
    e.sampleBuffers = new Map();

    const readings: number[] = [];
    const unsubscribe = e.onSidechainReduction((snapshot: { trackId: number; reductionDb: number }) => {
      if (snapshot.trackId === 2) readings.push(snapshot.reductionDb);
    });
    try {
      e.play(
        channels,
        clips,
        'song',
        undefined,
        buildTracks({ sidechain: fixture.levelSettings() }),
      );
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const attached = e.hasSidechainDetector(2);
      const maxReduction = readings.reduce((max, value) => Math.max(max, value), 0);
      e.stop();
      return { attached, maxReduction, samples: readings.length, reported: e.getSidechainReductionDb(2) };
    } finally {
      unsubscribe();
      e.stop();
    }
  });

  expect(result.attached).toBe(true);
  expect(result.samples).toBeGreaterThan(3);
  expect(result.maxReduction).toBeGreaterThan(4);
});

test('the same project rendered live and offline reports matching duck depth', async ({ page }) => {
  test.setTimeout(120_000);
  await openFixturePage(page);

  const result = await page.evaluate(async () => {
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    const fixture = (window as any).__sidechainFixture;
    const { channels, clips, buildTracks, bpm } = fixture.makeChannels();
    const settings = fixture.levelSettings();
    const offline = await fixture.renderVariant({ sidechain: settings });
    const baseline = await fixture.renderVariant({});
    const offlineReduction = baseline.hit - offline.hit;

    e.init();
    const liveCtx = e.getContext();
    await liveCtx.resume();
    e.setBpm(bpm);
    e.setMasterVolume(1);
    e.sampleBuffers = new Map();
    const readings: number[] = [];
    const unsubscribe = e.onSidechainReduction((snapshot: { trackId: number; reductionDb: number }) => {
      if (snapshot.trackId === 2) readings.push(snapshot.reductionDb);
    });
    try {
      e.play(channels, clips, 'song', undefined, buildTracks({ sidechain: settings }));
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      e.stop();
      return {
        offlineReduction,
        liveReduction: readings.reduce((max, value) => Math.max(max, value), 0),
      };
    } finally {
      unsubscribe();
      e.stop();
    }
  });

  expect(result.offlineReduction).toBeGreaterThan(3);
  expect(result.liveReduction).toBeGreaterThan(3);
  // Both paths run the same detector; the measured duck depths agree within 4 dB
  // (the live window samples the envelope, the export measures a fixed window).
  expect(Math.abs(result.offlineReduction - result.liveReduction)).toBeLessThan(4);
});
