/**
 * Phase 10G — renderer side of the disk-backed WAV export.
 *
 * `DesktopStreamedWavExport` is the `StreamedExportTarget` the engine writes
 * to. It converts master PCM to the selected bit depth with the application's
 * one sample encoder and sends it, in bounded messages, to the main-process
 * export store (`desktop-export.cjs`). Processed VST3 effect PCM goes to
 * scratch files in the same store. The renderer never holds more than one
 * message of either and never names a file path.
 */
import { encodeInterleavedWavSamples } from './wavEncoder';
import type { StreamedExportScratch, StreamedExportTarget } from './streamedOfflineExport';

/** PCM bytes per IPC message. The store rejects anything above 4 MiB. */
export const STREAMED_EXPORT_MESSAGE_BYTES = 1024 * 1024;
const SCRATCH_FRAME_BYTES = 8;

export interface DesktopExportStoreBridge {
  begin(config: { bitDepth: 16 | 24 | 32; channels: 2; sampleRate?: number; estimatedBytes?: number }): Promise<{ jobId: string; maxChunkBytes: number }>;
  write(jobId: string, sequence: number, bytes: Uint8Array): Promise<{ dataBytes: number }>;
  createScratch(jobId: string): Promise<{ scratchId: string }>;
  appendScratch(jobId: string, scratchId: string, bytes: Uint8Array): Promise<{ bytes: number }>;
  readScratch(jobId: string, scratchId: string, byteOffset: number, byteLength: number): Promise<Uint8Array>;
  releaseScratch(jobId: string, scratchId: string): Promise<{ released: boolean }>;
  finalize(jobId: string, result: { frames: number; sampleRate: number }): Promise<{ frames: number; sampleRate: number; bitDepth: number; channels: number; bytes: number }>;
  save(jobId: string, suggestedName: string): Promise<{ canceled: boolean; path?: string; bytes?: number; frames?: number }>;
  abort(jobId: string): Promise<{ aborted: boolean }>;
  stats(jobId: string): Promise<{ state: string; dataBytes: number; scratchBytes: number; scratchFiles: number; peakDiskBytes: number; frames: number; savedPath: string | null }>;
}

/** The export store of the desktop application, absent in a browser. */
export function getDesktopExportStore(): DesktopExportStoreBridge | undefined {
  const store = (globalThis as unknown as { desktopApp?: { exportStore?: DesktopExportStoreBridge } }).desktopApp?.exportStore;
  return store && typeof store.begin === 'function' && typeof store.write === 'function' ? store : undefined;
}

/** True when the project renders native VST3 audio in an export with these settings. */
export function exportUsesNativeVst3(
  channels: ReadonlyArray<{ instrumentType?: string }>,
  mixerTracks: ReadonlyArray<{ fxSlots?: ReadonlyArray<{ type?: string; enabled?: boolean }> }>,
  includeMixerFx: boolean,
): boolean {
  if (channels.some(channel => channel.instrumentType === 'vst3')) return true;
  return includeMixerFx && mixerTracks.some(track => (track.fxSlots ?? []).some(slot => slot.type === 'vst3' && slot.enabled));
}

/**
 * Upper estimate of the temporary disk space a streamed export needs: the WAV
 * itself plus one float32 stereo scratch file per enabled VST3 Mixer effect.
 */
export function estimateStreamedExportBytes(frames: number, bitDepth: 16 | 24 | 32, nativeEffects: number): number {
  return 44 + frames * 2 * (bitDepth / 8) + Math.max(0, nativeEffects) * frames * SCRATCH_FRAME_BYTES;
}

const toBytes = (pcm: Float32Array): Uint8Array => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

class DesktopExportScratch implements StreamedExportScratch {
  private bytes = 0;
  private released = false;
  constructor(private readonly bridge: DesktopExportStoreBridge, private readonly jobId: string, private readonly scratchId: string) {}

  get frames(): number { return this.bytes / SCRATCH_FRAME_BYTES; }

  async append(interleaved: Float32Array): Promise<void> {
    if (this.released) throw new Error('Temporary effect audio was already released.');
    const source = toBytes(interleaved);
    for (let offset = 0; offset < source.length; offset += STREAMED_EXPORT_MESSAGE_BYTES) {
      // `slice` copies: the message owns exactly its bytes, never the caller's buffer.
      const chunk = source.slice(offset, Math.min(source.length, offset + STREAMED_EXPORT_MESSAGE_BYTES));
      await this.bridge.appendScratch(this.jobId, this.scratchId, chunk);
      this.bytes += chunk.length;
    }
  }

