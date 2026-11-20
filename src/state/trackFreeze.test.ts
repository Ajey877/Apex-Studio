import assert from 'node:assert/strict';
import test from 'node:test';
import type { Channel, ChannelFreeze, Note, PlaylistClip, ProjectState } from '../types/daw';
import { createDefaultProjectState, deleteChannelFromProjectState, normalizeProjectState } from './projectState';
import { createHistory } from './projectHistory';
import { getAudioIdsForProject, getHistoryAudioIds, serializeProjectState } from './projectPersistence';
import {
  CHANNEL_FREEZE_BUFFER_PREFIX,
  CHANNEL_FREEZE_DECAY_THRESHOLD,
  analyzeChannelFreezeRender,
  applyChannelFreeze,
  channelFreezeSourceFromProject,
  collectChannelFreezeAudioIds,
  computeChannelFreezeFingerprint,
  createChannelFreezeBufferId,
  getChannelFreezeBlocker,
  isChannelFreezeRecord,
  isChannelFreezeSampleExact,
  markChannelFreezeAvailability,
  normalizeChannelFreeze,
  removeChannelFreeze,
  resolveActiveChannelFreezes,
  resolveChannelFreezeStatus,
} from './trackFreeze';

const note = (pitch: number, start: number, id = `n-${pitch}-${start}`): Note =>
  ({ id, pitch, start, duration: 2, velocity: 0.8 });

const project = (): ProjectState => {
  const state = createDefaultProjectState();
  const base = state.channels[0];
  const lead: Channel = { ...base, id: 'lead', name: 'Lead', mixerTrackId: 1, mute: false, solo: false,
    steps: Array(16).fill(false), notes: [note(60, 0), note(64, 4)] };
  const bass: Channel = { ...base, id: 'bass', name: 'Bass', mixerTrackId: 2, mute: false, solo: false,
    steps: Array(16).fill(false), notes: [note(36, 0)] };
  state.channels = [lead, bass];
  state.patterns = [{ id: 'p', name: 'Main', lengthSteps: 16, color: '#fff' }];
  state.selectedPatternId = 'p';
  const clip = (id: string, extra: Partial<PlaylistClip>): PlaylistClip => ({
    id, type: 'pattern', patternId: 'p', color: '#fff', name: id, trackIndex: 0, startBar: 0, lengthBars: 1, ...extra,
  } as PlaylistClip);
  state.playlistClips = [
    clip('lead-a', { channelId: 'lead', trackIndex: 0, lengthBars: 2 }),
    clip('bass-a', { channelId: 'bass', trackIndex: 1, lengthBars: 2 }),
    clip('full', { patternScope: 'all', trackIndex: 2, startBar: 2 } as Partial<PlaylistClip>),
    { id: 'lead-vol', type: 'automation', trackIndex: 3, startBar: 0, lengthBars: 3, color: '#fff', name: 'Lead vol',
      automationTarget: { type: 'channel_vol', targetId: 'lead' }, automationPoints: [{ x: 0, y: 0.8 }, { x: 1, y: 0.3 }] } as PlaylistClip,
    { id: 'ins-vol', type: 'automation', trackIndex: 4, startBar: 0, lengthBars: 3, color: '#fff', name: 'Insert vol',
      automationTarget: { type: 'mixer_vol', targetId: 1 }, automationPoints: [{ x: 0, y: 0.5 }, { x: 1, y: 0.7 }] } as PlaylistClip,
  ];
  return state;
};

const fingerprint = (state: ProjectState, id = 'lead') =>
  computeChannelFreezeFingerprint(state.channels.find(c => c.id === id)!, channelFreezeSourceFromProject(state));

const record = (state: ProjectState, id = 'lead', extra: Partial<ChannelFreeze> = {}): ChannelFreeze => ({
  version: 1, audioBufferId: `freeze-${id}-test`, sourceFingerprint: fingerprint(state, id), frozenAt: 1,
  sampleRate: 44100, frameCount: 1000, leadInFrames: 4410, contentSeconds: 4, tailSeconds: 8, tailDecayed: true, ...extra,
});

const frozenProject = (): ProjectState => {
  const state = project();
  return applyChannelFreeze(state, 'lead', record(state));
};

const status = (state: ProjectState, id = 'lead') =>
  resolveChannelFreezeStatus(state.channels.find(c => c.id === id)!, channelFreezeSourceFromProject(state));

