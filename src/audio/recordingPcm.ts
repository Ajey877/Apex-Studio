import { RECORDING_CAPTURE_PREROLL_SECONDS } from './recordingCaptureWorklet';

/** One PCM block delivered from the recording AudioWorklet, stamped in context frames. */
export interface RecordingPcmBlock {
  readonly frameStart: number;
  readonly frameCount: number;
  readonly channelCount: number;
  readonly samples: Float32Array;
}

export interface RecordingPauseInterval {
  readonly startFrame: number;
  readonly endFrame: number | null;
}

export interface AssembledRecordingPcm {
  readonly channelCount: number;
  readonly frameCount: number;
  /** Interleaved PCM chunks; views reuse the transferred AudioWorklet buffers. */
  readonly chunks: Float32Array[];
}

const MAX_RIFF_DATA_BYTES = 0xffff_ffff - 36;
const WAV_PART_BYTES = 1024 * 1024;
const isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Restricts the idle/pre-roll buffer to the documented AudioWorklet retention
 * window, keeping its newest frame boundary intact if it falls inside a block.
 */
export const trimRecordingPreRoll = (
  blocks: RecordingPcmBlock[],
  newestFrame: number,
  sampleRate: number,
): void => {
  const oldestFrame = Math.max(0, newestFrame - Math.ceil(RECORDING_CAPTURE_PREROLL_SECONDS * sampleRate));
  while (blocks.length > 0) {
    const first = blocks[0];
    const firstEnd = first.frameStart + first.frameCount;
    if (firstEnd <= oldestFrame) {
      blocks.shift();
      continue;
    }
    if (first.frameStart < oldestFrame) {
      const skippedFrames = oldestFrame - first.frameStart;
      blocks[0] = {
        ...first,
        frameStart: oldestFrame,
        frameCount: first.frameCount - skippedFrames,
        samples: first.samples.subarray(skippedFrames * first.channelCount),
      };
    }
    break;
  }
};

const normalizePauseIntervals = (
  intervals: readonly RecordingPauseInterval[],
  startFrame: number,
  stopFrame: number,
): Array<{ startFrame: number; endFrame: number }> => {
  const normalized = intervals
    .map(interval => ({
      startFrame: Math.max(startFrame, Math.min(stopFrame, interval.startFrame)),
      endFrame: Math.max(startFrame, Math.min(stopFrame, interval.endFrame ?? stopFrame)),
    }))
    .filter(interval => interval.endFrame > interval.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged: Array<{ startFrame: number; endFrame: number }> = [];
  for (const interval of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, interval.endFrame);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
};

/**
 * Slices timestamped AudioWorklet blocks to an exact half-open frame interval.
 * Pause gaps are omitted for ordinary recording (matching MediaRecorder's old
 * pause/resume semantics); an optional preservation mode fills them with digital
 * silence. Missing non-paused frames are a hard error, never silently padded.
 */
export const assembleRecordingPcm = (params: {
  blocks: readonly RecordingPcmBlock[];
  startFrame: number;
  stopFrame: number;
  pauseIntervals?: readonly RecordingPauseInterval[];
  preservePausedTimeline?: boolean;
  fallbackChannelCount?: number;
}): AssembledRecordingPcm => {
  const { startFrame, stopFrame } = params;
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(stopFrame) || stopFrame < startFrame) {
    throw new Error('The recording capture frame range is invalid');
  }

  const ordered = [...params.blocks].sort((a, b) => a.frameStart - b.frameStart);
  let channelCount = params.fallbackChannelCount ?? 0;
  for (const block of ordered) {
    if (block.frameStart + block.frameCount <= startFrame || block.frameStart >= stopFrame) continue;
    if (!Number.isSafeInteger(block.channelCount) || block.channelCount <= 0 || block.samples.length !== block.frameCount * block.channelCount) {
      throw new Error('The recording returned a malformed PCM block');
    }
    if (channelCount && channelCount !== block.channelCount) {
      throw new Error('The input channel layout changed during recording; the take was discarded.');
    }
    channelCount = block.channelCount;
  }
  if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > 32) {
    throw new Error('The recording contains no usable input channels');
  }

  const chunks: Float32Array[] = [];
  let frameCount = 0;
  const appendCapturedRange = (rangeStart: number, rangeEnd: number): void => {
    if (rangeEnd <= rangeStart) return;
    let coveredThrough = rangeStart;
    for (const block of ordered) {
      if (block.channelCount !== channelCount) continue;
      const blockEnd = block.frameStart + block.frameCount;
      if (blockEnd <= coveredThrough || block.frameStart >= rangeEnd) continue;
      const selectedStart = Math.max(coveredThrough, block.frameStart, rangeStart);
      const selectedEnd = Math.min(rangeEnd, blockEnd);
      if (selectedStart > coveredThrough) {
        throw new Error(`Audio capture lost ${selectedStart - coveredThrough} input frames; the take was discarded.`);
      }
      if (selectedEnd <= selectedStart) continue;
      const sourceOffset = (selectedStart - block.frameStart) * channelCount;
      const selectedSamples = (selectedEnd - selectedStart) * channelCount;
      chunks.push(block.samples.subarray(sourceOffset, sourceOffset + selectedSamples));
      frameCount += selectedEnd - selectedStart;
      coveredThrough = selectedEnd;
      if (coveredThrough >= rangeEnd) break;
    }
    if (coveredThrough < rangeEnd) {
      throw new Error(`Audio capture lost ${rangeEnd - coveredThrough} input frames; the take was discarded.`);
    }
  };

  const pauses = normalizePauseIntervals(params.pauseIntervals ?? [], startFrame, stopFrame);
  let cursor = startFrame;
  for (const pause of pauses) {
    appendCapturedRange(cursor, pause.startFrame);
    if (params.preservePausedTimeline) {
      const silentFrames = pause.endFrame - pause.startFrame;
      if (silentFrames > 0) {
        chunks.push(new Float32Array(silentFrames * channelCount));
        frameCount += silentFrames;
      }
    }
    cursor = pause.endFrame;
  }
  appendCapturedRange(cursor, stopFrame);

  return { channelCount, frameCount, chunks };
};

