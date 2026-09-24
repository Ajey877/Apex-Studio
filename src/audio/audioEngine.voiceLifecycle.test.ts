import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';
import type { Channel, Note } from '../types/daw';

class FakeAudioParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeNode {
  readonly gain = new FakeAudioParam();
  readonly frequency = new FakeAudioParam();
  readonly detune = new FakeAudioParam();
  readonly playbackRate = new FakeAudioParam();
  readonly pan = new FakeAudioParam();
  readonly Q = { value: 0 };
  type = '';
  onended: (() => void) | null = null;
  stopCalls = 0;
  connect() {}
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  buffer: AudioBuffer | null = null;
  startArgs: unknown[] | null = null;
  stop() { this.stopCalls += 1; this.onended?.(); }
  start(...args: unknown[]) { this.startArgs = args; }
}

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  readonly oscillators: FakeNode[] = [];
  readonly bufferSources: FakeNode[] = [];
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createStereoPanner() { return new FakeNode(); }
  createBufferSource() {
    const node = new FakeNode();
    this.bufferSources.push(node);
    return node;
  }
  createBuffer(_channels: number, _length: number, _sampleRate: number) {
    return { duration: _length / _sampleRate, getChannelData: () => new Float32Array(_length) } as unknown as AudioBuffer;
  }
  createOscillator() {
    const node = new FakeNode();
    this.oscillators.push(node);
    return node;
  }
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const saved: Record<string, unknown> = {};
const SAVED_KEYS = [
  'ctx',
  'activeVoices',
  'activeDrumPadVoices',
  'isPlaying',
  'transport',
  'playbackGeneration',
  'getOrCreateMixerChannel',
  'triggerSidechainDucking',
  'retriggerAudioClipsAtPosition',
  'rebaseAutomationAtPosition',
  'sampleBuffers',
  'instrumentRegistry',
];

const makeChannel = (id: string, instrumentType: Channel['instrumentType']): Channel => {
  const channel = structuredClone(createDefaultProjectState().channels[0]);
  channel.id = id;
  channel.name = id;
  channel.instrumentType = instrumentType;
  channel.notes = [];
  channel.steps = [];
  channel.customSample = undefined;
  return channel;
};

const makeNote = (id: string): Note => ({
  id,
  pitch: 60,
  start: 0,
  duration: 0.1,
  velocity: 0.8,
});

const renderers: Channel['instrumentType'][] = [
  'minisynth', 'fmsynth', 'independent_pluck', 'sampler', 'wavetable', 'fm_bell',
  'grand_piano', 'rhodes_epiano', 'hammond_organ', 'nylon_guitar', 'harpsichord',
  'strings_ensemble', 'pizzicato_strings', 'cinematic_brass', 'acid_303', 'reese_bass',
  'slap_bass', 'sub_808', 'supersaw_lead', 'ambient_pad', 'vox_choir', 'marimba_bell',
  'chiptune_8bit',
];

beforeEach(() => {
  for (const key of SAVED_KEYS) saved[key] = engine[key];

  const ctx = new FakeAudioContext();
  engine.ctx = ctx;
  engine.activeVoices = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.isPlaying = false;
  engine.playbackGeneration = 0;
  engine.transport = null;
  engine.getOrCreateMixerChannel = () => ({ input: {} as AudioNode });
  engine.triggerSidechainDucking = () => undefined;
  engine.retriggerAudioClipsAtPosition = () => undefined;
  engine.rebaseAutomationAtPosition = () => undefined;
  engine.sampleBuffers = new Map();
});

afterEach(() => {
  for (const key of SAVED_KEYS) engine[key] = saved[key];
});

