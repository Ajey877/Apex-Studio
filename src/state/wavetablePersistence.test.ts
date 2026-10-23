/**
 * Phase 8B — wavetable settings in the channel/project state model.
 *
 * The modal is not the source of truth: parameters live on the channel and must
 * survive the existing mutation, history, save/load and normalization paths.
 * These tests drive those exact modules (`updateChannelInProjectState`,
 * `createHistory`, `serializeProjectState`, `normalizeProjectState`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Channel, ProjectState, WavetableParameters } from '../types/daw';
import { createHistory } from './projectHistory';
import {
  getChannelUpdateLabel,
  isContinuousChannelUpdate,
  updateChannelInProjectState,
} from './projectMutations';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import {
  DEFAULT_WAVETABLE_HARMONICS,
  DEFAULT_WAVETABLE_PARAMETERS,
  normalizeWavetableParameters,
} from '../audio/wavetableTables';

const withWavetableChannel = (
  patch: Partial<WavetableParameters> = {},
  channelPatch: Partial<Channel> = {},
): ProjectState => {
  const state = createDefaultProjectState();
  return updateChannelInProjectState(state, state.channels[0].id, {
    instrumentType: 'wavetable',
    wavetable: normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, ...patch }),
    ...channelPatch,
  });
};

const channelOf = (state: ProjectState, id = state.channels[0].id): Channel => {
  const channel = state.channels.find((candidate) => candidate.id === id);
  assert.ok(channel, `channel ${id} exists`);
  return channel;
};

describe('Phase 8B — wavetable settings in project state', () => {
  it('stores settings on the channel instead of inside synthParams', () => {
    const state = withWavetableChannel({ morph: 0.72, warpMode: 'pwm', warpAmount: 0.3 });
    const channel = channelOf(state);
    assert.equal(channel.instrumentType, 'wavetable');
    assert.ok(channel.wavetable, 'the channel carries wavetable parameters');
    assert.equal(channel.wavetable?.morph, 0.72);
    assert.equal(channel.wavetable?.warpMode, 'pwm');
    assert.equal(
      Object.prototype.hasOwnProperty.call(channel.synthParams, 'wavetable'),
      false,
      'wavetable state does not leak into synthParams',
    );
  });

  it('treats control edits as continuous history and presets as one step', () => {
    const controlEdit = { wavetable: normalizeWavetableParameters({ morph: 0.6 }) };
    assert.equal(isContinuousChannelUpdate(controlEdit), true);
    assert.equal(getChannelUpdateLabel(controlEdit), 'Change synth parameter');

    const presetEdit = {
      instrumentType: 'wavetable' as const,
      wavetable: normalizeWavetableParameters({ morph: 1 }),
    };
    assert.equal(isContinuousChannelUpdate(presetEdit), false);
    assert.equal(getChannelUpdateLabel(presetEdit), 'Apply synth preset');
  });
});

describe('Phase 8B — save, load and old project files', () => {
  it('round-trips wavetable settings through the persisted project document', () => {
    const state = withWavetableChannel({
      morph: 0.18,
      warpMode: 'bend',
      warpAmount: 0.66,
      unisonVoices: 5,
      unisonDetuneCents: 27,
      unisonSpread: 0.55,
      harmonics: [1, 0.1, 0.9, 0.2, 0.7, 0.3, 0.4, 0.05],
    });
    const serialized = serializeProjectState(state);
    const reloaded = normalizeProjectState(JSON.parse(serialized).state);
    const channel = channelOf(reloaded);
    assert.equal(channel.instrumentType, 'wavetable');
    assert.deepEqual(channel.wavetable, channelOf(state).wavetable);
  });

  it('loads a pre-8B project unchanged, with safe engine defaults', () => {
    const legacy = createDefaultProjectState();
    for (const channel of legacy.channels) {
      delete (channel as { wavetable?: WavetableParameters }).wavetable;
    }
    const normalized = normalizeProjectState(legacy);
    for (const channel of normalized.channels) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(channel, 'wavetable'),
        false,
        'a project saved before Phase 8B keeps no wavetable field',
      );
    }
    const resolved = normalizeWavetableParameters(undefined);
    assert.deepEqual(resolved.harmonics, [...DEFAULT_WAVETABLE_HARMONICS]);
    assert.equal(resolved.unisonVoices, DEFAULT_WAVETABLE_PARAMETERS.unisonVoices);
  });

  it('clamps malformed persisted wavetable settings instead of trusting them', () => {
    const poisoned = createDefaultProjectState();
    (poisoned.channels[0] as unknown as Record<string, unknown>).wavetable = {
      morph: 42,
      warpMode: 'not-a-mode',
      warpAmount: -1,
      unisonVoices: 99,
      unisonDetuneCents: 999,
      unisonSpread: 4,
      harmonics: [5, -2, 0.5],
    };
    const normalized = normalizeProjectState(poisoned);
    const wavetable = channelOf(normalized).wavetable;
    assert.ok(wavetable);
    assert.equal(wavetable.morph, 1);
    assert.equal(wavetable.warpMode, 'none');
    assert.equal(wavetable.warpAmount, 0);
    assert.equal(wavetable.unisonVoices, 7);
    assert.equal(wavetable.unisonDetuneCents, 50);
    assert.equal(wavetable.unisonSpread, 1);
    assert.equal(wavetable.harmonics.length, 8);
    for (const value of wavetable.harmonics) {
      assert.ok(value >= 0 && value <= 1, `partial gain ${value} clamped`);
    }
  });
});

describe('Phase 8B — undo and redo preserve the wavetable instrument', () => {
  it('undoes a preset back to the previous settings and redoes it', () => {
    const initial = withWavetableChannel({ morph: 0.35, warpMode: 'none' });
    let history = createHistory(initial);
    const before = channelOf(history.present).wavetable;

    const afterPreset = updateChannelInProjectState(history.present, channelOf(initial).id, {
      instrumentType: 'wavetable',
      wavetable: normalizeWavetableParameters({
        ...DEFAULT_WAVETABLE_PARAMETERS,
        morph: 1,
        warpMode: 'sync',
        warpAmount: 0.7,
        unisonVoices: 7,
        unisonDetuneCents: 30,
        unisonSpread: 0.8,
      }),
    });
    history = history.commit(afterPreset, getChannelUpdateLabel({ instrumentType: 'wavetable' }));
    assert.equal(channelOf(history.present).wavetable?.morph, 1);

    history = history.undo();
    assert.deepEqual(channelOf(history.present).wavetable, before);

    history = history.redo();
    assert.equal(channelOf(history.present).wavetable?.morph, 1);
    assert.equal(channelOf(history.present).wavetable?.warpMode, 'sync');
    assert.equal(channelOf(history.present).wavetable?.unisonVoices, 7);
  });

  it('undoes one slider step at a time without touching other channels', () => {
    const initial = withWavetableChannel({ morph: 0.2 });
    const initialOther = channelOf(initial, initial.channels[1].id).wavetable;
    let history = createHistory(initial);

    history = history.commit(
      updateChannelInProjectState(history.present, channelOf(initial).id, {
        wavetable: normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, morph: 0.4 }),
      }),
      'Change synth parameter',
    );
    history = history.commit(
      updateChannelInProjectState(history.present, channelOf(initial).id, {
        wavetable: normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, morph: 0.6 }),
      }),
      'Change synth parameter',
    );

    history = history.undo();
    assert.equal(channelOf(history.present).wavetable?.morph, 0.4);
    history = history.undo();
    assert.equal(channelOf(history.present).wavetable?.morph, 0.2);
    assert.deepEqual(channelOf(history.present, initial.channels[1].id).wavetable, initialOther);
  });

  it('keeps per-channel settings independent when switching channels', () => {
    const base = withWavetableChannel({ morph: 0.9, warpMode: 'pwm' });
    const firstId = base.channels[0].id;
    const secondId = base.channels[1].id;
    assert.equal(channelOf(base, secondId).wavetable, undefined);

    const updated = updateChannelInProjectState(base, secondId, {
      instrumentType: 'wavetable',
      wavetable: normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, morph: 0.1 }),
    });
    assert.equal(channelOf(updated, firstId).wavetable?.morph, 0.9);
    assert.equal(channelOf(updated, secondId).wavetable?.morph, 0.1);
  });
});
