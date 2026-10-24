import { test, expect, type Page } from '@playwright/test';

// Real IndexedDB assets, decoding, shared scheduler/mixer, and the WAV encoder
// used by ExportModal. No replacement AudioContext, scheduler or PCM renderer.
async function fixture(page: Page, meter: [number, number] = [7, 8]) {
  // Isolated same-origin document: the App's live project re-sync callback
  // must not replace this test project's meter/mastering after each render.
  await page.route('http://localhost:3000/phase6c-harness', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Production export harness</title>',
  }));
  await page.goto('http://localhost:3000/phase6c-harness');
  await page.evaluate(async (meter) => {
    // @ts-ignore Vite browser module
    const { audioEngine: engine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore Vite browser module
    const { audioBufferToWav } = await import('/src/audio/wavEncoder.ts');
    // @ts-ignore Vite browser module
    const { persistAudioClip } = await import('/src/audio/audioPersistence.ts');
    // @ts-ignore Vite browser module
    const { hydrateProjectAudio } = await import('/src/state/projectPersistence.ts');
    const rate = engine.getContext().sampleRate;
    engine.setTimeSignature(meter);
    // A project with mastering bypassed has analytically checkable PCM. It
    // still traverses the production master/mixer, not a pre-master shortcut.
    engine.setMasteringState({ enabled: false });
    const bpm = (meter[0] * 4 / meter[1]) * 30; // exactly two seconds/bar
    const channel = { id: 'audio-owner', name: 'Audio owner', color: '#123456', instrumentType: 'minisynth',
      mixerTrackId: 1, volume: 0.5, pan: 0, pitch: 0, synthParams: engine.getDefaultSynthParams(), mute: false, solo: false, steps: Array(16).fill(false), notes: [] };
    const tracks = [0, 1].map(id => ({ id, name: `Bus ${id}`, color: '#123456', volume: 1, pan: 0,
      mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] }));
    const a = { id: 'clip-a', type: 'audio', name: 'Persisted A', audioBufferId: 'phase6c-a', audioUnavailable: true,
      trackIndex: 0, channelId: channel.id, startBar: 0.25, lengthBars: 0.125,
      offsetSteps: (meter[0] * 16 / meter[1]) / 4, color: '#123456' };
    const b = { ...a, id: 'clip-b', name: 'Persisted B', audioBufferId: 'phase6c-b', startBar: 0.3125 };
    // Quarter-second regions distinguish correct trimming/rate from buffer-zero
    // playback. Stereo signs/levels distinguish the two assets and their sum.
    for (const [id, left, right] of [
      ['phase6c-a', [0.03125, -0.03125, 0.125, 0.25, -0.125, 0.0625, 0.2, -0.2],
        [0.015625, 0.03125, 0.0625, -0.0625, 0.125, -0.125, 0.1, -0.1]],
      ['phase6c-b', Array(8).fill(-0.03125), Array(8).fill(0.09375)],
    ] as [string, number[], number[]][]) {
      const buffer = engine.getContext().createBuffer(2, rate * 2, rate);
      for (let c = 0; c < 2; c++) {
        const values = c === 0 ? left : right;
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) data[i] = values[Math.min(7, Math.floor(i / rate * 4))];
      }
      await persistAudioClip(id, audioBufferToWav(buffer, 32));
    }
    const project = { channels: [channel], playlistClips: [a, b], recordings: [], sampleLibrary: [] };
    const hydrated = await hydrateProjectAudio(project, engine);
    const clips = hydrated.state.playlistClips;
    const render = async (items: any[], channels = [channel]) => engine.renderTimelineOffline(
      channels, items, tracks, bpm, 2, rate, true, 'song');
    const wav = async (buffer: AudioBuffer) => {
      const bytes = await audioBufferToWav(buffer, 32).arrayBuffer();
      const view = new DataView(bytes);
      const pcm = [new Float32Array(buffer.length), new Float32Array(buffer.length)];
      for (let i = 0; i < buffer.length; i++) for (let c = 0; c < 2; c++) {
        pcm[c][i] = view.getFloat32(44 + (i * 2 + c) * 4, true);
        if (pcm[c][i] !== buffer.getChannelData(c)[i]) throw new Error('WAV differs from rendered PCM');
      }
      return { pcm, bytes, frames: buffer.length, format: view.getUint16(20, true), rate: view.getUint32(24, true) };
    };
    const peak = (pcm: Float32Array[], start: number, end: number) => {
      let max = 0;
      for (const ch of pcm) for (let i = Math.ceil(start * rate); i < Math.floor(end * rate); i++) max = Math.max(max, Math.abs(ch[i]));
      return max;
    };
    const support = (pcm: Float32Array[]) => {
      let first = -1, last = -1;
      for (let i = 0; i < pcm[0].length; i++) if (pcm.some(ch => ch[i] !== 0)) {
        if (first < 0) first = i;
        last = i;
      }
      return [first, last];
    };
    const probe = (pcm: Float32Array[], seconds: number) => pcm.map(ch => ch[Math.round(seconds * rate)]);
    const hash = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    (window as any).__audioExport = { engine, clips, channel, render, wav, peak, probe, support, hash, rate,
      hydrated: hydrated.hydratedAudioIds, missing: hydrated.missingAudioIds, project: hydrated.state };
  }, meter);
}

