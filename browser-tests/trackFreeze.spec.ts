import { expect, test } from '@playwright/test';

const URL = 'http://localhost:3000';

/**
 * Phase 10H — Track Freeze / Unfreeze, measured in a real browser with the real
 * Web Audio graph. Nothing here is mocked: every comparison is between PCM the
 * production engine rendered or played.
 */

// Shared in-page fixture: a small project with inserts, a bus, an aux return,
// note-triggered sidechain, channel automation and mixer automation.
const FIXTURE = `
  const { audioEngine: engine } = await import('/src/audio/audioEngine.ts');
  const { createDefaultProjectState } = await import('/src/state/projectState.ts');
  const freezeState = await import('/src/state/trackFreeze.ts');
  engine.init();
  const ctx = engine.getContext();
  const rate = ctx.sampleRate;
  const state = createDefaultProjectState();
  // The running app owns the engine's tempo, swing and meter and re-publishes
  // them after every offline render, so the fixture adopts the app's values
  // instead of fighting it. The measurements do not depend on what they are.
  const internals = engine;
  state.meta.bpm = internals.bpm; state.meta.swing = internals.swing; state.meta.timeSignature = [...internals.meter];
  const BPM = state.meta.bpm;
  engine.setGrossBeatState({ enabled: false });
  const note = (pitch, start, duration = 2) => ({ id: 'n' + pitch + '-' + start, pitch, start, duration, velocity: 0.7 });
  const base = { ...state.channels[0], steps: Array(16).fill(false), notes: [], mute: false, solo: false, pitch: 0,
    arp: undefined, customSample: undefined, drumPads: undefined, sampleZones: undefined, midiOutput: undefined,
    synthParams: { ...engine.getDefaultSynthParams(), osc1Type: 'sine', osc2Mix: 0, attack: 0.001, release: 0.05, lfoDepth: 0, humanize: 0, vibratoDepth: 0 } };
  const lead = { ...base, id: 'lead', name: 'Lead', instrumentType: 'minisynth', mixerTrackId: 1, volume: 0.6, pan: -0.3,
    notes: [note(64, 0), note(67, 4), note(71, 8), note(72, 12)] };
  const bass = { ...base, id: 'bass', name: 'Bass', instrumentType: 'minisynth', mixerTrackId: 2, volume: 0.5, pan: 0.2,
    notes: [note(40, 0, 4), note(43, 8, 4)] };
  state.channels = [lead, bass];
  state.patterns = [{ id: 'p', name: 'Main', lengthSteps: 16, color: '#fff' }];
  state.selectedPatternId = 'p';
  state.mixerTracks = [0, 1, 2, 3, 4].map(id => ({ id, name: 'Track ' + id, volume: 1, pan: 0, mute: false, solo: false, color: '#fff', peakL: 0, peakR: 0, fxSlots: [] }));
  state.mixerTracks[1].fxSlots = [{ id: 'lead-eq', type: 'equalizer', name: 'EQ', enabled: true, mix: 1, params: { midGain: 3 } }];
  state.mixerTracks[1].auxSends = [{ targetId: 3, amount: 0.4 }];
  state.mixerTracks[1].volume = 0.9; state.mixerTracks[1].pan = 0.1;
  state.mixerTracks[3].isAux = true;
  state.mixerTracks[3].fxSlots = [{ id: 'ret-delay', type: 'delay', name: 'Delay', enabled: true, mix: 1, params: { time: 0.2, feedback: 0.2 } }];
  state.mixerTracks[2].routingTargetId = 4;
  state.mixerTracks[4].volume = 0.8;
  // Bass is ducked by the lead's notes (note-triggered sidechain).
  state.mixerTracks[2].sidechain = { enabled: true, sourceTrackId: 1, amount: 0.8, attack: 0.005, release: 0.12 };
  state.playlistTracks = state.playlistTracks.map(t => ({ ...t, mute: false, solo: false }));
  const clip = (id, extra) => ({ id, type: 'pattern', patternId: 'p', color: '#fff', name: id, trackIndex: 0, startBar: 0, lengthBars: 1, ...extra });
  state.playlistClips = [
    clip('lead-a', { channelId: 'lead', trackIndex: 0, startBar: 0, lengthBars: 2 }),
    clip('bass-a', { channelId: 'bass', trackIndex: 1, startBar: 0, lengthBars: 2 }),
    clip('full', { patternScope: 'all', trackIndex: 2, startBar: 2, lengthBars: 1 }),
    { id: 'lead-vol', type: 'automation', trackIndex: 3, startBar: 0, lengthBars: 3, color: '#fff', name: 'Lead vol',
      automationTarget: { type: 'channel_vol', targetId: 'lead' }, automationPoints: [{ x: 0, y: 0.8 }, { x: 1, y: 0.35 }] },
    { id: 'ins-vol', type: 'automation', trackIndex: 4, startBar: 0, lengthBars: 3, color: '#fff', name: 'Insert vol',
      automationTarget: { type: 'mixer_vol', targetId: 1 }, automationPoints: [{ x: 0, y: 0.5 }, { x: 1, y: 0.7 }] },
  ];
  const BARS = 3;
  const SECONDS = 7;
  const render = (s, stage = 'pre-master') => engine.renderTimelineOffline(s.channels, s.playlistClips, s.mixerTracks, BPM, BARS, rate,
    true, 'song', undefined, undefined, s.playlistTracks, SECONDS, s.patterns, stage);
  const rms = (b) => { let sum = 0, n = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; n++; } } return Math.sqrt(sum / n); };
  const maxDiff = (a, b) => { let m = 0; const n = Math.min(a.length, b.length); for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) { const x = a.getChannelData(c), y = b.getChannelData(c); for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i] - y[i])); } return m; };
  const source = (s) => freezeState.channelFreezeSourceFromProject(s);
  const freeze = async (s, channelId, bufferId) => {
    const channel = s.channels.find(c => c.id === channelId);
    const result = await engine.renderChannelFreeze(channel, s.playlistClips, s.patterns, s.playlistTracks, s.meta.bpm);
    engine.setSampleBuffer(bufferId, result.buffer);
    return { state: freezeState.applyChannelFreeze(s, channelId, { ...result.freeze, audioBufferId: bufferId }), result };
  };
  const withChannel = (s, id, patch) => ({ ...s, channels: s.channels.map(c => c.id === id ? { ...c, ...patch } : c) });
`;