const editChannel = (state: ProjectState, id: string, patch: Partial<Channel>): ProjectState =>
  ({ ...state, channels: state.channels.map(c => (c.id === id ? { ...c, ...patch } : c)) });
const editClip = (state: ProjectState, id: string, patch: Partial<PlaylistClip>): ProjectState =>
  ({ ...state, playlistClips: state.playlistClips.map(c => (c.id === id ? { ...c, ...patch } as PlaylistClip : c)) });

test('10H: a fresh freeze is frozen; a channel without one reports none', () => {
  const state = frozenProject();
  assert.equal(status(state, 'lead'), 'frozen');
  assert.equal(status(state, 'bass'), 'none');
});

test('10H: everything baked into the freeze makes it stale when edited', () => {
  const state = frozenProject();
  const lead = state.channels[0];
  const baked: Array<[string, ProjectState]> = [
    ['a note pitch', editChannel(state, 'lead', { notes: [note(61, 0), note(64, 4)] })],
    ['a note added', editChannel(state, 'lead', { notes: [...lead.notes, note(67, 8)] })],
    ['a note velocity', editChannel(state, 'lead', { notes: [{ ...lead.notes[0], velocity: 0.5 }, lead.notes[1]] })],
    ['a step', editChannel(state, 'lead', { steps: lead.steps.map((s, i) => (i === 3 ? true : s)) })],
    ['channel volume', editChannel(state, 'lead', { volume: lead.volume * 0.5 })],
    ['channel pan', editChannel(state, 'lead', { pan: 0.4 })],
    ['channel pitch', editChannel(state, 'lead', { pitch: 3 })],
    ['instrument type', editChannel(state, 'lead', { instrumentType: lead.instrumentType === 'fmsynth' ? 'minisynth' : 'fmsynth' })],
    ['synth parameters', editChannel(state, 'lead', { synthParams: { ...(lead.synthParams as object), filterCutoff: 1234 } } as Partial<Channel>)],
    ['clip position', editClip(state, 'lead-a', { startBar: 1 })],
    ['clip length', editClip(state, 'lead-a', { lengthBars: 1 })],
    ['clip mute', editClip(state, 'lead-a', { mute: true })],
    ['a full-pattern clip that plays the channel', editClip(state, 'full', { startBar: 5 })],
    ['a new clip of the channel', { ...state, playlistClips: [...state.playlistClips,
      { ...state.playlistClips[0], id: 'lead-b', startBar: 6 }] }],
    ['lane mute of the clip lane', { ...state, playlistTracks: state.playlistTracks.map((t, i) => (i === 0 ? { ...t, mute: true } : t)) }],
    ['channel automation points', editClip(state, 'lead-vol', { automationPoints: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] } as Partial<PlaylistClip>)],
    ['channel automation removed', { ...state, playlistClips: state.playlistClips.filter(c => c.id !== 'lead-vol') }],
    ['tempo', { ...state, meta: { ...state.meta, bpm: state.meta.bpm + 1 } }],
    ['swing', { ...state, meta: { ...state.meta, swing: 0.3 } }],
    ['time signature', { ...state, meta: { ...state.meta, timeSignature: [3, 4] } }],
    ['pattern length', { ...state, patterns: state.patterns.map(p => ({ ...p, lengthSteps: 32 })) }],
    ['external-MIDI-only mode', editChannel(state, 'lead', { midiOutput: { mode: 'external' } } as Partial<Channel>)],
  ];
  for (const [what, edited] of baked) assert.equal(status(edited), 'stale', what);
});

