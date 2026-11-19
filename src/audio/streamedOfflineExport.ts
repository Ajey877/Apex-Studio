/**
 * Phase 10G — bounded-lookahead primitives for the streamed production export.
 *
 * The production offline renderer keeps its single `OfflineAudioContext` per
 * pass and its up-front scheduler. What changes for a streamed export is only
 * how PCM enters and leaves that context:
 *
 *  - VST3 instrument PCM and already-processed VST3 Mixer-effect PCM are
 *    scheduled one bounded window ahead of the render position instead of for
 *    the whole song before `startRendering()`;
 *  - the signal in front of a VST3 Mixer effect and the finished master are read
 *    through an AudioWorklet tap in bounded chunks instead of from a full-song
 *    render target, which is why that target can be a throw-away mono buffer.
 *
 * Nothing here knows about the engine, the mixer or Electron: the engine drives
 * these pieces, and `streamedWavExport.ts` supplies the disk-backed target.
 */
import {
  assertValidVst3EffectLatencySamples,
  assertVst3Effect,
  type Vst3Bridge,
  type Vst3Effect,
} from './nativeVst3Types';

/** Frames per tap message and per VST3 effect block (the production block size). */
export const STREAM_CHUNK_FRAMES = 4096;
/** Frames rendered between two suspensions of the offline context (≈4 s at 48 kHz). */
export const STREAM_WINDOW_FRAMES = STREAM_CHUNK_FRAMES * 48;
/**
 * PCM is scheduled this far past the next suspension point, so an implementation
 * that quantizes a suspend time up to the next render quantum still finds its
 * audio already scheduled.
 */
export const STREAM_LOOKAHEAD_MARGIN_FRAMES = 256;
/** A tap that delivers nothing for this long has failed; the export stops. */
export const STREAM_TAP_TIMEOUT_MS = 30_000;
export const STREAM_TAP_PROCESSOR_NAME = 'apex-offline-stream-tap';

/** Thrown when the caller's AbortSignal stops a streamed export. */
export class StreamedExportCancelledError extends Error {
  constructor(message = 'Export cancelled.') {
    super(message);
    this.name = 'StreamedExportCancelledError';
  }
}

export const isStreamedExportCancelled = (error: unknown): boolean =>
  error instanceof StreamedExportCancelledError ||
  (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'StreamedExportCancelledError');

export function throwIfStreamedExportCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StreamedExportCancelledError();
}

/**
 * Bounded scratch PCM owned by the export target (a main-process temporary file
 * in the desktop application). Frames are interleaved stereo float32.
 */
export interface StreamedExportScratch {
  /** Frames appended so far. */
  readonly frames: number;
  append(interleaved: Float32Array): Promise<void>;
  read(frameOffset: number, frames: number): Promise<Float32Array>;
  release(): Promise<void>;
}

/** Where a streamed export puts its PCM. Implemented over the desktop export store. */
export interface StreamedExportTarget {
  createScratch(label: string): Promise<StreamedExportScratch>;
  /** Final master PCM, interleaved stereo float32, in timeline order. */
  write(interleaved: Float32Array): Promise<void>;
}

export interface StreamedExportResult {
  /** Stereo frames written to the target. */
  frames: number;
  sampleRate: number;
  /** Full renders of the production timeline (VST3 effect levels + the master pass). */
  passes: number;
  /** Suspend/resume windows across all passes. */
  windows: number;
  nativeInstruments: number;
  nativeEffects: number;
}

// The tap copies its input into fixed-size interleaved chunks and posts them.
// It emits silence, so connecting it to the destination only keeps it pulled.
// `totalFrames` lets it flush the final partial chunk without a message from
// the control thread, which a finished offline context would never deliver.
export const STREAM_TAP_WORKLET_SOURCE = `
class ApexOfflineStreamTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = (options && options.processorOptions) || {};
    this.total = Math.max(0, Math.floor(Number(config.totalFrames) || 0));
    this.chunk = Math.max(128, Math.floor(Number(config.chunkFrames) || 4096));
    this.buffer = new Float32Array(this.chunk * 2);
    this.fill = 0;
    this.seen = 0;
    this.sent = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const left = input && input[0];
    const right = input && input[1];
    const frames = Math.min(128, this.total - this.seen);
    for (let index = 0; index < frames; index += 1) {
      const offset = this.fill * 2;
      this.buffer[offset] = left ? left[index] : 0;
      this.buffer[offset + 1] = right ? right[index] : 0;
      this.fill += 1;
      if (this.fill === this.chunk) this.flush();
    }
    this.seen += frames;
    if (this.seen >= this.total && this.fill > 0) this.flush();
    return this.seen < this.total;
  }
  flush() {
    const pcm = this.buffer.slice(0, this.fill * 2);
    this.port.postMessage({ start: this.sent, frames: this.fill, pcm: pcm.buffer }, [pcm.buffer]);
    this.sent += this.fill;
    this.fill = 0;
  }
}
registerProcessor('${STREAM_TAP_PROCESSOR_NAME}', ApexOfflineStreamTap);
`;