const evaluateWithFixture = (body: string) =>
  new Function(`return (async () => { ${FIXTURE}\n${body} })();`) as () => Promise<any>;

test('frozen channel nulls against its live source in the mastered export path, and is never doubled', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.locator('#nav-channel-rack').waitFor();
  const r = await page.evaluate(evaluateWithFixture(`
    const mastering = internals.masteringState.enabled;
    const reference = await render(state, 'master');
    const liveIds = engine.getLastOfflineRenderFrozenChannelIds();
    // The engine's own run-to-run repeatability for the unfrozen project: the
    // floor any null test in this path can reach.
    const repeatNull = maxDiff(reference, await render(state, 'master'));
    const { state: frozen, result } = await freeze(state, 'lead', 'freeze-lead-test');
    const status = freezeState.resolveChannelFreezeStatus(frozen.channels[0], source(frozen));
    const frozenRender = await render(frozen, 'master');
    const frozenIds = engine.getLastOfflineRenderFrozenChannelIds();
    // What doubling would sound like: the frozen audio on top of the live lead.
    const doubledState = { ...state, playlistClips: [...state.playlistClips,
      { id: 'dbl', type: 'audio', audioBufferId: 'freeze-lead-test', trackIndex: 0, startBar: 0, lengthBars: 3, color: '#fff', name: 'dbl' }] };
    const doubled = await render(doubledState, 'master');
    const withoutLead = await render(withChannel(state, 'lead', { mute: true }), 'master');
    // Proof that the frozen PCM, not the instrument, is what the frozen render
    // contains: swap the asset for silence and the lead disappears.
    const real = engine.getSampleBuffer('freeze-lead-test');
    engine.setSampleBuffer('freeze-lead-test', ctx.createBuffer(real.numberOfChannels, real.length, real.sampleRate));
    const silenced = await render(frozen, 'master');
    engine.setSampleBuffer('freeze-lead-test', real);

    // Renders on another render-quantum phase or sample rate are not
    // sample-exact for frozen audio, so they play the instrument.
    const preMasterLive = await render(state, 'pre-master');
    const preMasterFrozen = await render(frozen, 'pre-master');
    const preMasterIds = engine.getLastOfflineRenderFrozenChannelIds();
    const otherRate = rate === 48000 ? 44100 : 48000;
    const atRate = (s) => engine.renderTimelineOffline(s.channels, s.playlistClips, s.mixerTracks, BPM, BARS, otherRate, true, 'song', undefined, undefined, s.playlistTracks, SECONDS, s.patterns, 'master');
    const rateLive = await atRate(state);
    const rateFrozen = await atRate(frozen);
    const rateIds = engine.getLastOfflineRenderFrozenChannelIds();
    return {
      mastering, status, peak: result.peak, tailDecayed: result.freeze.tailDecayed, frames: result.freeze.frameCount, rate,
      leadInFrames: result.freeze.leadInFrames, liveIds, frozenIds, preMasterIds, rateIds,
      referenceRms: rms(reference), frozenRms: rms(frozenRender), doubledRms: rms(doubled), withoutLeadRms: rms(withoutLead),
      nullPeak: maxDiff(reference, frozenRender), repeatNull,
      leadContribution: maxDiff(reference, withoutLead),
      silencedDiff: maxDiff(reference, silenced),
      preMasterNull: maxDiff(preMasterLive, preMasterFrozen),
      otherRateNull: maxDiff(rateLive, rateFrozen),
    };
  `));
  console.log(`[trackFreeze] null-test evidence ${JSON.stringify(r)}`);
  expect(r.mastering).toBe(true);
  expect(r.status).toBe('frozen');
  expect(r.peak).toBeGreaterThan(0.01);
  expect(r.tailDecayed).toBe(true);
  expect(r.leadInFrames).toBe(Math.ceil(r.rate * 0.1));
  // The mastered render really used the frozen audio for the lead and only for it.
  expect(r.liveIds).toEqual([]);
  expect(r.frozenIds).toEqual(['lead']);
  expect(r.silencedDiff).toBeGreaterThan(0.05);
  // The lead is a real part of the mix, so a null result means something.
  expect(r.leadContribution).toBeGreaterThan(0.05);
  // Frozen audio through the live insert EQ, fader, pan, aux send, return delay,
  // routing, mixer automation, sidechain and the mastering chain equals the
  // live instrument through the same.
  expect(r.nullPeak).toBeLessThan(2e-4);
  expect(Math.abs(r.frozenRms - r.referenceRms) / r.referenceRms).toBeLessThan(1e-3);
  // And it is clearly not the doubled signal.
  expect(Math.abs(r.doubledRms - r.referenceRms) / r.referenceRms).toBeGreaterThan(0.05);
  // Where frozen audio would not be sample-exact, the instrument is rendered:
  // those files are identical to the unfrozen project's by construction.
  // (two instrument renders; the residue is the engine's own repeatability).
  expect(r.preMasterIds).toEqual([]);
  expect(r.preMasterNull).toBeLessThan(2e-4);
  expect(r.rateIds).toEqual([]);
  expect(r.otherRateNull).toBeLessThan(2e-4);
  expect(r.repeatNull).toBeLessThan(2e-4);
});