describe('Phase 22 standalone voice lifecycle integration', () => {
  it('registers and naturally removes every standalone renderer through playSingleVoice', () => {
    for (const instrumentType of renderers) {
      engine.activeVoices.clear();
      const ctx = engine.ctx as FakeAudioContext;
      ctx.oscillators.length = 0;

      engine.playSingleVoice(makeChannel(`natural-${instrumentType}`, instrumentType), makeNote(`n-${instrumentType}`), 0);

      assert.equal(engine.activeVoices.size, 1, `${instrumentType} should register a handle`);
      const naturalSources = [...ctx.oscillators, ...ctx.bufferSources].filter((source) => source.onended);
      assert.ok(naturalSources.length > 0, `${instrumentType} should expose natural completion`);

      for (const source of naturalSources) source.onended?.();
      assert.equal(engine.activeVoices.size, 0, `${instrumentType} should be removed after natural completion`);
    }
  });


  it('routes a custom sample through the sampler renderer and cleans it naturally', () => {
    const channel = makeChannel('sampler-production', 'sampler');
    channel.customSample = {
      id: 'sample-1',
      name: 'Test Sample',
      duration: 1,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [],
      rootPitch: 60,
      trimStart: 0.1,
      trimEnd: 0.9,
      reverse: true,
    };
    const zone = {
      id: 'zone-1',
      sampleId: 'sample-1',
      lowNote: 0,
      highNote: 127,
      rootNote: 60,
      lowVelocity: 0,
      highVelocity: 127,
      tuneSemitones: 2,
      loop: true,
      loopStart: 0.2,
      loopEnd: 0.8,
    };
    channel.sampleZones = [zone];
    const buffer = { duration: 2 } as AudioBuffer;
    engine.sampleBuffers.set('sample-1', buffer);

    engine.playSingleVoice(channel, makeNote('sampler-note'), 0);

    assert.equal(engine.activeVoices.size, 1);
    const source = (engine.ctx as FakeAudioContext).bufferSources[0];
    assert.ok(source);
    assert.equal(source.buffer, buffer);
    assert.equal(source.loop, true);
    assert.equal(source.loopStart, 0.4);
    assert.equal(source.loopEnd, 1.6);
    assert.deepEqual(source.startArgs, [0, 1.8, undefined]);

    source.onended?.();
    assert.equal(engine.activeVoices.size, 0);
  });

  it('preserves sampler-without-sample fallback to subtractive synthesis', () => {
    const channel = makeChannel('sampler-empty', 'sampler');

    engine.playSingleVoice(channel, makeNote('empty-note'), 0);

    assert.equal(engine.activeVoices.size, 1);
    assert.equal((engine.ctx as FakeAudioContext).bufferSources.length, 0);
    assert.ok((engine.ctx as FakeAudioContext).oscillators.some((osc) => osc.onended));
  });

  it('preserves missing custom-sample fallback to subtractive synthesis', () => {
    const channel = makeChannel('sampler-missing', 'sampler');
    channel.customSample = {
      id: 'missing-sample',
      name: 'Missing',
      duration: 1,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [],
    };

    engine.playSingleVoice(channel, makeNote('missing-note'), 0);

    assert.equal(engine.activeVoices.size, 1);
    assert.equal((engine.ctx as FakeAudioContext).bufferSources.length, 0);
    assert.ok((engine.ctx as FakeAudioContext).oscillators.some((osc) => osc.onended));
  });

  it('stopNote is idempotent and does not leave the voice registered', () => {
    for (const instrumentType of renderers) {
      engine.activeVoices.clear();
      const ctx = engine.ctx as FakeAudioContext;
      ctx.oscillators.length = 0;
      ctx.bufferSources.length = 0;
      const channel = makeChannel(`stop-${instrumentType}`, instrumentType);

      engine.playSingleVoice(channel, makeNote(`n-${instrumentType}`), 0);
      assert.equal(engine.activeVoices.size, 1);
      const voiceId = [...engine.activeVoices.keys()][0];
      const oscillator = ctx.oscillators[0];
      const sources = [...ctx.oscillators, ...ctx.bufferSources];
      const scheduledStopCalls = sources.reduce((sum, source) => sum + source.stopCalls, 0);
      engine.stopNote(voiceId);
      engine.stopNote(voiceId);

      assert.equal(engine.activeVoices.size, 0);
      assert.equal(sources.reduce((sum, source) => sum + source.stopCalls, 0), scheduledStopCalls + sources.length);
    }
  });

  it('stopChannelVoices only stops matching standalone voices', () => {
    engine.playSingleVoice(makeChannel('channel-a', 'minisynth'), makeNote('a'), 0);
    engine.playSingleVoice(makeChannel('channel-b', 'fmsynth'), makeNote('b'), 0);
    assert.equal(engine.activeVoices.size, 2);

    engine.stopChannelVoices('channel-a');

    assert.equal(engine.activeVoices.size, 1);
    assert.ok([...engine.activeVoices.keys()].every((id: string) => id.startsWith('channel-b-')));
  });

  it('stopActivePlaybackAudio clears all tracked standalone voices', () => {
    engine.playSingleVoice(makeChannel('channel-a', 'minisynth'), makeNote('a'), 0);
    engine.playSingleVoice(makeChannel('channel-b', 'independent_pluck'), makeNote('b'), 0);
    assert.equal(engine.activeVoices.size, 2);

    engine.stopActivePlaybackAudio();

    assert.equal(engine.activeVoices.size, 0);
  });

  it('pause stops tracked voices and seek while playing stops the old voices', () => {
    const stopped: string[] = [];
    engine.activeVoices = new Map([
      ['pause-voice', { stop: () => stopped.push('pause') }],
    ]);
    engine.isPlaying = true;
    engine.transport = {
      pause: () => undefined,
      seek: () => undefined,
      getState: () => ({ step: 0, bar: 1 }),
    };
    engine.pause();

    assert.deepEqual(stopped, ['pause']);
    assert.equal(engine.activeVoices.size, 0);
    assert.equal(engine.isPlaying, false);

    engine.activeVoices = new Map([
      ['seek-voice', { stop: () => stopped.push('seek') }],
    ]);
    engine.isPlaying = true;
    engine.seek(0.5);

    assert.deepEqual(stopped, ['pause', 'seek']);
    assert.equal(engine.activeVoices.size, 0);
  });

  it('repeatedly completes short sampler voices without activeVoices growth', () => {
    const ctx = engine.ctx as FakeAudioContext;
    const channel = makeChannel('sampler-stress', 'sampler');
    channel.customSample = {
      id: 'stress-sample',
      name: 'Stress',
      duration: 0.1,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [],
    };
    engine.sampleBuffers.set('stress-sample', { duration: 0.1 } as AudioBuffer);

    for (let i = 0; i < 100; i += 1) {
      ctx.bufferSources.length = 0;
      engine.playSingleVoice(channel, makeNote(`sampler-stress-${i}`), 0);
      assert.equal(engine.activeVoices.size, 1);
      ctx.bufferSources[0]?.onended?.();
      assert.equal(engine.activeVoices.size, 0);
    }
  });

  it('repeatedly completes short standalone voices without activeVoices growth', () => {
    const ctx = engine.ctx as FakeAudioContext;

    for (let i = 0; i < 100; i += 1) {
      ctx.oscillators.length = 0;
      ctx.bufferSources.length = 0;
      engine.playSingleVoice(makeChannel(`stress-${i}`, 'minisynth'), makeNote(`stress-note-${i}`), 0);
      assert.equal(engine.activeVoices.size, 1);
      ctx.oscillators.find((osc) => osc.onended)?.onended?.();
      assert.equal(engine.activeVoices.size, 0);
    }
  });
  it('stale natural completion cannot remove a replacement voice', () => {
    const ctx = engine.ctx as FakeAudioContext;
    const channel = makeChannel('replacement', 'grand_piano');

    engine.playSingleVoice(channel, makeNote('voice-a'), 0);
    const oldOscillatorCount = ctx.oscillators.length;
    const oldBufferSourceCount = ctx.bufferSources.length;
    const oldSources = [...ctx.oscillators, ...ctx.bufferSources].filter((source) => source.onended);
    assert.equal(engine.activeVoices.size, 1);

    engine.playSingleVoice(channel, makeNote('voice-b'), 0);
    assert.equal(engine.activeVoices.size, 2);

    for (const source of oldSources) source.onended?.();
    assert.equal(engine.activeVoices.size, 1);

    const newSources = [
      ...ctx.oscillators.slice(oldOscillatorCount),
      ...ctx.bufferSources.slice(oldBufferSourceCount),
    ].filter((source) => source.onended);
    for (const source of newSources) source.onended?.();
    assert.equal(engine.activeVoices.size, 0);
  });

  it('renderer failure leaves no lifecycle state and preserves an existing choke voice', () => {
    const ctx = engine.ctx as FakeAudioContext;
    const sampled = makeDrumPadChannel('failure-choke');
    engine.sampleBuffers.set('kick-sample', { duration: 1 } as AudioBuffer);
    engine.playSingleVoice(sampled, { ...makeNote('existing'), pitch: 36 }, 0);
    const existing = ctx.bufferSources[0];
    assert.equal(engine.activeVoices.size, 1);

    const originalRegistry = engine.instrumentRegistry;
    engine.instrumentRegistry = {
      get: () => () => { throw new Error('renderer failure'); },
      has: () => true,
    };

    engine.playSingleVoice(sampled, { ...makeNote('failed'), pitch: 36 }, 0.1);

    assert.equal(existing.stopCalls, 0);
    assert.equal(engine.activeVoices.size, 1);
    assert.equal(engine.activeDrumPadVoices.size, 1);
    engine.instrumentRegistry = originalRegistry;
  });


  it('stop advances playback generation and clears active voices', () => {
    const generationBefore = engine.playbackGeneration;
    engine.activeVoices = new Map([
      ['generation-voice', { stop: () => undefined }],
    ]);
    engine.isPlaying = true;
    engine.stop();

    assert.equal(engine.playbackGeneration, generationBefore + 1);
    assert.equal(engine.activeVoices.size, 0);
    assert.equal(engine.isPlaying, false);
  });
});