test('10H: everything that stays live leaves the freeze valid', () => {
  const state = frozenProject();
  const live: Array<[string, ProjectState]> = [
    ['channel mute', editChannel(state, 'lead', { mute: true })],
    ['channel solo', editChannel(state, 'lead', { solo: true })],
    ['mixer routing of the channel', editChannel(state, 'lead', { mixerTrackId: 5 })],
    ['channel name and colour', editChannel(state, 'lead', { name: 'Renamed', color: '#000' })],
    ['mixer track volume / pan / inserts / sends / sidechain', { ...state, mixerTracks: state.mixerTracks.map(t => ({
      ...t, volume: 0.3, pan: -1, mute: true, auxSends: [{ targetId: 3, amount: 1 }],
      fxSlots: [{ id: 'x', type: 'equalizer', name: 'EQ', enabled: true, mix: 1, params: {} }],
    })) as ProjectState['mixerTracks'] }],
    ['mixer automation', editClip(state, 'ins-vol', { automationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } as Partial<PlaylistClip>)],
    ['another channel', editChannel(state, 'bass', { volume: 0.1, notes: [note(40, 2)] })],
    ['another channel\'s clip', editClip(state, 'bass-a', { startBar: 3 })],
    ['an audio clip', { ...state, playlistClips: [...state.playlistClips,
      { id: 'audio', type: 'audio', audioBufferId: 'a', trackIndex: 5, startBar: 0, lengthBars: 1, color: '#fff', name: 'a' } as PlaylistClip] }],
    ['a muted lane that holds none of its clips', { ...state, playlistTracks: state.playlistTracks.map((t, i) => (i === 1 ? { ...t, mute: true } : t)) }],
    ['master volume', { ...state, meta: { ...state.meta, masterVolume: 0.2 } }],
    ['mastering', { ...state, masteringSuiteState: { ...state.masteringSuiteState, enabled: !state.masteringSuiteState.enabled } }],
    ['note ids only', editChannel(state, 'lead', { notes: state.channels[0].notes.map((n, i) => ({ ...n, id: `other-${i}` })) })],
  ];
  for (const [what, edited] of live) assert.equal(status(edited), 'frozen', what);
});

test('10H: undoing a baked edit makes the same freeze valid again', () => {
  const state = frozenProject();
  const edited = editChannel(state, 'lead', { volume: 0.123 });
  assert.equal(status(edited), 'stale');
  assert.equal(status(editChannel(edited, 'lead', { volume: state.channels[0].volume })), 'frozen');
});

test('10H: the fingerprint ignores session and display fields at any depth', () => {
  const state = frozenProject();
  const sample = { id: 's', name: 'S', duration: 1, sampleRate: 44100, channels: 2 };
  const withSession = editChannel(state, 'lead', { customSample: { ...sample, waveformPeaks: [1, 2, 3], url: 'blob:x' } });
  const withoutSession = editChannel(state, 'lead', { customSample: { ...sample, waveformPeaks: [] } });
  // The sample's identity is baked, its display data and session URL are not.
  assert.notEqual(fingerprint(withSession), fingerprint(state));
  assert.notEqual(
    fingerprint(editChannel(state, 'lead', { customSample: { ...sample, id: 'other', waveformPeaks: [] } })),
    fingerprint(withoutSession),
  );
  assert.equal(fingerprint(withSession), fingerprint(withoutSession));
});

test('10H: missing audio is its own status and never selects the frozen audio', () => {
  const state = frozenProject();
  const missing = { ...state, channels: markChannelFreezeAvailability(state.channels, new Set(['freeze-lead-test'])) };
  assert.equal(missing.channels[0].freeze?.audioUnavailable, true);
  assert.equal(status(missing), 'missing-audio');
  // The record, and so the way back, is kept.
  assert.equal(missing.channels[0].freeze?.audioBufferId, 'freeze-lead-test');
  const source = channelFreezeSourceFromProject(missing);
  assert.equal(resolveActiveChannelFreezes(missing.channels, source, () => true).size, 0);
  // Audio came back (for example after a backup restore): the flag clears.
  const back = { ...missing, channels: markChannelFreezeAvailability(missing.channels, new Set()) };
  assert.equal(back.channels[0].freeze?.audioUnavailable, undefined);
  assert.equal(status(back), 'frozen');
  // Unchanged channels keep their identity.
  assert.equal(markChannelFreezeAvailability(state.channels, new Set())[0], state.channels[0]);
});

test('10H: exactly the valid, loaded, accepted freezes are active', () => {
  const state = frozenProject();
  const source = channelFreezeSourceFromProject(state);
  assert.deepEqual([...resolveActiveChannelFreezes(state.channels, source, () => true).keys()], ['lead']);
  assert.equal(resolveActiveChannelFreezes(state.channels, source, () => false).size, 0, 'buffer not loaded');
  assert.equal(resolveActiveChannelFreezes(state.channels, source, () => true, () => false).size, 0, 'not accepted');
  const stale = editChannel(state, 'lead', { pan: 0.9 });
  assert.equal(resolveActiveChannelFreezes(stale.channels, channelFreezeSourceFromProject(stale), () => true).size, 0, 'stale');
});