test('what stays live stays live, stale and missing audio fall back to the instrument, bounce and stems stay correct', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.locator('#nav-channel-rack').waitFor();
  const r = await page.evaluate(evaluateWithFixture(`
    const { state: frozen } = await freeze(state, 'lead', 'freeze-lead-live');
    const status = (s) => freezeState.resolveChannelFreezeStatus(s.channels.find(c => c.id === 'lead'), source(s));
    const pair = async (edit) => { const live = await render(edit(state), 'master'); const cold = await render(edit(frozen), 'master'); return { status: status(edit(frozen)), diff: maxDiff(live, cold), frozenIds: engine.getLastOfflineRenderFrozenChannelIds() }; };
    const mixer = (patch) => (s) => ({ ...s, mixerTracks: s.mixerTracks.map(t => t.id === 1 ? { ...t, ...patch(t) } : t) });

    // Mixer stage edits after the freeze: still frozen, still identical to live.
    const fader = await pair(mixer(() => ({ volume: 0.4, pan: -0.6 })));
    const insert = await pair(mixer(t => ({ fxSlots: [{ ...t.fxSlots[0], params: { midGain: -6 } }] })));
    const send = await pair(mixer(() => ({ auxSends: [{ targetId: 3, amount: 0.9 }] })));
    const reroute = await pair(s => withChannel(s, 'lead', { mixerTrackId: 2 }));
    // Channel mute / solo are live.
    const muted = await pair(s => withChannel(s, 'lead', { mute: true }));
    const soloOther = await pair(s => withChannel(s, 'bass', { solo: true }));
    const soloSelf = await pair(s => withChannel(s, 'lead', { solo: true }));

    // The note-triggered sidechain the frozen lead drives is real in this mix.
    const reference = await render(state, 'master');
    const noSidechain = await render({ ...state, mixerTracks: state.mixerTracks.map(t => t.id === 2 ? { ...t, sidechain: undefined } : t) }, 'master');
    const sidechainMatters = maxDiff(reference, noSidechain);

    // A baked edit: the freeze is stale and the *edited* instrument is heard.
    const editNotes = (s) => withChannel(s, 'lead', { notes: s.channels[0].notes.map((n, i) => i === 1 ? { ...n, pitch: 79 } : n) });
    const stale = await pair(editNotes);
    const staleVsOldFreeze = maxDiff(await render(editNotes(frozen), 'master'), await render(frozen, 'master'));
    // Undoing the edit (same content again) makes the same freeze valid again.
    const undone = status({ ...editNotes(frozen), channels: frozen.channels });

    // Record present, audio not loaded: the instrument plays.
    const orphan = freezeState.applyChannelFreeze(state, 'lead', { ...frozen.channels[0].freeze, audioBufferId: 'freeze-not-loaded' });
    const missingDiff = maxDiff(reference, await render(orphan, 'master'));
    const missingIds = engine.getLastOfflineRenderFrozenChannelIds();

    // Bounce-In-Place of one lane renders the source, exactly as before.
    const bounceLive = await engine.bouncePlaylistLaneToAudioClip(state.channels, state.playlistClips, state.patterns, state.mixerTracks, state.playlistTracks, 2, BPM);
    const bounceFrozen = await engine.bouncePlaylistLaneToAudioClip(frozen.channels, frozen.playlistClips, frozen.patterns, frozen.mixerTracks, frozen.playlistTracks, 2, BPM);
    const bounceDiff = maxDiff(bounceLive.buffer, bounceFrozen.buffer);
    const bounceSameShape = bounceLive.startBar === bounceFrozen.startBar && bounceLive.lengthBars === bounceFrozen.lengthBars && bounceLive.buffer.length === bounceFrozen.buffer.length;

    // Stem export of the frozen channel equals the stem of the live channel.
    const stems = async (s) => {
      const out = await engine.renderProjectStems(s.channels, s.playlistClips, s.mixerTracks, BPM, BARS, 32, 'song', undefined, s.playlistTracks, true, s.patterns);
      const decoded = {};
      for (const [id, blob] of Object.entries(out.stems)) decoded[id] = await ctx.decodeAudioData(await blob.arrayBuffer());
      return decoded;
    };
    const liveStems = await stems(state);
    const frozenStems = await stems(frozen);
    const stemDiff = Math.max(...Object.keys(liveStems).map(id => maxDiff(liveStems[id], frozenStems[id])));
    const leadStemKey = Object.keys(liveStems).find(id => id.toLowerCase().includes('lead'));
    return { fader, insert, send, reroute, muted, soloOther, soloSelf, sidechainMatters, stale, staleVsOldFreeze, undone,
      missingDiff, missingIds, bounceDiff, bounceSameShape, stemDiff, stemDiffs: Object.fromEntries(Object.keys(liveStems).map(id => [id, [maxDiff(liveStems[id], frozenStems[id]), rms(liveStems[id]), rms(frozenStems[id]), liveStems[id].length, frozenStems[id].length]])), leadStemRms: leadStemKey ? rms(liveStems[leadStemKey]) : 0,
      frozenIdsAfterRender: engine.getActiveFrozenChannelIds() };
  `));
  console.log(`[trackFreeze] live-stage evidence ${JSON.stringify(r)}`);
  for (const key of ['fader', 'insert', 'send', 'reroute', 'muted', 'soloOther', 'soloSelf'] as const) {
    expect(r[key].status, key).toBe('frozen');
    expect(r[key].diff, key).toBeLessThan(2e-4);
    // Not a trivial null: the frozen audio is what was rendered (unless the lead is muted or not soloed, where neither plays).
    expect(r[key].frozenIds, key).toEqual(['lead']);
  }
  expect(r.sidechainMatters).toBeGreaterThan(0.01);
  expect(r.stale.status).toBe('stale');
  expect(r.stale.diff).toBeLessThan(2e-4);
  expect(r.stale.frozenIds).toEqual([]);
  expect(r.staleVsOldFreeze).toBeGreaterThan(0.01);
  expect(r.undone).toBe('frozen');
  expect(r.missingDiff).toBeLessThan(2e-4);
  expect(r.missingIds).toEqual([]);
  expect(r.bounceSameShape).toBe(true);
  expect(r.bounceDiff).toBeLessThan(2e-4);
  expect(r.leadStemRms).toBeGreaterThan(0.001);
  expect(r.stemDiff).toBeLessThan(2e-4);
  // An offline render never leaves its frozen selection on the live engine.
  expect(r.frozenIdsAfterRender).toEqual([]);
});