const tapModuleLoads = new WeakMap<object, Promise<void>>();

/** Loads the tap processor into `context` once. Rejects when AudioWorklet is unavailable. */
export function ensureStreamTapModule(context: BaseAudioContext): Promise<void> {
  const cached = tapModuleLoads.get(context);
  if (cached) return cached;
  const worklet = (context as unknown as { audioWorklet?: { addModule?: (url: string) => Promise<void> } }).audioWorklet;
  const load = (async () => {
    if (!worklet || typeof worklet.addModule !== 'function' || typeof Blob === 'undefined' ||
        typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' ||
        typeof (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode !== 'function') {
      throw new Error('Streamed export requires AudioWorklet support in the offline renderer. Export stopped; nothing was written.');
    }
    const url = URL.createObjectURL(new Blob([STREAM_TAP_WORKLET_SOURCE], { type: 'application/javascript' }));
    try { await worklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  })();
  tapModuleLoads.set(context, load);
  return load;
}

/**
 * Control-thread side of one tap. Chunks are queued until the driver takes
 * them at a suspension point, so at most one render window is held per tap.
 */
export class OfflineStreamTap {
  readonly node: AudioWorkletNode;
  private readonly chunks: Float32Array[] = [];
  private queuedOffset = 0;
  private received = 0;
  private taken = 0;
  private failure: Error | null = null;
  private waiters: Array<() => void> = [];

  /**
   * `interpretation` is the up-mix rule for a mono input: `speakers` matches the
   * destination node a master render would otherwise reach, `discrete` matches
   * the channel splitter the production capture pass uses in front of an effect.
   */
  constructor(
    context: BaseAudioContext,
    readonly totalFrames: number,
    interpretation: 'speakers' | 'discrete',
    readonly label: string,
  ) {
    const NodeClass = (globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNode }).AudioWorkletNode;
    this.node = new NodeClass(context, STREAM_TAP_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: interpretation,
      processorOptions: { totalFrames, chunkFrames: STREAM_CHUNK_FRAMES },
    });
    this.node.port.onmessage = event => this.accept(event.data);
    this.node.onprocessorerror = () => this.fail(new Error(`Streamed export tap "${this.label}" failed in the audio renderer.`));
  }

  get receivedFrames(): number { return this.received; }
  get takenFrames(): number { return this.taken; }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  private accept(message: unknown): void {
    const data = message as { start?: unknown; frames?: unknown; pcm?: unknown } | null;
    const frames = data?.frames;
    if (!data || data.start !== this.received || typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 ||
        !(data.pcm instanceof ArrayBuffer) || data.pcm.byteLength !== frames * 2 * Float32Array.BYTES_PER_ELEMENT ||
        this.received + frames > this.totalFrames) {
      this.fail(new Error(`Streamed export tap "${this.label}" delivered an out-of-order or malformed PCM chunk.`));
      return;
    }
    this.chunks.push(new Float32Array(data.pcm));
    this.received += frames;
    this.wake();
  }

  /** Resolves once at least `frames` frames have arrived from the render thread. */
  async waitForFrames(frames: number, signal?: AbortSignal, timeoutMs = STREAM_TAP_TIMEOUT_MS): Promise<void> {
    const target = Math.min(frames, this.totalFrames);
    while (this.received < target) {
      if (this.failure) throw this.failure;
      throwIfStreamedExportCancelled(signal);
      const before = this.received;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      await new Promise<void>(resolve => {
        this.waiters.push(resolve);
        timer = setTimeout(resolve, timeoutMs);
        if (signal) { onAbort = () => resolve(); signal.addEventListener('abort', onAbort, { once: true }); }
      });
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      throwIfStreamedExportCancelled(signal);
      if (this.failure) throw this.failure;
      if (this.received === before && this.received < target) {
        throw new Error(`Streamed export tap "${this.label}" stalled at frame ${this.received} of ${this.totalFrames}. Export stopped; nothing was written.`);
      }
    }
    if (this.failure) throw this.failure;
  }

  /** Removes and returns the interleaved PCM for frames `[takenFrames, untilFrame)`. */
  take(untilFrame: number): Float32Array {
    const target = Math.min(untilFrame, this.received);
    const count = Math.max(0, target - this.taken);
    const output = new Float32Array(count * 2);
    let written = 0;
    while (written < count) {
      const head = this.chunks[0]!;
      const headFrames = head.length / 2 - this.queuedOffset;
      const copy = Math.min(headFrames, count - written);
      output.set(head.subarray(this.queuedOffset * 2, (this.queuedOffset + copy) * 2), written * 2);
      written += copy;
      if (copy === headFrames) { this.chunks.shift(); this.queuedOffset = 0; }
      else this.queuedOffset += copy;
    }
    this.taken += count;
    return output;
  }

  dispose(): void {
    this.node.port.onmessage = null;
    try { this.node.port.close(); } catch { /* already closed */ }
    try { this.node.disconnect(); } catch { /* already disconnected */ }
    this.chunks.length = 0;
    this.fail(new Error(`Streamed export tap "${this.label}" was disposed.`));
  }
}