test('10H: an offline render is sample-exact only at the same rate and render-quantum phase', () => {
  const freeze = { sampleRate: 44100, leadInFrames: 4410 };
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 44100, leadInFrames: 4410 }), true);
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 44100, leadInFrames: 4410 + 128 * 3 }), true);
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 44100, leadInFrames: 4410 - 128 }), true);
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 44100, leadInFrames: 0 }), false, 'no lead-in: 4410 is not a whole number of quanta');
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 44100, leadInFrames: 4411 }), false);
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 48000, leadInFrames: 4410 }), false, 'another sample rate');
  assert.equal(isChannelFreezeSampleExact({ sampleRate: 48000, leadInFrames: 4800 }, { sampleRate: 48000, leadInFrames: 4800 }), true);
  assert.equal(isChannelFreezeSampleExact(freeze, { sampleRate: 44100, leadInFrames: 4410.5 }), false);
});

test('10H: blockers name why a channel cannot be frozen', () => {
  const state = project();
  const source = channelFreezeSourceFromProject(state);
  assert.equal(getChannelFreezeBlocker(state.channels[0], source), null);
  assert.match(getChannelFreezeBlocker({ ...state.channels[0], midiOutput: { mode: 'external' } } as Channel, source)!, /external MIDI/);
  const noClips = { ...state, playlistClips: state.playlistClips.filter(c => c.type !== 'pattern') };
  assert.match(getChannelFreezeBlocker(noClips.channels[0], channelFreezeSourceFromProject(noClips))!, /Nothing to freeze/);
  const allMuted = { ...state, playlistClips: state.playlistClips.map(c => ({ ...c, mute: true })) };
  assert.match(getChannelFreezeBlocker(allMuted.channels[0], channelFreezeSourceFromProject(allMuted))!, /Nothing to freeze/);
});

test('10H: apply and remove touch only the freeze record', () => {
  const state = project();
  const frozen = applyChannelFreeze(state, 'lead', record(state));
  const { freeze, ...rest } = frozen.channels[0];
  assert.deepEqual(rest, state.channels[0]);
  assert.equal(freeze?.audioBufferId, 'freeze-lead-test');
  assert.equal(frozen.channels[1], state.channels[1]);
  assert.equal(frozen.playlistClips, state.playlistClips);
  assert.equal(frozen.mixerTracks, state.mixerTracks);
  const unfrozen = removeChannelFreeze(frozen, 'lead');
  assert.deepEqual(unfrozen.channels, state.channels);
  assert.equal('freeze' in unfrozen.channels[0], false);
  // No-ops return the same object, so they create no undo step.
  assert.equal(removeChannelFreeze(state, 'lead'), state);
  assert.equal(removeChannelFreeze(state, 'nope'), state);
  assert.equal(applyChannelFreeze(state, 'nope', record(state)), state);
});

test('10H: the record survives normalisation and serialisation; a malformed one is dropped, not the channel', () => {
  const frozen = frozenProject();
  const roundTripped = normalizeProjectState(JSON.parse(serializeProjectState(frozen)).state);
  assert.deepEqual(roundTripped.channels[0].freeze, frozen.channels[0].freeze);
  assert.equal(status(roundTripped), 'frozen');
  assert.deepEqual(roundTripped.channels[0].notes, frozen.channels[0].notes);

  for (const broken of [
    { ...record(frozen), version: 2 },
    { ...record(frozen), audioBufferId: '' },
    { ...record(frozen), sourceFingerprint: 7 },
    { ...record(frozen), frameCount: 0 },
    { ...record(frozen), leadInFrames: -1 },
    { ...record(frozen), leadInFrames: undefined },
    { ...record(frozen), tailDecayed: 'yes' },
    'frozen', null, 42,
  ]) {
    assert.equal(isChannelFreezeRecord(broken), false);
    const channel = normalizeChannelFreeze({ ...frozen.channels[0], freeze: broken as unknown as ChannelFreeze });
    assert.equal('freeze' in channel, false);
    assert.deepEqual(channel.notes, frozen.channels[0].notes);
  }
  const loaded = normalizeProjectState({ ...frozen, channels: [{ ...frozen.channels[0], freeze: { version: 99 } }, frozen.channels[1]] } as unknown as ProjectState);
  assert.equal(loaded.channels[0].freeze, undefined);
  assert.equal(loaded.channels[0].id, 'lead');
});