/**
 * Builds an IEEE-float 32-bit RIFF/WAVE Blob from interleaved PCM chunks without
 * flattening the entire take into another full-size AudioBuffer. Blocks are
 * coalesced into 1 MiB byte parts to keep Blob-part counts bounded.
 */
export const encodeFloat32PcmWav = (
  chunks: readonly Float32Array[],
  channelCount: number,
  sampleRate: number,
): Blob => {
  if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > 32) {
    throw new Error('The recording channel count is invalid');
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('The recording sample rate is invalid');
  const blockAlign = channelCount * Float32Array.BYTES_PER_ELEMENT;
  let sampleCount = 0;
  for (const chunk of chunks) {
    if (chunk.length % channelCount !== 0) throw new Error('The recording PCM block is not frame-aligned');
    sampleCount += chunk.length;
  }
  if (sampleCount === 0) throw new Error('The recording contains no audio samples');
  const dataBytes = sampleCount * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > MAX_RIFF_DATA_BYTES) {
    throw new Error('The recording exceeds the 4 GiB WAV asset limit; stop and save a shorter take.');
  }

  const headerBuffer = new ArrayBuffer(44);
  const header = new DataView(headerBuffer);
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++) header.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  header.setUint16(22, channelCount, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * blockAlign, true);
  header.setUint16(32, blockAlign, true);
  header.setUint16(34, 32, true);
  writeText(36, 'data');
  header.setUint32(40, dataBytes, true);

  const partCapacity = Math.max(blockAlign, Math.floor(WAV_PART_BYTES / blockAlign) * blockAlign);
  const parts: BlobPart[] = [headerBuffer];
  let bytePart = new Uint8Array(partCapacity);
  let byteFill = 0;
  const pushBytes = (source: Uint8Array): void => {
    let sourceOffset = 0;
    while (sourceOffset < source.length) {
      const count = Math.min(bytePart.length - byteFill, source.length - sourceOffset);
      bytePart.set(source.subarray(sourceOffset, sourceOffset + count), byteFill);
      sourceOffset += count;
      byteFill += count;
      if (byteFill === bytePart.length) {
        parts.push(bytePart);
        bytePart = new Uint8Array(partCapacity);
        byteFill = 0;
      }
    }
  };

  for (const chunk of chunks) {
    let hasNonFinite = false;
    for (let index = 0; index < chunk.length; index++) {
      if (!Number.isFinite(chunk[index])) { hasNonFinite = true; break; }
    }
    if (isLittleEndian && !hasNonFinite) {
      pushBytes(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      continue;
    }
    const sampleBytes = new Uint8Array(Math.min(partCapacity, Math.max(blockAlign, chunk.length * 4)));
    const view = new DataView(sampleBytes.buffer);
    let writeOffset = 0;
    for (let index = 0; index < chunk.length; index++) {
      let value = chunk[index];
      if (!Number.isFinite(value)) value = 0;
      view.setFloat32(writeOffset, value, true);
      writeOffset += 4;
      if (writeOffset === sampleBytes.length) {
        pushBytes(sampleBytes);
        writeOffset = 0;
      }
    }
    if (writeOffset > 0) pushBytes(sampleBytes.subarray(0, writeOffset));
  }
  if (byteFill > 0) parts.push(bytePart.subarray(0, byteFill));
  return new Blob(parts, { type: 'audio/wav' });
};

/** Peak waveform generated from the exact captured PCM, without decode/resample drift. */
export const buildRecordingWaveform = (
  chunks: readonly Float32Array[],
  channelCount: number,
  frameCount: number,
  sampleCount: number,
): number[] => {
  if (sampleCount <= 0 || frameCount <= 0 || channelCount <= 0) return [];
  const waveform = new Array<number>(sampleCount).fill(0);
  let frameOffset = 0;
  for (const chunk of chunks) {
    const chunkFrames = chunk.length / channelCount;
    for (let frame = 0; frame < chunkFrames; frame++) {
      const bucket = Math.min(sampleCount - 1, Math.floor(((frameOffset + frame) * sampleCount) / frameCount));
      for (let channel = 0; channel < channelCount; channel++) {
        const value = chunk[frame * channelCount + channel];
        if (Number.isFinite(value)) waveform[bucket] = Math.max(waveform[bucket], Math.min(1, Math.abs(value)));
      }
    }
    frameOffset += chunkFrames;
  }
  return waveform;
};