/** Interleaved stereo frames `[start, start + count)` of `source`, clipped to a window of the stream. */
export function sliceInterleavedWindow(
  source: Float32Array,
  /** Stream frame index of `source[0]`. */
  sourceStartFrame: number,
  windowStartFrame: number,
  windowFrameCount: number,
): Float32Array {
  const sourceFrames = source.length / 2;
  const from = Math.max(sourceStartFrame, windowStartFrame);
  const to = Math.min(sourceStartFrame + sourceFrames, windowStartFrame + windowFrameCount);
  if (to <= from) return new Float32Array(0);
  return source.subarray((from - sourceStartFrame) * 2, (to - sourceStartFrame) * 2);
}

/**
 * One offline VST3 effect instance fed in arrival order.
 *
 * The block partition and the latency handling are the production ones
 * (`processOfflineVst3Effect`): the stream is the captured input followed by
 * `latencySamples` frames of silence, cut into 4096-frame blocks from frame
 * zero, and the first `latencySamples` output frames are dropped. The plug-in
 * therefore sees exactly the calls it sees in the full-buffer path; only the
 * place the PCM is held differs. The session stays open for the whole pass so
 * plug-in state is continuous across windows.
 */
export class StreamedVst3EffectSession {
  private readonly pendingLeft = new Float32Array(STREAM_CHUNK_FRAMES);
  private readonly pendingRight = new Float32Array(STREAM_CHUNK_FRAMES);
  private pendingFrames = 0;
  /** Frames sent to the plug-in so far. */
  private streamOffset = 0;
  private inputFrames = 0;
  private outputFrames = 0;
  private closed = false;

  private constructor(
    private readonly bridge: Vst3Bridge,
    private readonly sessionId: string,
    private readonly effectName: string,
    readonly latencySamples: number,
    private readonly bpm: number,
  ) {}

  static async open(bridge: Vst3Bridge, effect: Vst3Effect, sampleRate: number, bpm: number): Promise<StreamedVst3EffectSession> {
    assertVst3Effect(effect);
    const opened = await bridge.open(effect, sampleRate, 'offline', 'effect');
    let latencySamples: number;
    try {
      latencySamples = assertValidVst3EffectLatencySamples(opened.latencySamples, sampleRate);
    } catch (error) {
      await bridge.close(opened.id).catch(() => {});
      throw error;
    }
    return new StreamedVst3EffectSession(bridge, opened.id, effect.name, latencySamples, Math.max(20, Math.min(300, Number(bpm) || 120)));
  }

  /** Latency-compensated output frames produced so far. */
  get producedFrames(): number { return this.outputFrames; }