test('10H: frozen audio is a referenced project asset, kept alive by undo history and released by deletion', () => {
  const state = project();
  const frozen = applyChannelFreeze(state, 'lead', record(state));
  assert.deepEqual(collectChannelFreezeAudioIds(frozen), ['freeze-lead-test']);
  assert.ok(getAudioIdsForProject(frozen).includes('freeze-lead-test'));
  assert.equal(getAudioIdsForProject(state).includes('freeze-lead-test'), false);

  // Freeze -> Unfreeze -> the asset is no longer in the present, but undo can bring it back.
  let history = createHistory(state).commit(frozen, 'Freeze channel');
  history = history.commit(removeChannelFreeze(frozen, 'lead'), 'Unfreeze channel');
  assert.equal(getAudioIdsForProject(history.present).includes('freeze-lead-test'), false);
  assert.ok(getHistoryAudioIds(history).includes('freeze-lead-test'));
  history = history.undo();
  assert.equal(history.present.channels[0].freeze?.audioBufferId, 'freeze-lead-test');
  assert.equal(status(history.present), 'frozen');
  history = history.undo();
  assert.equal(history.present.channels[0].freeze, undefined);
  assert.ok(getHistoryAudioIds(history).includes('freeze-lead-test'), 'redo still needs the asset');
  history = history.redo();
  assert.equal(status(history.present), 'frozen');
  // Undo steps carry the labels the UI shows.
  assert.deepEqual(history.past.map(entry => entry.label), ['Freeze channel']);

  // Deleting the channel removes its record with it.
  const deleted = deleteChannelFromProjectState(frozen, 'lead');
  assert.equal(deleted.state.channels.some(c => c.id === 'lead'), false);
  assert.deepEqual(collectChannelFreezeAudioIds(deleted.state), []);
});

test('10H: a refreeze replaces the record and leaves the old asset to history', () => {
  const state = frozenProject();
  const edited = editChannel(state, 'lead', { pan: 0.5 });
  assert.equal(status(edited), 'stale');
  const refrozen = applyChannelFreeze(edited, 'lead', record(edited, 'lead', { audioBufferId: 'freeze-lead-second' }));
  assert.equal(status(refrozen), 'frozen');
  assert.deepEqual(collectChannelFreezeAudioIds(refrozen), ['freeze-lead-second']);
  const history = createHistory(state).commit(edited, 'Edit').commit(refrozen, 'Freeze channel');
  assert.ok(getHistoryAudioIds(history).includes('freeze-lead-test'));
  assert.ok(getHistoryAudioIds(history).includes('freeze-lead-second'));
});

test('10H: buffer ids are unique, prefixed and carry the channel id', () => {
  const a = createChannelFreezeBufferId('lead', 1000);
  const b = createChannelFreezeBufferId('lead', 1000);
  assert.ok(a.startsWith(`${CHANNEL_FREEZE_BUFFER_PREFIX}lead-`));
  assert.notEqual(a, b);
});

test('10H: tail analysis trims trailing silence and reports an undecayed tail', () => {
  const rate = 1000;
  const decayed = new Float32Array(4000);
  for (let i = 0; i < 1500; i += 1) decayed[i] = 0.5;
  const result = analyzeChannelFreezeRender([decayed, new Float32Array(4000)], rate);
  assert.equal(result.peak, 0.5);
  assert.equal(result.tailDecayed, true);
  assert.equal(result.trimmedFrameCount, 1500 + 10);

  const ringing = new Float32Array(4000).fill(CHANNEL_FREEZE_DECAY_THRESHOLD * 10);
  const cut = analyzeChannelFreezeRender([ringing], rate);
  assert.equal(cut.tailDecayed, false);
  assert.equal(cut.trimmedFrameCount, 4000);

  const silent = analyzeChannelFreezeRender([new Float32Array(100)], rate);
  assert.equal(silent.peak, 0);
  assert.ok(silent.trimmedFrameCount >= 1, 'never an empty buffer; a silent render is rejected by the engine');
});