const makeDrumPadChannel = (id = 'drum-pad'): Channel => {
  const channel = makeChannel(id, 'drumpad');
  channel.drumPads = [{
    id: 'kick-pad',
    note: 36,
    name: 'Kick',
    sampleId: 'kick-sample',
    volume: 1,
    pan: 0.2,
    tuneSemitones: 2,
    trimStart: 0.1,
    trimEnd: 0.9,
    reverse: false,
    loop: false,
    chokeGroup: 1,
  }];
  return channel;
};

describe('Phase 23 drum-pad lifecycle integration', () => {
  it('dispatches sampled drum pads through InstrumentRegistry and owns lifecycle in AudioEngine', () => {
    const channel = makeDrumPadChannel('drum-dispatch');
    engine.sampleBuffers.set('kick-sample', { duration: 1 } as AudioBuffer);

    const ctx = engine.ctx as FakeAudioContext;
    const note = { ...makeNote('drum-note'), pitch: 36 };
    engine.playSingleVoice(channel, note, 0);

    assert.equal(engine.activeVoices.size, 1);
    assert.equal(engine.activeDrumPadVoices.size, 1);
    assert.equal(ctx.bufferSources.length, 1);

    ctx.bufferSources[0].onended?.();
    assert.equal(engine.activeVoices.size, 0);
    assert.equal(engine.activeDrumPadVoices.size, 0);
  });

  it('falls back to the legacy drum synthesizer when a pad has no sampleId', () => {
    const channel = makeDrumPadChannel('drum-fallback');
    channel.drumPads![0].sampleId = '';

    const ctx = engine.ctx as FakeAudioContext;
    engine.playSingleVoice(channel, { ...makeNote('fallback'), pitch: 36 }, 0);

    assert.equal(ctx.bufferSources.length, 0);
    assert.ok(ctx.oscillators.length > 0);
  });

  it('does not synthesize a missing referenced pad sample', () => {
    const channel = makeDrumPadChannel('drum-missing');

    engine.playSingleVoice(channel, { ...makeNote('missing'), pitch: 36 }, 0);

    assert.equal(engine.activeVoices.size, 0);
    assert.equal((engine.ctx as FakeAudioContext).bufferSources.length, 0);
  });

  it('choke groups stop the previous renderer handle without renderer access to activeVoices', () => {
    const first = makeDrumPadChannel('drum-choke');
    const second = makeDrumPadChannel('drum-choke');
    engine.sampleBuffers.set('kick-sample', { duration: 1 } as AudioBuffer);

    engine.playSingleVoice(first, { ...makeNote('choke-a'), pitch: 36 }, 0);
    const ctx = engine.ctx as FakeAudioContext;
    const firstSource = ctx.bufferSources[0];
    assert.equal(engine.activeVoices.size, 1);

    engine.playSingleVoice(second, { ...makeNote('choke-b'), pitch: 36 }, 0.1);

    assert.equal(firstSource.stopCalls, 1);
    assert.equal(engine.activeVoices.size, 1);
    assert.equal(engine.activeDrumPadVoices.size, 1);
  });

  it('does not choke an existing sampled pad when the new pad sample buffer is missing', () => {
    const first = makeDrumPadChannel('drum-missing-choke');
    const second = makeDrumPadChannel('drum-missing-choke');
    second.drumPads![0].sampleId = 'missing-sample';
    engine.sampleBuffers.set('kick-sample', { duration: 1 } as AudioBuffer);

    engine.playSingleVoice(first, { ...makeNote('missing-choke-a'), pitch: 36 }, 0);
    const ctx = engine.ctx as FakeAudioContext;
    const firstSource = ctx.bufferSources[0];
    assert.equal(engine.activeVoices.size, 1);

    engine.playSingleVoice(second, { ...makeNote('missing-choke-b'), pitch: 36 }, 0.1);

    assert.equal(firstSource.stopCalls, 0);
    assert.equal(engine.activeVoices.size, 1);
    assert.equal(engine.activeDrumPadVoices.size, 1);
    assert.equal(ctx.bufferSources.length, 1);
  });

  it('keeps legacy drum-synth fallback and existing sampled voice when new pad has no sampleId', () => {
    const first = makeDrumPadChannel('drum-legacy-choke');
    const second = makeDrumPadChannel('drum-legacy-choke');
    second.drumPads![0].sampleId = '';
    engine.sampleBuffers.set('kick-sample', { duration: 1 } as AudioBuffer);

    engine.playSingleVoice(first, { ...makeNote('legacy-choke-a'), pitch: 36 }, 0);
    const ctx = engine.ctx as FakeAudioContext;
    const firstSource = ctx.bufferSources[0];
    assert.equal(engine.activeVoices.size, 1);

    engine.playSingleVoice(second, { ...makeNote('legacy-choke-b'), pitch: 36 }, 0.1);

    assert.equal(firstSource.stopCalls, 0);
    assert.equal(engine.activeVoices.size, 2);
    assert.equal(engine.activeDrumPadVoices.size, 1);
    assert.ok(ctx.oscillators.length > 0);
  });

  it('explicit stop removes the drum-pad voice from AudioEngine lifecycle state', () => {
    const channel = makeDrumPadChannel('drum-stop');
    engine.sampleBuffers.set('kick-sample', { duration: 1 } as AudioBuffer);

    engine.playSingleVoice(channel, { ...makeNote('stop'), pitch: 36 }, 0);
    assert.equal(engine.activeVoices.size, 1);

    const voiceId = [...engine.activeVoices.keys()][0];
    engine.stopNote(voiceId);
    engine.stopNote(voiceId);

    assert.equal(engine.activeVoices.size, 0);
    assert.equal(engine.activeDrumPadVoices.size, 0);
  });

  it('repeatedly completes short drum-pad voices without activeVoices growth', () => {
    const channel = makeDrumPadChannel('drum-stress');
    engine.sampleBuffers.set('kick-sample', { duration: 0.05 } as AudioBuffer);
    const ctx = engine.ctx as FakeAudioContext;

    for (let i = 0; i < 100; i += 1) {
      ctx.bufferSources.length = 0;
      engine.playSingleVoice(channel, { ...makeNote(`drum-stress-${i}`), pitch: 36 }, 0);
      assert.equal(engine.activeVoices.size, 1);
      ctx.bufferSources[0].onended?.();
      assert.equal(engine.activeVoices.size, 0);
      assert.equal(engine.activeDrumPadVoices.size, 0);
    }
  });
});