  private async processBlock(frames: number, parts: Float32Array[]): Promise<void> {
    const planar = new Float32Array(frames * 2);
    planar.set(this.pendingLeft.subarray(0, Math.min(frames, this.pendingFrames)), 0);
    planar.set(this.pendingRight.subarray(0, Math.min(frames, this.pendingFrames)), frames);
    const blockStart = this.streamOffset;
    const processed = await this.bridge.processAudio(this.sessionId, frames, planar, this.bpm);
    if (!(processed instanceof Float32Array) || processed.length !== frames * 2 || processed.some(sample => !Number.isFinite(sample))) {
      throw new Error(`VST3 effect ${this.effectName} returned malformed/non-finite PCM at frame ${blockStart}. Export stopped.`);
    }
    this.streamOffset += frames;
    this.pendingFrames = 0;
    const keepStart = Math.max(blockStart, this.latencySamples);
    const keepEnd = Math.min(blockStart + frames, this.latencySamples + this.inputFrames);
    if (keepEnd <= keepStart) return;
    const sourceOffset = keepStart - blockStart;
    const count = keepEnd - keepStart;
    const interleaved = new Float32Array(count * 2);
    for (let index = 0; index < count; index += 1) {
      interleaved[index * 2] = processed[sourceOffset + index]!;
      interleaved[index * 2 + 1] = processed[frames + sourceOffset + index]!;
    }
    this.outputFrames += count;
    parts.push(interleaved);
  }

  /** Feeds captured interleaved stereo input; returns the output that became available. */
  async push(interleaved: Float32Array): Promise<Float32Array> {
    if (this.closed) throw new Error(`VST3 effect ${this.effectName} session is closed.`);
    const parts: Float32Array[] = [];
    const frames = interleaved.length / 2;
    let consumed = 0;
    while (consumed < frames) {
      const copy = Math.min(STREAM_CHUNK_FRAMES - this.pendingFrames, frames - consumed);
      for (let index = 0; index < copy; index += 1) {
        this.pendingLeft[this.pendingFrames + index] = interleaved[(consumed + index) * 2]!;
        this.pendingRight[this.pendingFrames + index] = interleaved[(consumed + index) * 2 + 1]!;
      }
      this.pendingFrames += copy;
      this.inputFrames += copy;
      consumed += copy;
      if (this.pendingFrames === STREAM_CHUNK_FRAMES) await this.processBlock(STREAM_CHUNK_FRAMES, parts);
    }
    return concatFloat32(parts);
  }

  /** Flushes the final partial block and the plug-in's latency; returns the remaining output. */
  async finish(): Promise<Float32Array> {
    if (this.closed) throw new Error(`VST3 effect ${this.effectName} session is closed.`);
    const parts: Float32Array[] = [];
    const totalStreamFrames = this.inputFrames + this.latencySamples;
    while (this.streamOffset < totalStreamFrames) {
      const frames = Math.min(STREAM_CHUNK_FRAMES, totalStreamFrames - this.streamOffset);
      // `pendingFrames` real frames lead the block; the rest is the silence the
      // production path feeds while it drains the plug-in's latency.
      await this.processBlock(frames, parts);
    }
    return concatFloat32(parts);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.bridge.close(this.sessionId);
  }
}

export function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]!;
  let length = 0;
  for (const part of parts) length += part.length;
  const output = new Float32Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

/**
 * Assigns every enabled VST3 Mixer effect to the render pass that captures its
 * input. A slot is captured one pass after the deepest VST3 effect upstream of
 * it, so independent tracks share a pass and the pass count is the longest
 * serial chain plus the master pass, not the effect count plus one.
 *
 * `tracks` must be ordered upstream-first (the production
 * `orderMixerTracksUpstreamFirst` order) and list each track's enabled VST3
 * slots in insert order; `edges` are the audio edges between tracks (routing
 * and aux sends). With `sequential` the plan is the historic one-slot-per-pass
 * order, which is required whenever a coupling that is not an audio edge
 * (level-detected sidechain) can make one track's level depend on another's.
 */
export function planNativeEffectLevels(
  tracks: ReadonlyArray<{ id: number; slotIds: readonly string[] }>,
  edges: ReadonlyArray<{ sourceTrackId: number; targetTrackId: number }>,
  sequential: boolean,
): Array<{ trackId: number; slotId: string; level: number }> {
  const plan: Array<{ trackId: number; slotId: string; level: number }> = [];
  if (sequential) {
    for (const track of tracks) for (const slotId of track.slotIds) plan.push({ trackId: track.id, slotId, level: plan.length + 1 });
    return plan;
  }
  const upstream = new Map<number, number[]>();
  for (const edge of edges) {
    const list = upstream.get(edge.targetTrackId) ?? [];
    list.push(edge.sourceTrackId);
    upstream.set(edge.targetTrackId, list);
  }
  const outputLevel = new Map<number, number>();
  for (const track of tracks) {
    let level = 0;
    for (const sourceId of upstream.get(track.id) ?? []) {
      const sourceLevel = outputLevel.get(sourceId);
      // A source that is not ordered before its target would break the
      // "everything upstream is already processed" guarantee.
      if (sourceLevel === undefined) {
        if (tracks.some(candidate => candidate.id === sourceId)) {
          throw new Error('Streamed VST3 export requires an upstream-first Mixer track order.');
        }
        continue;
      }
      level = Math.max(level, sourceLevel);
    }
    for (const slotId of track.slotIds) {
      level += 1;
      plan.push({ trackId: track.id, slotId, level });
    }
    outputLevel.set(track.id, level);
  }
  return plan;
}