for (const meter of [[4, 4], [3, 4], [7, 8]] as [number, number][]) {
  test(`persisted clip reaches production WAV at quarter-bar in ${meter.join('/')}`, async ({ page }) => {
    await fixture(page, meter);
    const result = await page.evaluate(async () => {
      const f = (window as any).__audioExport;
      const before = JSON.stringify(f.project);
      const out = await f.wav(await f.render([f.clips[0]]));
      const repeat = await f.wav(await f.render([f.clips[0]]));
      const muted = await f.wav(await f.render([{ ...f.clips[0], mute: true }]));
      return { hydrated: f.hydrated, missing: f.missing, sample: f.probe(out.pcm, 0.6),
        support: f.support(out.pcm), rate: out.rate, pre: f.peak(out.pcm, 0, 0.5), post: f.peak(out.pcm, 0.75, 4),
        muted: f.peak(muted.pcm, 0, 4), duration: out.frames / out.rate, format: out.format,
        hash: await f.hash(out.bytes), repeatHash: await f.hash(repeat.bytes), unchanged: before === JSON.stringify(f.project) };
    });
    console.log('[playlist-audio-wav]', meter, result);
    expect(result.hydrated.sort()).toEqual(['phase6c-a', 'phase6c-b']);
    expect(result.missing).toEqual([]);
    expect(result.sample[0]).toBeCloseTo(0.125 * 0.5, 6);
    expect(result.sample[1]).toBeCloseTo(0.0625 * 0.5, 6);
    expect(result.support).toEqual([result.rate * 0.5, result.rate * 0.75 - 1]);
    expect(result.pre).toBe(0);
    expect(result.post).toBe(0);
    expect(result.muted).toBe(0);
    expect(result.duration).toBe(4);
    expect(result.format).toBe(3);
    expect(result.hash).toBe(result.repeatHash);
    expect(result.unchanged).toBe(true);
  });
}

test('fractional-step overlap sums the intended assets; trim and rate retain source semantics', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__audioExport;
    const both = await f.wav(await f.render(f.clips));
    const onlyB = await f.wav(await f.render([f.clips[1]]));
    const fast = await f.wav(await f.render([{ ...f.clips[0], timeStretchRate: 2 }]));
    return { a: f.probe(both.pcm, 0.55), overlap: f.probe(both.pcm, 0.7), b: f.probe(both.pcm, 0.8),
      onlyB: f.probe(onlyB.pcm, 0.7), absentA: f.peak(onlyB.pcm, 0, 0.625),
      fastFirst: f.probe(fast.pcm, 0.55), fastSecond: f.probe(fast.pcm, 0.7),
      pre: f.peak(both.pcm, 0, 0.5), post: f.peak(both.pcm, 0.875, 4) };
  });
  console.log('[playlist-overlap-wav]', result);
  for (const [actual, expected] of [
    [result.a, [0.0625, 0.03125]], [result.overlap, [0.046875, 0.078125]],
    [result.b, [-0.015625, 0.046875]], [result.onlyB, [-0.015625, 0.046875]],
    [result.fastFirst, [-0.0625, 0.0625]], [result.fastSecond, [0.03125, -0.0625]],
  ]) for (let c = 0; c < 2; c++) expect(actual[c]).toBeCloseTo(expected[c], 6);
  expect(result.absentA).toBe(0);
  expect(result.pre).toBe(0);
  expect(result.post).toBe(0);
});

