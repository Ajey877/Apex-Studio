import { expect, test } from '@playwright/test';

const URL = 'http://localhost:3000';

test('whole-pattern Draw, duplicate, retarget, undo/redo and reload keep scope and references', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#nav-playlist').click();
  const arranger = page.locator('#fl-playlist-arranger');
  await arranger.locator('[data-playlist-cell="4:10"]').click();
  const full = arranger.locator('[data-pattern-scope="all"]').first();
  await expect(full).toContainText('Main Groove');
  await expect(full).toContainText('All instruments');
  await expect(arranger.locator('[data-clip-id="clip-1"]')).toHaveAttribute('data-pattern-scope', 'channel');
  await full.click();
  await arranger.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(arranger.locator('[data-pattern-scope="all"]')).toHaveCount(2);
  const picker = arranger.locator('#selected-clip-pattern');
  await picker.selectOption({ label: 'Melody & Pluck' });
  await page.locator('#nav-channel-rack').click(); // remove SELECT focus before shortcut
  await page.keyboard.press('Control+z');
  await page.locator('#nav-playlist').click();
  await expect(arranger.locator('[data-pattern-scope="all"]').last()).toContainText('Main Groove');
  await page.keyboard.press('Control+Shift+z');
  await expect(arranger.locator('[data-pattern-scope="all"]').last()).toContainText('Melody & Pluck');
  await expect.poll(async () => page.evaluate(async () => {
    // @ts-ignore Vite module
    const p = await import('/src/audio/audioPersistence.ts');
    const saved = await p.getPersistedProjectStateRecord();
    return saved && JSON.parse(saved).state.playlistClips.filter((c: any) => c.patternScope === 'all').map((c: any) => c.patternId);
  })).toEqual(['pat-1', 'pat-2']);
  await page.reload();
  await page.locator('#nav-playlist').click();
  await expect(arranger.locator('[data-pattern-scope="all"]')).toHaveCount(2);
  await expect(arranger.locator('[data-pattern-scope="all"]').last()).toContainText('Melody & Pluck');
});

