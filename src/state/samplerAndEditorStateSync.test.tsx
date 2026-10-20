import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { MultiZoneSamplerModal } from '../components/MultiZoneSamplerModal';
import { SampleManagerModal } from '../components/SampleManagerModal';
import { DrumSamplerPanel } from '../components/DrumSamplerPanel';
import { ArpeggiatorModal } from '../components/ArpeggiatorModal';
import { MasterMacroRackModal } from '../components/MasterMacroRackModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import { audioEngine } from '../audio/audioEngine';
import { renderSamplerVoice } from '../audio/instruments/sampler';
import { findSampleZone } from '../audio/sampleZones';
import { createHistory } from './projectHistory';
import { updateChannelInProjectState, updateMacroRackInProjectState } from './projectMutations';
import { normalizeProjectState } from './projectState';
import { hydrateProjectAudio } from './projectPersistence';
import { resolveMacroRack } from './macroMappings';
import type { Channel, CustomSampleData, DrumPad, MasterMacroKnob, Note, ProjectState } from '../types/daw';

/**
 * Lightweight stateful React 19 hook harness for Node tests.
 * Executes real function components across multiple renders, prop updates,
 * and `useEffect` lifecycles without requiring a browser DOM.
 */
function createComponentHarness<P extends Record<string, any>>(Component: React.FC<P>, initialProps: P) {
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: any[] = [];
  let hookIndex = 0;
  let currentProps = initialProps;
  let lastTree: React.ReactNode = null;
  const pendingEffects: Array<() => void> = [];

  const dispatcher = {
    useState(initialValue: any) {
      const idx = hookIndex++;
      if (!(idx in slots)) {
        slots[idx] = typeof initialValue === 'function' ? initialValue() : initialValue;
      }
      const setState = (updater: any) => {
        slots[idx] = typeof updater === 'function' ? updater(slots[idx]) : updater;
      };
      return [slots[idx], setState];
    },
    useMemo(factory: () => any, deps?: readonly any[]) {
      const idx = hookIndex++;
      const prev = slots[idx];
      if (!prev || !deps || !prev.deps || deps.some((dep, i) => !Object.is(dep, prev.deps[i]))) {
        slots[idx] = { value: factory(), deps };
      }
      return slots[idx].value;
    },
    useCallback(fn: any, deps?: readonly any[]) {
      return dispatcher.useMemo(() => fn, deps);
    },
    useRef(initialValue: any) {
      const idx = hookIndex++;
      if (!(idx in slots)) {
        slots[idx] = { current: initialValue };
      }
      return slots[idx];
    },
    useEffect(effect: () => void | (() => void), deps?: readonly any[]) {
      const idx = hookIndex++;
      const prev = slots[idx];
      if (!prev || !deps || !prev.deps || deps.some((dep, i) => !Object.is(dep, prev.deps[i]))) {
        slots[idx] = { deps, cleanup: prev?.cleanup };
        pendingEffects.push(() => {
          if (typeof slots[idx].cleanup === 'function') {
            slots[idx].cleanup();
          }
          slots[idx].cleanup = effect();
        });
      }
    },
    useLayoutEffect(effect: () => void | (() => void), deps?: readonly any[]) {
      dispatcher.useEffect(effect, deps);
    },
    useContext(ctx: any) {
      return ctx._currentValue;
    },
    useId() {
      const idx = hookIndex++;
      if (!(idx in slots)) slots[idx] = `:r${idx}:`;
      return slots[idx];
    },
  };

  const renderOnce = () => {
    const prevDispatcher = internals.H;
    internals.H = dispatcher;
    hookIndex = 0;
    try {
      lastTree = Component(currentProps) as React.ReactNode;
    } finally {
      internals.H = prevDispatcher;
    }
  };

  const flushEffects = () => {
    let safety = 0;
    while (pendingEffects.length > 0 && safety < 20) {
      safety += 1;
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const run of batch) run();
      renderOnce();
    }
  };

  const rerender = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    renderOnce();
    flushEffects();
    return lastTree;
  };

  rerender();

  return {
    get tree() {
      return lastTree;
    },
    get props() {
      return currentProps;
    },
    rerender,
  };
}

interface ElementMatch {
  type: any;
  props: Record<string, any>;
  text: string;
}

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (React.isValidElement(node)) {
    return collectText((node.props as any)?.children);
  }
  return '';
}

function collectElements(node: React.ReactNode, out: ElementMatch[] = []): ElementMatch[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (React.isValidElement(node)) {
    const props = (node.props || {}) as Record<string, any>;
    out.push({
      type: node.type,
      props,
      text: collectText(props.children).replace(/\s+/g, ' ').trim(),
    });
    collectElements(props.children, out);
  }
  return out;
}

const makeSample = (id: string, overrides: Partial<CustomSampleData> = {}): CustomSampleData => ({
  id,
  name: `Sample ${id}`,
  url: `blob:${id}`,
  duration: 2,
  sampleRate: 44100,
  channels: 1,
  waveformPeaks: [0.2, 0.6, 0.9, 0.4],
  trimStart: 0,
  trimEnd: 1,
  rootPitch: 60,
  reverse: false,
  ...overrides,
});