test('live Song playback: frozen audio replaces the voices, hands over both ways, follows mute, seek and stop', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.locator('#nav-channel-rack').waitFor();
  const r = await page.evaluate(evaluateWithFixture(`
    const { state: frozen } = await freeze(state, 'lead', 'freeze-lead-playback');
    const buffer = engine.getSampleBuffer('freeze-lead-playback');
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // Record how the frozen buffer is started.
    const starts = [];
    const originalCreate = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => {
      const node = originalCreate();
      const originalStart = node.start.bind(node);
      node.start = (when, offset) => { if (node.buffer === buffer) starts.push({ when, offset, now: ctx.currentTime }); return originalStart(when, offset); };
      return node;
    };
    const voices = (id) => [...internals.activeVoices.keys()].filter(key => key.startsWith(id + '-')).length;
    const sampleVoices = async (ms) => { let lead = 0, bass = 0; const end = performance.now() + ms; while (performance.now() < end) { lead = Math.max(lead, voices('lead')); bass = Math.max(bass, voices('bass')); await wait(10); } return { lead, bass }; };
    const peak = () => { const data = new Uint8Array(1024); engine.getMasterWaveformData(data); let p = 0; for (const v of data) p = Math.max(p, Math.abs((v - 128) / 128)); return p; };
    const play = (s, mode) => engine.play(s.channels, s.playlistClips, mode, 'p', s.mixerTracks, 16, s.playlistTracks, s.patterns);
    const sync = (s) => engine.synchronizePlaybackState({ channels: s.channels, clips: s.playlistClips, patterns: s.patterns, playlistTracks: s.playlistTracks });
    const secondsPerStep = 60 / BPM / 4;
    const out = {};
    try {
      await play(frozen, 'song');
      await ctx.resume();
      let masterPeak = 0;
      const first = await (async () => { const v = await sampleVoices(700); masterPeak = Math.max(masterPeak, peak()); return v; })();
      out.frozen = { ...first, sources: engine.getFreezeSourceChannelIds(), active: engine.getActiveFrozenChannelIds(), masterPeak, starts: starts.slice() };

      // Stale mid-take: the frozen audio stops, the instrument takes over.
      const edited = withChannel(frozen, 'lead', { volume: 0.55 });
      sync(edited);
      const afterEditSources = engine.getFreezeSourceChannelIds();
      out.stale = { ...(await sampleVoices(900)), sources: afterEditSources, active: engine.getActiveFrozenChannelIds() };

      // Valid again mid-take (the edit is undone): frozen audio returns, voices stop.
      const before = starts.length;
      sync(frozen);
      const cutImmediately = voices('lead');
      await wait(400);
      out.restored = { ...(await sampleVoices(600)), cutImmediately, sources: engine.getFreezeSourceChannelIds(), restarted: starts.length - before,
        lastStart: starts[starts.length - 1] };

      // Channel mute is live on the frozen audio.
      sync(withChannel(frozen, 'lead', { mute: true }));
      await wait(120);
      const mutedGain = internals.freezeSources.get('lead')?.gain.gain.value;
      sync(frozen);
      await wait(120);
      out.mute = { mutedGain, unmutedGain: internals.freezeSources.get('lead')?.gain.gain.value };

      // Seek: the source is restarted from the new timeline position.
      const seekBefore = starts.length;
      engine.seek(secondsPerStep * 16);
      await wait(500);
      out.seek = { restarted: starts.length - seekBefore, lastStart: starts[starts.length - 1], sources: engine.getFreezeSourceChannelIds() };

      engine.stop();
      out.stopped = { sources: engine.getFreezeSourceChannelIds(), entries: internals.freezeSources.size };

      // Pattern mode always plays the instrument.
      await play(frozen, 'pat');
      out.pattern = { ...(await sampleVoices(700)), sources: engine.getFreezeSourceChannelIds(), active: engine.getActiveFrozenChannelIds() };
    } finally {
      engine.stop();
      ctx.createBufferSource = originalCreate;
    }
    out.secondsPerStep = secondsPerStep;
    return out;
  `));
  console.log(`[trackFreeze] live playback evidence ${JSON.stringify(r)}`);
  // Frozen: no lead voice ever exists, the bass still plays, audio reaches the master.
  expect(r.frozen.active).toEqual(['lead']);
  expect(r.frozen.sources).toEqual(['lead']);
  expect(r.frozen.lead).toBe(0);
  expect(r.frozen.bass).toBeGreaterThan(0);
  expect(r.frozen.masterPeak).toBeGreaterThan(0.005);
  // Started exactly once, at timeline zero.
  expect(r.frozen.starts).toHaveLength(1);
  expect(r.frozen.starts[0].offset).toBeLessThan(0.05);
  // Stale: frozen audio is gone at once and lead voices exist again.
  expect(r.stale.sources).toEqual([]);
  expect(r.stale.active).toEqual([]);
  expect(r.stale.lead).toBeGreaterThan(0);
  // Restored: lead voices were cut at the handover and never return; the source is back.
  expect(r.restored.cutImmediately).toBe(0);
  expect(r.restored.lead).toBe(0);
  expect(r.restored.sources).toEqual(['lead']);
  expect(r.restored.restarted).toBe(1);
  // The restart is aligned to a step: offset = whole steps (+ only the lateness of the call).
  const steps = (r.restored.lastStart.offset - Math.max(0, r.restored.lastStart.now - r.restored.lastStart.when)) / r.secondsPerStep;
  expect(Math.abs(steps - Math.round(steps))).toBeLessThan(0.02);
  expect(r.mute.mutedGain).toBeLessThan(0.01);
  expect(r.mute.unmutedGain).toBeGreaterThan(0.99);
  expect(r.seek.restarted).toBe(1);
  expect(r.seek.lastStart.offset).toBeGreaterThanOrEqual(r.secondsPerStep * 16 - 1e-6);
  expect(r.seek.lastStart.offset).toBeLessThan(r.secondsPerStep * 16 + 0.3);
  expect(r.stopped.entries).toBe(0);
  expect(r.pattern.active).toEqual([]);
  expect(r.pattern.sources).toEqual([]);
  expect(r.pattern.lead).toBeGreaterThan(0);
});

