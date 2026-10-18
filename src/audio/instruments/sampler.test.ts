import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSamplerVoice } from './sampler';
import { isImplicitDefaultSingleZone } from '../sampleZones';
import { normalizeProjectState } from '../../state/projectState';
import { updateChannelInProjectState } from '../../state/projectMutations';
import { DEFAULT_PROJECT } from '../presets';

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
  exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly playbackRate = new FakeParam();
  readonly Q = { value: 0 };
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startArgs: unknown[] | null = null;
  stopCalls = 0;
  type = '';
  connect() {}
  start(...args: unknown[]) { this.startArgs = args; }
  stop() { this.stopCalls += 1; }
}

class FakeContext {
  currentTime = 0;
  readonly sources: FakeNode[] = [];
  createBufferSource() { const node = new FakeNode(); this.sources.push(node); return node; }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
}

const channel = (overrides: Record<string, unknown> = {}) => ({
  id: 'sampler-test',
  name: 'Sampler',
  color: '#fff',
  instrumentType: 'sampler',
  mixerTrackId: 1,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: {
    filterType: 'lowpass',
    filterCutoff: 18000,
    filterResonance: 1,
    sampleLoop: false,
  },
  customSample: {
    id: 'sample',
    name: 'Sample',
    duration: 2,
    sampleRate: 44100,
    channels: 1,
    waveformPeaks: [],
    rootPitch: 60,
  },
  ...overrides,
} as any);

const note = { id: 'note', pitch: 72, start: 0, duration: 1, velocity: 1 } as any;

