/** Sample-exact, non-destructive PCM operations. Ranges are [start, end). */
export interface FrameSelection { start: number; end: number }
export type WaveformOperation =
  | { type: 'crop' | 'delete' | 'silence' | 'reverse' | 'fade-in' | 'fade-out' }
  | { type: 'gain'; db: number }
  | { type: 'normalize'; db: number };
export type BufferFactory = (channels: number, frames: number, sampleRate: number) => AudioBuffer;
export const MAX_EDITOR_BYTES = 64 * 1024 * 1024;
export function validatePcm(buffer: AudioBuffer): void {
  if (!buffer || !Number.isInteger(buffer.length) || buffer.length < 1 ||
    !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 ||
    !Number.isFinite(buffer.sampleRate) || buffer.sampleRate < 8000 || buffer.sampleRate > 384000 ||
    buffer.length * buffer.numberOfChannels * 4 > MAX_EDITOR_BYTES) {
    throw new Error('Editor requires non-empty mono/stereo PCM, 8–384 kHz, at most 64 MiB per buffer.');
  }
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const samples = buffer.getChannelData(c);
    if (samples.length !== buffer.length || samples.some(value => !Number.isFinite(value))) throw new Error('Audio contains invalid/non-finite PCM.');
  }
}
export function validateSelection(buffer: Pick<AudioBuffer, 'length'>, selection: FrameSelection): void {
  if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 ||
    selection.end > buffer.length || selection.start >= selection.end) {
    throw new Error('Select a non-empty range: integer frames 0 ≤ start < end ≤ audio length (end is exclusive).');
  }
}
export function copyPcmRange(source: AudioBuffer, selection: FrameSelection, create: BufferFactory): AudioBuffer {
  validatePcm(source); validateSelection(source, selection);
  const output = create(source.numberOfChannels, selection.end - selection.start, source.sampleRate);
  for (let c = 0; c < source.numberOfChannels; c++) output.getChannelData(c).set(source.getChannelData(c).subarray(selection.start, selection.end));
  return output;
}
export function selectionPeak(source: AudioBuffer, range: FrameSelection): number {
  let peak = 0;
  for (let c = 0; c < source.numberOfChannels; c++) {
    const data = source.getChannelData(c);
    for (let i = range.start; i < range.end; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
}
export function editWaveform(source: AudioBuffer, range: FrameSelection, operation: WaveformOperation, create: BufferFactory): AudioBuffer {
  validatePcm(source); validateSelection(source, range);
  const count = range.end - range.start;
  if (operation.type === 'crop') return copyPcmRange(source, range, create);
  if (operation.type === 'delete' && count === source.length) throw new Error('Deleting the whole clip would create empty audio. Use Silence instead.');
  let gain = 1;
  if (operation.type === 'normalize' || operation.type === 'gain') {
    if (!Number.isFinite(operation.db) || operation.db < -60 || operation.db > (operation.type === 'normalize' ? 0 : 24)) {
      throw new Error(operation.type === 'normalize' ? 'Normalization target must be −60 to 0 dBFS.' : 'Gain must be −60 to +24 dB.');
    }
    const peak = selectionPeak(source, range);
    if (operation.type === 'normalize' && peak === 0) throw new Error('Silent selection cannot be normalized.');
    gain = operation.type === 'normalize' ? Math.pow(10, operation.db / 20) / peak : Math.pow(10, operation.db / 20);
    if (peak * gain > 1 + 1e-7) throw new Error('Requested gain would clip. Lower the gain or normalize first. Nothing changed.');
  }
  const output = create(source.numberOfChannels, source.length - (operation.type === 'delete' ? count : 0), source.sampleRate);
  for (let c = 0; c < source.numberOfChannels; c++) {
    const input = source.getChannelData(c), data = output.getChannelData(c);
    if (operation.type === 'delete') {
      data.set(input.subarray(0, range.start)); data.set(input.subarray(range.end), range.start); continue;
    }
    data.set(input);
    for (let i = range.start; i < range.end; i++) {
      switch (operation.type) {
        case 'silence': data[i] = 0; break;
        case 'reverse': data[i] = input[range.end - 1 - (i - range.start)]; break;
        case 'gain': case 'normalize': data[i] = Math.max(-1, Math.min(1, input[i] * gain)); break;
        case 'fade-in': data[i] = input[i] * (count === 1 ? 0 : (i - range.start) / (count - 1)); break;
        case 'fade-out': data[i] = input[i] * (count === 1 ? 0 : (range.end - 1 - i) / (count - 1)); break;
      }
    }
  }
  return output;
}

/** Bound draft undo separately from serializable project history. Never put PCM in project snapshots. */
export function appendDraft(history: AudioBuffer[], index: number, next: AudioBuffer): AudioBuffer[] {
  const retained = [...history.slice(0, index + 1), next];
  let bytes = retained.reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0);
  while (retained.length > 8 || (bytes > 128 * 1024 * 1024 && retained.length > 1)) {
    const removed = retained.shift()!; bytes -= removed.length * removed.numberOfChannels * 4;
  }
  return retained;
}