test('Channel Rack: Freeze, undo, redo, save, reload and Unfreeze through the real UI and storage', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.locator('#nav-channel-rack').waitFor();
  // Seed the stored project, then boot the app from it the way a user reopens a project.
  await page.evaluate(evaluateWithFixture(`
    const { persistProjectState } = await import('/src/state/projectPersistence.ts');
    await persistProjectState(state);
  `));
  await page.reload();
  await page.locator('#nav-channel-rack').click();

  const stored = () => page.evaluate(async () => {
    // @ts-ignore Vite browser module import
    const { getPersistedProjectStateRecord, getPersistedAudioClip } = await import('/src/audio/audioPersistence.ts');
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    const record = await getPersistedProjectStateRecord();
    const project = record ? JSON.parse(record).state : null;
    const lead = project?.channels?.find((c: any) => c.id === 'lead');
    const freeze = lead?.freeze ?? null;
    const blob = freeze ? await getPersistedAudioClip(freeze.audioBufferId) : null;
    const buffer = freeze ? audioEngine.getSampleBuffer(freeze.audioBufferId) : null;
    return {
      freeze, blobBytes: blob?.size ?? 0, bufferFrames: buffer?.length ?? 0,
      notes: lead?.notes?.length ?? -1, instrumentType: lead?.instrumentType ?? null,
      serialized: JSON.stringify(project ?? null).length,
    };
  });

  const freezeButton = page.getByTestId('channel-freeze-lead');
  const unfreezeButton = page.getByTestId('channel-unfreeze-lead');
  await expect(freezeButton).toHaveAttribute('data-freeze-status', 'none');
  await expect(unfreezeButton).toHaveCount(0);
  // The other channel has its own, independent control.
  await expect(page.getByTestId('channel-freeze-bass')).toHaveAttribute('data-freeze-status', 'none');

  await freezeButton.click();
  await expect(freezeButton).toHaveAttribute('data-freeze-status', 'frozen', { timeout: 60_000 });
  await expect(page.getByTestId('channel-freeze-message')).toContainText('Lead is frozen');
  await expect(page.getByTestId('channel-freeze-bass')).toHaveAttribute('data-freeze-status', 'none');
  await expect(unfreezeButton).toBeVisible();

  // Autosave writes the record; the PCM is a durable asset, not project JSON.
  await expect.poll(async () => (await stored()).freeze?.audioBufferId ?? null, { timeout: 30_000 }).toMatch(/^freeze-/);
  const saved = await stored();
  console.log(`[trackFreeze] stored after freeze ${JSON.stringify(saved)}`);
  expect(saved.blobBytes).toBeGreaterThan(saved.freeze.frameCount * 2 * 4 - 1);
  expect(saved.bufferFrames).toBe(saved.freeze.frameCount);
  expect(saved.serialized).toBeLessThan(200_000);
  expect(saved.notes).toBe(4);
  expect(saved.instrumentType).toBe('minisynth');

  // Undo removes the freeze, redo restores the very same one (asset kept alive by history).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(freezeButton).toHaveAttribute('data-freeze-status', 'none');
  await page.keyboard.press('Control+Shift+z');
  await expect(freezeButton).toHaveAttribute('data-freeze-status', 'frozen');
  await expect.poll(async () => (await stored()).freeze?.audioBufferId ?? null, { timeout: 30_000 }).toBe(saved.freeze.audioBufferId);
  expect((await stored()).bufferFrames).toBe(saved.freeze.frameCount);

  // Reopen the project: still frozen, audio hydrated, and Song playback uses it.
  await page.reload();
  await page.locator('#nav-channel-rack').click();
  await expect(page.getByTestId('channel-freeze-lead')).toHaveAttribute('data-freeze-status', 'frozen', { timeout: 30_000 });
  const reopened = await stored();
  expect(reopened.freeze).toEqual(saved.freeze);
  expect(reopened.bufferFrames).toBe(saved.freeze.frameCount);

  // Unfreeze: the record is gone, the instrument and its notes are untouched.
  await page.getByTestId('channel-unfreeze-lead').click();
  await expect(page.getByTestId('channel-freeze-lead')).toHaveAttribute('data-freeze-status', 'none');
  await expect(page.getByTestId('channel-freeze-message')).toContainText('unfrozen');
  await expect.poll(async () => (await stored()).freeze, { timeout: 30_000 }).toBeNull();
  const after = await stored();
  expect(after.notes).toBe(4);
  expect(after.instrumentType).toBe('minisynth');
});