describe('F-1 + F-2: MultiZoneSamplerModal & sampler resolution/history synchronization (A)', () => {
  it('never mutates channel state while closed and creates no automatic history entries on render, channel switch, or close', () => {
    const sampleA = makeSample('kick-sample-a', { rootPitch: 60 });
    const sampleB = makeSample('snare-sample-b', { rootPitch: 64 });
    let project: ProjectState = {
      ...structuredClone(DEFAULT_PROJECT),
      sampleLibrary: [sampleA, sampleB],
      channels: DEFAULT_PROJECT.channels.map((ch, idx) =>
        idx === 0
          ? { ...structuredClone(ch), id: 'ch-kick', instrumentType: 'sampler', customSample: sampleA, sampleZones: [] }
          : idx === 1
            ? { ...structuredClone(ch), id: 'ch-snare', instrumentType: 'sampler', customSample: sampleB, sampleZones: [] }
            : structuredClone(ch)
      ),
    };
    let history = createHistory(project);
    let mutationCalls = 0;

    const handleUpdateChannel = (channelId: string, updates: Partial<Channel>) => {
      mutationCalls += 1;
      project = updateChannelInProjectState(history.present, channelId, updates);
      history = history.commit(project, 'Update channel');
    };

    // 1. Mount closed modal with customSample and empty sampleZones.
    const harness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: false,
      onClose: () => {},
      channels: history.present.channels,
      selectedChannelId: 'ch-kick',
      sampleLibrary: history.present.sampleLibrary,
      onUpdateChannel: handleUpdateChannel,
    });

    assert.equal(mutationCalls, 0, 'closed MultiZoneSamplerModal must not call onUpdateChannel');
    assert.equal(history.canUndo, false, 'mounting closed modal must not push a history entry');
    assert.deepEqual(history.present.channels[0].sampleZones, []);

    // 2. Open modal, switch selectedChannelId to ch-snare, and close without editing any zone.
    harness.rerender({ isOpen: true });
    assert.equal(mutationCalls, 0, 'opening MultiZoneSamplerModal must not auto-mutate project state');
    assert.equal(history.canUndo, false, 'opening modal must not push an automatic history entry');

    harness.rerender({ isOpen: true, selectedChannelId: 'ch-snare' });
    assert.equal(mutationCalls, 0, 'switching channels in MultiZoneSamplerModal must not mutate project state');
    assert.equal(history.canUndo, false, 'switching channels must not push a history entry');

    harness.rerender({ isOpen: false });
    assert.equal(mutationCalls, 0, 'closing MultiZoneSamplerModal must not mutate project state');
    assert.equal(history.canUndo, false);
  });

  it('Undo does not trigger a re-commit from MultiZoneSamplerModal and Redo remains intact', () => {
    const sampleA = makeSample('kick-sample-a', { rootPitch: 60 });
    const baseProject: ProjectState = {
      ...structuredClone(DEFAULT_PROJECT),
      sampleLibrary: [sampleA],
    };
    let history = createHistory(baseProject);
    let autoMutationsDuringUndo = 0;
    let isUndoing = false;

    const handleUpdateChannel = (channelId: string, updates: Partial<Channel>) => {
      if (isUndoing) autoMutationsDuringUndo += 1;
      const next = updateChannelInProjectState(history.present, channelId, updates);
      history = history.commit(next, 'Update channel');
    };

    const harness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: false,
      onClose: () => {},
      channels: history.present.channels,
      sampleLibrary: history.present.sampleLibrary,
      onUpdateChannel: handleUpdateChannel,
    });

    // User assigns a customSample (history entry 1) and then changes channel volume (history entry 2).
    const withSample = updateChannelInProjectState(history.present, 'ch-kick', {
      instrumentType: 'sampler',
      customSample: sampleA,
      sampleZones: [],
    });
    history = history.commit(withSample, 'Assign sample');
    harness.rerender({ channels: history.present.channels });

    const withVolume = updateChannelInProjectState(history.present, 'ch-kick', { volume: 0.5 });
    history = history.commit(withVolume, 'Change volume');
    harness.rerender({ channels: history.present.channels });

    assert.equal(history.canUndo, true);

    // Undo the volume change back to `withSample` (where sampleZones is empty and customSample is set).
    isUndoing = true;
    history = history.undo();
    harness.rerender({ channels: history.present.channels });
    isUndoing = false;

    assert.equal(autoMutationsDuringUndo, 0, 'Undo must not trigger an automatic channel mutation');
    assert.equal(history.canRedo, true, 'Redo stack must remain intact after Undo');
    assert.equal(history.present.channels[0].volume, 0.95);

    history = history.redo();
    assert.equal(history.present.channels[0].volume, 0.5, 'Redo must restore the undone volume edit');
  });

  it('does not turn the untouched auto-seeded default zone into authored project data, so Add Zone Split stays audible and customSample reassignment still takes effect', async () => {
    const sampleA = makeSample('seed-a', { rootPitch: 60 });
    const sampleB = makeSample('seed-b', { rootPitch: 60 });
    const bufferA = { duration: 2, sampleTag: 'a' } as unknown as AudioBuffer;
    const bufferB = { duration: 2, sampleTag: 'b' } as unknown as AudioBuffer;
    const notes: Note[] = [
      { id: 'note-in-split', pitch: 65, start: 0, duration: 1, velocity: 1 },
      { id: 'note-outside-split', pitch: 30, start: 4, duration: 1, velocity: 1 },
    ];
    let project: ProjectState = {
      ...structuredClone(DEFAULT_PROJECT),
      sampleLibrary: [sampleA, sampleB],
      channels: DEFAULT_PROJECT.channels.map((ch, idx) =>
        idx === 0
          ? { ...structuredClone(ch), id: 'ch-kick', instrumentType: 'sampler', customSample: sampleA, sampleZones: [], notes }
          : structuredClone(ch)
      ),
    };
    let history = createHistory(project);

    const handleUpdateChannel = (channelId: string, updates: Partial<Channel>) => {
      project = updateChannelInProjectState(history.present, channelId, updates);
      history = history.commit(project, 'Update channel');
    };

    const harness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: true,
      onClose: () => {},
      channels: history.present.channels,
      selectedChannelId: 'ch-kick',
      sampleLibrary: history.present.sampleLibrary,
      onUpdateChannel: handleUpdateChannel,
    });

    const addZoneButton = collectElements(harness.tree).find(
      el => el.type === 'button' && el.text.includes('Add Zone Split')
    );
    assert.ok(addZoneButton, 'Add Zone Split must be available for a sampler channel');
    addZoneButton.props.onClick();
    harness.rerender({ channels: history.present.channels });

    const splitChannel = history.present.channels.find(ch => ch.id === 'ch-kick')!;
    const splitZones = splitChannel.sampleZones || [];
    assert.equal(
      splitZones.length,
      1,
      'the untouched auto-seeded default zone is a view of customSample and must not be persisted as authored zone data'
    );
    assert.notEqual(splitZones[0].id, 'zone-ch-kick', 'the added zone must be a real authored split');
    assert.equal(splitZones[0].userAuthored, true);
    assert.equal(splitZones[0].sampleId, sampleA.id);
    assert.equal(splitZones[0].lowNote, 60);
    assert.equal(splitZones[0].highNote, 72);
    assert.equal(
      findSampleZone(splitZones, notes[0])?.id,
      splitZones[0].id,
      'the new split must resolve for its own key range'
    );

    const renderAt = (channel: Channel, pitch: number): AudioBuffer | null => {
      let captured: AudioBuffer | null = null;
      const ctx = {
        currentTime: 0,
        createBufferSource: () => ({
          get buffer() { return captured; },
          set buffer(value: AudioBuffer | null) { captured = value; },
          playbackRate: { setValueAtTime: () => {} },
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          connect: () => {},
          start: () => {},
          stop: () => {},
        }),
        createGain: () => ({
          gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: () => {},
        }),
        createBiquadFilter: () => ({
          type: 'lowpass',
          frequency: { setValueAtTime: () => {} },
          Q: { value: 1 },
          connect: () => {},
        }),
      };
      renderSamplerVoice({
        channel,
        note: { id: `render-${pitch}`, pitch, start: 0, duration: 1, velocity: 0.8 },
        time: 0,
        destination: {} as AudioNode,
        audioContext: ctx as any,
        voiceId: `render-${pitch}`,
        bpm: 120,
        getSampleBuffer: (id) => (id === sampleA.id ? bufferA : id === sampleB.id ? bufferB : undefined),
      });
      return captured;
    };

    assert.equal(renderAt(splitChannel, 65), bufferA, 'the split range must play its zone sample');
    assert.equal(renderAt(splitChannel, 30), bufferA, 'keys outside the split must keep the channel sample');

    // SampleManager assigns another sample through the same project-state boundary.
    const reassigned = updateChannelInProjectState(history.present, 'ch-kick', { customSample: sampleB });
    history = history.commit(reassigned, 'Assign sample');
    const reassignedChannel = history.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(reassignedChannel.customSample?.id, sampleB.id);
    assert.deepEqual(reassignedChannel.sampleZones, splitZones, 'the authored split must survive the reassignment');
    assert.equal(renderAt(reassignedChannel, 65), bufferA, 'the authored split must keep playing its own sample');
    assert.equal(renderAt(reassignedChannel, 30), bufferB, 'customSample reassignment must take effect outside the split');
    assert.equal(renderAt(reassignedChannel, 90), bufferB);

    // Undo/Redo publish the same document to playback.
    const undone = history.undo();
    const undoneChannel = undone.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(undoneChannel.customSample?.id, sampleA.id);
    assert.deepEqual(undoneChannel.sampleZones, splitZones);
    const redone = undone.redo();
    assert.equal(redone.present.channels.find(ch => ch.id === 'ch-kick')!.customSample?.id, sampleB.id);

    // Offline export must resolve the same key map as live playback.
    const offlineBuffers: AudioBuffer[] = [];
    const prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    const engine = audioEngine as any;
    const prevSampleBuffers = engine.sampleBuffers;
    class CapturingOfflineContext {
      currentTime = 0;
      sampleRate = 44100;
      length = 44100;
      numberOfChannels = 2;
      destination = { connect: () => {} };
      createGain() { return { gain: { value: 1, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} }, connect: () => {}, disconnect: () => {} }; }
      createStereoPanner() { return { pan: { value: 0, setValueAtTime: () => {}, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} }; }
      createBiquadFilter() { return { type: 'lowpass', frequency: { value: 18000, setValueAtTime: () => {}, setTargetAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, Q: { value: 1, setValueAtTime: () => {} }, gain: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} }; }
      createDynamicsCompressor() { return { threshold: { value: -24, setValueAtTime: () => {} }, knee: { value: 30, setValueAtTime: () => {} }, ratio: { value: 12, setValueAtTime: () => {} }, attack: { value: 0.003, setValueAtTime: () => {} }, release: { value: 0.25, setValueAtTime: () => {} }, reduction: 0, connect: () => {}, disconnect: () => {} }; }
      createWaveShaper() { return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} }; }
      createDelay() { return { delayTime: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} }; }
      createConvolver() { return { buffer: null, normalize: true, connect: () => {}, disconnect: () => {} }; }
      createAnalyser() { return { fftSize: 256, smoothingTimeConstant: 0.7, connect: () => {}, disconnect: () => {}, getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0), getByteFrequencyData: (arr: Uint8Array) => arr.fill(0), getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128) }; }
      createConstantSource() { return { offset: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} }; }
      createOscillator() { return { type: 'sine', frequency: { value: 440, setValueAtTime: () => {} }, detune: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} }; }
      createBufferSource() {
        return {
          get buffer() { return null; },
          set buffer(value: AudioBuffer | null) { if (value) offlineBuffers.push(value); },
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          playbackRate: { value: 1, setValueAtTime: () => {} },
          connect: () => {},
          disconnect: () => {},
          start: () => {},
          stop: () => {},
        };
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
          copyFromChannel: () => {},
          copyToChannel: () => {},
        } as unknown as AudioBuffer;
      }
      async startRendering() {
        return this.createBuffer(2, this.length, this.sampleRate);
      }
    }
    try {
      (globalThis as any).OfflineAudioContext = CapturingOfflineContext;
      engine.sampleBuffers = new Map<string, AudioBuffer>([[sampleA.id, bufferA], [sampleB.id, bufferB]]);
      await audioEngine.renderTimelineOffline(
        [reassignedChannel],
        [],
        DEFAULT_PROJECT.mixerTracks,
        120,
        1,
        44100,
        false,
        'pattern'
      );
    } finally {
      engine.sampleBuffers = prevSampleBuffers;
      (globalThis as any).OfflineAudioContext = prevOfflineCtx;
    }
    assert.ok(offlineBuffers.includes(bufferA), 'offline export must use the split zone sample');
    assert.ok(offlineBuffers.includes(bufferB), 'offline export must use the reassigned customSample outside the split');
  });

  it('persists an edited seed zone as authored data and lets the last authored zone be deleted back to customSample', () => {
    const sampleA = makeSample('seed-edit-a', { rootPitch: 60 });
    const sampleB = makeSample('seed-edit-b', { rootPitch: 60 });
    const bufferA = { duration: 2, sampleTag: 'edit-a' } as unknown as AudioBuffer;
    const bufferB = { duration: 2, sampleTag: 'edit-b' } as unknown as AudioBuffer;
    let project: ProjectState = {
      ...structuredClone(DEFAULT_PROJECT),
      sampleLibrary: [sampleA, sampleB],
      channels: DEFAULT_PROJECT.channels.map((ch, idx) =>
        idx === 0
          ? { ...structuredClone(ch), id: 'ch-kick', instrumentType: 'sampler', customSample: sampleA, sampleZones: [] }
          : structuredClone(ch)
      ),
    };
    let history = createHistory(project);
    const handleUpdateChannel = (channelId: string, updates: Partial<Channel>) => {
      project = updateChannelInProjectState(history.present, channelId, updates);
      history = history.commit(project, 'Update channel');
    };
    const harness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: true,
      onClose: () => {},
      channels: history.present.channels,
      selectedChannelId: 'ch-kick',
      sampleLibrary: history.present.sampleLibrary,
      onUpdateChannel: handleUpdateChannel,
    });

    // Editing the seed makes it real authored data (rootNote 48, still full range).
    let rangeSliders = collectElements(harness.tree).filter(el => el.type === 'input' && el.props.type === 'range');
    assert.equal(rangeSliders.length, 3);
    rangeSliders[2].props.onChange({ target: { value: '48' } });
    harness.rerender({ channels: history.present.channels });

    let channel = history.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(channel.sampleZones?.length, 1);
    assert.equal(channel.sampleZones?.[0].userAuthored, true, 'an edited seed must be published as authored data');
    assert.equal(channel.sampleZones?.[0].rootNote, 48);
    assert.equal(channel.sampleZones?.[0].lowNote, 0);
    assert.equal(channel.sampleZones?.[0].highNote, 127);

    // A later customSample assignment must not discard the authored edit.
    project = updateChannelInProjectState(history.present, 'ch-kick', { customSample: sampleB });
    history = history.commit(project, 'Assign sample');
    harness.rerender({ channels: history.present.channels });
    channel = history.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(channel.customSample?.id, sampleB.id);
    assert.equal(channel.sampleZones?.length, 1);
    assert.equal(channel.sampleZones?.[0].sampleId, sampleA.id);
    assert.equal(channel.sampleZones?.[0].rootNote, 48);

    // Deleting the last authored zone returns the channel to its body sample.
    const deleteButton = collectElements(harness.tree).find(
      el => el.type === 'button' && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Delete zone ')
    );
    assert.ok(deleteButton, 'the authored zone must be deletable');
    deleteButton.props.onClick();
    harness.rerender({ channels: history.present.channels });

    channel = history.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.deepEqual(channel.sampleZones, [], 'deleting the last authored zone must clear the key map');
    assert.equal(channel.customSample?.id, sampleB.id, 'deleting a zone must not discard the assigned sample');

    let captured: AudioBuffer | null = null;
    const ctx = {
      currentTime: 0,
      createBufferSource: () => ({
        get buffer() { return captured; },
        set buffer(value: AudioBuffer | null) { captured = value; },
        playbackRate: { setValueAtTime: () => {} },
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        connect: () => {},
        start: () => {},
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };
    renderSamplerVoice({
      channel,
      note: { id: 'after-delete', pitch: 60, start: 0, duration: 1, velocity: 0.8 },
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'after-delete',
      bpm: 120,
      getSampleBuffer: (id) => (id === sampleA.id ? bufferA : id === sampleB.id ? bufferB : undefined),
    });
    assert.equal(captured, bufferB, 'after the key map is cleared the channel body sample must play again');

    const undone = history.undo();
    assert.equal(
      undone.present.channels.find(ch => ch.id === 'ch-kick')!.sampleZones?.[0].sampleId,
      sampleA.id,
      'undo must restore the deleted authored zone'
    );
  });

  it('replacing customSample and editing trim/rootPitch/reverse affects played and offline-exported audio while preserving explicit multi-zone splits', async () => {
    const oldSample = makeSample('old-sample', { duration: 1, rootPitch: 60 });
    const newSample = makeSample('new-sample', {
      duration: 2,
      trimStart: 0.25,
      trimEnd: 0.75,
      rootPitch: 72,
      reverse: true,
    });

    // Channel that previously received an auto-generated default 0..127 zone for oldSample,
    // and now has its customSample replaced and edited in SampleManagerModal.
    const samplerChannel: Channel = {
      ...structuredClone(DEFAULT_PROJECT.channels[0]),
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: newSample,
      sampleZones: [
        {
          id: 'zone-ch-kick',
          lowNote: 0,
          highNote: 127,
          rootNote: 60,
          lowVelocity: 0,
          highVelocity: 127,
          sampleId: oldSample.id,
          tuneSemitones: 0,
        },
      ],
      notes: [{ id: 'n-1', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const oldBuf = { duration: 1, sampleRate: 44100, numberOfChannels: 1, length: 44100, getChannelData: () => new Float32Array(44100).fill(0.1) } as unknown as AudioBuffer;
    const newBuf = { duration: 2, sampleRate: 44100, numberOfChannels: 1, length: 88200, getChannelData: () => new Float32Array(88200).fill(0.8) } as unknown as AudioBuffer;

    const requestedSampleIds: string[] = [];
    let capturedRate = 0;
    let capturedStartArgs: unknown[] = [];
    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => ({
        buffer: null as AudioBuffer | null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: { setValueAtTime: (v: number) => { capturedRate = v; } },
        connect: () => {},
        start: (...args: unknown[]) => { capturedStartArgs = args; },
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };

    const handle = renderSamplerVoice({
      channel: samplerChannel,
      note: samplerChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-replace',
      bpm: 120,
      getSampleBuffer: (id) => {
        requestedSampleIds.push(id);
        return id === newSample.id ? newBuf : id === oldSample.id ? oldBuf : undefined;
      },
    });

    assert.ok(handle);
    assert.deepEqual(requestedSampleIds, [newSample.id], 'sampler must resolve replaced customSample.id');
    assert.ok(Math.abs(capturedRate + 0.5) < 1e-9, 'sampler must apply rootPitch=72 and reverse=true from customSample');
    assert.deepEqual(capturedStartArgs, [0, 1.5, 1], 'sampler must apply trimStart=0.25 and trimEnd=0.75 from customSample');

    // Offline export path must also render the replaced customSample.id and its edited trim/pitch/reverse.
    const offlineCreatedSources: Array<{ buffer: AudioBuffer | null; rate: number; startArgs: unknown[] }> = [];
    const origGetSampleBuffer = (audioEngine as any).sampleBuffers;
    const sampleMap = new Map<string, AudioBuffer>([
      [oldSample.id, oldBuf],
      [newSample.id, newBuf],
    ]);
    const prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    class StubOfflineAudioContext {
      currentTime = 0;
      sampleRate = 44100;
      length = 44100;
      numberOfChannels = 2;
      destination = { connect: () => {} };
      createGain() {
        return {
          gain: { value: 1, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} },
          connect: () => {},
          disconnect: () => {},
        };
      }
      createStereoPanner() {
        return { pan: { value: 0, setValueAtTime: () => {}, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createBiquadFilter() {
        return { type: 'lowpass', frequency: { value: 18000, setValueAtTime: () => {}, setTargetAtTime: () => {} }, Q: { value: 1, setValueAtTime: () => {} }, gain: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createDynamicsCompressor() {
        return { threshold: { value: -24, setValueAtTime: () => {} }, knee: { value: 30, setValueAtTime: () => {} }, ratio: { value: 12, setValueAtTime: () => {} }, attack: { value: 0.003, setValueAtTime: () => {} }, release: { value: 0.25, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createWaveShaper() {
        return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} };
      }
      createDelay() {
        return { delayTime: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createConvolver() {
        return { buffer: null, connect: () => {}, disconnect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 256,
          smoothingTimeConstant: 0.7,
          connect: () => {},
          disconnect: () => {},
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0),
          getByteFrequencyData: (arr: Uint8Array) => arr.fill(0),
          getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
        };
      }
      createConstantSource() {
        return { offset: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
      }
      createOscillator() {
        return { type: 'sine', frequency: { value: 440, setValueAtTime: () => {} }, detune: { value: 0, setValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} };
      }
      createBufferSource() {
        const record = { buffer: null as AudioBuffer | null, rate: 1, startArgs: [] as unknown[] };
        offlineCreatedSources.push(record);
        return {
          get buffer() { return record.buffer; },
          set buffer(val: AudioBuffer | null) { record.buffer = val; },
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          playbackRate: { value: 1, setValueAtTime: (v: number) => { record.rate = v; } },
          connect: () => {},
          start: (...args: unknown[]) => { record.startArgs = args; },
          stop: () => {},
        };
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
        };
      }
      async startRendering() {
        return this.createBuffer(2, this.length, this.sampleRate);
      }
    }
    try {
      (globalThis as any).OfflineAudioContext = StubOfflineAudioContext;
      (audioEngine as any).sampleBuffers = sampleMap;
      await audioEngine.renderTimelineOffline(
        [samplerChannel],
        [],
        DEFAULT_PROJECT.mixerTracks,
        120,
        1,
        44100,
        false,
        'pattern'
      );
    } finally {
      (audioEngine as any).sampleBuffers = origGetSampleBuffer;
      (globalThis as any).OfflineAudioContext = prevOfflineCtx;
    }
    assert.ok(offlineCreatedSources.length >= 1);
    assert.ok(offlineCreatedSources.every(s => s.buffer === newBuf), 'offline export must render replaced customSample buffer');
    assert.ok(Math.abs(offlineCreatedSources[0].rate + 0.5) < 1e-9, 'offline export must apply rootPitch=72 and reverse=true');
    assert.deepEqual(offlineCreatedSources[0].startArgs, [0, 1.5, 1], 'offline export must apply trimStart=0.25 and trimEnd=0.75');

    // Explicit multi-zone split (2 zones) must remain authoritative over customSample.
    const multiZoneChannel: Channel = {
      ...samplerChannel,
      sampleZones: [
        { id: 'zone-low', lowNote: 0, highNote: 59, rootNote: 48, lowVelocity: 0, highVelocity: 127, sampleId: 'low-zone-sample', tuneSemitones: 0 },
        { id: 'zone-high', lowNote: 60, highNote: 127, rootNote: 60, lowVelocity: 0, highVelocity: 127, sampleId: 'high-zone-sample', tuneSemitones: 3 },
      ],
    };
    const multiRequested: string[] = [];
    renderSamplerVoice({
      channel: multiZoneChannel,
      note: { id: 'n-hi', pitch: 60, start: 0, duration: 1, velocity: 1 } as Note,
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-multi',
      bpm: 120,
      getSampleBuffer: (id) => {
        multiRequested.push(id);
        return newBuf;
      },
    });
    assert.deepEqual(multiRequested, ['high-zone-sample'], 'explicit multi-zone mapping must remain intact');
  });

  it('keeps an explicitly user-authored full-range single-zone mapping in MultiZoneSamplerModal authoritative when customSample also exists', () => {
    const channelSample = makeSample('channel-custom-sample', {
      duration: 2,
      rootPitch: 60,
      trimStart: 0.2,
      trimEnd: 0.8,
      reverse: false,
    });
    const zoneLibrarySample = makeSample('zone-authored-sample', {
      duration: 4,
      rootPitch: 60,
      trimStart: 0.1,
      trimEnd: 0.9,
      reverse: true,
    });

    let activeChannel: Channel = {
      ...structuredClone(DEFAULT_PROJECT.channels[0]),
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: channelSample,
      sampleZones: [],
      synthParams: {
        ...structuredClone(DEFAULT_PROJECT.channels[0].synthParams),
        sampleLoop: true,
      },
      notes: [{ id: 'n-zone', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const harness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: true,
      onClose: () => {},
      channels: [activeChannel],
      selectedChannelId: 'ch-kick',
      sampleLibrary: [channelSample, zoneLibrarySample],
      onUpdateChannel: (channelId, updates) => {
        if (channelId === activeChannel.id) {
          activeChannel = { ...activeChannel, ...updates };
        }
      },
    });

    // User edits the full-range single zone in MultiZoneSamplerModal by assigning `zone-authored-sample`
    // and setting rootNote to 48 while keeping the full 0..127 MIDI range.
    let elements = collectElements(harness.tree);
    const sampleSelect = elements.find(el => el.type === 'select');
    assert.ok(sampleSelect, 'sample selector must render in MultiZoneSamplerModal');
    sampleSelect.props.onChange({ target: { value: zoneLibrarySample.id } });
    harness.rerender({ channels: [activeChannel] });

    elements = collectElements(harness.tree);
    const rangeSliders = elements.filter(el => el.type === 'input' && el.props.type === 'range');
    assert.equal(rangeSliders.length, 3, 'lowNote, highNote, and rootNote sliders must render');
    rangeSliders[2].props.onChange({ target: { value: '48' } });
    harness.rerender({ channels: [activeChannel] });

    assert.equal(activeChannel.sampleZones?.length, 1);
    assert.equal(activeChannel.sampleZones?.[0].lowNote, 0);
    assert.equal(activeChannel.sampleZones?.[0].highNote, 127);
    assert.equal(activeChannel.sampleZones?.[0].sampleId, zoneLibrarySample.id);
    assert.equal(activeChannel.sampleZones?.[0].rootNote, 48);

    const channelBuf = { duration: 2 } as AudioBuffer;
    const zoneBuf = { duration: 4 } as AudioBuffer;
    let capturedBuffer: AudioBuffer | null = null;
    let capturedRate = 0;
    let capturedLoop = false;
    let capturedStartArgs: unknown[] = [];

    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => ({
        get buffer() { return capturedBuffer; },
        set buffer(val: AudioBuffer | null) { capturedBuffer = val; },
        get loop() { return capturedLoop; },
        set loop(val: boolean) { capturedLoop = val; },
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: { setValueAtTime: (v: number) => { capturedRate = v; } },
        connect: () => {},
        start: (...args: unknown[]) => { capturedStartArgs = args; },
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };

    const handle = renderSamplerVoice({
      channel: activeChannel,
      note: activeChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-authored-single-zone',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === zoneLibrarySample.id ? zoneBuf : id === channelSample.id ? channelBuf : undefined,
    });

    assert.ok(handle);
    assert.equal(capturedBuffer, zoneBuf, 'user-authored full-range single zone must play its assigned sample even when customSample exists');
    assert.ok(
      Math.abs(capturedRate + Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'user-authored full-range single zone must apply its rootNote=48 and reverse=true',
    );
    assert.equal(capturedLoop, true, 'user-authored full-range single zone must preserve loop setting');
    assert.deepEqual(
      capturedStartArgs,
      [0, 3.6, undefined],
      'user-authored full-range single zone must apply its trimEnd=0.9 offset',
    );
  });

  it('replaces a legacy implicit single zone whose non-default rootNote, trim, and reverse were copied from its original sample across live playback, modal hydration, and offline export', async () => {
    const originalSample = makeSample('orig-nondefault', {
      duration: 2,
      rootPitch: 48,
      trimStart: 0.15,
      trimEnd: 0.85,
      reverse: true,
    });
    const replacementSample = makeSample('replacement-nondefault', {
      duration: 4,
      rootPitch: 72,
      trimStart: 0.25,
      trimEnd: 0.75,
      reverse: false,
    });

    const baseProject = structuredClone(DEFAULT_PROJECT);
    const legacyChannel: Channel = {
      ...baseProject.channels[0],
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: originalSample,
      synthParams: {
        ...baseProject.channels[0].synthParams,
        sampleLoop: true,
      },
      // Legacy auto-generated zone created from originalSample before userAuthored existed
      sampleZones: [
        {
          id: 'zone-ch-kick',
          sampleId: originalSample.id,
          lowNote: 0,
          highNote: 127,
          rootNote: 48,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
          trimStart: 0.15,
          trimEnd: 0.85,
          reverse: true,
          loop: true,
        },
      ],
      notes: [{ id: 'n-legacy-replace', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const initialNormalized: ProjectState = normalizeProjectState({
      ...baseProject,
      channels: [legacyChannel, ...baseProject.channels.slice(1)],
      sampleLibrary: [originalSample, replacementSample],
    });
    let history = createHistory(initialNormalized);
    let state: ProjectState = updateChannelInProjectState(initialNormalized, 'ch-kick', {
      customSample: replacementSample,
    });
    history = history.commit(state, 'Replace sample');

    // Undo / Redo across customSample replacement on a confirmed legacy implicit zone:
    assert.equal(history.canUndo, true, 'undo must be available after replacing customSample');
    const undoneHistory = history.undo();
    const undoneChannel = undoneHistory.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(undoneChannel.customSample?.id, originalSample.id, 'undo must restore original customSample');
    assert.equal(undoneChannel.sampleZones?.length, 1, 'undo must restore pre-replacement implicit zone snapshot');
    assert.equal(undoneChannel.sampleZones?.[0].sampleId, originalSample.id);

    const redoneHistory = undoneHistory.redo();
    const redoneChannel = redoneHistory.present.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(redoneChannel.customSample?.id, replacementSample.id, 'redo must restore replacement customSample');
    assert.equal(redoneChannel.sampleZones?.length, 0, 'redo must clear the confirmed legacy implicit zone');

    const updatedChannel = state.channels.find(ch => ch.id === 'ch-kick')!;
    const origBuf = { duration: 2 } as AudioBuffer;
    const replacementBuf = { duration: 4 } as AudioBuffer;
    let capturedBuffer: AudioBuffer | null = null;
    let capturedRate = 0;
    let capturedLoop = false;
    let capturedLoopStart = 0;
    let capturedLoopEnd = 0;
    let capturedStartArgs: unknown[] = [];

    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => ({
        get buffer() { return capturedBuffer; },
        set buffer(val: AudioBuffer | null) { capturedBuffer = val; },
        get loop() { return capturedLoop; },
        set loop(val: boolean) { capturedLoop = val; },
        get loopStart() { return capturedLoopStart; },
        set loopStart(val: number) { capturedLoopStart = val; },
        get loopEnd() { return capturedLoopEnd; },
        set loopEnd(val: number) { capturedLoopEnd = val; },
        onended: null,
        playbackRate: { setValueAtTime: (v: number) => { capturedRate = v; } },
        connect: () => {},
        start: (...args: unknown[]) => { capturedStartArgs = args; },
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };

    const handle = renderSamplerVoice({
      channel: updatedChannel,
      note: updatedChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-legacy-nondefault-replace',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === replacementSample.id ? replacementBuf : id === originalSample.id ? origBuf : undefined,
    });

    assert.ok(handle);
    assert.equal(capturedBuffer, replacementBuf, 'live playback must use replacement customSample buffer');
    assert.ok(
      Math.abs(capturedRate - Math.pow(2, (60 - 72) / 12)) < 1e-9,
      'live playback must use replacement rootPitch=72 and reverse=false',
    );
    assert.equal(capturedLoop, true, 'live playback must preserve channel sampleLoop=true');
    assert.equal(capturedLoopStart, 1, 'live playback must use replacement trimStart=0.25 * 4s');
    assert.equal(capturedLoopEnd, 3, 'live playback must use replacement trimEnd=0.75 * 4s');
    assert.deepEqual(capturedStartArgs, [0, 1, undefined], 'live playback must start at replacement trimStart offset');

    // MultiZoneSamplerModal must also hydrate from the replacement customSample instead of the stale legacy zone.
    const modalHarness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: true,
      onClose: () => {},
      channels: state.channels,
      selectedChannelId: 'ch-kick',
      sampleLibrary: state.sampleLibrary,
      onUpdateChannel: () => {},
    });
    const modalElements = collectElements(modalHarness.tree);
    const sampleSelect = modalElements.find(el => el.type === 'select');
    assert.equal(
      sampleSelect?.props.value,
      replacementSample.id,
      'MultiZoneSamplerModal must hydrate from replacement customSample when persisted zone is a legacy implicit copy',
    );

    // Offline export via audioEngine.renderTimelineOffline must also use the replacement sample and its settings.
    const offlineCreatedSources: Array<{ buffer: AudioBuffer | null; rate: number; startArgs: unknown[] }> = [];
    const origGetSampleBuffer = (audioEngine as any).sampleBuffers;
    const sampleMap = new Map<string, AudioBuffer>([
      [originalSample.id, origBuf],
      [replacementSample.id, replacementBuf],
    ]);
    const prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    class StubOfflineAudioContext {
      currentTime = 0;
      sampleRate = 44100;
      length = 44100;
      numberOfChannels = 2;
      destination = { connect: () => {} };
      createGain() {
        return {
          gain: { value: 1, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} },
          connect: () => {},
          disconnect: () => {},
        };
      }
      createStereoPanner() {
        return { pan: { value: 0, setValueAtTime: () => {}, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createBiquadFilter() {
        return { type: 'lowpass', frequency: { value: 18000, setValueAtTime: () => {}, setTargetAtTime: () => {} }, Q: { value: 1, setValueAtTime: () => {} }, gain: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createDynamicsCompressor() {
        return { threshold: { value: -24, setValueAtTime: () => {} }, knee: { value: 30, setValueAtTime: () => {} }, ratio: { value: 12, setValueAtTime: () => {} }, attack: { value: 0.003, setValueAtTime: () => {} }, release: { value: 0.25, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createWaveShaper() {
        return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} };
      }
      createDelay() {
        return { delayTime: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createConvolver() {
        return { buffer: null, connect: () => {}, disconnect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 256,
          smoothingTimeConstant: 0.7,
          connect: () => {},
          disconnect: () => {},
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0),
          getByteFrequencyData: (arr: Uint8Array) => arr.fill(0),
          getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
        };
      }
      createConstantSource() {
        return { offset: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
      }
      createOscillator() {
        return { type: 'sine', frequency: { value: 440, setValueAtTime: () => {} }, detune: { value: 0, setValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} };
      }
      createBufferSource() {
        const record = { buffer: null as AudioBuffer | null, rate: 1, startArgs: [] as unknown[] };
        offlineCreatedSources.push(record);
        return {
          get buffer() { return record.buffer; },
          set buffer(val: AudioBuffer | null) { record.buffer = val; },
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          playbackRate: { value: 1, setValueAtTime: (v: number) => { record.rate = v; } },
          connect: () => {},
          start: (...args: unknown[]) => { record.startArgs = args; },
          stop: () => {},
        };
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
        };
      }
      async startRendering() {
        return this.createBuffer(2, this.length, this.sampleRate);
      }
    }
    try {
      (globalThis as any).OfflineAudioContext = StubOfflineAudioContext;
      (audioEngine as any).sampleBuffers = sampleMap;
      await audioEngine.renderTimelineOffline(
        [updatedChannel],
        [],
        DEFAULT_PROJECT.mixerTracks,
        120,
        1,
        44100,
        false,
        'pattern'
      );
    } finally {
      (audioEngine as any).sampleBuffers = origGetSampleBuffer;
      (globalThis as any).OfflineAudioContext = prevOfflineCtx;
    }
    assert.ok(offlineCreatedSources.length >= 1, 'offline export must schedule at least one buffer source');
    assert.ok(
      offlineCreatedSources.every(src => src.buffer === replacementBuf),
      'offline export must use replacement customSample buffer instead of stale legacy implicit zone buffer',
    );
    assert.ok(
      Math.abs(offlineCreatedSources[0].rate - Math.pow(2, (60 - 72) / 12)) < 1e-9,
      'offline export must apply replacement rootPitch=72 and reverse=false',
    );
    assert.deepEqual(
      offlineCreatedSources[0].startArgs,
      [0, 1, undefined],
      'offline export must apply replacement trimStart=0.25 with loop=true',
    );
  });

  it('preserves an unflagged generated-ID full-range single zone whose sampleId differs from customSample.id even when its source exists in sampleLibrary with matching playback settings across normalization, live playback, modal hydration, and offline export', async () => {
    const channelSample = makeSample('channel-sample-match-test', {
      duration: 2,
      rootPitch: 72,
      trimStart: 0.25,
      trimEnd: 0.75,
      reverse: false,
    });
    const libraryZoneSample = makeSample('library-zone-match-test', {
      duration: 4,
      rootPitch: 48,
      trimStart: 0.15,
      trimEnd: 0.85,
      reverse: true,
    });

    const baseProject = structuredClone(DEFAULT_PROJECT);
    const legacyExplicitZoneChannel: Channel = {
      ...baseProject.channels[0],
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: channelSample,
      synthParams: {
        ...baseProject.channels[0].synthParams,
        sampleLoop: true,
      },
      // Legacy zone where user selected libraryZoneSample in MultiZoneSamplerModal before userAuthored existed
      sampleZones: [
        {
          id: 'zone-ch-kick',
          sampleId: libraryZoneSample.id,
          lowNote: 0,
          highNote: 127,
          rootNote: 48,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
          trimStart: 0.15,
          trimEnd: 0.85,
          reverse: true,
          loop: true,
        },
      ],
      notes: [{ id: 'n-library-match-sync', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const state: ProjectState = normalizeProjectState({
      ...baseProject,
      channels: [legacyExplicitZoneChannel, ...baseProject.channels.slice(1)],
      sampleLibrary: [channelSample, libraryZoneSample],
    });
    const normalizedChannel = state.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(
      normalizedChannel.sampleZones?.length,
      1,
      'normalizeProjectState must preserve an unflagged generated-ID full-range single zone whose sampleId differs from customSample.id',
    );
    assert.equal(normalizedChannel.sampleZones?.[0].sampleId, libraryZoneSample.id);
    assert.equal(normalizedChannel.sampleZones?.[0].userAuthored, true);

    const channelBuf = { duration: 2 } as AudioBuffer;
    const zoneBuf = { duration: 4 } as AudioBuffer;
    let capturedBuffer: AudioBuffer | null = null;
    let capturedRate = 0;

    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => ({
        get buffer() { return capturedBuffer; },
        set buffer(val: AudioBuffer | null) { capturedBuffer = val; },
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: { setValueAtTime: (v: number) => { capturedRate = v; } },
        connect: () => {},
        start: () => {},
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };

    const handle = renderSamplerVoice({
      channel: normalizedChannel,
      note: normalizedChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-library-match-sync',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === libraryZoneSample.id ? zoneBuf : id === channelSample.id ? channelBuf : undefined,
    });
    assert.ok(handle);
    assert.equal(capturedBuffer, zoneBuf, 'live playback must use preserved zone sample buffer');
    assert.ok(
      Math.abs(capturedRate + Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'live playback must preserve zone rootNote=48 and reverse=true',
    );

    const modalHarness = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: true,
      onClose: () => {},
      channels: state.channels,
      selectedChannelId: 'ch-kick',
      sampleLibrary: state.sampleLibrary,
      onUpdateChannel: () => {},
    });
    const modalElements = collectElements(modalHarness.tree);
    const sampleSelect = modalElements.find(el => el.type === 'select');
    assert.equal(
      sampleSelect?.props.value,
      libraryZoneSample.id,
      'MultiZoneSamplerModal must hydrate from the preserved zone sampleId',
    );

    const offlineCreatedSources: Array<{ buffer: AudioBuffer | null; rate: number }> = [];
    const origGetSampleBuffer = (audioEngine as any).sampleBuffers;
    const sampleMap = new Map<string, AudioBuffer>([
      [channelSample.id, channelBuf],
      [libraryZoneSample.id, zoneBuf],
    ]);
    const prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    class StubOfflineAudioContext {
      currentTime = 0;
      sampleRate = 44100;
      length = 44100;
      numberOfChannels = 2;
      destination = { connect: () => {} };
      createGain() {
        return {
          gain: { value: 1, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} },
          connect: () => {},
          disconnect: () => {},
        };
      }
      createStereoPanner() {
        return { pan: { value: 0, setValueAtTime: () => {}, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createBiquadFilter() {
        return { type: 'lowpass', frequency: { value: 18000, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} }, Q: { value: 1, setValueAtTime: () => {} }, gain: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createDynamicsCompressor() {
        return { threshold: { value: -24, setValueAtTime: () => {} }, knee: { value: 30, setValueAtTime: () => {} }, ratio: { value: 12, setValueAtTime: () => {} }, attack: { value: 0.003, setValueAtTime: () => {} }, release: { value: 0.25, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createWaveShaper() {
        return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} };
      }
      createDelay() {
        return { delayTime: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createConvolver() {
        return { buffer: null, connect: () => {}, disconnect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 256,
          smoothingTimeConstant: 0.7,
          connect: () => {},
          disconnect: () => {},
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0),
          getByteFrequencyData: (arr: Uint8Array) => arr.fill(0),
          getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
        };
      }
      createConstantSource() {
        return { offset: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
      }
      createOscillator() {
        return { type: 'sine', frequency: { value: 440, setValueAtTime: () => {} }, detune: { value: 0, setValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} };
      }
      createBufferSource() {
        const record = { buffer: null as AudioBuffer | null, rate: 1 };
        offlineCreatedSources.push(record);
        return {
          get buffer() { return record.buffer; },
          set buffer(val: AudioBuffer | null) { record.buffer = val; },
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          playbackRate: { value: 1, setValueAtTime: (v: number) => { record.rate = v; } },
          connect: () => {},
          start: () => {},
          stop: () => {},
        };
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
        };
      }
      async startRendering() {
        return this.createBuffer(2, this.length, this.sampleRate);
      }
    }
    try {
      (globalThis as any).OfflineAudioContext = StubOfflineAudioContext;
      (audioEngine as any).sampleBuffers = sampleMap;
      await audioEngine.renderTimelineOffline(
        [normalizedChannel],
        [],
        DEFAULT_PROJECT.mixerTracks,
        120,
        1,
        44100,
        false,
        'pattern'
      );
    } finally {
      (audioEngine as any).sampleBuffers = origGetSampleBuffer;
      (globalThis as any).OfflineAudioContext = prevOfflineCtx;
    }
    assert.ok(offlineCreatedSources.length >= 1);
    assert.ok(
      offlineCreatedSources.every(src => src.buffer === zoneBuf),
      'offline export must use the preserved zone sample buffer',
    );
  });

  it('preserves a legacy full-range single zone whose rootNote diverged from its library sample when normalizing and rendering', () => {
    const channelSample = makeSample('current-channel-sample', {
      duration: 2,
      rootPitch: 72,
      trimStart: 0.2,
      trimEnd: 0.8,
      reverse: false,
    });
    const libraryZoneSample = makeSample('legacy-library-sample', {
      duration: 4,
      rootPitch: 60,
      trimStart: 0,
      trimEnd: 1,
      reverse: false,
    });

    const baseProject = structuredClone(DEFAULT_PROJECT);
    const legacyDivergedChannel: Channel = {
      ...baseProject.channels[0],
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: channelSample,
      // Legacy single zone without userAuthored, but rootNote=48 diverges from libraryZoneSample.rootPitch=60
      sampleZones: [
        {
          id: 'zone-ch-kick',
          sampleId: libraryZoneSample.id,
          lowNote: 0,
          highNote: 127,
          rootNote: 48,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
        },
      ],
      notes: [{ id: 'n-diverged', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const normalized = normalizeProjectState({
      ...baseProject,
      channels: [legacyDivergedChannel, ...baseProject.channels.slice(1)],
      sampleLibrary: [channelSample, libraryZoneSample],
    });
    const normalizedChannel = normalized.channels.find(ch => ch.id === 'ch-kick')!;

    const channelBuf = { duration: 2 } as AudioBuffer;
    const libraryZoneBuf = { duration: 4 } as AudioBuffer;
    let capturedBuffer: AudioBuffer | null = null;
    let capturedRate = 0;

    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => ({
        get buffer() { return capturedBuffer; },
        set buffer(val: AudioBuffer | null) { capturedBuffer = val; },
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: { setValueAtTime: (v: number) => { capturedRate = v; } },
        connect: () => {},
        start: () => {},
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };

    const handle = renderSamplerVoice({
      channel: normalizedChannel,
      note: normalizedChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-legacy-diverged',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === libraryZoneSample.id ? libraryZoneBuf : id === channelSample.id ? channelBuf : undefined,
    });

    assert.ok(handle);
    assert.equal(
      capturedBuffer,
      libraryZoneBuf,
      'legacy single zone whose rootNote diverged from its library sample must remain authoritative',
    );
    assert.ok(
      Math.abs(capturedRate - Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'legacy diverged single zone must play with its edited rootNote=48',
    );

    // Also verify when the library sample had rootPitch=48 and the legacy zone's rootNote was edited to 60:
    const nonDefaultLibrarySample = makeSample('legacy-library-sample-48', {
      duration: 4,
      rootPitch: 48,
      trimStart: 0,
      trimEnd: 1,
      reverse: false,
    });
    const normalizedEditedTo60 = normalizeProjectState({
      ...baseProject,
      channels: [
        {
          ...legacyDivergedChannel,
          sampleZones: [
            {
              id: 'zone-ch-kick',
              sampleId: nonDefaultLibrarySample.id,
              lowNote: 0,
              highNote: 127,
              rootNote: 60,
              lowVelocity: 0,
              highVelocity: 127,
              tuneSemitones: 0,
            },
          ],
        },
        ...baseProject.channels.slice(1),
      ],
      sampleLibrary: [channelSample, nonDefaultLibrarySample],
    });
    const editedTo60Channel = normalizedEditedTo60.channels.find(ch => ch.id === 'ch-kick')!;
    capturedBuffer = null;
    capturedRate = 0;
    const handleEditedTo60 = renderSamplerVoice({
      channel: editedTo60Channel,
      note: editedTo60Channel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-legacy-diverged-60',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === nonDefaultLibrarySample.id ? libraryZoneBuf : id === channelSample.id ? channelBuf : undefined,
    });
    assert.ok(handleEditedTo60);
    assert.equal(
      capturedBuffer,
      libraryZoneBuf,
      'legacy single zone whose rootNote=60 diverged from librarySample.rootPitch=48 must remain authoritative',
    );
    assert.ok(
      Math.abs(capturedRate - 1) < 1e-9,
      'legacy diverged single zone must play with its edited rootNote=60',
    );
  });

  it('preserves unflagged full-range single zones whose source sample is absent from sampleLibrary across normalization, modal hydration, and live/offline playback', async () => {
    const channelSample = makeSample('channel-custom-sample', {
      duration: 4,
      rootPitch: 72,
      trimStart: 0.25,
      trimEnd: 0.75,
      reverse: false,
    });
    const baseProject = structuredClone(DEFAULT_PROJECT);

    // Case 1: Zone with customized playback settings (rootNote=48, trimStart=0.15, trimEnd=0.85, reverse=true)
    // whose source sample ('absent-custom-source') is missing from sampleLibrary.
    const customizedMissingSourceChannel: Channel = {
      ...baseProject.channels[0],
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: channelSample,
      synthParams: {
        ...baseProject.channels[0].synthParams,
        sampleLoop: true,
      },
      sampleZones: [
        {
          id: 'zone-ch-kick',
          sampleId: 'absent-custom-source',
          lowNote: 0,
          highNote: 127,
          rootNote: 48,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
          trimStart: 0.15,
          trimEnd: 0.85,
          reverse: true,
          loop: true,
        },
      ],
      notes: [{ id: 'n-absent-custom', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const normalizedCustomized = normalizeProjectState({
      ...baseProject,
      channels: [customizedMissingSourceChannel, ...baseProject.channels.slice(1)],
      sampleLibrary: [channelSample],
    });
    const normCustomizedChannel = normalizedCustomized.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(normCustomizedChannel.sampleZones?.length, 1);
    assert.equal(normCustomizedChannel.sampleZones?.[0].sampleId, 'absent-custom-source');
    assert.equal(
      normCustomizedChannel.sampleZones?.[0].userAuthored,
      true,
      'normalizeProjectState must preserve and mark customized zone whose source sample is absent from sampleLibrary',
    );

    const modalCustomized = createComponentHarness(MultiZoneSamplerModal, {
      isOpen: true,
      onClose: () => {},
      channels: normalizedCustomized.channels,
      selectedChannelId: 'ch-kick',
      sampleLibrary: normalizedCustomized.sampleLibrary,
      onUpdateChannel: () => {},
    });
    const customizedSelect = collectElements(modalCustomized.tree).find(el => el.type === 'select');
    assert.equal(
      customizedSelect?.props.value,
      'absent-custom-source',
      'MultiZoneSamplerModal must preserve zone sampleId instead of substituting customSample when source sample is absent from sampleLibrary',
    );

    const channelBuf = { duration: 4 } as AudioBuffer;
    const absentZoneBuf = { duration: 2 } as AudioBuffer;
    let capturedBuffer: AudioBuffer | null = null;
    let capturedRate = 0;

    const fakeCtx = {
      currentTime: 0,
      createBufferSource: () => ({
        get buffer() { return capturedBuffer; },
        set buffer(val: AudioBuffer | null) { capturedBuffer = val; },
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: { setValueAtTime: (v: number) => { capturedRate = v; } },
        connect: () => {},
        start: () => {},
        stop: () => {},
      }),
      createGain: () => ({
        gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: () => {} },
        Q: { value: 1 },
        connect: () => {},
      }),
    };

    // When the zone's audio buffer is missing, live renderSamplerVoice must return undefined
    // rather than substituting channel.customSample.
    const missingLiveHandle = renderSamplerVoice({
      channel: normCustomizedChannel,
      note: normCustomizedChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-absent-custom-missing',
      bpm: 120,
      getSampleBuffer: (id) => (id === channelSample.id ? channelBuf : undefined),
    });
    assert.equal(
      missingLiveHandle,
      undefined,
      'live renderSamplerVoice must not substitute customSample when zone source sample is missing',
    );
    assert.equal(capturedBuffer, null);

    // When the zone's audio buffer IS available, live renderSamplerVoice must play the zone buffer with its customized settings.
    const presentLiveHandle = renderSamplerVoice({
      channel: normCustomizedChannel,
      note: normCustomizedChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-absent-custom-present',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === 'absent-custom-source' ? absentZoneBuf : id === channelSample.id ? channelBuf : undefined,
    });
    assert.ok(presentLiveHandle);
    assert.equal(capturedBuffer, absentZoneBuf, 'live renderSamplerVoice must play the zone buffer when available');
    assert.ok(
      Math.abs(capturedRate + Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'live renderSamplerVoice must apply customized zone rootNote=48 and reverse=true',
    );

    // Case 2: Zone with generic default settings whose source sample ('absent-default-source')
    // is absent from sampleLibrary — do not invent certainty that it is implicit.
    const defaultMissingSourceChannel: Channel = {
      ...baseProject.channels[0],
      id: 'ch-kick',
      instrumentType: 'sampler',
      pitch: 0,
      volume: 1,
      customSample: channelSample,
      sampleZones: [
        {
          id: 'zone-ch-kick',
          sampleId: 'absent-default-source',
          lowNote: 0,
          highNote: 127,
          rootNote: 60,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
        },
      ],
      notes: [{ id: 'n-absent-default', pitch: 60, start: 0, duration: 1, velocity: 1 }],
    };

    const normalizedDefault = normalizeProjectState({
      ...baseProject,
      channels: [defaultMissingSourceChannel, ...baseProject.channels.slice(1)],
      sampleLibrary: [channelSample],
    });
    const normDefaultChannel = normalizedDefault.channels.find(ch => ch.id === 'ch-kick')!;
    assert.equal(normDefaultChannel.sampleZones?.length, 1);
    assert.equal(normDefaultChannel.sampleZones?.[0].sampleId, 'absent-default-source');
    assert.equal(
      normDefaultChannel.sampleZones?.[0].userAuthored,
      true,
      'normalizeProjectState must not classify a zone as implicit when its source sample is absent from sampleLibrary',
    );

    capturedBuffer = null;
    const missingDefaultHandle = renderSamplerVoice({
      channel: normDefaultChannel,
      note: normDefaultChannel.notes[0],
      time: 0,
      destination: {} as AudioNode,
      audioContext: fakeCtx as any,
      voiceId: 'v-absent-default-missing',
      bpm: 120,
      getSampleBuffer: (id) => (id === channelSample.id ? channelBuf : undefined),
    });
    assert.equal(
      missingDefaultHandle,
      undefined,
      'renderSamplerVoice must not substitute customSample when an unflagged zone references a missing source sample',
    );
    assert.equal(capturedBuffer, null);

    // Offline export path must also agree and never substitute channelSample's buffer when the zone's source buffer is missing.
    const offlineCreatedSources: Array<{ buffer: AudioBuffer | null }> = [];
    const origGetSampleBuffer = (audioEngine as any).sampleBuffers;
    const sampleMap = new Map<string, AudioBuffer>([[channelSample.id, channelBuf]]);
    const prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    class StubOfflineAudioContext {
      currentTime = 0;
      sampleRate = 44100;
      length = 44100;
      numberOfChannels = 2;
      destination = { connect: () => {} };
      createGain() {
        return {
          gain: { value: 1, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} },
          connect: () => {},
          disconnect: () => {},
        };
      }
      createStereoPanner() {
        return { pan: { value: 0, setValueAtTime: () => {}, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createBiquadFilter() {
        return {
          type: 'lowpass',
          frequency: { value: 18000, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} },
          Q: { value: 1, setValueAtTime: () => {} },
          gain: { value: 0, setValueAtTime: () => {} },
          connect: () => {},
          disconnect: () => {},
        };
      }
      createDynamicsCompressor() {
        return { threshold: { value: -24, setValueAtTime: () => {} }, knee: { value: 30, setValueAtTime: () => {} }, ratio: { value: 12, setValueAtTime: () => {} }, attack: { value: 0.003, setValueAtTime: () => {} }, release: { value: 0.25, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createWaveShaper() {
        return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} };
      }
      createDelay() {
        return { delayTime: { value: 0, setValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
      }
      createConvolver() {
        return { buffer: null, connect: () => {}, disconnect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 256,
          smoothingTimeConstant: 0.7,
          connect: () => {},
          disconnect: () => {},
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0),
          getByteFrequencyData: (arr: Uint8Array) => arr.fill(0),
          getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
        };
      }
      createConstantSource() {
        return { offset: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
      }
      createOscillator() {
        return { type: 'sine', frequency: { value: 440, setValueAtTime: () => {} }, detune: { value: 0, setValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} };
      }
      createBufferSource() {
        const record = { buffer: null as AudioBuffer | null };
        offlineCreatedSources.push(record);
        return {
          get buffer() { return record.buffer; },
          set buffer(val: AudioBuffer | null) { record.buffer = val; },
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null,
          playbackRate: { value: 1, setValueAtTime: () => {} },
          connect: () => {},
          start: () => {},
          stop: () => {},
        };
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
        };
      }
      async startRendering() {
        return this.createBuffer(2, this.length, this.sampleRate);
      }
    }
    try {
      (globalThis as any).OfflineAudioContext = StubOfflineAudioContext;
      (audioEngine as any).sampleBuffers = sampleMap;
      await audioEngine.renderTimelineOffline(
        [normCustomizedChannel],
        [],
        DEFAULT_PROJECT.mixerTracks,
        120,
        1,
        44100,
        false,
        'pattern'
      );
    } finally {
      (audioEngine as any).sampleBuffers = origGetSampleBuffer;
      (globalThis as any).OfflineAudioContext = prevOfflineCtx;
    }
    assert.ok(
      !offlineCreatedSources.some(src => src.buffer === channelBuf),
      'offline export must not substitute channel.customSample buffer when the zone references a missing source sample',
    );
  });
});

describe('F-1 + F-2: SampleManagerModal lifecycle & hydration synchronization (B)', () => {
  it('initializes controls from selectedChannel and synchronizes across channel switch, close/reopen, project load, and Undo/Redo without overwriting another channel', () => {
    const kickSample = makeSample('kick-s', { trimStart: 0.15, trimEnd: 0.85, rootPitch: 48, reverse: true });
    const snareSample = makeSample('snare-s', { trimStart: 0.05, trimEnd: 0.65, rootPitch: 62, reverse: false });
    const baseChannels: Channel[] = [
      { ...structuredClone(DEFAULT_PROJECT.channels[0]), id: 'ch-kick', name: 'Kick', customSample: kickSample },
      { ...structuredClone(DEFAULT_PROJECT.channels[1]), id: 'ch-snare', name: 'Snare', customSample: snareSample },
    ];
    const assignments: Array<{ channelId: string; sample: CustomSampleData }> = [];

    // Mount closed with ch-kick selected, then open.
    const harness = createComponentHarness(SampleManagerModal, {
      isOpen: false,
      onClose: () => {},
      selectedChannel: baseChannels[0],
      channels: baseChannels,
      sampleLibrary: [kickSample, snareSample],
      onSampleImported: () => {},
      onCreateChannelFromSample: () => {},
      onAssignSampleToChannel: (channelId, sampleData) => {
        assignments.push({ channelId, sample: sampleData });
      },
    });

    harness.rerender({ isOpen: true });
    const openElements = collectElements(harness.tree);
    const rangeInputs = openElements.filter(el => el.type === 'input' && el.props.type === 'range');
    const selects = openElements.filter(el => el.type === 'select');
    assert.equal(rangeInputs.length, 2, 'trimStart and trimEnd sliders must render');
    assert.equal(selects.length, 2, 'rootPitch and targetChannelId selects must render');
    assert.equal(rangeInputs[0].props.value, 0.15, 'trimStart must initialize from selectedChannel.customSample');
    assert.equal(rangeInputs[1].props.value, 0.85, 'trimEnd must initialize from selectedChannel.customSample');
    assert.equal(selects[0].props.value, 48, 'rootPitch must initialize from selectedChannel.customSample');
    assert.equal(selects[1].props.value, 'ch-kick', 'targetChannelId must initialize from selectedChannel');

    // Dirty local trimStart, then close without assigning and reopen on ch-kick: must reset to persisted 0.15.
    rangeInputs[0].props.onChange({ target: { value: '0.45' } });
    harness.rerender({ isOpen: false });
    harness.rerender({ isOpen: true });
    const reopenedRanges = collectElements(harness.tree).filter(el => el.type === 'input' && el.props.type === 'range');
    assert.equal(reopenedRanges[0].props.value, 0.15, 'closing and reopening must reset unsaved local edits');

    // Switch selectedChannel to ch-snare: controls and targetChannelId must synchronize to ch-snare.
    harness.rerender({ selectedChannel: baseChannels[1], isOpen: true });
    const snareElements = collectElements(harness.tree);
    const snareRanges = snareElements.filter(el => el.type === 'input' && el.props.type === 'range');
    const snareSelects = snareElements.filter(el => el.type === 'select');
    assert.equal(snareSelects[1]?.props.value, 'ch-snare', 'targetChannelId must synchronize to ch-snare');
    assert.equal(snareRanges[0].props.value, 0.05, 'trimStart must synchronize to ch-snare');
    assert.equal(snareRanges[1].props.value, 0.65, 'trimEnd must synchronize to ch-snare');
    assert.equal(snareSelects[0]?.props.value, 62, 'rootPitch must synchronize to ch-snare');

    const assignBtn = snareElements.find(el => el.type === 'button' && el.text.includes('Assign to Channel'));
    assert.ok(assignBtn);
    assignBtn.props.onClick();
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].channelId, 'ch-snare', 'Assign to Channel must target ch-snare, never overwriting ch-kick');
    assert.equal(assignments[0].sample.id, 'snare-s');
    assert.equal(assignments[0].sample.trimStart, 0.05);
    assert.equal(assignments[0].sample.rootPitch, 62);

    // Undo/Redo or project replacement updating selectedChannel.customSample must update modal controls.
    const undoneSnareSample = makeSample('snare-s', { trimStart: 0.2, trimEnd: 0.9, rootPitch: 60, reverse: true });
    const undoneChannels = [baseChannels[0], { ...baseChannels[1], customSample: undoneSnareSample }];
    harness.rerender({ selectedChannel: undoneChannels[1], channels: undoneChannels, isOpen: true });
    const undoneElements = collectElements(harness.tree);
    const undoneRanges = undoneElements.filter(el => el.type === 'input' && el.props.type === 'range');
    const undoneSelects = undoneElements.filter(el => el.type === 'select');
    assert.equal(undoneRanges[0].props.value, 0.2, 'Undo/Redo must synchronize trimStart');
    assert.equal(undoneRanges[1].props.value, 0.9, 'Undo/Redo must synchronize trimEnd');
    assert.equal(undoneSelects[0]?.props.value, 60, 'Undo/Redo must synchronize rootPitch');
  });

  it('preserves sample availability after hydration and synchronizes missing-audio state in SampleManagerModal and App.tsx openers', async () => {
    const sample = makeSample('persisted-sample-1', { trimStart: 0.1, trimEnd: 0.9, rootPitch: 64 });
    const projectWithSample: ProjectState = {
      ...structuredClone(DEFAULT_PROJECT),
      sampleLibrary: [sample],
      channels: DEFAULT_PROJECT.channels.map((ch, idx) =>
        idx === 0 ? { ...structuredClone(ch), customSample: sample } : structuredClone(ch)
      ),
    };
    // Hydrate when audio asset is missing -> audioUnavailable: true
    const hydratedMissing = await hydrateProjectAudio(projectWithSample, {
      loadAudioFile: async () => ({ buffer: {} as AudioBuffer, peaks: [], duration: 1 }),
    });
    assert.equal(hydratedMissing.state.channels[0].customSample?.audioUnavailable, true);
    assert.equal(hydratedMissing.state.sampleLibrary?.[0]?.audioUnavailable, true);

    const harness = createComponentHarness(SampleManagerModal, {
      isOpen: true,
      onClose: () => {},
      selectedChannel: DEFAULT_PROJECT.channels[0],
      channels: DEFAULT_PROJECT.channels,
      sampleLibrary: [],
      onSampleImported: () => {},
      onCreateChannelFromSample: () => {},
      onAssignSampleToChannel: () => {},
    });

    // Hydrated state arrives after initial mount: SampleManagerModal must show the hydrated sample and missing badge.
    harness.rerender({
      selectedChannel: hydratedMissing.state.channels[0],
      channels: hydratedMissing.state.channels,
      sampleLibrary: hydratedMissing.state.sampleLibrary,
      isOpen: true,
    });
    const missingElements = collectElements(harness.tree);
    assert.ok(
      missingElements.some(el => el.props.id === 'sample-manager-missing-audio'),
      'SampleManagerModal must display missing-audio warning after hydration marks sample unavailable'
    );

    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(
      appSource,
      /onOpenSampleManager=\{\(\) => \{\s*setSampleChannelId\(selectedChannelId\);\s*setIsSampleManagerOpen\(true\);\s*\}\}/,
      'TransportBar sample manager opener must sync sampleChannelId to selectedChannelId'
    );
  });
});

describe('F-1 + F-2: DrumSamplerPanel channel switching, slice mapping, Undo/Redo & pad audition (C)', () => {
  it('displays and updates only the active drum channel across channel switches, slice mappings, and Undo/Redo', () => {
    const kickPads: DrumPad[] = [
      { id: 'pad-36', note: 36, name: 'Kick A', sampleId: 's-kick', volume: 0.9, pan: -0.2, tuneSemitones: -2, chokeGroup: 0 },
    ];
    const snarePads: DrumPad[] = [
      { id: 'pad-38', note: 38, name: 'Snare B', sampleId: 's-snare', volume: 0.75, pan: 0.35, tuneSemitones: 5, chokeGroup: 1 },
    ];
    const chKick: Channel = { ...structuredClone(DEFAULT_PROJECT.channels[0]), id: 'ch-kick', name: 'Kick Ch', drumPads: kickPads };
    const chSnare: Channel = { ...structuredClone(DEFAULT_PROJECT.channels[1]), id: 'ch-snare', name: 'Snare Ch', drumPads: snarePads };

    const updates: Array<{ channelId: string; patch: Partial<Channel> }> = [];
    const harness = createComponentHarness(DrumSamplerPanel, {
      channel: chKick,
      sampleLibrary: [makeSample('s-kick'), makeSample('s-snare')],
      onUpdateChannel: (channelId, patch) => updates.push({ channelId, patch }),
    });

    // Switch from ch-kick to ch-snare: panel must display Snare B and its parameters.
    harness.rerender({ channel: chSnare });
    const snareText = collectText(harness.tree);
    assert.ok(snareText.includes('Snare B'), 'switching to ch-snare must render ch-snare pads');
    assert.ok(!snareText.includes('Kick A'), 'switching to ch-snare must not retain ch-kick pads');

    const snareRanges = collectElements(harness.tree).filter(el => el.type === 'input' && el.props.type === 'range');
    // Volume (0.75), Pan (0.35), Tune (5)
    assert.equal(snareRanges[0].props.value, 0.75);
    assert.equal(snareRanges[1].props.value, 0.35);
    assert.equal(snareRanges[2].props.value, 5);

    // Editing tune slider on ch-snare updates only ch-snare with ch-snare's pads.
    snareRanges[2].props.onChange({ target: { value: '7' } });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].channelId, 'ch-snare');
    assert.equal(updates[0].patch.drumPads?.[0].id, 'pad-38');
    assert.equal(updates[0].patch.drumPads?.[0].tuneSemitones, 7);

    // Mapping slices into ch-snare (or Undo/Redo) updates channel.drumPads on the same channel id.
    const slicedPads: DrumPad[] = [
      { id: 'slice-pad-1', note: 36, name: 'Slice 1', sampleId: 's-snare', volume: 1, pan: 0, tuneSemitones: 0, trimStart: 0, trimEnd: 0.5 },
      { id: 'slice-pad-2', note: 37, name: 'Slice 2', sampleId: 's-snare', volume: 1, pan: 0, tuneSemitones: 0, trimStart: 0.5, trimEnd: 1 },
    ];
    harness.rerender({ channel: { ...chSnare, drumPads: slicedPads } });
    assert.ok(collectText(harness.tree).includes('Slice 1'), 'slice mapping must synchronize DrumSamplerPanel');

    // Undo back to snarePads:
    harness.rerender({ channel: chSnare });
    assert.ok(collectText(harness.tree).includes('Snare B'), 'Undo must restore Snare B pads in DrumSamplerPanel');
  });

  it('auditions pads with the current pad configuration before any slider has been edited', () => {
    const customKick = makeSample('kick-default-sample');
    const uneditedChannel: Channel = {
      ...structuredClone(DEFAULT_PROJECT.channels[0]),
      id: 'ch-kick',
      instrumentType: 'drumpad',
      customSample: customKick,
      drumPads: undefined,
      pitch: 2,
      synthParams: {
        ...DEFAULT_PROJECT.channels[0].synthParams,
        decay: 0.42,
      },
    };

    const playedCalls: Array<{ channel: Channel; note: Note }> = [];
    const origPlayNote = audioEngine.playNote.bind(audioEngine);
    (audioEngine as any).playNote = (ch: Channel, note: Note) => {
      playedCalls.push({ channel: ch, note });
    };

    try {
      const harness = createComponentHarness(DrumSamplerPanel, {
        channel: uneditedChannel,
        sampleLibrary: [customKick],
        onUpdateChannel: () => {},
      });

      const auditionBtn = collectElements(harness.tree).find(el => el.type === 'button' && el.text.includes('AUDITION'));
      assert.ok(auditionBtn, 'AUDITION button must render');
      auditionBtn.props.onClick();

      assert.equal(playedCalls.length, 1);
      assert.equal(playedCalls[0].channel.instrumentType, 'drumpad');
      assert.ok(Array.isArray(playedCalls[0].channel.drumPads) && playedCalls[0].channel.drumPads.length > 0, 'audition must pass current drumPads even before any slider is edited');
      assert.equal(playedCalls[0].channel.drumPads![0].sampleId, 'kick-default-sample', 'audition must include default pad sampleId derived from channel.customSample');
      assert.equal(playedCalls[0].channel.synthParams.decay, 0.42);
      assert.equal(playedCalls[0].channel.pitch, 2);
    } finally {
      (audioEngine as any).playNote = origPlayNote;
    }
  });
});

describe('F-1 + F-2: ArpeggiatorModal lifecycle synchronization (D)', () => {
  it('synchronizes arpState on open, channel switch, cancel/reopen, project load, and Undo/Redo without overwriting another channel', () => {
    const chLead: Channel = {
      ...structuredClone(DEFAULT_PROJECT.channels[4]),
      id: 'ch-pluck',
      name: 'Dark Bell Pluck',
      arp: {
        enabled: true,
        mode: 'down',
        rate: '1/8',
        octaves: 3,
        gate: 0.65,
        swing: 0,
        strumMs: 22,
        euclideanSteps: 16,
        euclideanHits: 5,
        euclideanRotate: 0,
      },
    };
    const chBass: Channel = {
      ...structuredClone(DEFAULT_PROJECT.channels[3]),
      id: 'ch-808',
      name: '808 Sub Glide',
      arp: {
        enabled: false,
        mode: 'euclidean',
        rate: '1/16',
        octaves: 1,
        gate: 0.9,
        swing: 0,
        strumMs: 10,
        euclideanSteps: 12,
        euclideanHits: 7,
        euclideanRotate: 2,
      },
    };

    const savedChannels: Channel[] = [];
    const harness = createComponentHarness(ArpeggiatorModal, {
      isOpen: true,
      onClose: () => {},
      channel: chLead,
      onUpdateChannel: (updated) => savedChannels.push(updated),
      bpm: 140,
    });

    assert.ok(collectText(harness.tree).includes('ENABLED'));
    assert.ok(collectText(harness.tree).includes('3 Oct'));

    // Edit mode to random and toggle off, then cancel (close without saving) and reopen on chLead.
    const toggleBtn = collectElements(harness.tree).find(el => el.type === 'button' && (el.text === 'ON' || el.text === 'OFF'));
    assert.ok(toggleBtn);
    toggleBtn.props.onClick();
    harness.rerender({ isOpen: false });
    harness.rerender({ isOpen: true });
    assert.ok(collectText(harness.tree).includes('ENABLED'), 'cancelling and reopening must discard unsaved arp edits');

    // Switch channel to chBass: must display chBass arp settings and save only to chBass.
    harness.rerender({ channel: chBass, isOpen: true });
    const bassText = collectText(harness.tree);
    assert.ok(bassText.includes('DISABLED'), 'switching to ch-808 must show DISABLED');
    assert.ok(bassText.includes('1 Oct'), 'switching to ch-808 must show 1 Oct');
    assert.ok(bassText.includes('E(7, 12)'), 'switching to ch-808 must show Euclidean E(7, 12)');

    const saveBtn = collectElements(harness.tree).find(el => el.type === 'button' && el.text.includes('Save Arp Settings'));
    assert.ok(saveBtn);
    saveBtn.props.onClick();
    assert.equal(savedChannels.length, 1);
    assert.equal(savedChannels[0].id, 'ch-808');
    assert.equal(savedChannels[0].arp?.mode, 'euclidean');
    assert.equal(savedChannels[0].arp?.octaves, 1);

    // Undo/Redo updating channel.arp on the active channel must synchronize the modal.
    const undoneBass: Channel = {
      ...chBass,
      arp: { ...chBass.arp!, enabled: true, octaves: 4 },
    };
    harness.rerender({ channel: undoneBass, isOpen: true });
    assert.ok(collectText(harness.tree).includes('ENABLED'), 'Undo/Redo must synchronize enabled state');
    assert.ok(collectText(harness.tree).includes('4 Oct'), 'Undo/Redo must synchronize octaves');
  });
});

describe('F-1 + F-2: MasterMacroRackModal hydration, Undo/Redo & valid default targets (E)', () => {
  it('shows authoritative project macro state after hydration, project replacement, and Undo/Redo without restoring stale initial state', () => {
    let project: ProjectState = {
      ...structuredClone(DEFAULT_PROJECT),
      macroKnobs: [],
    };
    let history = createHistory(project);

    // 1. Mount closed before IndexedDB hydration (macroKnobs is empty []).
    const harness = createComponentHarness(MasterMacroRackModal, {
      isOpen: false,
      onClose: () => {},
      mixerTracks: history.present.mixerTracks,
      channels: history.present.channels,
      macroKnobs: history.present.macroKnobs,
      onUpdateMacros: (macros) => {
        project = updateMacroRackInProjectState(history.present, macros);
        history = history.commit(project, 'Update macro rack');
      },
    });

    // 2. Simulate IndexedDB hydration / project replacement arriving with persisted macros.
    const hydratedMacros: MasterMacroKnob[] = [
      {
        id: 'macro-hydrated-1',
        name: 'HYDRATED SUB SWEEP',
        value: 0.65,
        color: '#00ff88',
        mappings: [
          { targetType: 'channel_volume', targetId: 'ch-808', min: 0.4, max: 1.0, curve: 'linear' },
        ],
      },
    ];
    project = updateMacroRackInProjectState(DEFAULT_PROJECT, hydratedMacros);
    history = history.reset(project);

    // Open modal after hydration: must show HYDRATED SUB SWEEP at 65%, NOT stale DEFAULT_MACRO_KNOBS.
    harness.rerender({
      isOpen: true,
      mixerTracks: history.present.mixerTracks,
      channels: history.present.channels,
      macroKnobs: history.present.macroKnobs,
    });
    const hydratedText = collectText(harness.tree);
    assert.ok(hydratedText.includes('HYDRATED SUB SWEEP'), 'modal must render hydrated macro rack');
    assert.ok(hydratedText.includes('65%'), 'modal must render hydrated macro value');
    assert.ok(!hydratedText.includes('DROP BUILDUP (SWEEP)'), 'modal must not show stale pre-hydration defaults');

    // 3. Edit knob value to 0.9: must update HYDRATED SUB SWEEP and never restore stale initial defaults.
    const rangeInput = collectElements(harness.tree).find(el => el.type === 'input' && el.props.type === 'range');
    assert.ok(rangeInput);
    rangeInput.props.onChange({ target: { value: '0.9' } });
    harness.rerender({
      mixerTracks: history.present.mixerTracks,
      channels: history.present.channels,
      macroKnobs: history.present.macroKnobs,
    });
    assert.equal(history.present.macroKnobs?.[0].id, 'macro-hydrated-1');
    assert.equal(history.present.macroKnobs?.[0].value, 0.9);
    assert.ok(collectText(harness.tree).includes('90%'));

    // 4. Undo restores 0.65 and synchronizes modal state.
    history = history.undo();
    harness.rerender({
      mixerTracks: history.present.mixerTracks,
      channels: history.present.channels,
      macroKnobs: history.present.macroKnobs,
    });
    assert.equal(history.present.macroKnobs?.[0].value, 0.65);
    assert.ok(collectText(harness.tree).includes('65%'), 'Undo must synchronize MasterMacroRackModal');
  });

  it('default macro channel targets resolve to valid channel IDs in DEFAULT_PROJECT without silently retargeting unknown IDs', () => {
    const published: MasterMacroKnob[][] = [];
    const harness = createComponentHarness(MasterMacroRackModal, {
      isOpen: true,
      onClose: () => {},
      mixerTracks: DEFAULT_PROJECT.mixerTracks,
      channels: DEFAULT_PROJECT.channels,
      macroKnobs: [],
      onUpdateMacros: (macros) => published.push(macros),
    });

    const firstRange = collectElements(harness.tree).find(el => el.type === 'input' && el.props.type === 'range');
    assert.ok(firstRange);
    firstRange.props.onChange({ target: { value: '0.25' } });
    assert.equal(published.length, 1);

    const defaultKnobs = published[0];
    const resolution = resolveMacroRack(defaultKnobs, DEFAULT_PROJECT);
    const unresolvedChannelTargets = resolution.unresolved.filter(
      entry => entry.targetType === 'channel_volume' || entry.targetType === 'channel_pan'
    );
    assert.deepEqual(
      unresolvedChannelTargets,
      [],
      'all default macro channel targets must resolve to valid channel IDs in DEFAULT_PROJECT'
    );

    // Unknown channel IDs must still remain unresolved (no silent fallback to arbitrary channels).
    const unknownResolution = resolveMacroRack(
      [
        {
          id: 'macro-unknown',
          name: 'Unknown Target',
          value: 0.8,
          color: '#00ff88',
          mappings: [{ targetType: 'channel_volume', targetId: 'non-existent-channel', min: 0, max: 1, curve: 'linear' }],
        },
      ],
      DEFAULT_PROJECT
    );
    assert.equal(unknownResolution.parameters.length, 0);
    assert.equal(unknownResolution.unresolved.length, 1);
  });
});