const TAIL_SILENCE_THRESHOLD = 1e-4;
const TAIL_TRIM_MARGIN_FRAMES = 512;

/**
 * Streams the content window of a master render to the target and applies the
 * Song-export tail rule (`resolveOfflineTailFrameCount`) without holding the
 * song: the song window is written through as it arrives, only the bounded
 * tail region is kept until the last audible frame is known.
 */
export class StreamedContentWriter {
  private position = 0;
  private lastAudibleFrame = -1;
  private readonly tail: Float32Array;
  private tailFrames = 0;
  private finished = false;

  constructor(
    private readonly write: (interleaved: Float32Array) => Promise<void>,
    readonly songFrameCount: number,
    readonly tailFrameCount: number,
  ) {
    this.tail = new Float32Array(Math.max(0, tailFrameCount) * 2);
  }

  /** Content frames accepted so far (song window plus tail region). */
  get acceptedFrames(): number { return this.position; }

  async push(interleaved: Float32Array): Promise<void> {
    if (this.finished) throw new Error('Streamed export content was already finalized.');
    const capacity = this.songFrameCount + this.tailFrameCount - this.position;
    const frames = Math.min(interleaved.length / 2, capacity);
    if (frames <= 0) return;
    const scanTail = this.tailFrameCount > 0;
    if (scanTail) {
      for (let index = frames - 1; index >= 0; index -= 1) {
        if (Math.abs(interleaved[index * 2]!) > TAIL_SILENCE_THRESHOLD || Math.abs(interleaved[index * 2 + 1]!) > TAIL_SILENCE_THRESHOLD) {
          this.lastAudibleFrame = this.position + index;
          break;
        }
      }
    }
    const songFrames = Math.max(0, Math.min(frames, this.songFrameCount - this.position));
    if (songFrames > 0) await this.write(interleaved.subarray(0, songFrames * 2));
    if (frames > songFrames) {
      const tailPart = interleaved.subarray(songFrames * 2, frames * 2);
      this.tail.set(tailPart, this.tailFrames * 2);
      this.tailFrames += frames - songFrames;
    }
    this.position += frames;
  }

  /** Writes the kept part of the tail and returns the final frame count. */
  async finish(): Promise<number> {
    if (this.finished) throw new Error('Streamed export content was already finalized.');
    this.finished = true;
    const finalFrames = this.tailFrameCount > 0 && this.lastAudibleFrame >= 0
      ? Math.min(this.songFrameCount + this.tailFrameCount,
          Math.max(this.songFrameCount, this.lastAudibleFrame + 1 + TAIL_TRIM_MARGIN_FRAMES))
      : this.songFrameCount;
    // A render that ran out of frames (a fallback with less latency than was
    // reserved) is padded with silence rather than reported shorter.
    if (this.position < this.songFrameCount) {
      let missing = this.songFrameCount - this.position;
      const silence = new Float32Array(Math.min(missing, STREAM_CHUNK_FRAMES) * 2);
      while (missing > 0) {
        const frames = Math.min(missing, silence.length / 2);
        await this.write(silence.subarray(0, frames * 2));
        missing -= frames;
      }
    }
    const keptTailFrames = finalFrames - this.songFrameCount;
    if (keptTailFrames > 0) {
      const kept = new Float32Array(keptTailFrames * 2);
      kept.set(this.tail.subarray(0, Math.min(keptTailFrames, this.tailFrames) * 2));
      await this.write(kept);
    }
    return finalFrames;
  }
}

/** Stereo AudioBuffer for interleaved float32 frames. */
export function interleavedToAudioBuffer(context: BaseAudioContext, interleaved: Float32Array): AudioBuffer {
  const frames = interleaved.length / 2;
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let index = 0; index < frames; index += 1) {
    left[index] = interleaved[index * 2]!;
    right[index] = interleaved[index * 2 + 1]!;
  }
  return buffer;
}
