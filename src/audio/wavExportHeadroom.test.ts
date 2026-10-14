/**
 * Audio Integrity Fix 2 — Preserve 32-bit Float WAV Export Headroom
 *
 * Regression suite verifying the actual encoded WAV bytes across:
 *   1. `audioBufferToWav` (`src/audio/wavEncoder.ts`, used by `ExportModal.tsx` and
 *      `sampleBufferPersistence.ts`)
 *   2. `audioEngine.renderProjectToWav` (`src/audio/audioEngine.ts`)
 *   3. `audioEngine.renderProjectStems` (`src/audio/audioEngine.ts`)
 *   4. `encodeSampleBufferForStorage` (`src/audio/sampleBufferPersistence.ts`)
 *
 * Every test decodes the produced WAV `Blob` bytes (RIFF/WAVE header, `fmt ` chunk,
 * and `data` payload) rather than inspecting source text.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Engine from 'web-audio-engine';
import { audioBufferToWav } from './wavEncoder';
import { audioEngine } from './audioEngine';
import { encodeSampleBufferForStorage } from './sampleBufferPersistence';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';

const RealOfflineAudioContext = (Engine as unknown as { OfflineAudioContext: typeof OfflineAudioContext }).OfflineAudioContext;

/** Float32 representation tolerance (exact `Math.fround` match is 0; 1e-7 covers float32 rounding). */
const FLOAT32_TOLERANCE = 1e-7;

interface DecodedWav {
  riffId: string;
  chunkSize: number;
  waveId: string;
  fmtId: string;
  fmtChunkSize: number;
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataId: string;
  dataSize: number;
  byteLength: number;
  frameCount: number;
  /** Per-channel decoded samples (float32 values for format 3; normalized [-1, 1] for PCM format 1). */
  channels: Float64Array[];
  /** Raw signed integers for 16-bit and 24-bit PCM formats. */
  pcmIntegers: Int32Array[];
}

const readAscii = (view: DataView, offset: number, length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
};

async function decodeWavBlob(blob: Blob): Promise<DecodedWav> {
  assert.equal(blob.type, 'audio/wav', 'WAV blob must declare audio/wav MIME type');
  const arrayBuffer = await blob.arrayBuffer();
  assert.ok(arrayBuffer.byteLength >= 44, `WAV must be at least 44 bytes, got ${arrayBuffer.byteLength}`);
  const view = new DataView(arrayBuffer);

  const riffId = readAscii(view, 0, 4);
  const chunkSize = view.getUint32(4, true);
  const waveId = readAscii(view, 8, 4);
  const fmtId = readAscii(view, 12, 4);
  const fmtChunkSize = view.getUint32(16, true);
  const audioFormat = view.getUint16(20, true);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataId = readAscii(view, 36, 4);
  const dataSize = view.getUint32(40, true);

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = blockAlign > 0 ? dataSize / blockAlign : 0;

  const channels = Array.from({ length: numChannels }, () => new Float64Array(frameCount));
  const pcmIntegers = Array.from({ length: numChannels }, () => new Int32Array(frameCount));

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      if (bitsPerSample === 32 && audioFormat === 3) {
        const sample = view.getFloat32(offset, true);
        channels[ch][frame] = sample;
        offset += 4;
      } else if (bitsPerSample === 24 && audioFormat === 1) {
        const b0 = view.getUint8(offset);
        const b1 = view.getUint8(offset + 1);
        const b2 = view.getUint8(offset + 2);
        const signed24 = ((b0 | (b1 << 8) | (b2 << 16)) << 8) >> 8;
        pcmIntegers[ch][frame] = signed24;
        channels[ch][frame] = signed24 < 0 ? signed24 / 0x800000 : signed24 / 0x7fffff;
        offset += 3;
      } else if (bitsPerSample === 16 && audioFormat === 1) {
        const signed16 = view.getInt16(offset, true);
        pcmIntegers[ch][frame] = signed16;
        channels[ch][frame] = signed16 < 0 ? signed16 / 0x8000 : signed16 / 0x7fff;
        offset += 2;
      } else {
        throw new Error(`Unsupported WAV format=${audioFormat} bitsPerSample=${bitsPerSample}`);
      }
    }
  }

  return {
    riffId,
    chunkSize,
    waveId,
    fmtId,
    fmtChunkSize,
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataId,
    dataSize,
    byteLength: arrayBuffer.byteLength,
    frameCount,
    channels,
    pcmIntegers,
  };
}