describe('sampler renderer', () => {
  it('uses the narrow resolver and existing zone/rate/trim/reverse/loop helpers', () => {
    const ctx = new FakeContext();
    const buffer = { duration: 2 } as AudioBuffer;
    let ended = 0;
    const handle = renderSamplerVoice({
      channel: channel({
        pitch: 1,
        sampleZones: [{
          id: 'zone',
          sampleId: 'sample',
          lowNote: 0,
          highNote: 127,
          rootNote: 60,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 2,
          trimStart: 0.1,
          trimEnd: 0.9,
          reverse: true,
          loop: true,
          loopStart: 0.2,
          loopEnd: 0.8,
        }],
      }),
      note,
      time: 3,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'voice', bpm: 120,
      onEnded: () => { ended += 1; },
      getSampleBuffer: (id) => id === 'sample' ? buffer : undefined,
    });

    assert.ok(handle);
    const source = ctx.sources[0];
    assert.equal(source.buffer, buffer);
    // Contract: playbackRate = 2^((notePitch - rootNote) + channelPitch + tuneSemitones)/12
    // Example: (72 - 60) + 1 (channelPitch) + 2 (tune) = 15 semitones => 2^(15/12)
    // reverse:true => negative rate
    assert.ok(Math.abs(source.playbackRate.value + Math.pow(2, 15 / 12)) < 1e-9);
    assert.equal(source.loop, true);
    assert.equal(source.loopStart, 0.4);
    assert.equal(source.loopEnd, 1.6);
    assert.deepEqual(source.startArgs, [3, 1.8, undefined]);

    source.onended?.();
    assert.equal(ended, 1);
  });

  it('applies root note, channel pitch, and zone tuning additively', () => {
    const ctx = new FakeContext();
    const buffer = { duration: 1 } as AudioBuffer;
    // No zone tuning, no channel pitch: one octave above root (72 vs 60) => 2^(12/12)=2
    const handle1 = renderSamplerVoice({
      channel: channel({ pitch: 0, sampleZones: [{ id:'z', sampleId:'sample', lowNote:0, highNote:127, rootNote:60, lowVelocity:0, highVelocity:127, tuneSemitones:0 } as any]}),
      note, time: 0, destination: {} as AudioNode, audioContext: ctx as any, voiceId:'v1', bpm: 120, getSampleBuffer: id=> id==='sample'?buffer:undefined,
    });
    assert.ok(handle1);
    assert.ok(Math.abs(ctx.sources[0].playbackRate.value - Math.pow(2, 12/12)) < 1e-9);

    // With channel pitch and tune, they add
    const ctx2 = new FakeContext();
    const handle2 = renderSamplerVoice({
      channel: channel({ pitch: 2, sampleZones: [{ id:'z', sampleId:'sample', lowNote:0, highNote:127, rootNote:60, lowVelocity:0, highVelocity:127, tuneSemitones: -1 } as any]}),
      note: { id:'n', pitch: 60, start:0, duration:1, velocity:1 } as any, time: 0, destination: {} as AudioNode, audioContext: ctx2 as any, voiceId:'v2', bpm: 120, getSampleBuffer: id=> id==='sample'?buffer:undefined,
    });
    assert.ok(handle2);
    // (60-60)+2 + (-1) =1 semitone => 2^(1/12)
    assert.ok(Math.abs(ctx2.sources[0].playbackRate.value - Math.pow(2, 1/12)) < 1e-9);

    // Reverse playback flips sign
    const ctx3 = new FakeContext();
    const handle3 = renderSamplerVoice({
      channel: channel({ pitch: 0, sampleZones: [{ id:'z', sampleId:'sample', lowNote:0, highNote:127, rootNote:60, lowVelocity:0, highVelocity:127, tuneSemitones:0, reverse:true } as any]}),
      note: { id:'n', pitch: 60, start:0, duration:1, velocity:1 } as any, time: 0, destination: {} as AudioNode, audioContext: ctx3 as any, voiceId:'v3', bpm: 120, getSampleBuffer: id=> id==='sample'?buffer:undefined,
    });
    assert.ok(handle3);
    // root 60, note 60 => 0 semitones, reverse => -1
    assert.ok(Math.abs(ctx3.sources[0].playbackRate.value + 1) < 1e-9);
  });

  it('uses replaced customSample and edited trim, rootPitch, and reverse when sampleZones only has an implicit default full-range zone', () => {
    for (const defaultZoneId of ['zone-sampler-test', 'zone-default-sampler-test']) {
      const ctx = new FakeContext();
      const staleZoneBuffer = { duration: 2 } as AudioBuffer;
      const updatedCustomBuffer = { duration: 4 } as AudioBuffer;
      const testChannel = channel({
        sampleZones: [
          {
            id: defaultZoneId,
            sampleId: 'sample',
            lowNote: 0,
            highNote: 127,
            rootNote: 60,
            lowVelocity: 0,
            highVelocity: 127,
            tuneSemitones: 0,
          },
        ],
        customSample: {
          id: 'replaced-sample',
          name: 'Replaced Sample',
          duration: 4,
          sampleRate: 44100,
          channels: 1,
          waveformPeaks: [0.2, 0.8],
          trimStart: 0.25,
          trimEnd: 0.75,
          rootPitch: 72,
          reverse: true,
        },
      });

      const handle = renderSamplerVoice({
        channel: testChannel,
        note: { id: 'n', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
        time: 0,
        destination: {} as AudioNode,
        audioContext: ctx as any,
        voiceId: `implicit-zone-${defaultZoneId}`,
        bpm: 120,
        getSampleBuffer: (id) =>
          id === 'replaced-sample'
            ? updatedCustomBuffer
            : id === 'sample'
              ? staleZoneBuffer
              : undefined,
      });

      assert.ok(handle);
      const source = ctx.sources[0];
      assert.equal(source.buffer, updatedCustomBuffer, `expected replaced customSample buffer for ${defaultZoneId}`);
      assert.ok(
        Math.abs(source.playbackRate.value + Math.pow(2, (60 - 72) / 12)) < 1e-9,
        `expected reverse + rootPitch=72 playbackRate for ${defaultZoneId}`,
      );
      assert.deepEqual(source.startArgs, [0, 3, 2], `expected trimStart=0.25..trimEnd=0.75 for ${defaultZoneId}`);
    }
  });

  it('uses replacement customSample when a legacy implicit full-range zone copied non-default rootNote, trim, and reverse from its known original sample', () => {
    for (const defaultZoneId of ['zone-sampler-test', 'zone-default-sampler-test']) {
      const ctx = new FakeContext();
      const staleOriginalBuffer = { duration: 2 } as AudioBuffer;
      const replacementBuffer = { duration: 4 } as AudioBuffer;
      const originalSample = {
        id: 'original-sample',
        name: 'Original Sample',
        duration: 2,
        sampleRate: 44100,
        channels: 1,
        waveformPeaks: [0.2, 0.7],
        trimStart: 0.15,
        trimEnd: 0.85,
        rootPitch: 48,
        reverse: true,
      };
      const replacementSample = {
        id: 'replacement-sample',
        name: 'Replacement Sample',
        duration: 4,
        sampleRate: 44100,
        channels: 1,
        waveformPeaks: [0.4, 0.9],
        trimStart: 0.25,
        trimEnd: 0.75,
        rootPitch: 72,
        reverse: false,
      };
      const rawChannel = channel({
        synthParams: {
          filterType: 'lowpass',
          filterCutoff: 18000,
          filterResonance: 1,
          sampleLoop: true,
        },
        sampleZones: [
          {
            id: defaultZoneId,
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
        customSample: originalSample,
      });

      assert.equal(
        isImplicitDefaultSingleZone(rawChannel, rawChannel.sampleZones?.[0], [originalSample, replacementSample]),
        true,
        `expected zone matching channel.customSample (${defaultZoneId}) to be confirmed as a legacy implicit zone`,
      );

      let state = normalizeProjectState({
        ...structuredClone(DEFAULT_PROJECT),
        channels: [rawChannel as any, ...structuredClone(DEFAULT_PROJECT.channels.slice(1))],
        sampleLibrary: [originalSample, replacementSample],
      });
      state = updateChannelInProjectState(state, 'sampler-test', {
        customSample: replacementSample,
      });
      const testChannel = state.channels.find(ch => ch.id === 'sampler-test')!;

      const handle = renderSamplerVoice({
        channel: testChannel,
        note: { id: 'n-legacy-nondefault', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
        time: 0,
        destination: {} as AudioNode,
        audioContext: ctx as any,
        voiceId: `legacy-nondefault-${defaultZoneId}`,
        bpm: 120,
        getSampleBuffer: (id) =>
          id === 'replacement-sample'
            ? replacementBuffer
            : id === 'original-sample'
              ? staleOriginalBuffer
              : undefined,
      });

      assert.ok(handle);
      const source = ctx.sources[0];
      assert.equal(
        source.buffer,
        replacementBuffer,
        `legacy implicit zone with non-default copied sample settings must yield to replacement customSample for ${defaultZoneId}`,
      );
      assert.ok(
        Math.abs(source.playbackRate.value - Math.pow(2, (60 - 72) / 12)) < 1e-9,
        `expected forward playbackRate with replacement rootPitch=72 for ${defaultZoneId}`,
      );
      assert.equal(source.loop, true, `expected channel sampleLoop=true for ${defaultZoneId}`);
      assert.equal(source.loopStart, 1, `expected replacement trimStart=0.25 * 4s for ${defaultZoneId}`);
      assert.equal(source.loopEnd, 3, `expected replacement trimEnd=0.75 * 4s for ${defaultZoneId}`);
      assert.deepEqual(
        source.startArgs,
        [0, 1, undefined],
        `expected replacement forward offset=1s (trimStart=0.25 * 4s) for ${defaultZoneId}`,
      );
    }
  });

  it('preserves an unflagged generated-ID full-range single zone whose sampleId differs from customSample.id even when its source exists in sampleLibrary with matching playback settings', () => {
    const channelSample = {
      id: 'channel-sample',
      name: 'Channel Sample',
      duration: 2,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [0.2, 0.7],
      trimStart: 0.25,
      trimEnd: 0.75,
      rootPitch: 72,
      reverse: false,
    };
    const libraryZoneSample = {
      id: 'library-zone-sample',
      name: 'Library Zone Sample',
      duration: 4,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [0.4, 0.9],
      trimStart: 0.15,
      trimEnd: 0.85,
      rootPitch: 48,
      reverse: true,
    };
    const channelSampleBuffer = { duration: 2 } as AudioBuffer;
    const libraryZoneBuffer = { duration: 4 } as AudioBuffer;

    const rawChannel = channel({
      synthParams: {
        filterType: 'lowpass',
        filterCutoff: 18000,
        filterResonance: 1,
        sampleLoop: true,
      },
      sampleZones: [
        {
          id: 'zone-sampler-test',
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
      customSample: channelSample,
    });

    assert.equal(
      isImplicitDefaultSingleZone(rawChannel, rawChannel.sampleZones?.[0], [channelSample, libraryZoneSample]),
      false,
      'matching library sample settings must not classify a zone as implicit when zone.sampleId differs from channel.customSample.id',
    );

    const normalized = normalizeProjectState({
      ...structuredClone(DEFAULT_PROJECT),
      channels: [rawChannel as any, ...structuredClone(DEFAULT_PROJECT.channels.slice(1))],
      sampleLibrary: [channelSample, libraryZoneSample],
    });
    const normalizedChannel = normalized.channels.find(ch => ch.id === 'sampler-test')!;

    assert.equal(
      normalizedChannel.sampleZones?.length,
      1,
      'normalizeProjectState must not clear an unflagged single zone whose sampleId differs from customSample.id',
    );
    assert.equal(normalizedChannel.sampleZones?.[0].sampleId, libraryZoneSample.id);
    assert.equal(normalizedChannel.sampleZones?.[0].userAuthored, true);

    const ctx = new FakeContext();
    const handle = renderSamplerVoice({
      channel: normalizedChannel,
      note: { id: 'n-library-match', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'library-matching-zone-voice',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === libraryZoneSample.id
          ? libraryZoneBuffer
          : id === channelSample.id
            ? channelSampleBuffer
            : undefined,
    });

    assert.ok(handle);
    const source = ctx.sources[0];
    assert.equal(
      source.buffer,
      libraryZoneBuffer,
      'renderSamplerVoice must play the preserved zone sample rather than channel.customSample',
    );
    assert.ok(
      Math.abs(source.playbackRate.value + Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'renderSamplerVoice must preserve the zone rootNote=48 and reverse=true',
    );
  });

  it('does not classify an unflagged full-range zone with an unknown or missing source sample as implicit', () => {
    const customSample = {
      id: 'channel-custom-sample',
      name: 'Channel Custom Sample',
      duration: 4,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [0.3, 0.8],
      trimStart: 0.25,
      trimEnd: 0.75,
      rootPitch: 72,
      reverse: false,
    };
    const customSampleBuffer = { duration: 4 } as AudioBuffer;
    const zoneBuffer = { duration: 2 } as AudioBuffer;

    // 1. Unflagged generated-ID full-range zone whose sampleId differs from customSample.id,
    //    whose source sample is absent from sampleLibrary, and whose playback settings
    //    contain evidence of customization (rootNote=48, trimStart=0.15, trimEnd=0.85, reverse=true).
    const customizedUnknownSourceChannel = channel({
      synthParams: {
        filterType: 'lowpass',
        filterCutoff: 18000,
        filterResonance: 1,
        sampleLoop: true,
      },
      sampleZones: [
        {
          id: 'zone-sampler-test',
          sampleId: 'missing-customized-source',
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
      customSample,
    });

    assert.equal(
      isImplicitDefaultSingleZone(
        customizedUnknownSourceChannel,
        customizedUnknownSourceChannel.sampleZones?.[0],
        [customSample],
      ),
      false,
      'zone with customized playback settings whose source sample is absent from sampleLibrary must not be classified as implicit',
    );
    assert.equal(
      isImplicitDefaultSingleZone(
        customizedUnknownSourceChannel,
        customizedUnknownSourceChannel.sampleZones?.[0],
      ),
      false,
      'standalone check without sampleLibrary must also reject customized playback settings when source sample is unknown',
    );

    // When the zone's source audio buffer is missing, renderSamplerVoice must return undefined
    // (preserving missing-audio fallback behavior) rather than substituting customSample.
    const ctxMissingCustomized = new FakeContext();
    const missingCustomizedHandle = renderSamplerVoice({
      channel: customizedUnknownSourceChannel,
      note: { id: 'n-missing-customized', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxMissingCustomized as any,
      voiceId: 'missing-customized-source-voice',
      bpm: 120,
      getSampleBuffer: (id) => (id === customSample.id ? customSampleBuffer : undefined),
    });
    assert.equal(
      missingCustomizedHandle,
      undefined,
      'renderSamplerVoice must not substitute customSample when a customized zone references a missing source sample',
    );
    assert.equal(ctxMissingCustomized.sources.length, 0);

    // When the zone's audio buffer IS present in getSampleBuffer (even if absent from sampleLibrary),
    // renderSamplerVoice must play the zone buffer with the zone's customized playback settings.
    const ctxPresentCustomized = new FakeContext();
    const presentCustomizedHandle = renderSamplerVoice({
      channel: customizedUnknownSourceChannel,
      note: { id: 'n-present-customized', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxPresentCustomized as any,
      voiceId: 'present-customized-source-voice',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === 'missing-customized-source'
          ? zoneBuffer
          : id === customSample.id
            ? customSampleBuffer
            : undefined,
    });
    assert.ok(presentCustomizedHandle);
    assert.equal(
      ctxPresentCustomized.sources[0].buffer,
      zoneBuffer,
      'customized zone with unknown library source must play its own zone buffer when available',
    );
    assert.ok(
      Math.abs(ctxPresentCustomized.sources[0].playbackRate.value + Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'customized zone must preserve its rootNote=48 and reverse=true',
    );

    // 2. Unflagged generated-ID full-range zone with generic default settings whose source sample
    //    is absent from sampleLibrary and missing from getSampleBuffer: do not invent certainty or
    //    substitute customSample over a missing zone sample.
    const defaultSettingsMissingSourceChannel = channel({
      sampleZones: [
        {
          id: 'zone-sampler-test',
          sampleId: 'missing-default-source',
          lowNote: 0,
          highNote: 127,
          rootNote: 60,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
        },
      ],
      customSample,
    });

    assert.equal(
      isImplicitDefaultSingleZone(
        defaultSettingsMissingSourceChannel,
        defaultSettingsMissingSourceChannel.sampleZones?.[0],
        [customSample],
      ),
      false,
      'zone whose source sample is absent from sampleLibrary must not be classified as implicit when sampleLibrary is provided',
    );

    const normalizedDefaultMissingSource = normalizeProjectState({
      ...structuredClone(DEFAULT_PROJECT),
      channels: [defaultSettingsMissingSourceChannel as any, ...structuredClone(DEFAULT_PROJECT.channels.slice(1))],
      sampleLibrary: [customSample],
    });
    const normalizedDefaultChannel = normalizedDefaultMissingSource.channels.find(ch => ch.id === 'sampler-test')!;

    const ctxMissingDefault = new FakeContext();
    const missingDefaultHandle = renderSamplerVoice({
      channel: normalizedDefaultChannel,
      note: { id: 'n-missing-default', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxMissingDefault as any,
      voiceId: 'missing-default-source-voice',
      bpm: 120,
      getSampleBuffer: (id) => (id === customSample.id ? customSampleBuffer : undefined),
    });
    assert.equal(
      missingDefaultHandle,
      undefined,
      'renderSamplerVoice must preserve missing-audio behavior instead of substituting customSample when normalized zone source sample is missing',
    );
    assert.equal(ctxMissingDefault.sources.length, 0);
  });

  it('keeps an explicitly user-authored full-range single-zone mapping authoritative when customSample also exists', () => {
    const channelSampleBuffer = { duration: 2 } as AudioBuffer;
    const explicitZoneBuffer = { duration: 4 } as AudioBuffer;

    // 1. User-authored full-range single zone carrying the modal's `zone-${channel.id}` ID
    //    and explicit zone settings (sampleId, rootNote, trimStart, trimEnd, reverse, loop).
    const ctxExplicitSettings = new FakeContext();
    const channelWithExplicitZoneSettings = channel({
      sampleZones: [
        {
          id: 'zone-sampler-test',
          sampleId: 'explicit-zone-sample',
          lowNote: 0,
          highNote: 127,
          rootNote: 48,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
          trimStart: 0.1,
          trimEnd: 0.9,
          reverse: true,
          loop: true,
          loopStart: 0.25,
          loopEnd: 0.75,
        },
      ],
      customSample: {
        id: 'channel-sample',
        name: 'Channel Sample',
        duration: 2,
        sampleRate: 44100,
        channels: 1,
        waveformPeaks: [0.3, 0.7],
        trimStart: 0.4,
        trimEnd: 0.6,
        rootPitch: 72,
        reverse: false,
      },
    });

    const handleSettings = renderSamplerVoice({
      channel: channelWithExplicitZoneSettings,
      note: { id: 'n-explicit-settings', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxExplicitSettings as any,
      voiceId: 'explicit-single-zone-settings',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === 'explicit-zone-sample'
          ? explicitZoneBuffer
          : id === 'channel-sample'
            ? channelSampleBuffer
            : undefined,
    });

    assert.ok(handleSettings);
    const sourceSettings = ctxExplicitSettings.sources[0];
    assert.equal(sourceSettings.buffer, explicitZoneBuffer, 'explicit single-zone sampleId must take precedence over customSample');
    assert.ok(
      Math.abs(sourceSettings.playbackRate.value + Math.pow(2, (60 - 48) / 12)) < 1e-9,
      'explicit single-zone rootNote=48 and reverse=true must take precedence over customSample',
    );
    assert.equal(sourceSettings.loop, true, 'explicit single-zone loop=true must take precedence over customSample');
    assert.equal(sourceSettings.loopStart, 1, 'explicit single-zone loopStart must use zone buffer duration');
    assert.equal(sourceSettings.loopEnd, 3, 'explicit single-zone loopEnd must use zone buffer duration');
    assert.deepEqual(sourceSettings.startArgs, [0, 3.6, undefined], 'explicit single-zone trimEnd=0.9 offset must apply');

    // 2. User-authored full-range single zone with default geometry/rootNote=60 and userAuthored provenance
    //    (e.g. user opened MultiZoneSamplerModal and selected a different sampleId on the full-range zone).
    const ctxProvenance = new FakeContext();
    const channelWithUserAuthoredFlag = channel({
      sampleZones: [
        {
          id: 'zone-sampler-test',
          sampleId: 'explicit-zone-sample',
          lowNote: 0,
          highNote: 127,
          rootNote: 60,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 0,
          userAuthored: true,
        } as any,
      ],
      customSample: {
        id: 'channel-sample',
        name: 'Channel Sample',
        duration: 2,
        sampleRate: 44100,
        channels: 1,
        waveformPeaks: [0.3, 0.7],
        trimStart: 0.25,
        trimEnd: 0.75,
        rootPitch: 72,
        reverse: true,
      },
    });

    const handleProvenance = renderSamplerVoice({
      channel: channelWithUserAuthoredFlag,
      note: { id: 'n-explicit-provenance', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxProvenance as any,
      voiceId: 'explicit-single-zone-provenance',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === 'explicit-zone-sample'
          ? explicitZoneBuffer
          : id === 'channel-sample'
            ? channelSampleBuffer
            : undefined,
    });

    assert.ok(handleProvenance);
    const sourceProvenance = ctxProvenance.sources[0];
    assert.equal(sourceProvenance.buffer, explicitZoneBuffer, 'userAuthored full-range single zone must remain authoritative over customSample');
    assert.ok(
      Math.abs(sourceProvenance.playbackRate.value - 1) < 1e-9,
      'userAuthored zone with different sampleId must use its own rootNote=60 and reverse=false without leaking customSample reverse/rootPitch',
    );
    assert.deepEqual(
      sourceProvenance.startArgs,
      [0, 0, 4],
      'userAuthored zone with different sampleId must not inherit customSample trimStart/trimEnd',
    );
  });

  it('preserves explicit multi-zone mappings and legacy zone-only playback', () => {
    const lowZoneBuffer = { duration: 2 } as AudioBuffer;
    const highZoneBuffer = { duration: 3 } as AudioBuffer;
    const customBuffer = { duration: 5 } as AudioBuffer;
    const multiChannel = channel({
      customSample: {
        id: 'custom-sample',
        name: 'Custom Sample',
        duration: 5,
        sampleRate: 44100,
        channels: 1,
        waveformPeaks: [],
        rootPitch: 60,
      },
      sampleZones: [
        { id: 'zone-low', sampleId: 'low-sample', lowNote: 0, highNote: 59, rootNote: 48, lowVelocity: 0, highVelocity: 127, tuneSemitones: 0 },
        { id: 'zone-high', sampleId: 'high-sample', lowNote: 60, highNote: 127, rootNote: 72, lowVelocity: 0, highVelocity: 127, tuneSemitones: 0 },
      ],
    });

    const ctxMulti = new FakeContext();
    const handleMulti = renderSamplerVoice({
      channel: multiChannel,
      note: { id: 'n-high', pitch: 72, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxMulti as any,
      voiceId: 'multi-zone',
      bpm: 120,
      getSampleBuffer: (id) =>
        id === 'low-sample' ? lowZoneBuffer : id === 'high-sample' ? highZoneBuffer : customBuffer,
    });
    assert.ok(handleMulti);
    assert.equal(ctxMulti.sources[0].buffer, highZoneBuffer, 'explicit multi-zone mapping must remain unchanged');

    // Legacy zone-only channel (customSample is undefined, even with default zone-${channel.id} ID).
    const legacyBuffer = { duration: 2.5 } as AudioBuffer;
    const legacyZoneOnlyChannel = channel({
      customSample: undefined,
      sampleZones: [
        { id: 'zone-sampler-test', sampleId: 'legacy-zone-sample', lowNote: 0, highNote: 127, rootNote: 60, lowVelocity: 0, highVelocity: 127, tuneSemitones: 0 },
      ],
    });
    const ctxLegacy = new FakeContext();
    const handleLegacy = renderSamplerVoice({
      channel: legacyZoneOnlyChannel,
      note: { id: 'n-legacy', pitch: 60, start: 0, duration: 1, velocity: 0.8 } as any,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctxLegacy as any,
      voiceId: 'legacy-zone-only',
      bpm: 120,
      getSampleBuffer: (id) => (id === 'legacy-zone-sample' ? legacyBuffer : undefined),
    });
    assert.ok(handleLegacy);
    assert.equal(ctxLegacy.sources[0].buffer, legacyBuffer, 'legacy zone-only playback must remain compatible');
  });

  it('returns no voice when the resolver cannot supply the selected sample', () => {
    const ctx = new FakeContext();
    const result = renderSamplerVoice({
      channel: channel(),
      note,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'missing', bpm: 120,
      getSampleBuffer: () => undefined,
    });

    assert.equal(result, undefined);
    assert.equal(ctx.sources.length, 0);
  });

  it('stop is safe to call repeatedly', () => {
    const ctx = new FakeContext();
    const handle = renderSamplerVoice({
      channel: channel(),
      note,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'stop', bpm: 120,
      getSampleBuffer: () => ({ duration: 1 } as AudioBuffer),
    });

    assert.ok(handle);
    handle.stop(0.5);
    handle.stop(0.5);
    assert.equal(ctx.sources[0].stopCalls, 2);
  });
});
