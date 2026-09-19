/**
 * Phase 8B — P1-4 regression suite: "Placeholder Audio Stem clip breaks export".
 *
 * A placeholder/missing/unavailable audio stem asset must never be silently
 * rendered as fake/silent audio and reported as a successful export. Every
 * offline export path must detect the problem before producing a WAV and
 * surface a descriptive error through the existing error mechanism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import {
  assertAudioClipsExportable,
  isAudioClipExportable,
  renderProjectTimelineOffline,
} from './offlineProjectRenderer';
import type { Channel, PlaylistClip, MixerTrack } from '../types/daw';

// --- Web Audio mocks (same approach as audioEngine.export.test.ts) ---

class MockAudioParam {
  value: number;
  constructor(defaultValue = 1) { this.value = defaultValue; }
  setValueAtTime(v: number) { this.value = v; }
  linearRampToValueAtTime(v: number) { if (v <= 0) throw new RangeError('ramp target must be > 0'); this.value = v; }
  exponentialRampToValueAtTime(v: number) { if (v <= 0) throw new RangeError('ramp target must be > 0'); this.value = v; }
  setTargetAtTime(v: number) { this.value = v; }
  cancelScheduledValues() {}
}

class MockAudioNode {
  connect(target: unknown) { return target; }
  disconnect() {}
}

class MockGainNode extends MockAudioNode { gain = new MockAudioParam(1); }
class MockStereoPannerNode extends MockAudioNode { pan = new MockAudioParam(0); }

class MockAnalyserNode extends MockAudioNode {
  fftSize = 512;
  smoothingTimeConstant = 0.8;
  getFloatTimeDomainData(target: Float32Array) { target.fill(0); }
}

class MockBufferSourceNode extends MockAudioNode {
  buffer: unknown = null;
  playbackRate = new MockAudioParam(1);
  detune = new MockAudioParam(0);
  start() {}
  stop() {}
}

class MockOscillatorNode extends MockAudioNode {
  type = 'sawtooth';
  frequency = new MockAudioParam(440);
  detune = new MockAudioParam(0);
  start() {}
  stop() {}
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam(350);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}

class MockDelayNode extends MockAudioNode { delayTime = new MockAudioParam(0); }
class MockConvolverNode extends MockAudioNode { buffer: unknown = null; normalize = true; }
class MockWaveShaperNode extends MockAudioNode { curve: Float32Array | null = null; oversample = 'none'; }

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
  reduction = 0;
}

class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(ch: number) { return this.data[ch] ?? this.data[0]; }
  copyToChannel(src: Float32Array, ch: number) { this.getChannelData(ch).set(src); }
  copyFromChannel(dest: Float32Array, ch: number) { dest.set(this.getChannelData(ch)); }
}

let offlineContextConstructions = 0;

class MockOfflineAudioContext {
  sampleRate: number;
  length: number;
  destination = new MockGainNode();
  currentTime = 0;
  state = 'suspended';
  constructor(_channels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    offlineContextConstructions += 1;
  }
  createGain() { return new MockGainNode(); }
  createStereoPanner() { return new MockStereoPannerNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
  createBufferSource() { return new MockBufferSourceNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDelay() { return new MockDelayNode(); }
  createConvolver() { return new MockConvolverNode(); }
  createWaveShaper() { return new MockWaveShaperNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  async startRendering() { return new MockAudioBuffer(2, this.length, this.sampleRate); }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

// --- Fixtures ---

const defaultMixerTracks = [
  { id: 0, name: 'Master', volume: 0.9, pan: 0, mute: false, solo: false, fxSlots: [], sends: [] },
  { id: 1, name: 'Track 1', volume: 0.9, pan: 0, mute: false, solo: false, fxSlots: [], sends: [] },
  { id: 2, name: 'Track 2', volume: 0.9, pan: 0, mute: false, solo: false, fxSlots: [], sends: [] },
] as unknown as MixerTrack[];

const synthChannel = {
  id: 'ch-synth-1',
  name: 'Lead Synth',
  volume: 0.8,
  pan: 0,
  mute: false,
  solo: false,
  color: '#ff6e00',
  instrumentType: 'supersaw_lead',
  steps: Array(16).fill(false),
  notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.8 }],
  mixerTrackId: 1,
} as unknown as Channel;

const audioClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-audio-1',
  name: 'Audio Take',
  trackIndex: 1,
  startBar: 0,
  lengthBars: 2,
  type: 'audio',
  audioBufferId: 'valid-audio',
  color: '#00ff88',
  ...overrides,
});

const makeBuffer = (): AudioBuffer => {
  const buffer = new MockAudioBuffer(2, 44100, 44100);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i / 10) * 0.5;
  return buffer as unknown as AudioBuffer;
};

const VALID_BUFFER_ID = 'integrity-valid-audio';
const PLACEHOLDER_STEM_ID = 'stem-vocals';

const validClip = () => audioClip({ id: 'clip-valid', name: 'Real Take', audioBufferId: VALID_BUFFER_ID });
const placeholderStemClip = () => audioClip({ id: 'clip-placeholder', name: 'Vocal Stem', audioBufferId: PLACEHOLDER_STEM_ID });

let previousOfflineContext: unknown;

const withMockOfflineContext = async (run: () => Promise<void>): Promise<void> => {
  previousOfflineContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  offlineContextConstructions = 0;
  try {
    await run();
  } finally {
    (globalThis as any).OfflineAudioContext = previousOfflineContext;
  }
};

// The module renderer resolves buffers through its injected lookup; the engine
// through its in-memory sample registry. Keep one source of truth per test.
const buffers = new Map<string, AudioBuffer>();
const resolveFromMap = (id: string) => buffers.get(id);

test('Phase 8B export integrity: placeholder/missing audio stem assets', async (t) => {
  await t.beforeEach(() => {
    buffers.clear();
    buffers.set(VALID_BUFFER_ID, makeBuffer());
    audioEngine.setSampleBuffer(VALID_BUFFER_ID, buffers.get(VALID_BUFFER_ID)!);
  });

  // --- 1. Valid audio clip exports normally (behavior preserved) ---

  await t.test('valid audio clip exports a master WAV through the engine timeline renderer', async () => {
    await withMockOfflineContext(async () => {
      const rendered = await audioEngine.renderTimelineOffline(
        [], [validClip()], defaultMixerTracks, 120, 4
      );
      assert.ok(rendered, 'valid audio clip must render');
      assert.ok(offlineContextConstructions > 0, 'a real offline render must run');
    });
  });

  await t.test('valid audio clip exports through the deterministic project renderer', async () => {
    await withMockOfflineContext(async () => {
      const rendered = await renderProjectTimelineOffline({
        channels: [synthChannel],
        clips: [validClip()],
        bpm: 120,
        totalBars: 4,
        getAudioBuffer: resolveFromMap,
      });
      assert.ok(rendered, 'valid audio clip must render');
    });
  });

  await t.test('valid audio clip still produces stems and master through renderProjectStems', async () => {
    await withMockOfflineContext(async () => {
      const { stems, master } = await audioEngine.renderProjectStems(
        [synthChannel], [validClip()], defaultMixerTracks, 120, 4
      );
      assert.ok(master instanceof Blob && master.size > 44, 'master WAV must be produced');
      assert.ok(stems['track_2_Real_Take.wav'] instanceof Blob, 'audio clip stem must be produced');
    });
  });

  // --- 2. Placeholder / missing stem rejects safely on every export path ---

  await t.test('placeholder stem clip rejects the engine timeline export with a descriptive error', async () => {
    await withMockOfflineContext(async () => {
      await assert.rejects(
        async () => {
          await audioEngine.renderTimelineOffline(
            [], [placeholderStemClip()], defaultMixerTracks, 120, 4
          );
        },
        (err: Error) => {
          assert.match(err.message, /Missing audio buffer for clip "Vocal Stem"/);
          assert.match(err.message, new RegExp(PLACEHOLDER_STEM_ID));
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0, 'no render may start before the missing asset is reported');
    });
  });

  await t.test('placeholder stem clip rejects stem export (no misleading partial stems)', async () => {
    await withMockOfflineContext(async () => {
      await assert.rejects(
        async () => {
          await audioEngine.renderProjectStems(
            [synthChannel], [validClip(), placeholderStemClip()], defaultMixerTracks, 120, 4
          );
        },
        (err: Error) => {
          assert.match(err.message, /Missing audio buffer for clip "Vocal Stem"/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0, 'stem export must fail before rendering anything');
    });
  });

  await t.test('placeholder stem clip rejects renderProjectToWav', async () => {
    await withMockOfflineContext(async () => {
      await assert.rejects(
        async () => {
          await audioEngine.renderProjectToWav(
            [synthChannel], [placeholderStemClip()], 120, 4, 24, defaultMixerTracks
          );
        },
        (err: Error) => {
          assert.match(err.message, /Missing audio buffer for clip "Vocal Stem"/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0);
    });
  });

  await t.test('placeholder stem clip rejects the deterministic project renderer before any render', async () => {
    await withMockOfflineContext(async () => {
      await assert.rejects(
        async () => {
          await renderProjectTimelineOffline({
            channels: [synthChannel],
            clips: [validClip(), placeholderStemClip()],
            bpm: 120,
            totalBars: 4,
            getAudioBuffer: resolveFromMap,
          });
        },
        (err: Error) => {
          assert.match(err.message, /Missing audio buffer for clip "Vocal Stem"/);
          assert.match(err.message, new RegExp(PLACEHOLDER_STEM_ID));
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0, 'no offline context may be built for a rejected export');
    });
  });

  await t.test('audio clip without an audioBufferId is rejected, not silently skipped', async () => {
    await withMockOfflineContext(async () => {
      const orphanClip = audioClip({ id: 'clip-orphan', name: 'Orphan Take', audioBufferId: undefined });

      await assert.rejects(
        async () => {
          await audioEngine.renderTimelineOffline([], [orphanClip], defaultMixerTracks, 120, 4);
        },
        (err: Error) => {
          assert.match(err.message, /Audio clip "Orphan Take" is missing an audioBufferId/);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await renderProjectTimelineOffline({
            channels: [synthChannel],
            clips: [orphanClip],
            bpm: 120,
            totalBars: 4,
            getAudioBuffer: resolveFromMap,
          });
        },
        (err: Error) => {
          assert.match(err.message, /Audio clip "Orphan Take" is missing an audioBufferId/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0);
    });
  });

  // --- 3. Persisted audio missing (hydration flagged audioUnavailable) ---

  await t.test('clip whose persisted audio is missing (audioUnavailable) rejects engine export even when a same-id buffer is in memory', async () => {
    await withMockOfflineContext(async () => {
      const ghostId = 'ghost-persisted-asset';
      audioEngine.setSampleBuffer(ghostId, makeBuffer());
      const unavailableClip = audioClip({
        id: 'clip-unavailable',
        name: 'Lost Recording',
        audioBufferId: ghostId,
        audioUnavailable: true,
      });

      await assert.rejects(
        async () => {
          await audioEngine.renderTimelineOffline([], [unavailableClip], defaultMixerTracks, 120, 4);
        },
        (err: Error) => {
          assert.match(err.message, /Audio clip "Lost Recording"/);
          assert.match(err.message, /unavailable audio asset/);
          assert.match(err.message, /persisted audio could not be restored/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0);
    });
  });

  await t.test('clip whose persisted audio is missing (audioUnavailable) rejects the deterministic project renderer', async () => {
    await withMockOfflineContext(async () => {
      const ghostId = 'ghost-persisted-asset';
      buffers.set(ghostId, makeBuffer());
      const unavailableClip = audioClip({
        id: 'clip-unavailable-2',
        name: 'Lost Bounce',
        audioBufferId: ghostId,
        audioUnavailable: true,
      });

      await assert.rejects(
        async () => {
          await renderProjectTimelineOffline({
            channels: [synthChannel],
            clips: [unavailableClip],
            bpm: 120,
            totalBars: 4,
            getAudioBuffer: resolveFromMap,
          });
        },
        (err: Error) => {
          assert.match(err.message, /Audio clip "Lost Bounce"/);
          assert.match(err.message, /unavailable audio asset/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0);
    });
  });

  // --- 4. Multiple clips with one missing asset reject the whole export ---

  await t.test('multiple clips with one missing asset reject the timeline export instead of exporting a partial mix', async () => {
    await withMockOfflineContext(async () => {
      const secondValid = audioClip({ id: 'clip-valid-2', name: 'Second Take', audioBufferId: VALID_BUFFER_ID, startBar: 2 });

      await assert.rejects(
        async () => {
          await audioEngine.renderTimelineOffline(
            [], [validClip(), secondValid, placeholderStemClip()], defaultMixerTracks, 120, 8
          );
        },
        (err: Error) => {
          assert.match(err.message, /Missing audio buffer for clip "Vocal Stem"/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0);
    });
  });

  await t.test('multiple clips with one missing asset reject the deterministic project renderer', async () => {
    await withMockOfflineContext(async () => {
      const secondValid = audioClip({ id: 'clip-valid-3', name: 'Third Take', audioBufferId: VALID_BUFFER_ID, startBar: 2 });

      await assert.rejects(
        async () => {
          await renderProjectTimelineOffline({
            channels: [synthChannel],
            clips: [validClip(), secondValid, placeholderStemClip()],
            bpm: 120,
            totalBars: 8,
            getAudioBuffer: resolveFromMap,
          });
        },
        (err: Error) => {
          assert.match(err.message, /Missing audio buffer for clip "Vocal Stem"/);
          return true;
        }
      );
      assert.equal(offlineContextConstructions, 0);
    });
  });

  // --- 5. Existing export semantics preserved ---

  await t.test('a muted clip with a missing asset does not block export (mute semantics preserved)', async () => {
    await withMockOfflineContext(async () => {
      const mutedPlaceholder = placeholderStemClip();
      mutedPlaceholder.mute = true;

      const rendered = await audioEngine.renderTimelineOffline(
        [], [validClip(), mutedPlaceholder], defaultMixerTracks, 120, 4
      );
      assert.ok(rendered, 'muted missing clips render nothing and must not block export');

      const moduleRendered = await renderProjectTimelineOffline({
        channels: [synthChannel],
        clips: [validClip(), mutedPlaceholder],
        bpm: 120,
        totalBars: 4,
        getAudioBuffer: resolveFromMap,
      });
      assert.ok(moduleRendered);
    });
  });

  await t.test('exportability helpers classify clips without side effects', () => {
    assert.equal(isAudioClipExportable(validClip(), resolveFromMap), true);
    assert.equal(isAudioClipExportable(placeholderStemClip(), resolveFromMap), false);
    assert.equal(isAudioClipExportable({ ...placeholderStemClip(), mute: true }, resolveFromMap), true);
    assert.equal(isAudioClipExportable({ ...validClip(), audioUnavailable: true }, resolveFromMap), false);
    assert.throws(
      () => assertAudioClipsExportable([validClip(), placeholderStemClip()], resolveFromMap),
      /Missing audio buffer for clip "Vocal Stem"/
    );
    assert.doesNotThrow(() => assertAudioClipsExportable([validClip()], resolveFromMap));
  });
});