function createSyntheticAudioBuffer(
  channelData: ReadonlyArray<ArrayLike<number>>,
  sampleRate = 48000,
  useRawArray = false,
): AudioBuffer {
  const numChannels = channelData.length;
  const length = channelData[0]?.length ?? 0;
  const stored = channelData.map(ch =>
    useRawArray ? (Array.from(ch) as unknown as Float32Array) : Float32Array.from(ch),
  );
  return {
    numberOfChannels: numChannels,
    length,
    sampleRate,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    getChannelData(channel: number): Float32Array {
      if (channel < 0 || channel >= numChannels) {
        throw new RangeError(`Channel index ${channel} out of bounds`);
      }
      return stored[channel];
    },
    copyFromChannel() {},
    copyToChannel() {},
  } as unknown as AudioBuffer;
}

describe('Audio Integrity Fix 2: 32-bit float WAV export headroom & format contract', () => {
  it('encodes known in-range floating-point samples and round-trips them bit-exactly in 32-bit float WAV', async () => {
    const leftInRange = [-1.0, -0.75, -0.5, -0.125, 0.0, 0.125, 0.33333334, 0.5, 0.875, 1.0];
    const rightInRange = [1.0, 0.625, 0.25, 0.0, -0.25, -0.625, -0.9, -1.0, 0.0625, -0.0625];
    const buffer = createSyntheticAudioBuffer([leftInRange, rightInRange], 44100);

    const blob = audioBufferToWav(buffer, 32);
    const decoded = await decodeWavBlob(blob);

    assert.equal(decoded.riffId, 'RIFF');
    assert.equal(decoded.waveId, 'WAVE');
    assert.equal(decoded.fmtId, 'fmt ');
    assert.equal(decoded.fmtChunkSize, 16);
    assert.equal(decoded.audioFormat, 3, '32-bit float WAV must use WAVE_FORMAT_IEEE_FLOAT (3)');
    assert.equal(decoded.bitsPerSample, 32);
    assert.equal(decoded.numChannels, 2);
    assert.equal(decoded.sampleRate, 44100);
    assert.equal(decoded.blockAlign, 8);
    assert.equal(decoded.byteRate, 44100 * 8);
    assert.equal(decoded.dataId, 'data');
    assert.equal(decoded.frameCount, leftInRange.length);
    assert.equal(decoded.dataSize, leftInRange.length * 8);
    assert.equal(decoded.chunkSize, 36 + decoded.dataSize);
    assert.equal(decoded.byteLength, 44 + decoded.dataSize);

    for (let i = 0; i < leftInRange.length; i += 1) {
      assert.equal(decoded.channels[0][i], Math.fround(leftInRange[i]), `left[${i}] in-range float32 round-trip`);
      assert.equal(decoded.channels[1][i], Math.fround(rightInRange[i]), `right[${i}] in-range float32 round-trip`);
    }
  });

  it('preserves finite samples below -1.0 and above +1.0 in 32-bit float WAV without clamping to [-1, 1]', async () => {
    const leftHeadroom = [-6.0, -3.25, -1.75, -1.001, -0.5, 0.0, 0.5, 1.001, 1.5, 2.75, 4.5, 12.0];
    const rightHeadroom = [8.5, 3.125, 1.25, 1.05, 0.25, 0.0, -0.25, -1.05, -1.5, -2.25, -5.0, -9.75];
    const buffer = createSyntheticAudioBuffer([leftHeadroom, rightHeadroom], 48000);

    const blob = audioBufferToWav(buffer, 32);
    const decoded = await decodeWavBlob(blob);

    assert.equal(decoded.audioFormat, 3, 'WAVE_FORMAT_IEEE_FLOAT (3)');
    assert.equal(decoded.bitsPerSample, 32);
    assert.equal(decoded.numChannels, 2);
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.frameCount, leftHeadroom.length);

    for (let i = 0; i < leftHeadroom.length; i += 1) {
      const expectedL = Math.fround(leftHeadroom[i]);
      const expectedR = Math.fround(rightHeadroom[i]);
      assert.ok(
        Math.abs(decoded.channels[0][i] - expectedL) <= FLOAT32_TOLERANCE,
        `left[${i}]: expected ${expectedL} to be preserved in 32-bit float WAV, got ${decoded.channels[0][i]}`,
      );
      assert.ok(
        Math.abs(decoded.channels[1][i] - expectedR) <= FLOAT32_TOLERANCE,
        `right[${i}]: expected ${expectedR} to be preserved in 32-bit float WAV, got ${decoded.channels[1][i]}`,
      );
    }
  });

  it('clamps out-of-range samples in 16-bit and 24-bit integer PCM exports according to the PCM contract', async () => {
    const samplesL = [-4.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 3.25];
    const samplesR = [2.5, 1.1, 1.0, 0.25, 0.0, -0.25, -1.0, -1.1, -2.5];
    const buffer = createSyntheticAudioBuffer([samplesL, samplesR], 44100);

    // 16-bit PCM
    const wav16 = await decodeWavBlob(audioBufferToWav(buffer, 16));
    assert.equal(wav16.audioFormat, 1, '16-bit WAV must use WAVE_FORMAT_PCM (1)');
    assert.equal(wav16.bitsPerSample, 16);
    assert.equal(wav16.numChannels, 2);
    assert.equal(wav16.blockAlign, 4);
    assert.equal(wav16.byteRate, 44100 * 4);
    assert.equal(wav16.frameCount, samplesL.length);

    // Below -1.0 clamps to -32768; above +1.0 clamps to +32767 (no integer wrap-around)
    assert.equal(wav16.pcmIntegers[0][0], -32768);
    assert.equal(wav16.pcmIntegers[0][1], -32768);
    assert.equal(wav16.pcmIntegers[0][2], -32768);
    assert.equal(wav16.pcmIntegers[0][3], -16384);
    assert.equal(wav16.pcmIntegers[0][4], 0);
    assert.equal(wav16.pcmIntegers[0][5], Math.round(0.5 * 0x7fff));
    assert.equal(wav16.pcmIntegers[0][6], 32767);
    assert.equal(wav16.pcmIntegers[0][7], 32767);
    assert.equal(wav16.pcmIntegers[0][8], 32767);

    assert.equal(wav16.pcmIntegers[1][0], 32767);
    assert.equal(wav16.pcmIntegers[1][1], 32767);
    assert.equal(wav16.pcmIntegers[1][7], -32768);
    assert.equal(wav16.pcmIntegers[1][8], -32768);

    // 24-bit PCM
    const wav24 = await decodeWavBlob(audioBufferToWav(buffer, 24));
    assert.equal(wav24.audioFormat, 1, '24-bit WAV must use WAVE_FORMAT_PCM (1)');
    assert.equal(wav24.bitsPerSample, 24);
    assert.equal(wav24.numChannels, 2);
    assert.equal(wav24.blockAlign, 6);
    assert.equal(wav24.byteRate, 44100 * 6);
    assert.equal(wav24.frameCount, samplesL.length);

    // Below -1.0 clamps to -8388608 (-0x800000); above +1.0 clamps to +8388607 (0x7fffff)
    assert.equal(wav24.pcmIntegers[0][0], -0x800000);
    assert.equal(wav24.pcmIntegers[0][1], -0x800000);
    assert.equal(wav24.pcmIntegers[0][2], -0x800000);
    assert.equal(wav24.pcmIntegers[0][3], -0x400000);
    assert.equal(wav24.pcmIntegers[0][4], 0);
    assert.equal(wav24.pcmIntegers[0][5], Math.round(0.5 * 0x7fffff));
    assert.equal(wav24.pcmIntegers[0][6], 0x7fffff);
    assert.equal(wav24.pcmIntegers[0][7], 0x7fffff);
    assert.equal(wav24.pcmIntegers[0][8], 0x7fffff);

    assert.equal(wav24.pcmIntegers[1][0], 0x7fffff);
    assert.equal(wav24.pcmIntegers[1][1], 0x7fffff);
    assert.equal(wav24.pcmIntegers[1][7], -0x800000);
    assert.equal(wav24.pcmIntegers[1][8], -0x800000);
  });

  it('handles silence and invalid numeric inputs (NaN, +Infinity, -Infinity, float32 overflow) safely without preserving them as headroom', async () => {
    const rawSamplesL = [0.0, -0.0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -1e300, 1.75, -2.25];
    const rawSamplesR = [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 0.0, -0.0, -2.5, 3.5, -1e300, 1e300];
    // Pass raw JS number arrays so 1e300 (finite in float64, Infinity in float32) reaches the encoder
    const buffer = createSyntheticAudioBuffer([rawSamplesL, rawSamplesR], 48000, true);

    const decoded32 = await decodeWavBlob(audioBufferToWav(buffer, 32));
    for (let ch = 0; ch < 2; ch += 1) {
      for (let i = 0; i < decoded32.frameCount; i += 1) {
        const sample = decoded32.channels[ch][i];
        assert.ok(
          Number.isFinite(sample),
          `32-bit float WAV channel ${ch} sample ${i} must be finite, got ${sample}`,
        );
      }
    }
    // Invalid numeric inputs sanitize to 0, while valid finite headroom samples are preserved
    assert.equal(Object.is(decoded32.channels[0][0], 0), true);
    assert.equal(Object.is(decoded32.channels[0][1], -0), true);
    assert.equal(decoded32.channels[0][2], 0, 'NaN must sanitize to 0');
    assert.equal(decoded32.channels[0][3], 0, '+Infinity must not be preserved in float WAV');
    assert.equal(decoded32.channels[0][4], 0, '-Infinity must not be preserved in float WAV');
    assert.equal(decoded32.channels[0][5], 0, 'Float64 overflowing float32 to +Infinity must sanitize to 0');
    assert.equal(decoded32.channels[0][6], 0, 'Float64 overflowing float32 to -Infinity must sanitize to 0');
    assert.equal(decoded32.channels[0][7], Math.fround(1.75), 'valid finite +1.75 headroom preserved');
    assert.equal(decoded32.channels[0][8], Math.fround(-2.25), 'valid finite -2.25 headroom preserved');

    assert.equal(decoded32.channels[1][0], 0);
    assert.equal(decoded32.channels[1][1], 0);
    assert.equal(decoded32.channels[1][2], 0);
    assert.equal(decoded32.channels[1][5], Math.fround(-2.5), 'valid finite -2.5 headroom preserved on R');
    assert.equal(decoded32.channels[1][6], Math.fround(3.5), 'valid finite +3.5 headroom preserved on R');

    // 16-bit and 24-bit PCM also remain finite and safe on invalid inputs
    const decoded16 = await decodeWavBlob(audioBufferToWav(buffer, 16));
    const decoded24 = await decodeWavBlob(audioBufferToWav(buffer, 24));
    assert.equal(decoded16.pcmIntegers[0][2], 0, '16-bit NaN -> 0');
    assert.equal(decoded24.pcmIntegers[0][2], 0, '24-bit NaN -> 0');
    assert.equal(decoded16.pcmIntegers[0][7], 32767, '16-bit +1.75 clamps to +32767');
    assert.equal(decoded16.pcmIntegers[0][8], -32768, '16-bit -2.25 clamps to -32768');
    assert.equal(decoded24.pcmIntegers[0][7], 0x7fffff, '24-bit +1.75 clamps to +8388607');
    assert.equal(decoded24.pcmIntegers[0][8], -0x800000, '24-bit -2.25 clamps to -8388608');
  });

  it('preserves 32-bit float headroom in sampleBufferPersistence.encodeSampleBufferForStorage', async () => {
    const buffer = createSyntheticAudioBuffer([[-2.25, -1.2, 0, 1.35, 3.0]], 44100);
    const blob = encodeSampleBufferForStorage(buffer);
    const decoded = await decodeWavBlob(blob);

    assert.equal(decoded.audioFormat, 3);
    assert.equal(decoded.bitsPerSample, 32);
    assert.equal(decoded.numChannels, 1);
    assert.equal(decoded.frameCount, 5);
    assert.equal(decoded.channels[0][0], Math.fround(-2.25));
    assert.equal(decoded.channels[0][1], Math.fround(-1.2));
    assert.equal(decoded.channels[0][2], 0);
    assert.equal(decoded.channels[0][3], Math.fround(1.35));
    assert.equal(decoded.channels[0][4], Math.fround(3.0));
  });
});