test('pattern-only exports are deterministic and missing/unreadable assets reject without poisoning later export', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__audioExport;
    // A sample-backed pattern has no filter-tail/ended-callback rounding
    // variation: require bit-identical WAV, not a relaxed PCM tolerance.
    const channel = { ...f.channel, instrumentType: 'drumpad',
      drumPads: [{ note: 60, sampleId: 'phase6c-a', volume: 1, pan: 0, trimStart: 0, trimEnd: 0.125 }],
      notes: [{ id: 'n', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] };
    const pattern = { id: 'pattern', type: 'pattern', channelId: channel.id, trackIndex: 0, startBar: 0, lengthBars: 1 };
    const first = await f.wav(await f.render([pattern], [channel]));
    const errors = [];
    for (const clip of [{ ...f.clips[0], audioBufferId: 'absent' }, { ...f.clips[0], audioUnavailable: true }]) {
      try { await f.render([clip]); errors.push('DID NOT REJECT'); } catch (e) { errors.push(String(e)); }
    }
    // Real decoder must reject corrupt bytes, never register a silent substitute.
    try { await f.engine.loadAudioFile(new Blob(['not audio']), 'corrupt'); errors.push('DID NOT REJECT'); }
    catch { errors.push('decode rejected'); }
    try { await f.render([{ ...f.clips[0], audioBufferId: 'corrupt' }]); errors.push('DID NOT REJECT'); }
    catch (e) { errors.push(String(e)); }
    const again = await f.wav(await f.render([pattern, { ...f.clips[0], mute: true }], [channel]));
    let maxDiff = 0, changed = 0, firstDifference = null;
    for (let c = 0; c < 2; c++) for (let i = 0; i < first.frames; i++) {
      const d = Math.abs(first.pcm[c][i] - again.pcm[c][i]);
      if (d) { changed++; if (!firstDifference) firstDifference = [c, i, first.pcm[c][i], again.pcm[c][i]]; }
      maxDiff = Math.max(maxDiff, d);
    }
    return { maxDiff, changed, firstDifference, peak: f.peak(first.pcm, 0, 4), first: await f.hash(first.bytes), again: await f.hash(again.bytes), errors };
  });
  console.log('[playlist-pattern-wav]', result);
  expect(result.peak).toBeGreaterThan(0.001);
  expect(result.maxDiff).toBe(0);
  expect(result.first).toBe(result.again);
  expect(result.errors[0]).toContain('Missing audio buffer');
  expect(result.errors[1]).toContain('unavailable audio asset');
  expect(result.errors[2]).toBe('decode rejected');
  expect(result.errors[3]).toContain('Missing audio buffer');
});


test('a fractional audio onset after the first bar is neither dropped nor retriggered', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).__audioExport;
    const out = await f.wav(await f.render([{ ...f.clips[0], startBar: 1.25 }]));
    return { sample: f.probe(out.pcm, 2.6), support: f.support(out.pcm), rate: out.rate,
      pre: f.peak(out.pcm, 0, 2.5), post: f.peak(out.pcm, 2.75, 4) };
  });
  expect(result.sample).toEqual([0.0625, 0.03125]);
  expect(result.support).toEqual([result.rate * 2.5, result.rate * 2.75 - 1]);
  expect(result.pre).toBe(0);
  expect(result.post).toBe(0);
});