test('export: the WAV export and the streamed production export of a frozen project equal the unfrozen ones', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.locator('#nav-channel-rack').waitFor();
  const r = await page.evaluate(evaluateWithFixture(`
    const { state: frozen } = await freeze(state, 'lead', 'freeze-lead-export');
    // 1. The ordinary WAV export (mastered, 32-bit float).
    const wav = async (s) => {
      const blob = await engine.renderProjectToWav(s.channels, s.playlistClips, BPM, BARS, 32, s.mixerTracks, true, s.playlistTracks, s.patterns);
      return { buffer: await ctx.decodeAudioData(await blob.arrayBuffer()), frozenIds: engine.getLastOfflineRenderFrozenChannelIds() };
    };
    const liveWav = await wav(state);
    const frozenWav = await wav(frozen);

    // 2. The streamed production export (the desktop export path), into memory.
    const streamed = async (s) => {
      const chunks = [];
      const target = { createScratch: async () => { throw new Error('no scratch expected without VST3 effects'); },
        write: async (interleaved) => { chunks.push(new Float32Array(interleaved)); } };
      const result = await engine.renderTimelineOfflineStreamed({ channels: s.channels, clips: s.playlistClips, mixerTracks: s.mixerTracks,
        bpm: BPM, totalBars: BARS, includeMixerFx: true, renderScope: 'song', playlistTracks: s.playlistTracks, patterns: s.patterns }, target);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(total); let offset = 0; for (const c of chunks) { pcm.set(c, offset); offset += c.length; }
      return { pcm, frames: result.frames, windows: result.windows, frozenIds: engine.getLastOfflineRenderFrozenChannelIds() };
    };
    const liveStream = await streamed(state);
    const frozenStream = await streamed(frozen);
    let streamDiff = 0, streamPeak = 0;
    for (let i = 0; i < Math.min(liveStream.pcm.length, frozenStream.pcm.length); i++) {
      streamDiff = Math.max(streamDiff, Math.abs(liveStream.pcm[i] - frozenStream.pcm[i]));
      streamPeak = Math.max(streamPeak, Math.abs(liveStream.pcm[i]));
    }
    // The streamed export equals the in-memory export for the frozen project too.
    let streamedVsWav = 0;
    const left = frozenWav.buffer.getChannelData(0);
    for (let i = 0; i < Math.min(left.length, frozenStream.frames); i++) streamedVsWav = Math.max(streamedVsWav, Math.abs(left[i] - frozenStream.pcm[i * 2]));
    return {
      wavDiff: maxDiff(liveWav.buffer, frozenWav.buffer), wavFrames: [liveWav.buffer.length, frozenWav.buffer.length], wavRms: rms(liveWav.buffer),
      wavLiveIds: liveWav.frozenIds, wavFrozenIds: frozenWav.frozenIds,
      streamDiff, streamPeak, streamFrames: [liveStream.frames, frozenStream.frames], windows: frozenStream.windows,
      streamLiveIds: liveStream.frozenIds, streamFrozenIds: frozenStream.frozenIds, streamedVsWav,
    };
  `));
  console.log(`[trackFreeze] export evidence ${JSON.stringify(r)}`);
  expect(r.wavLiveIds).toEqual([]);
  expect(r.wavFrozenIds).toEqual(['lead']);
  expect(r.wavFrames[1]).toBe(r.wavFrames[0]);
  expect(r.wavRms).toBeGreaterThan(0.01);
  expect(r.wavDiff).toBeLessThan(2e-4);
  expect(r.streamLiveIds).toEqual([]);
  expect(r.streamFrozenIds).toEqual(['lead']);
  expect(r.streamFrames[1]).toBe(r.streamFrames[0]);
  expect(r.windows).toBeGreaterThan(1);
  expect(r.streamPeak).toBeGreaterThan(0.05);
  expect(r.streamDiff).toBeLessThan(2e-4);
  expect(r.streamedVsWav).toBeLessThan(2e-4);
});