  async read(frameOffset: number, frames: number): Promise<Float32Array> {
    if (this.released) throw new Error('Temporary effect audio was already released.');
    const output = new Float32Array(frames * 2);
    const target = toBytes(output);
    const start = frameOffset * SCRATCH_FRAME_BYTES;
    for (let offset = 0; offset < target.length; offset += STREAMED_EXPORT_MESSAGE_BYTES) {
      const length = Math.min(STREAMED_EXPORT_MESSAGE_BYTES, target.length - offset);
      const chunk = await this.bridge.readScratch(this.jobId, this.scratchId, start + offset, length);
      if (!(chunk instanceof Uint8Array) || chunk.length !== length) {
        throw new Error('Temporary effect audio could not be read back from disk. Export stopped.');
      }
      target.set(chunk, offset);
    }
    return output;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.bridge.releaseScratch(this.jobId, this.scratchId);
  }
}

/** One streamed WAV export job in the desktop export store. */
export class DesktopStreamedWavExport implements StreamedExportTarget {
  private sequence = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private framesWritten = 0;
  private closed = false;

  private constructor(
    private readonly bridge: DesktopExportStoreBridge,
    readonly jobId: string,
    readonly bitDepth: 16 | 24 | 32,
  ) {}

  static async begin(
    bridge: DesktopExportStoreBridge,
    config: { bitDepth: 16 | 24 | 32; sampleRate?: number; estimatedBytes?: number },
  ): Promise<DesktopStreamedWavExport> {
    const { jobId } = await bridge.begin({ bitDepth: config.bitDepth, channels: 2, sampleRate: config.sampleRate, estimatedBytes: config.estimatedBytes });
    return new DesktopStreamedWavExport(bridge, jobId, config.bitDepth);
  }

  get frames(): number { return this.framesWritten; }

  async createScratch(_label: string): Promise<StreamedExportScratch> {
    const { scratchId } = await this.bridge.createScratch(this.jobId);
    return new DesktopExportScratch(this.bridge, this.jobId, scratchId);
  }

  private async flush(all: boolean): Promise<void> {
    // A message always holds whole stereo frames: 1 MiB is not a multiple of
    // the 6-byte frame of a 24-bit file.
    const frameBytes = 2 * (this.bitDepth / 8);
    const messageBytes = STREAMED_EXPORT_MESSAGE_BYTES - (STREAMED_EXPORT_MESSAGE_BYTES % frameBytes);
    while (this.pendingBytes >= messageBytes || (all && this.pendingBytes > 0)) {
      const size = Math.min(this.pendingBytes, messageBytes);
      const message = new Uint8Array(size);
      let filled = 0;
      while (filled < size) {
        const head = this.pending[0]!;
        const take = Math.min(head.length, size - filled);
        message.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) this.pending.shift();
        else this.pending[0] = head.subarray(take);
      }
      this.pendingBytes -= size;
      await this.bridge.write(this.jobId, this.sequence, message);
      this.sequence += 1;
    }
  }

  async write(interleaved: Float32Array): Promise<void> {
    if (this.closed) throw new Error('The export file is already closed.');
    if (!interleaved.length) return;
    const encoded = encodeInterleavedWavSamples(interleaved, this.bitDepth);
    this.pending.push(encoded);
    this.pendingBytes += encoded.length;
    this.framesWritten += interleaved.length / 2;
    await this.flush(false);
  }

  /** Completes the WAV on disk. Rejects unless every frame the engine reports was received. */
  async finalize(result: { frames: number; sampleRate: number }) {
    if (this.closed) throw new Error('The export file is already closed.');
    await this.flush(true);
    if (this.framesWritten !== result.frames) {
      throw new Error(`The export is incomplete: ${this.framesWritten} of ${result.frames} frames were written.`);
    }
    const finished = await this.bridge.finalize(this.jobId, result);
    this.closed = true;
    return finished;
  }

  /** Opens the save dialog and copies the finished WAV to the chosen destination. */
  save(suggestedName: string) { return this.bridge.save(this.jobId, suggestedName); }

  stats() { return this.bridge.stats(this.jobId); }

  /** Discards the job and everything it wrote. Safe to call more than once. */
  async abort(): Promise<void> {
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    await this.bridge.abort(this.jobId).catch(() => {});
  }
}