test('real browser DSP: one full clip equals three channel clips; WAV/stems/MIDI, live routes, lane bounce and audio reload', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(URL);
  const result = await page.evaluate(async () => {
    // @ts-ignore Vite module
    const { audioEngine: engine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    // @ts-ignore
    const { serializeProjectState, hydrateProjectAudio } = await import('/src/state/projectPersistence.ts');
    // @ts-ignore
    const { buildStandardMidiFile } = await import('/src/utils/exportUtils.ts');
    // @ts-ignore
    const { MidiParser } = await import('/src/utils/midiParser.ts');
    engine.init();
    engine.setBpm(120); engine.setSwing(0); engine.setTimeSignature([4,4]);
    engine.setGrossBeatState({ enabled: false });
    const ctx = engine.getContext();
    const sample = ctx.createBuffer(1, 2205, 44100);
    for (let i = 0; i < sample.length; i++) sample.getChannelData(0)[i] = Math.sin(i * .19) * Math.exp(-i / 220);
    engine.setSampleBuffer('full-pattern-drum', sample);
    const state = createDefaultProjectState();
    state.meta.bpm = 120; state.meta.swing = 0;
    const note = (pitch: number, start: number) => ({ id: `${pitch}`, pitch, start, duration: 2, velocity: .65 });
    const base = { ...state.channels[0], steps: Array(16).fill(false), volume: .3, pan: 0,
      synthParams: { ...engine.getDefaultSynthParams(), osc1Type: 'sine', osc2Mix: 0, attack: .001, release: .01, lfoDepth: 0 } };
    state.channels = [
      { ...base, id: 'kick', name: 'Kick', instrumentType: 'drumpad', mixerTrackId: 1, steps: [true, ...Array(15).fill(false)], notes: [], drumPads: [{ id: 'pad', note: 36, name: 'Kick', sampleId: 'full-pattern-drum', volume: 1, pan: 0, tuneSemitones: 0 }] },
      { ...base, id: 'snare', name: 'Snare', instrumentType: 'drumpad', mixerTrackId: 2, notes: [note(38,4)], drumPads: [{ id: 'pad2', note: 38, name: 'Snare', sampleId: 'full-pattern-drum', volume: 1, pan: 0, tuneSemitones: 0 }] },
      { ...base, id: 'melody', name: 'Melody', instrumentType: 'minisynth', mixerTrackId: 3, notes: [note(67,8)] },
    ];
    state.patterns = [{ id: 'p', name: 'Trio', lengthSteps: 16, color: '#fff' }];
    state.selectedPatternId = 'p';
    state.mixerTracks = [0,1,2,3,4,5].map(id => ({ id, name: `Track ${id}`, volume: 1, pan: 0, mute: false, solo: false, color: '#fff', peakL: 0, peakR: 0, fxSlots: [] }));
    // Actual insert/bus/aux/master graph, not mocked routing.
    state.mixerTracks[0].fxSlots = [{ id: 'master-eq', type: 'equalizer', name: 'Master EQ', enabled: true, mix: 1, params: { midGain: 2 } }];
    state.mixerTracks[3].routingTargetId = 4;
    state.mixerTracks[4].volume = .7;
    state.mixerTracks[2].auxSends = [{ targetId: 5, amount: .3 }];
    state.mixerTracks[5].isAux = true;
    state.mixerTracks[5].fxSlots = [{ id: 'return-delay', type: 'delay', name: 'Return delay', enabled: true, mix: 1, params: { time: .35, feedback: .15 } }];
    const full = { id: 'full', type: 'pattern', patternScope: 'all', patternId: 'p', name: 'Trio', color: '#fff', trackIndex: 0, startBar: 0, lengthBars: 1 };
    const automation = { id: 'auto', type: 'automation', trackIndex: 1, startBar: 0, lengthBars: 1, color: '#fff', name: 'Melody volume',
      automationTarget: { type: 'channel_vol', targetId: 'melody' }, automationPoints: [{ x: 0, y: .4 }, { x: 1, y: .4 }] };
    const render = (clips: any[], channels = state.channels) => engine.renderTimelineOffline(channels, [...clips, automation], state.mixerTracks, 120, 1, 44100, true, 'song', undefined, undefined, state.playlistTracks, 0, state.patterns);
    const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, x) => sum+x*x, 0) / data.length);
    const energy = (b: AudioBuffer) => [0, .5, 1].map(t => rms(b.getChannelData(0).subarray(Math.floor((t+.01)*b.sampleRate), Math.floor((t+.06)*b.sampleRate))));
    const mix = await render([full]);
    const ref = await render(state.channels.map((c: any, i: number) => ({ ...full, id: `legacy${i}`, patternScope: undefined, channelId: c.id })));
    let diff = 0;
    const l = mix.getChannelData(0), r = ref.getChannelData(0);
    for (let i=0; i<l.length; i++) diff = Math.max(diff, Math.abs(l[i]-r[i]));
    const muted = await render([full], state.channels.map((c: any) => ({ ...c, mute: c.id === 'snare' })));
    const midi = await MidiParser.parseMidiFile(await buildStandardMidiFile(state.channels, [full], state.meta, { patterns: state.patterns }).arrayBuffer());
    const wav = await engine.renderProjectToWav(state.channels, [full, automation], 120, 1, 32, state.mixerTracks, true, state.playlistTracks, state.patterns);
    const stems = await engine.renderProjectStems(state.channels, [full, automation], state.mixerTracks, 120, 1, 32, 'song', undefined, state.playlistTracks, true, state.patterns);
    const stemEnergy: Record<string, number[]> = {};
    for (const [id, blob] of Object.entries(stems.stems)) {
      const decoded = await ctx.decodeAudioData(await (blob as Blob).arrayBuffer());
      stemEnergy[id] = [...energy(decoded), rms(decoded.getChannelData(0))];
    }
    const bounce = await engine.bouncePlaylistLaneToAudioClip(state.channels, [full, automation], state.patterns, state.mixerTracks, state.playlistTracks, 0, 120);
    engine.setSampleBuffer('bounce', bounce.buffer);
    const audio = { ...full, id: 'audio', type: 'audio', patternScope: undefined, patternId: undefined, audioBufferId: 'bounce', audioMixerTrackId: 0 };
    state.playlistClips = [full, audio];
    // Persist PCM to IndexedDB, discard engine buffers, and hydrate a serialized reload.
    // @ts-ignore Vite module
    const { persistAudioClip } = await import('/src/audio/audioPersistence.ts');
    // @ts-ignore
    const { audioBufferToWav } = await import('/src/audio/wavEncoder.ts');
    await persistAudioClip('bounce', audioBufferToWav(bounce.buffer, 32));
    await persistAudioClip('full-pattern-drum', audioBufferToWav(sample, 32));
    const saved = JSON.parse(serializeProjectState(state));
    engine.setProjectSampleBufferOwnership(['bounce', 'full-pattern-drum']);
    engine.setProjectSampleBufferOwnership([]);
    const hydrated = await hydrateProjectAudio(saved.state, engine);
    if (hydrated.missingAudioIds.length) throw new Error('Audio reload lost buffers');
    const audioMix = await render([audio]);
    const calls: Array<[string, number, number]> = [];
    const original = engine.playNote;
    engine.playNote = function(c: any, n: any, t: number, bpm: number) { calls.push([c.id, c.mixerTrackId, n.pitch]); return original.call(this,c,n,t,bpm); };
    try {
      engine.play(state.channels, [full, automation], 'song', 'p', state.mixerTracks, 16, state.playlistTracks, state.patterns);
      await new Promise(resolve => setTimeout(resolve, 1400));
    } finally { engine.stop(); engine.playNote = original; }
    return { diff, energy: energy(mix), muted: energy(muted), midi: midi.map((t: any) => [t.name, t.notes.map((n: any) => [n.pitch,n.startStep])]),
      wav: energy(await ctx.decodeAudioData(await wav.arrayBuffer())), stemEnergy, bounce: energy(bounce.buffer), audio: energy(audioMix),
      persisted: saved.state.playlistClips.map((c: any) => [c.patternScope ?? null,c.patternId ?? null,c.audioBufferId ?? null,c.audioMixerTrackId ?? null]), calls };
  });
  expect(result.diff).toBeLessThan(1e-6);
  result.energy.forEach(e => expect(e).toBeGreaterThan(.001));
  expect(result.muted[1]).toBeLessThan(1e-6);
  expect(result.midi).toEqual([['Kick', [[36,0]]], ['Snare', [[38,4]]], ['Melody', [[67,8]]]]);
  result.wav.forEach(e => expect(e).toBeGreaterThan(.001));
  expect(result.stemEnergy['kick_Kick.wav'][0]).toBeGreaterThan(.001);
  expect(result.stemEnergy['snare_Snare.wav'][1]).toBeGreaterThan(.001);
  expect(result.stemEnergy['melody_Melody.wav'][2]).toBeGreaterThan(.001);
  result.bounce.forEach(e => expect(e).toBeGreaterThan(.001));
  // Audio clips retain the established 2ms safety fade at their outer edge.
  // It changes the very first kick attack, not later onsets or routing/master processing.
  result.audio.forEach(e => expect(e).toBeGreaterThan(.001));
  expect(result.audio[0]).toBeLessThan(result.energy[0]);
  for (const i of [1, 2]) expect(Math.abs(result.audio[i]-result.energy[i])).toBeLessThan(1e-5);
  expect(Object.keys(result.stemEnergy)).toContain('return_5_Track_5.wav');
  expect(result.stemEnergy['return_5_Track_5.wav'].some(e => e > 1e-6)).toBe(true);
  expect(result.persisted).toEqual([['all','p',null,null],[null,null,'bounce',0]]);
  expect(result.calls).toEqual([['kick',1,36],['snare',2,38],['melody',3,67]]);
});