test('live Song playback: the frozen audio stops at the song end and starts again from the top on the next take', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.locator('#nav-channel-rack').waitFor();
  const r = await page.evaluate(evaluateWithFixture(`
    // One bar only, so the take reaches the song end quickly.
    const short = { ...state, playlistClips: state.playlistClips.filter(c => c.id === 'lead-a' || c.id === 'bass-a').map(c => ({ ...c, lengthBars: 1 })) };
    const { state: frozen } = await freeze(short, 'lead', 'freeze-lead-end');
    const buffer = engine.getSampleBuffer('freeze-lead-end');
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const starts = [];
    const originalCreate = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => {
      const node = originalCreate();
      const originalStart = node.start.bind(node);
      node.start = (when, offset) => { if (node.buffer === buffer) starts.push({ when, offset }); return originalStart(when, offset); };
      return node;
    };
    const play = (s) => engine.play(s.channels, s.playlistClips, 'song', 'p', s.mixerTracks, 16, s.playlistTracks, s.patterns);
    const barSeconds = 60 / BPM * 4;
    const out = { barSeconds, bufferSeconds: buffer.duration };
    try {
      await play(frozen); await ctx.resume();
      await wait(400);
      out.during = { playing: internals.isPlaying, sources: engine.getFreezeSourceChannelIds(), starts: starts.length };
      // Wait for the arrangement end (or the loop restart, whichever this transport does).
      await wait(barSeconds * 1000 + 600);
      out.after = { playing: internals.isPlaying, sources: engine.getFreezeSourceChannelIds(), entries: internals.freezeSources.size, starts: starts.length,
        offsets: starts.map(s => s.offset) };
      if (!internals.isPlaying) {
        await play(frozen); await wait(400);
        out.again = { playing: internals.isPlaying, sources: engine.getFreezeSourceChannelIds(), starts: starts.length, offsets: starts.map(s => s.offset) };
      }
    } finally {
      engine.stop();
      ctx.createBufferSource = originalCreate;
    }
    out.stopped = { entries: internals.freezeSources.size };
    return out;
  `));
  console.log(`[trackFreeze] song-end evidence ${JSON.stringify(r)}`);
  expect(r.during.playing).toBe(true);
  expect(r.during.sources).toEqual(['lead']);
  expect(r.during.starts).toBe(1);
  if (r.after.playing) {
    // Looping transport: the frozen audio was restarted from the top for the new pass.
    expect(r.after.starts).toBeGreaterThanOrEqual(2);
    expect(r.after.sources).toEqual(['lead']);
  } else {
    // The take ended: nothing of the frozen audio keeps playing past the end,
    // exactly like the instrument's voices.
    expect(r.after.entries).toBe(0);
    expect(r.after.starts).toBe(1);
    expect(r.again.sources).toEqual(['lead']);
    expect(r.again.starts).toBe(2);
  }
  // Every start of a take begins at the top of the frozen audio.
  for (const offset of (r.again ?? r.after).offsets) expect(offset).toBeLessThan(0.05);
  expect(r.stopped.entries).toBe(0);
});