describe('Audio Integrity Fix 2: production AudioEngine export path preserves 32-bit float headroom', () => {
  let prevOfflineAudioContext: unknown;
  const hotBufferId = 'fix2-hot-audio-buffer';

  beforeEach(() => {
    prevOfflineAudioContext = (globalThis as Record<string, unknown>).OfflineAudioContext;
    (globalThis as Record<string, unknown>).OfflineAudioContext = RealOfflineAudioContext;
    audioEngine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).OfflineAudioContext = prevOfflineAudioContext;
    audioEngine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  const buildHotClipFixture = () => {
    const sampleRate = 44100;
    const durationSeconds = 0.5;
    const length = Math.floor(sampleRate * durationSeconds);
    const bufferFactoryCtx = new RealOfflineAudioContext(2, length, sampleRate);
    const hotBuffer = bufferFactoryCtx.createBuffer(2, length, sampleRate);
    const left = hotBuffer.getChannelData(0);
    const right = hotBuffer.getChannelData(1);
    // Place away from the clip start/end so the 5 ms clip fade-in/out window leaves full amplitude intact.
    for (let i = 0; i < length; i += 1) {
      const phase = (2 * Math.PI * 2200 * i) / sampleRate;
      left[i] = Math.fround(3.25 * Math.sin(phase));
      right[i] = Math.fround(-3.75 * Math.cos(phase));
    }
    audioEngine.setSampleBuffer(hotBufferId, hotBuffer);

    const channel: Channel = {
      id: 'ch-hot',
      name: 'Hot Stem',
      color: '#10b981',
      instrumentType: 'sampler',
      mixerTrackId: 1,
      volume: 1.0,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: new Array(16).fill(false),
      notes: [],
      synthParams: audioEngine.getDefaultSynthParams(),
    };

    const clip: PlaylistClip = {
      id: 'clip-hot-audio',
      name: 'Hot Audio Clip',
      audioName: 'Hot Audio Clip',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 0.25,
      type: 'audio',
      channelId: channel.id,
      audioBufferId: hotBufferId,
      color: '#f97316',
      mute: false,
    };

    const mixerTracks: MixerTrack[] = [
      { id: 0, name: 'Master', color: '#3b82f6', volume: 1.25, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
      { id: 1, name: 'Track 1', color: '#10b981', volume: 1.25, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
    ];

    return { channel, clip, mixerTracks };
  };

  it('renderProjectToWav with bitDepth=32 preserves rendered samples outside [-1.0, +1.0]', async () => {
    const { channel, clip, mixerTracks } = buildHotClipFixture();

    const renderedBuffer = await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      mixerTracks,
      120,
      1,
      44100,
      false,
      'song',
    );
    const renderedL = renderedBuffer.getChannelData(0);
    const renderedR = renderedBuffer.getChannelData(1);

    let minL = 0;
    let maxL = 0;
    let minR = 0;
    let maxR = 0;
    for (let i = 0; i < renderedBuffer.length; i += 1) {
      if (renderedL[i] < minL) minL = renderedL[i];
      if (renderedL[i] > maxL) maxL = renderedL[i];
      if (renderedR[i] < minR) minR = renderedR[i];
      if (renderedR[i] > maxR) maxR = renderedR[i];
    }
    assert.ok(maxL > 1.2 && minL < -1.2, `Expected rendered L buffer to exceed [-1, 1], got [${minL}, ${maxL}]`);
    assert.ok(maxR > 1.2 && minR < -1.2, `Expected rendered R buffer to exceed [-1, 1], got [${minR}, ${maxR}]`);

    const wav32Blob = await audioEngine.renderProjectToWav(
      [channel],
      [clip],
      120,
      1,
      32,
      mixerTracks,
      false,
    );
    const decoded32 = await decodeWavBlob(wav32Blob);

    assert.equal(decoded32.audioFormat, 3, '32-bit export must use IEEE float format (3)');
    assert.equal(decoded32.bitsPerSample, 32);
    assert.equal(decoded32.numChannels, 2);
    assert.equal(decoded32.sampleRate, 44100);
    assert.equal(decoded32.frameCount, renderedBuffer.length);

    let decodedMaxL = 0;
    let decodedMinL = 0;
    let decodedMaxR = 0;
    let decodedMinR = 0;
    for (let i = 0; i < decoded32.frameCount; i += 1) {
      const l = decoded32.channels[0][i];
      const r = decoded32.channels[1][i];
      if (l > decodedMaxL) decodedMaxL = l;
      if (l < decodedMinL) decodedMinL = l;
      if (r > decodedMaxR) decodedMaxR = r;
      if (r < decodedMinR) decodedMinR = r;
      assert.ok(
        Math.abs(l - renderedL[i]) <= FLOAT32_TOLERANCE,
        `Frame ${i} L mismatch: rendered ${renderedL[i]} vs encoded ${l}`,
      );
      assert.ok(
        Math.abs(r - renderedR[i]) <= FLOAT32_TOLERANCE,
        `Frame ${i} R mismatch: rendered ${renderedR[i]} vs encoded ${r}`,
      );
    }

    assert.ok(decodedMaxL > 1.2, `Decoded 32-bit float WAV must preserve positive headroom > 1.0 (got ${decodedMaxL})`);
    assert.ok(decodedMinL < -1.2, `Decoded 32-bit float WAV must preserve negative headroom < -1.0 (got ${decodedMinL})`);
    assert.ok(decodedMaxR > 1.2, `Decoded 32-bit float WAV R must preserve positive headroom > 1.0 (got ${decodedMaxR})`);
    assert.ok(decodedMinR < -1.2, `Decoded 32-bit float WAV R must preserve negative headroom < -1.0 (got ${decodedMinR})`);
  });

  it('renderProjectToWav defaults to 24-bit PCM and clamps out-of-range samples in 16-bit and 24-bit modes', async () => {
    const { channel, clip, mixerTracks } = buildHotClipFixture();

    // Default bitDepth (omitted -> 24-bit PCM)
    const defaultWavBlob = await audioEngine.renderProjectToWav([channel], [clip], 120, 1, undefined, mixerTracks, false);
    const decodedDefault = await decodeWavBlob(defaultWavBlob);
    assert.equal(decodedDefault.audioFormat, 1, 'Default WAV export must remain PCM (1)');
    assert.equal(decodedDefault.bitsPerSample, 24, 'Default WAV export bitDepth must remain 24-bit');

    let maxInt24 = 0;
    let minInt24 = 0;
    for (let i = 0; i < decodedDefault.frameCount; i += 1) {
      const v = decodedDefault.pcmIntegers[0][i];
      if (v > maxInt24) maxInt24 = v;
      if (v < minInt24) minInt24 = v;
      assert.ok(decodedDefault.channels[0][i] >= -1.0 && decodedDefault.channels[0][i] <= 1.0);
    }
    assert.equal(maxInt24, 0x7fffff, '24-bit PCM positive overload must clamp at +0x7fffff');
    assert.equal(minInt24, -0x800000, '24-bit PCM negative overload must clamp at -0x800000');

    // Explicit 16-bit PCM
    const wav16Blob = await audioEngine.renderProjectToWav([channel], [clip], 120, 1, 16, mixerTracks, false);
    const decoded16 = await decodeWavBlob(wav16Blob);
    assert.equal(decoded16.audioFormat, 1);
    assert.equal(decoded16.bitsPerSample, 16);

    let maxInt16 = 0;
    let minInt16 = 0;
    for (let i = 0; i < decoded16.frameCount; i += 1) {
      const v = decoded16.pcmIntegers[0][i];
      if (v > maxInt16) maxInt16 = v;
      if (v < minInt16) minInt16 = v;
    }
    assert.equal(maxInt16, 32767, '16-bit PCM positive overload must clamp at +32767');
    assert.equal(minInt16, -32768, '16-bit PCM negative overload must clamp at -32768');
  });

  it('renderProjectStems with bitDepth=32 preserves floating-point headroom in both master and stem WAVs', async () => {
    const { channel, clip, mixerTracks } = buildHotClipFixture();

    const { master, stems } = await audioEngine.renderProjectStems(
      [channel],
      [clip],
      mixerTracks,
      120,
      1,
      32,
      'song',
      undefined,
      undefined,
      false,
    );

    const decodedMaster = await decodeWavBlob(master);
    const stemBlob = stems['ch-hot_Hot_Stem.wav'];
    assert.ok(stemBlob instanceof Blob, 'Channel stem blob must exist');
    const decodedStem = await decodeWavBlob(stemBlob);

    for (const [label, wav] of [
      ['master', decodedMaster],
      ['stem', decodedStem],
    ] as const) {
      assert.equal(wav.audioFormat, 3, `${label} must be IEEE Float (3)`);
      assert.equal(wav.bitsPerSample, 32, `${label} must be 32-bit`);
      let maxSample = 0;
      let minSample = 0;
      for (let i = 0; i < wav.frameCount; i += 1) {
        if (wav.channels[0][i] > maxSample) maxSample = wav.channels[0][i];
        if (wav.channels[0][i] < minSample) minSample = wav.channels[0][i];
      }
      assert.ok(maxSample > 1.2, `${label} 32-bit float WAV must preserve peaks > +1.0 (got ${maxSample})`);
      assert.ok(minSample < -1.2, `${label} 32-bit float WAV must preserve peaks < -1.0 (got ${minSample})`);
    }
  });

  it('explicitly enabled Mastering Suite maximizer ceiling still limits the signal as configured', async () => {
    const { channel, clip, mixerTracks } = buildHotClipFixture();

    audioEngine.setMasteringState({
      ...DEFAULT_MASTERING_SUITE_STATE,
      enabled: true,
      maximizerCeiling: -3.0,
      maximizerThreshold: -12.0,
    });

    const renderedWithMastering = await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      mixerTracks,
      120,
      1,
      44100,
      false,
      'song',
    );
    const wavWithMastering = await decodeWavBlob(audioBufferToWav(renderedWithMastering, 32));

    // When the user explicitly enables the Mastering Suite maximizer, the encoded
    // 32-bit float WAV faithfully reflects the mastered buffer (attenuated relative to the unmastered +1.85/+2.15 peak).
    let masteredMax = 0;
    const renderedL = renderedWithMastering.getChannelData(0);
    for (let i = 0; i < wavWithMastering.frameCount; i += 1) {
      assert.ok(
        Math.abs(wavWithMastering.channels[0][i] - renderedL[i]) <= FLOAT32_TOLERANCE,
        `Mastered frame ${i} must match rendered buffer exactly`,
      );
      if (Math.abs(wavWithMastering.channels[0][i]) > masteredMax) {
        masteredMax = Math.abs(wavWithMastering.channels[0][i]);
      }
    }
    assert.ok(masteredMax > 0.05 && masteredMax < 1.5, `Mastering maximizer reduced peak as configured (got ${masteredMax})`);
  });
});
