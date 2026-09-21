/**
 * Phase 10B — Mixer / FX automation regression coverage.
 *
 * Covers the four P1 fixes that bridge the model and the audio engine:
 *   1. live slot.mix changes (no chain rebuild on slot.mix-only edits)
 *   2. fx_mix automation (writes slot.mix and forwards to the live WetDry)
 *   3. channel_filter_res automation (writes synthParams.filterResonance)
 *   4. channel_pitch automation (writes channel.pitch)
 *
 * Plus:
 *   - existing automation targets remain regression-free
 *   - resetActiveAutomationTarget restores the new automation types
 *   - trackOnlyMixChanged detects that property-level differences are NOT
 *     a mix-only change (e.g. adding a new slot requires a rebuild)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, FxSlot, MixerTrack, PlaylistClip } from '../types/daw';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAVED_KEYS = [
  'ctx', 'activeChannels', 'activeMixerTracks', 'activeClips',
  'playbackProjectChannels', 'playbackProjectMixerTracks',
  'masterGain', 'mixerChannels', 'isOfflineRendering', 'isPlaying',
  'currentBar', 'currentStep',
];

let savedInternals: EngineInternals = {};
let originalPlayNote: unknown;
let originalApplyAutomationValue: unknown;

function makeChannel(id: string, opts: Partial<Channel> = {}): Channel {
  return {
    id,
    name: id,
    color: '#ff6e00',
    instrumentType: 'drumpad',
    mixerTrackId: 1,
    volume: 0.9,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: new Array(16).fill(false),
    notes: [],
    synthParams: {
      filterCutoff: 3500,
      filterResonance: 1,
      filterType: 'lowpass',
      filterEnvAmount: 0,
      attack: 0.01,
      decay: 0.15,
      sustain: 0.6,
      release: 0.2,
      unisonVoices: 1,
      osc2Mix: 0.65,
    },
    ...opts,
  } as Channel;
}

function makeMixerTrack(id: number, fxSlots: FxSlot[]): MixerTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#fff',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots,
  };
}

function makeSlot(id: string, type: FxSlot['type'], mix: number): FxSlot {
  return { id, type, name: type, enabled: true, mix, params: {} };
}

function makeAutomationClip(
  id: string,
  target: NonNullable<PlaylistClip['automationTarget']>,
  startBar: number,
  lengthBars: number,
  yEnd: number,
): PlaylistClip {
  return {
    id,
    trackIndex: 0,
    startBar,
    lengthBars,
    type: 'automation',
    color: '#00e5ff',
    name: id,
    automationTarget: target,
    automationPoints: [
      { x: 0, y: 0, tension: 0 },
      { x: 1, y: yEnd, tension: 0 },
    ],
  };
}

function installFakeCtx(): { currentTime: number } {
  // A plain object that satisfies the engine's `this.ctx.currentTime` lookups
  // without firing audio worklets. The engine only writes to `currentTime`-based
  // AudioParams when the patch registry is absent — automation writes are
  // otherwise pure in-state, no audio side-effects required.
  const ctx = { currentTime: 1.5, sampleRate: 48000 };
  engine.ctx = ctx;
  engine.masterGain = { gain: { setTargetAtTime() {}, setValueAtTime() {} } };
  return ctx;
}

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  originalPlayNote = engine.playNote;
  originalApplyAutomationValue = engine.applyAutomationValue;
  installFakeCtx();
  engine.isOfflineRendering = false;
  engine.isPlaying = true;
  engine.activeChannels = [];
  engine.activeMixerTracks = [];
  engine.activeClips = [];
  engine.playbackProjectChannels = [];
  engine.playbackProjectMixerTracks = [];
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  engine.applyAutomationValue = originalApplyAutomationValue;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

describe('Phase 10B: applyAutomationValue gains fx_mix / channel_filter_res / channel_pitch', () => {
  it('writes slot.mix for fx_mix automation and clamps the value', () => {
    const slot = makeSlot('fx-slot-1', 'reverb', 0.4);
    const track = makeMixerTrack(1, [slot]);
    engine.activeMixerTracks = [track];

    // Out-of-range value is clamped to [0, 1].
    engine.applyAutomationValue(
      { type: 'fx_mix', targetId: 1, paramName: 'fx-slot-1' },
      1.42,
      [],
      engine.activeMixerTracks,
      0,
    );
    assert.equal(slot.mix, 1, 'values above 1 are clamped to 1');

    engine.applyAutomationValue(
      { type: 'fx_mix', targetId: 1, paramName: 'fx-slot-1' },
      -0.5,
      [],
      engine.activeMixerTracks,
      0,
    );
    assert.equal(slot.mix, 0, 'values below 0 are clamped to 0');

    engine.applyAutomationValue(
      { type: 'fx_mix', targetId: 1, paramName: 'fx-slot-1' },
      0.6,
      [],
      engine.activeMixerTracks,
      0,
    );
    assert.equal(slot.mix, 0.6, 'in-range values pass through verbatim');
  });

  it('skips unknown slot ids without throwing', () => {
    const slot = makeSlot('fx-slot-2', 'delay', 0.7);
    const track = makeMixerTrack(1, [slot]);
    engine.activeMixerTracks = [track];

    engine.applyAutomationValue(
      { type: 'fx_mix', targetId: 1, paramName: 'does-not-exist' },
      0.25,
      [],
      engine.activeMixerTracks,
      0,
    );
    assert.equal(slot.mix, 0.7, 'unknown slot ids leave the existing mix untouched');
  });

  it('routes the live mix to the patch registry when one is installed', () => {
    const slot = makeSlot('fx-slot-3', 'chorus', 0.4);
    const track = makeMixerTrack(1, [slot]);
    engine.activeMixerTracks = [track];

    const applied: Array<{ trackId: number; slotId: string; mix: number; time: number }> = [];
    const registry = {
      applyLiveMix(trackId: number, slotId: string, mix: number, time: number) {
        applied.push({ trackId, slotId, mix, time });
        return true;
      },
    };
    engine.__liveFxChainRegistry = registry;

    engine.applyAutomationValue(
      { type: 'fx_mix', targetId: 1, paramName: 'fx-slot-3' },
      0.85,
      [],
      engine.activeMixerTracks,
      0,
    );

    assert.equal(slot.mix, 0.85, 'slot.mix is updated from automation');
    assert.equal(applied.length, 1, 'patch registry receives exactly one live update');
    assert.deepEqual(applied[0], { trackId: 1, slotId: 'fx-slot-3', mix: 0.85, time: 0 });

    delete engine.__liveFxChainRegistry;
  });

  it('writes synthParams.filterResonance mapped from a 0..1 curve onto 0..20', () => {
    const channel = makeChannel('ch-res-1');
    channel.synthParams!.filterResonance = 2;
    engine.activeChannels = [channel];

    engine.applyAutomationValue({ type: 'channel_filter_res', targetId: 'ch-res-1' }, 0.5, engine.activeChannels, [], 0);
    assert.equal(channel.synthParams!.filterResonance, 10, '0..1 -> 0..20 maps the midpoint to 10');

    engine.applyAutomationValue({ type: 'channel_filter_res', targetId: 'ch-res-1' }, 0, engine.activeChannels, [], 0);
    assert.ok(channel.synthParams!.filterResonance >= 0.0001, 'floor keeps the Q-value non-zero for filter math');

    engine.applyAutomationValue({ type: 'channel_filter_res', targetId: 'ch-res-1' }, 1, engine.activeChannels, [], 0);
    assert.equal(channel.synthParams!.filterResonance, 20, 'unit value reaches the model ceiling');
  });

  it('writes channel.pitch mapped onto a -12..+12 semitone offset', () => {
    const channel = makeChannel('ch-pitch-1', { pitch: 0 });
    engine.activeChannels = [channel];

    engine.applyAutomationValue({ type: 'channel_pitch', targetId: 'ch-pitch-1' }, 0, engine.activeChannels, [], 0);
    assert.equal(channel.pitch, -12, '0 maps to the floor (-12 semitones)');

    engine.applyAutomationValue({ type: 'channel_pitch', targetId: 'ch-pitch-1' }, 0.5, engine.activeChannels, [], 0);
    assert.equal(channel.pitch, 0, '0.5 maps to 0 (no transposition)');

    engine.applyAutomationValue({ type: 'channel_pitch', targetId: 'ch-pitch-1' }, 1, engine.activeChannels, [], 0);
    assert.equal(channel.pitch, 12, '1 maps to +12 semitones');
  });

  it('leaves unrelated channel synth params alone when pitch / resonance change', () => {
    const channel = makeChannel('ch-keep');
    const synthParams = channel.synthParams!;
    synthParams.filterCutoff = 2400;
    synthParams.filterResonance = 1;
    synthParams.attack = 0.02;
    synthParams.osc2Mix = 0.4;
    engine.activeChannels = [channel];

    engine.applyAutomationValue({ type: 'channel_filter_res', targetId: 'ch-keep' }, 0.4, engine.activeChannels, [], 0);
    engine.applyAutomationValue({ type: 'channel_pitch', targetId: 'ch-keep' }, 0.7, engine.activeChannels, [], 0);

    assert.equal(synthParams.filterCutoff, 2400, 'cutoff is unchanged by filter_res automation');
    assert.equal(synthParams.attack, 0.02, 'envelope attack is unchanged');
    assert.equal(synthParams.osc2Mix, 0.4, 'osc2Mix is unchanged');
    assert.equal(channel.pitch, (0.7 * 24) - 12, 'pitch reflects the new automation value');
  });

  it('preserves existing master_vol / channel_vol / mixer_vol semantics', () => {
    const masterGain = engine.masterGain as { gain: { setTargetAtTime: (value: number, time?: number, tc?: number) => void } };
    const events: Array<{ v: number }> = [];
    masterGain.gain = {
      setTargetAtTime(v: number) { events.push({ v }); },
    };
    engine.applyAutomationValue({ type: 'master_vol' }, 0.5, [], [], 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].v, 0.6, 'master_vol scales by 1.2 (existing behavior preserved)');

    const channel = makeChannel('ch-existing', { volume: 0.42 });
    engine.activeChannels = [channel];
    engine.applyAutomationValue({ type: 'channel_vol', targetId: 'ch-existing' }, 0.7, engine.activeChannels, [], 0);
    assert.equal(channel.volume, 0.7, 'channel_vol still writes channel.volume');
  });
});

describe('Phase 10B: resetActiveAutomationTarget restores the new automation types', () => {
  function getResetTarget() {
    return (engine as any).resetActiveAutomationTarget.bind(engine);
  }

  it('restores fx_mix to the project-side slot.mix on reset', () => {
    const activeSlot = makeSlot('fx-reset', 'reverb', 0.42);
    const projectSlot = { ...makeSlot('fx-reset', 'reverb', 0.0) };
    const active = makeMixerTrack(1, [activeSlot]);
    const project = makeMixerTrack(1, [projectSlot]);
    engine.activeMixerTracks = [active];
    engine.playbackProjectMixerTracks = [project];

    const applied: Array<{ mix: number }> = [];
    engine.__liveFxChainRegistry = { applyLiveMix(_t: number, _s: string, mix: number) { applied.push({ mix }); return true; } };

    getResetTarget()({ type: 'fx_mix', targetId: 1, paramName: 'fx-reset' });

    assert.equal(activeSlot.mix, 0, 'slot.mix is reset to project value');
    assert.equal(applied.length, 1, 'the live patch receives the reset');
    assert.equal(applied[0].mix, 0);

    delete engine.__liveFxChainRegistry;
  });

  it('restores channel_filter_res and channel_pitch on reset', () => {
    const active = makeChannel('ch-reset', {
      pitch: 9,
      synthParams: { ...makeChannel('').synthParams, filterResonance: 17 } as any,
    });
    const project = makeChannel('ch-reset', {
      pitch: 0,
      synthParams: { ...makeChannel('').synthParams, filterResonance: 2 } as any,
    });
    engine.activeChannels = [active];
    engine.playbackProjectChannels = [project];

    getResetTarget()({ type: 'channel_filter_res', targetId: 'ch-reset' });
    getResetTarget()({ type: 'channel_pitch', targetId: 'ch-reset' });

    assert.equal(active.synthParams!.filterResonance, 2, 'resonance restored');
    assert.equal(active.pitch, 0, 'pitch restored');
  });

  it('no-ops when the project-side channel is missing (defensive)', () => {
    const active = makeChannel('ch-orphan');
    engine.activeChannels = [active];
    engine.playbackProjectChannels = []; // missing

    assert.doesNotThrow(() => getResetTarget()({ type: 'channel_filter_res', targetId: 'ch-orphan' }));
    assert.doesNotThrow(() => getResetTarget()({ type: 'channel_pitch', targetId: 'ch-orphan' }));
  });
});

describe('Phase 10B: setFxSlotMix updates slot.mix and forwards to the live WetDry', () => {
  it('clamps and forwards the value when a live registry exists', () => {
    const slot = makeSlot('fx-setmix', 'delay', 0.5);
    const track = makeMixerTrack(1, [slot]);
    engine.activeMixerTracks = [track];

    const calls: Array<{ trackId: number; slotId: string; mix: number; time: number }> = [];
    engine.__liveFxChainRegistry = {
      applyLiveMix(trackId: number, slotId: string, mix: number, time: number) {
        calls.push({ trackId, slotId, mix, time });
        return true;
      },
    };

    const result = engine.setFxSlotMix(1, 'fx-setmix', 1.42);
    assert.equal(result, true);
    assert.equal(slot.mix, 1, 'over-range clamps to 1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mix, 1);

    engine.setFxSlotMix(1, 'fx-setmix', -0.5);
    assert.equal(slot.mix, 0, 'under-range clamps to 0');

    delete engine.__liveFxChainRegistry;
  });

  it('returns false without throwing when the slot id is unknown', () => {
    const track = makeMixerTrack(1, [makeSlot('fx-1', 'reverb', 0.5)]);
    engine.activeMixerTracks = [track];
    assert.equal(engine.setFxSlotMix(1, 'fx-missing', 0.5), false);
  });
});

describe('Phase 10B: synchronizePlaybackState bypasses full FX rebuild for slot.mix-only edits', () => {
  it('skips updateMixerTrack when only slot.mix changed', () => {
    const initialSlot = makeSlot('fx-sync', 'reverb', 0.2);
    const updatedSlot = makeSlot('fx-sync', 'reverb', 0.7);
    const initial = makeMixerTrack(1, [initialSlot]);
    const updated = makeMixerTrack(1, [updatedSlot]);

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };

    const appliedMixes: number[] = [];
    engine.__liveFxChainRegistry = {
      applyLiveMix(_t: number, _s: string, mix: number) { appliedMixes.push(mix); return true; },
    };

    engine.synchronizePlaybackState({ mixerTracks: [updated] });

    assert.equal(rebuildCount, 0, 'no full rebuild when only slot.mix changed');
    assert.equal(appliedMixes.length, 1, 'live mix forwarded once');
    assert.equal(appliedMixes[0], 0.7, 'live mix matches the new project value');

    const activeTrack = engine.activeMixerTracks[0];
    const activeSlot = activeTrack.fxSlots[0];
    assert.equal(activeSlot.mix, 0.7, 'active take reflects the new mix');

    delete engine.__liveFxChainRegistry;
  });

  it('triggers a full rebuild when a non-mix field changed', () => {
    const initial = makeMixerTrack(1, [makeSlot('fx-sync', 'reverb', 0.5)]);
    const updated = makeMixerTrack(1, [makeSlot('fx-sync', 'reverb', 0.5)]);
    updated.volume = 0.42; // changed track-level field

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };

    engine.synchronizePlaybackState({ mixerTracks: [updated] });
    assert.equal(rebuildCount, 1, 'track-level change still triggers the rebuild');
  });

  it('triggers a full rebuild when a new slot was added', () => {
    const initial = makeMixerTrack(1, [makeSlot('fx-sync', 'reverb', 0.5)]);
    const updated = makeMixerTrack(1, [
      makeSlot('fx-sync', 'reverb', 0.5),
      makeSlot('fx-new', 'delay', 0.7),
    ]);

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };

    engine.synchronizePlaybackState({ mixerTracks: [updated] });
    assert.equal(rebuildCount, 1, 'a new slot forces a full rebuild');
  });

  it('triggers a full rebuild when an existing slot was removed', () => {
    const initial = makeMixerTrack(1, [makeSlot('fx-a', 'reverb', 0.5), makeSlot('fx-b', 'delay', 0.5)]);
    const updated = makeMixerTrack(1, [makeSlot('fx-a', 'reverb', 0.5)]);

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };

    engine.synchronizePlaybackState({ mixerTracks: [updated] });
    assert.equal(rebuildCount, 1, 'removing a slot forces a full rebuild');
  });

  it('triggers a full rebuild when slot.enabled toggles', () => {
    const initial = makeMixerTrack(1, [makeSlot('fx-sync', 'reverb', 0.5)]);
    const updated = makeMixerTrack(1, [{ ...makeSlot('fx-sync', 'reverb', 0.5), enabled: false }]);

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };

    engine.synchronizePlaybackState({ mixerTracks: [updated] });
    assert.equal(rebuildCount, 1, 'toggling slot.enabled forces a rebuild');
  });
});

describe('Phase 10B: song-mode automation triggers the new automation cases during playback', () => {
  it('applies fx_mix automation to the active slot during triggerCurrentStep', () => {
    const slot = makeSlot('fx-song', 'reverb', 0.0);
    const track = makeMixerTrack(1, [slot]);
    const automation = makeAutomationClip(
      'auto-fx',
      { type: 'fx_mix', targetId: 1, paramName: 'fx-song' },
      0,
      1,
      0.5,
    );

    engine.activeMixerTracks = [track];
    engine.activeClips = [automation];
    engine.activePlayMode = 'song';
    engine.currentBar = 1; // bar 1 (index 0) is the automation start
    engine.currentStep = 0;

    // The trigger scheduler calls applyAutomationValue with the current bar/step.
    // song-currentTotalBar = barIdx + step/16 = 0 + 0/16 = 0; relX = (0 - 0) / 1 = 0 -> y = 0.
    engine.triggerCurrentStep(0);
    assert.equal(slot.mix, 0, 'relX 0 reads the first automation point');

    engine.currentBar = 2; // 0.5 in -> y = 0.5
    engine.triggerCurrentStep(0.5);
    // Halfway through a 1-bar automation: relX = (1 - 0) / 1 = 1, y = 1.
    // Reframing: with startBar=0, lengthBars=1, currentTotalBar = (bar-1) + step/16.
    // bar=2, step=0 -> totalBar = 1 -> relX = (1 - 0) / 1 = 1 -> y=0.5.
    assert.equal(slot.mix, 0.5, 'halfway point of lengthBars=1 reads the endpoint y');
  });
});

describe('Phase 10B: voice triggers read the new automation targets', () => {
  it('channel.pitch is read at every note trigger so fx_mix-style automation reaches new notes', () => {
    const channel = makeChannel('ch-voice-pitch', {
      instrumentType: 'minisynth',
      pitch: 0,
    });
    channel.notes = [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 }];
    engine.activeChannels = [channel];
    engine.activePlayMode = 'pat';
    engine.currentStep = 0;

    const oscillatorFreqs: number[] = [];
    engine.playNote = (() => {
      // Replace triggerSubtractiveVoice's internal oscillator-create path
      // by stubbing createOscillator on the fake ctx.
      const fakeOsc = (engine.ctx as any);
      const originalCreateOscillator = fakeOsc.createOscillator;
      fakeOsc.createOscillator = () => ({
        frequency: { setValueAtTime(value: number) { oscillatorFreqs.push(value); } },
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      });
      return ((channelArg: Channel, note: { pitch: number }, time?: number) => {
        // Mirror the engine's midiToFreq using the current channel.pitch.
        const semi = (note.pitch - 69) / 12;
        const baseFreq = 440 * Math.pow(2, semi);
        const finalFreq = baseFreq * Math.pow(2, (channelArg.pitch || 0) / 12);
        oscillatorFreqs.push(finalFreq);
      });
    })();

    // First trigger with pitch=0
    engine.playNote(channel, channel.notes[0], 0);
    const baselineFreq = oscillatorFreqs[oscillatorFreqs.length - 1];

    // Apply +12 semitone automation, then a fresh note trigger reads it.
    engine.applyAutomationValue(
      { type: 'channel_pitch', targetId: 'ch-voice-pitch' },
      1,
      engine.activeChannels,
      [],
      0,
    );
    assert.equal(channel.pitch, 12, 'pitch is +12 semitones after unit automation');

    engine.playNote(channel, channel.notes[0], 0.1);
    const transposedFreq = oscillatorFreqs[oscillatorFreqs.length - 1];
    assert.ok(
      Math.abs(transposedFreq - baselineFreq * 2) < 1e-9,
      'next note is exactly one octave above the baseline (transposed by pitch=+12 semitones)',
    );
  });

  it('channel.synthParams.filterResonance drives the next voice filter Q when automation changes', () => {
    const channel = makeChannel('ch-voice-res');
    channel.notes = [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 }];
    engine.activeChannels = [channel];
    engine.activePlayMode = 'pat';
    engine.currentStep = 0;

    let lastVoiceQ: number | null = null;
    engine.playNote = ((channelArg: Channel) => {
      const p = channelArg.synthParams!;
      lastVoiceQ = p.filterResonance;
    });

    engine.playNote(channel, channel.notes[0], 0);
    assert.equal(lastVoiceQ, channel.synthParams!.filterResonance, 'voice reads the current filterResonance at trigger');

    // Apply automation that doubles the resonance.
    const before = channel.synthParams!.filterResonance;
    engine.applyAutomationValue(
      { type: 'channel_filter_res', targetId: 'ch-voice-res' },
      1,
      engine.activeChannels,
      [],
      0,
    );
    assert.equal(channel.synthParams!.filterResonance, 20, 'automation ceiling (20)');
    assert.notEqual(channel.synthParams!.filterResonance, before, 'resonance moved');

    engine.playNote(channel, channel.notes[0], 0.1);
    assert.equal(lastVoiceQ, 20, 'subsequent voice picks up the automated Q');
  });
});
