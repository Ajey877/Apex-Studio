import { persistAudioClip, deletePersistedAudioClip as deletePersistedAudioClipFromStore } from './audioPersistence';
import { installAudioPlaybackLifecycle } from './audioPlaybackLifecycle';
import { sessionBlobUrlRegistry } from '../state/sessionBlobUrlRegistry';
import {
  AudioDeviceManager,
  audioDeviceManager,
  hasActiveRecordingSession,
  registerActiveRecordingSession,
} from './audioDeviceManager';
import {
  RECORDING_CAPTURE_PACKET_FRAMES,
  RECORDING_CAPTURE_PROCESSOR,
  RECORDING_CAPTURE_PREROLL_SECONDS,
  RECORDING_CAPTURE_WORKLET_SOURCE,
} from './recordingCaptureWorklet';
import {
  assembleRecordingPcm,
  buildRecordingWaveform,
  encodeFloat32PcmWav,
  trimRecordingPreRoll,
  type RecordingPauseInterval,
  type RecordingPcmBlock,
} from './recordingPcm';

installAudioPlaybackLifecycle();

export interface RecordingResult {
  id: string;
  name: string;
  timestamp: number;
  durationSeconds: number;
  blob: Blob;
  url: string;
  waveform: number[];
  mimeType: string;
  /** Exact AudioContext frame selected as sample zero of the saved WAV. */
  captureStartFrame: number;
  /** Exact exclusive AudioContext frame selected as the end of the saved WAV. */
  captureEndFrame: number;
  /** AudioContext sample rate used by the capture worklet and WAV container. */
  sampleRate: number;
  /** Number of output frames after any explicitly paused sections are omitted. */
  capturedFrames: number;
}

export type RecordingState = 'idle' | 'preparing' | 'prepared' | 'recording' | 'paused' | 'stopping';

export class RecordingCancelledError extends Error {
  constructor(message = 'Audio recording was cancelled') {
    super(message);
    this.name = 'RecordingCancelledError';
  }
}

/** Structural surface shared by the browser AudioWorkletNode and deterministic tests. */
export interface RecordingCapturePortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close?: () => void;
}

export interface RecordingCaptureNodeLike {
  port: RecordingCapturePortLike;
  onprocessorerror: ((event: Event) => void) | null;
  connect(destination: AudioNode): AudioNode;
  disconnect(): void;
}

export interface RecordingEngineOptions {
  waveformSamples?: number;
  onError?: (error: Error) => void;
  persistAudioClip?: (id: string, blob: Blob) => Promise<void>;
  deletePersistedAudioClip?: (id: string) => Promise<void>;
  deviceManager?: AudioDeviceManager;
  inputDeviceId?: string;
  /** Dependency seams used by deterministic tests; production defaults use browser APIs. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createInputSource?: (context: AudioContext, stream: MediaStream) => Pick<AudioNode, 'connect' | 'disconnect'>;
  createCaptureNode?: (context: AudioContext, processorName: string, options: AudioWorkletNodeOptions) => RecordingCaptureNodeLike;
  loadCaptureModule?: (context: AudioContext) => Promise<void>;
}

export const hasActiveRecordingEngineSession = (): boolean => hasActiveRecordingSession();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const captureModules = new WeakMap<BaseAudioContext, Promise<void>>();

const loadRecordingCaptureModule = async (context: AudioContext): Promise<void> => {
  const worklet = context.audioWorklet;
  if (!worklet || typeof worklet.addModule !== 'function' || typeof AudioWorkletNode === 'undefined') {
    throw new Error('This environment does not support sample-aligned AudioWorklet microphone capture.');
  }
  let load = captureModules.get(context);
  if (!load) {
    load = (async () => {
      const url = URL.createObjectURL(new Blob([RECORDING_CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await worklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    captureModules.set(context, load);
    void load.catch(() => {
      if (captureModules.get(context) === load) captureModules.delete(context);
    });
  }
  await load;
};

const isCaptureSamples = (value: unknown): value is Float32Array =>
  typeof value === 'object' && value !== null && ArrayBuffer.isView(value) &&
  Object.prototype.toString.call(value) === '[object Float32Array]';

const errorFrom = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(fallback);

export class RecordingEngine {
  private stream: MediaStream | null = null;
  private detachStreamMonitor: (() => void) | null = null;
  private releaseActiveSessionToken: (() => void) | null = null;
  private detachContextStateListener: (() => void) | null = null;
  private inputSource: Pick<AudioNode, 'connect' | 'disconnect'> | null = null;
  private captureNode: RecordingCaptureNodeLike | null = null;
  private silentSink: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private context: AudioContext | null = null;
  private state: RecordingState = 'idle';
  private starting = false;
  private generation = 0;
  private cancelledGeneration: number | null = null;
  private preparationPromise: Promise<MediaStream> | null = null;
  private preparationAbort: Deferred<never> | null = null;
  private readyDeferred: Deferred<void> | null = null;
  private primedDeferred: Deferred<void> | null = null;
  private armDeferred: Deferred<void> | null = null;
  private finalizationPromise: Promise<RecordingResult> | null = null;
  /** The async assembly/persistence work continues after a caller cancels stop; track it so cancel/dispose can await orphan cleanup. */
  private finalizationWork: Promise<void> | null = null;
  private finalizationResolve: ((result: RecordingResult) => void) | null = null;
  private finalizationReject: ((error: unknown) => void) | null = null;
  private preRollBlocks: RecordingPcmBlock[] = [];
  private captureBlocks: RecordingPcmBlock[] = [];
  private pauseIntervals: RecordingPauseInterval[] = [];
  private captureStartFrame: number | null = null;
  private captureStopFrame: number | null = null;
  private captureSampleRate = 0;
  private inputChannelCount = 0;
  private captureChannelCount: number | null = null;
  private preservePausedTimeline = false;
  private readonly waveformSamples: number;
  private readonly onError?: (error: Error) => void;
  private readonly persistAudioClip: (id: string, blob: Blob) => Promise<void>;
  private readonly deletePersistedAudioClip: (id: string) => Promise<void>;
  private readonly getUserMediaOverride?: RecordingEngineOptions['getUserMedia'];
  private readonly createInputSourceOverride?: RecordingEngineOptions['createInputSource'];
  private readonly createCaptureNodeOverride?: RecordingEngineOptions['createCaptureNode'];
  private readonly loadCaptureModuleOverride?: RecordingEngineOptions['loadCaptureModule'];
  private readonly deviceManager: AudioDeviceManager;
  private readonly explicitInputDeviceId?: string;

  constructor(private readonly contextProvider: () => AudioContext, options: RecordingEngineOptions = {}) {
    this.waveformSamples = Math.max(32, Math.min(2048, Math.floor(options.waveformSamples ?? 512)));
    this.onError = options.onError;
    this.persistAudioClip = options.persistAudioClip ?? persistAudioClip;
    this.deletePersistedAudioClip = options.deletePersistedAudioClip ?? deletePersistedAudioClipFromStore;
    this.deviceManager = options.deviceManager ?? audioDeviceManager;
    this.explicitInputDeviceId = options.inputDeviceId;
    this.getUserMediaOverride = options.getUserMedia;
    this.createInputSourceOverride = options.createInputSource;
    this.createCaptureNodeOverride = options.createCaptureNode;
    this.loadCaptureModuleOverride = options.loadCaptureModule;
  }

  getState(): RecordingState { return this.state; }
  getMimeType(): string { return this.state === 'idle' ? '' : 'audio/wav'; }
  isBusy(): boolean { return this.starting || this.state !== 'idle' || this.finalizationPromise !== null; }

  /**
   * Duration is measured on the AudioContext frame clock, not performance.now().
   * Ordinary pause/resume excludes paused frames just as the former recorder did.
   */
  getDurationSeconds(): number {
    if (this.captureStartFrame === null || this.captureSampleRate <= 0) return 0;
    const context = this.context;
    const contextFrame = context ? Math.round(context.currentTime * this.captureSampleRate) : this.captureStartFrame;
    let endFrame = this.captureStopFrame ?? contextFrame;
    if (this.state === 'paused') {
      const openPause = [...this.pauseIntervals].reverse().find(interval => interval.endFrame === null);
      if (openPause) endFrame = Math.min(endFrame, openPause.startFrame);
    }
    endFrame = Math.max(this.captureStartFrame, endFrame);
    let pausedFrames = 0;
    if (!this.preservePausedTimeline) {
      for (const interval of this.pauseIntervals) {
        const pauseEnd = interval.endFrame ?? endFrame;
        pausedFrames += Math.max(0, Math.min(endFrame, pauseEnd) - Math.max(this.captureStartFrame, interval.startFrame));
      }
    }
    return Math.max(0, endFrame - this.captureStartFrame - pausedFrames) / this.captureSampleRate;
  }

  /**
   * Opens and primes the input graph BEFORE a count-in or punch boundary is
   * scheduled. The worklet continuously sends frame-stamped PCM while prepared;
   * `start()` can therefore select a boundary even if its JS callback arrives
   * late, using the bounded pre-roll retained here.
   */
  prepare(): Promise<MediaStream> {
    if (this.state === 'prepared' && this.stream) return Promise.resolve(this.stream);
    if (this.starting && this.preparationPromise) return this.preparationPromise;
    if (this.state !== 'idle' || this.finalizationPromise) {
      return Promise.reject(new Error(`Cannot prepare recording while state is ${this.state}`));
    }
    if (!this.getUserMediaOverride && (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)) {
      return Promise.reject(new Error('Microphone capture is not supported in this environment'));
    }

    const generation = ++this.generation;
    this.cancelledGeneration = null;
    this.starting = true;
    this.state = 'preparing';
    this.releaseActiveSessionToken = registerActiveRecordingSession();
    this.preRollBlocks = [];
    this.captureBlocks = [];
    this.captureStartFrame = null;
    this.captureStopFrame = null;
    this.captureChannelCount = null;
    this.inputChannelCount = 0;

    const abort = deferred<never>();
    this.preparationAbort = abort;
    this.preparationPromise = this.prepareSession(generation, abort);
    return this.preparationPromise;
  }

  private async prepareSession(generation: number, abort: Deferred<never>): Promise<MediaStream> {
    try {
      const requestedDeviceId = this.explicitInputDeviceId !== undefined
        ? this.explicitInputDeviceId
        : this.deviceManager.getPreferredInputDeviceId();
      const constraints = this.deviceManager.buildRecordingConstraints(requestedDeviceId);
      const getUserMedia = this.getUserMediaOverride ?? ((value: MediaStreamConstraints) =>
        navigator.mediaDevices.getUserMedia(value));
      const request = getUserMedia(constraints);
      // A getUserMedia permission prompt cannot be aborted by the web platform.
      // If it resolves after cancellation, this continuation still stops the late stream.
      void request.then(stream => {
        if (this.isGenerationCancelled(generation)) this.stopStream(stream);
      }, () => undefined);
      let stream: MediaStream;
      try {
        stream = await Promise.race([request, abort.promise]);
      } catch (error) {
        if (this.isGenerationCancelled(generation)) throw new RecordingCancelledError();
        throw this.deviceManager.translateAndRecordCaptureFailure(error, requestedDeviceId);
      }
      if (this.isGenerationCancelled(generation)) {
        this.stopStream(stream);
        throw new RecordingCancelledError();
      }
      this.stream = stream;
      this.detachStreamMonitor = this.deviceManager.monitorActiveCaptureStream(stream, error => {
        this.failActive(error, generation);
      });

      const context = this.contextProvider();
      this.context = context;
      if (context.state === 'closed') throw new Error('The audio context is closed; reopen audio before recording.');
      if (context.state !== 'running') {
        await Promise.race([context.resume(), abort.promise]);
      }
      if (this.isGenerationCancelled(generation)) throw new RecordingCancelledError();
      if (context.state !== 'running') {
        throw new Error('The audio context remained suspended. Resume audio and try recording again.');
      }
      if (!Number.isFinite(context.sampleRate) || context.sampleRate <= 0) {
        throw new Error('The audio context has no valid sample rate for microphone capture.');
      }
      this.captureSampleRate = context.sampleRate;

      if (this.createCaptureNodeOverride) {
        // The test factory compiles the same production worklet source in a deterministic host.
      } else if (this.loadCaptureModuleOverride) {
        await Promise.race([this.loadCaptureModuleOverride(context), abort.promise]);
      } else {
        await Promise.race([loadRecordingCaptureModule(context), abort.promise]);
      }
      if (this.isGenerationCancelled(generation)) throw new RecordingCancelledError();

      const source = this.createInputSourceOverride
        ? this.createInputSourceOverride(context, stream)
        : context.createMediaStreamSource(stream);
      this.inputSource = source;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      this.analyser = analyser;
      const processorOptions: AudioWorkletNodeOptions = {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'max',
        channelInterpretation: 'discrete',
        processorOptions: { packetFrames: RECORDING_CAPTURE_PACKET_FRAMES },
      };
      const captureNode = this.createCaptureNodeOverride
        ? this.createCaptureNodeOverride(context, RECORDING_CAPTURE_PROCESSOR, processorOptions)
        : new AudioWorkletNode(context, RECORDING_CAPTURE_PROCESSOR, processorOptions);
      this.captureNode = captureNode;
      const silentSink = context.createGain();
      silentSink.gain.value = 0;
      this.silentSink = silentSink;

      const ready = deferred<void>();
      const primed = deferred<void>();
      this.readyDeferred = ready;
      this.primedDeferred = primed;
      captureNode.port.onmessage = event => this.handleCaptureMessage(event.data, generation);
      captureNode.onprocessorerror = () => this.failActive(
        new Error('The microphone AudioWorklet processor failed; the take was discarded.'),
        generation,
      );
      const onContextStateChange = () => {
        if (generation !== this.generation || this.state === 'idle') return;
        if (context.state !== 'running') {
          this.failActive(new Error('The audio context was interrupted; recording was cancelled to avoid a timing gap.'), generation);
        }
      };
      context.addEventListener?.('statechange', onContextStateChange);
      this.detachContextStateListener = () => context.removeEventListener?.('statechange', onContextStateChange);

      source.connect(captureNode as unknown as AudioNode);
      source.connect(analyser);
      captureNode.connect(silentSink);
      silentSink.connect(context.destination);

      await Promise.race([ready.promise, abort.promise]);
      await Promise.race([primed.promise, abort.promise]);
      if (this.isGenerationCancelled(generation)) throw new RecordingCancelledError();
      if (context.state !== 'running') {
        throw new Error('The audio context stopped while the microphone input was being prepared.');
      }
      this.deviceManager.notifyInputCaptureSucceeded(stream);
      this.state = 'prepared';
      this.starting = false;
      this.preparationAbort = null;
      this.preparationPromise = null;
      return stream;
    } catch (error) {
      const normalized = errorFrom(error, 'Unable to prepare microphone capture');
      if (generation === this.generation && this.state !== 'idle') {
        this.releaseCaptureResources();
        this.state = 'idle';
        this.starting = false;
        this.preparationAbort = null;
        this.preparationPromise = null;
      }
      throw normalized;
    }
  }

  /**
   * Arms capture at an AudioContext time. If called late, `startTime` is still
   * honored by selecting the retained frame-stamped pre-roll rather than
   * beginning at callback time. Calling without a time starts at the current
   * audio-clock frame after preparation.
   */
  async start(
    startTime?: number,
    options: { preserveTimelineWhilePaused?: boolean } = {},
  ): Promise<MediaStream> {
    if (this.state === 'idle') await this.prepare();
    else if (this.state === 'preparing' && this.preparationPromise) await this.preparationPromise;
    if (this.state !== 'prepared' || !this.stream || !this.context || !this.captureNode) {
      throw new Error(`Cannot start recording while state is ${this.state}`);
    }
    if (this.finalizationPromise) throw new Error('A previous recording is still finalizing.');
    if (this.context.state !== 'running') throw new Error('The audio context is not running; the capture boundary cannot be trusted.');

    const captureTime = startTime ?? this.context.currentTime;
    const startFrame = this.frameAtTime(captureTime, this.captureSampleRate);
    const nowFrame = this.frameAtTime(this.context.currentTime, this.captureSampleRate);
    const oldestRetainedFrame = nowFrame - Math.ceil(RECORDING_CAPTURE_PREROLL_SECONDS * this.captureSampleRate);
    if (startFrame < oldestRetainedFrame) {
      throw new Error('The planned capture point is older than the retained microphone pre-roll; no misaligned take was saved.');
    }

    this.captureStartFrame = startFrame;
    this.captureStopFrame = null;
    this.captureBlocks = [];
    this.captureChannelCount = null;
    this.pauseIntervals = [];
    this.preservePausedTimeline = options.preserveTimelineWhilePaused ?? false;
    this.state = 'recording';

    const buffered = this.preRollBlocks;
    this.preRollBlocks = [];
    for (const block of buffered) this.collectCaptureBlock(block);
    if (this.state !== 'recording' || !this.captureNode) {
      throw new RecordingCancelledError('The recording input changed while the capture boundary was being armed.');
    }

    const generation = this.generation;
    const armed = deferred<void>();
    this.armDeferred = armed;
    try {
      this.captureNode.port.postMessage({ type: 'start', sessionId: generation, startFrame });
    } catch (error) {
      this.failActive(errorFrom(error, 'Unable to arm microphone capture'), generation);
      throw error;
    }
    try {
      await armed.promise;
    } catch (error) {
      throw errorFrom(error, 'Unable to arm the microphone capture worklet');
    }
    if (this.isGenerationCancelled(generation)) throw new RecordingCancelledError();
    return this.stream;
  }

  pause(): void {
    if (this.state !== 'recording' || this.captureStartFrame === null || !this.captureNode || !this.context) return;
    const frame = this.frameAtTime(this.context.currentTime, this.captureSampleRate);
    this.pauseIntervals.push({ startFrame: Math.max(this.captureStartFrame, frame), endFrame: null });
    this.state = 'paused';
    try {
      this.captureNode.port.postMessage({ type: 'pause', sessionId: this.generation, frame });
    } catch (error) {
      this.failActive(errorFrom(error, 'Unable to pause microphone capture'), this.generation);
    }
  }

  resume(): void {
    if (this.state !== 'paused' || !this.captureNode || !this.context) return;
    const frame = this.frameAtTime(this.context.currentTime, this.captureSampleRate);
    const openPause = [...this.pauseIntervals].reverse().find(interval => interval.endFrame === null);
    if (openPause) (openPause as { startFrame: number; endFrame: number | null }).endFrame = Math.max(openPause.startFrame, frame);
    this.state = 'recording';
    try {
      this.captureNode.port.postMessage({ type: 'resume', sessionId: this.generation, frame });
    } catch (error) {
      this.failActive(errorFrom(error, 'Unable to resume microphone capture'), this.generation);
    }
  }

  getPeak(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
    return peak;
  }

  /** Stops at the supplied AudioContext time (or the current frame when omitted). */
  stop(stopTime?: number): Promise<RecordingResult> {
    if (this.finalizationPromise) return this.finalizationPromise;
    if ((this.state !== 'recording' && this.state !== 'paused') || !this.context || !this.captureNode || this.captureStartFrame === null) {
      throw new Error('No active recording');
    }
    if (this.context.state !== 'running') throw new Error('The audio context was interrupted before the recording could be finalized.');
    const stopFrame = this.frameAtTime(stopTime ?? this.context.currentTime, this.captureSampleRate);
    if (stopFrame < this.captureStartFrame) throw new Error('The recording stop boundary precedes its capture start.');
    this.captureStopFrame = stopFrame;
    const openPause = [...this.pauseIntervals].reverse().find(interval => interval.endFrame === null);
    if (openPause) (openPause as { startFrame: number; endFrame: number | null }).endFrame = Math.max(openPause.startFrame, stopFrame);
    this.state = 'stopping';

    this.finalizationPromise = new Promise<RecordingResult>((resolve, reject) => {
      this.finalizationResolve = resolve;
      this.finalizationReject = reject;
    });
    const completion = this.finalizationPromise;
    try {
      this.captureNode.port.postMessage({ type: 'stop', sessionId: this.generation, stopFrame });
    } catch (error) {
      this.failActive(errorFrom(error, 'Unable to stop microphone capture'), this.generation);
    }
    return completion;
  }

  cancel(): Promise<void> {
    if (this.state === 'idle' && !this.starting && !this.finalizationPromise) {
      this.releaseCaptureResources();
      return Promise.resolve();
    }
    const generation = this.generation;
    this.cancelledGeneration = generation;
    const error = new RecordingCancelledError();
    const pendingFinalization = this.finalizationPromise;
    const pendingFinalizationWork = this.finalizationWork;
    const pendingPreparation = this.preparationAbort;
    try { this.captureNode?.port.postMessage({ type: 'cancel', sessionId: generation }); } catch (_) { /* best effort */ }
    pendingPreparation?.reject(error);
    this.releaseCaptureResources();
    this.state = 'idle';
    this.starting = false;
    if (pendingFinalization) this.settleFinalizationError(error);
    else if (this.armDeferred) {
      this.armDeferred.reject(error);
      this.armDeferred = null;
    }
    if (pendingFinalization) {
      const settled = pendingFinalization.then(() => undefined, () => undefined);
      return settled.then(async () => {
        // The public stop promise is rejected immediately, but cancellation is
        // not complete until in-flight persistence has deleted any late asset.
        await pendingFinalizationWork?.catch(() => undefined);
        throw error;
      });
    }
    return Promise.reject(error);
  }

  async dispose(): Promise<void> {
    if (this.state !== 'idle' || this.starting || this.finalizationPromise) {
      try { await this.cancel(); } catch (_) { /* disposal is an expected cancellation */ }
    } else {
      this.releaseCaptureResources();
    }
    await this.finalizationPromise?.then(() => undefined, () => undefined);
    await this.finalizationWork?.catch(() => undefined);
  }

  private handleCaptureMessage(message: unknown, generation: number): void {
    if (generation !== this.generation || !message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    if (value.type === 'ready') {
      if (typeof value.sampleRate === 'number' && Math.abs(value.sampleRate - this.captureSampleRate) > 0.5) {
        this.failActive(new Error('The capture worklet sample rate does not match the audio context.'), generation);
      } else {
        this.readyDeferred?.resolve();
      }
      return;
    }
    if (value.type === 'samples') {
      this.handlePcmBlock(value, generation);
      return;
    }
    if (value.type === 'started') {
      if (value.sessionId === generation) {
        this.armDeferred?.resolve();
        this.armDeferred = null;
      }
      return;
    }
    if (value.type === 'stopped') {
      if (value.sessionId !== generation || !this.finalizationPromise) return;
      if (value.stopFrame !== this.captureStopFrame) {
        this.failActive(new Error('The capture worklet stopped at an unexpected audio frame.'), generation);
        return;
      }
      const channels = Number(value.channelCount);
      if (Number.isSafeInteger(channels) && channels > 0) this.inputChannelCount = channels;
      const work = this.finishCapture(generation);
      this.finalizationWork = work;
      void work.then(
        () => { if (this.finalizationWork === work) this.finalizationWork = null; },
        () => { if (this.finalizationWork === work) this.finalizationWork = null; },
      );
      return;
    }
    if (value.type === 'failure') {
      this.failActive(new Error(typeof value.message === 'string' ? value.message : 'The microphone capture worklet failed.'), generation);
    }
  }

  private handlePcmBlock(value: Record<string, unknown>, generation: number): void {
    if (generation !== this.generation) return;
    const frameStart = value.frameStart;
    const frameCount = value.frameCount;
    const channelCount = value.channelCount;
    const samples = value.samples;
    if (!Number.isSafeInteger(frameStart) || (frameStart as number) < 0 ||
        !Number.isSafeInteger(frameCount) || (frameCount as number) <= 0 ||
        !Number.isSafeInteger(channelCount) || (channelCount as number) <= 0 ||
        !isCaptureSamples(samples) || samples.length !== (frameCount as number) * (channelCount as number)) {
      this.failActive(new Error('The microphone capture worklet returned a malformed PCM block.'), generation);
      return;
    }
    const block: RecordingPcmBlock = {
      frameStart: frameStart as number,
      frameCount: frameCount as number,
      channelCount: channelCount as number,
      samples,
    };
    this.inputChannelCount = block.channelCount;

    if (this.state === 'preparing' || this.state === 'prepared') {
      this.preRollBlocks.push(block);
      trimRecordingPreRoll(this.preRollBlocks, block.frameStart + block.frameCount, this.captureSampleRate);
      this.primedDeferred?.resolve();
      return;
    }
    if (this.state === 'recording' || this.state === 'paused' || this.state === 'stopping') {
      this.collectCaptureBlock(block);
    }
  }

  private collectCaptureBlock(block: RecordingPcmBlock): void {
    const startFrame = this.captureStartFrame;
    if (startFrame === null) return;
    const stopFrame = this.captureStopFrame ?? Number.POSITIVE_INFINITY;
    const selectedStart = Math.max(startFrame, block.frameStart);
    const selectedEnd = Math.min(stopFrame, block.frameStart + block.frameCount);
    if (selectedEnd <= selectedStart) return;
    if (this.captureChannelCount !== null && this.captureChannelCount !== block.channelCount) {
      this.failActive(new Error('The input channel layout changed during recording; the take was discarded.'), this.generation);
      return;
    }
    this.captureChannelCount = block.channelCount;
    const offsetFrames = selectedStart - block.frameStart;
    const selectedFrames = selectedEnd - selectedStart;
    this.captureBlocks.push({
      frameStart: selectedStart,
      frameCount: selectedFrames,
      channelCount: block.channelCount,
      samples: block.samples.subarray(offsetFrames * block.channelCount, (offsetFrames + selectedFrames) * block.channelCount),
    });
  }

  private async finishCapture(generation: number): Promise<void> {
    if (generation !== this.generation || !this.finalizationPromise || this.captureStartFrame === null || this.captureStopFrame === null) return;
    const startFrame = this.captureStartFrame;
    const stopFrame = this.captureStopFrame;
    const sampleRate = this.captureSampleRate;
    const blocks = [...this.captureBlocks];
    const pauses = this.pauseIntervals.map(interval => ({ ...interval }));
    const fallbackChannelCount = this.captureChannelCount ?? this.inputChannelCount;
    const persistedId = `recording-rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let assetPersisted = false;

    try {
      const assembled = assembleRecordingPcm({
        blocks,
        startFrame,
        stopFrame,
        pauseIntervals: pauses,
        preservePausedTimeline: this.preservePausedTimeline,
        fallbackChannelCount,
      });
      if (assembled.frameCount <= 0) throw new Error('The recording contains no captured audio frames.');
      const blob = encodeFloat32PcmWav(assembled.chunks, assembled.channelCount, sampleRate);
      if (!blob.size) throw new Error('Audio recording produced no data.');
      const waveform = buildRecordingWaveform(assembled.chunks, assembled.channelCount, assembled.frameCount, this.waveformSamples);
      const id = persistedId.slice('recording-'.length);
      if (this.isGenerationCancelled(generation)) throw new RecordingCancelledError();
      await this.persistAudioClip(persistedId, blob);
      assetPersisted = true;
      if (this.isGenerationCancelled(generation)) {
        // Let the catch path remove a committed asset before cancellation settles.
        throw new RecordingCancelledError();
      }
      const url = URL.createObjectURL(blob);
      sessionBlobUrlRegistry.retain(url);
      const result: RecordingResult = {
        id,
        name: `Audio Take ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
        timestamp: Date.now(),
        durationSeconds: assembled.frameCount / sampleRate,
        blob,
        url,
        waveform,
        mimeType: blob.type || 'audio/wav',
        captureStartFrame: startFrame,
        captureEndFrame: stopFrame,
        sampleRate,
        capturedFrames: assembled.frameCount,
      };
      if (generation !== this.generation) {
        sessionBlobUrlRegistry.release(url);
        await this.deletePersistedAudioClip(persistedId).catch(() => undefined);
        assetPersisted = false;
        return;
      }
      this.releaseCaptureResources();
      this.state = 'idle';
      this.settleFinalizationSuccess(result);
    } catch (error) {
      if (assetPersisted || this.isGenerationCancelled(generation)) {
        await this.deletePersistedAudioClip(persistedId).catch(() => undefined);
        assetPersisted = false;
      }
      if (generation === this.generation) {
        this.releaseCaptureResources();
        this.state = 'idle';
        this.settleFinalizationError(error);
        if (!(error instanceof RecordingCancelledError)) this.notifyError(errorFrom(error, 'Audio recording failed'));
      }
    }
  }

  private failActive(error: Error, generation: number): void {
    if (generation !== this.generation || this.state === 'idle') return;
    this.cancelledGeneration = generation;
    const preparationAbort = this.preparationAbort;
    const arm = this.armDeferred;
    this.releaseCaptureResources();
    this.state = 'idle';
    this.starting = false;
    preparationAbort?.reject(error);
    arm?.reject(error);
    this.armDeferred = null;
    if (this.finalizationPromise) this.settleFinalizationError(error);
    this.notifyError(error);
  }

  private settleFinalizationSuccess(result: RecordingResult): void {
    const resolve = this.finalizationResolve;
    if (!resolve) return;
    this.finalizationResolve = null;
    this.finalizationReject = null;
    this.finalizationPromise = null;
    resolve(result);
  }

  private settleFinalizationError(error: unknown): void {
    const reject = this.finalizationReject;
    if (!reject) return;
    this.finalizationResolve = null;
    this.finalizationReject = null;
    this.finalizationPromise = null;
    reject(error);
  }

  private isGenerationCancelled(generation: number): boolean {
    return generation !== this.generation || this.cancelledGeneration === generation;
  }

  private frameAtTime(time: number, sampleRate: number): number {
    if (!Number.isFinite(time) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('The recording boundary is not a valid AudioContext time.');
    }
    const frame = Math.round(time * sampleRate);
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('The recording boundary is outside the supported AudioContext timeline.');
    return frame;
  }

  private releaseCaptureResources(): void {
    this.detachStreamMonitor?.();
    this.detachStreamMonitor = null;
    this.detachContextStateListener?.();
    this.detachContextStateListener = null;
    try { this.captureNode?.port.postMessage({ type: 'cancel', sessionId: this.generation }); } catch (_) { /* best effort */ }
    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      this.captureNode.onprocessorerror = null;
      try { this.captureNode.disconnect(); } catch (_) { /* best effort */ }
      try { this.captureNode.port.close?.(); } catch (_) { /* best effort */ }
    }
    try { this.inputSource?.disconnect(); } catch (_) { /* best effort */ }
    try { this.analyser?.disconnect(); } catch (_) { /* best effort */ }
    try { this.silentSink?.disconnect(); } catch (_) { /* best effort */ }
    this.stopStream(this.stream);
    this.stream = null;
    this.context = null;
    this.inputSource = null;
    this.captureNode = null;
    this.silentSink = null;
    this.analyser = null;
    this.preRollBlocks = [];
    this.captureBlocks = [];
    this.pauseIntervals = [];
    this.captureStartFrame = null;
    this.captureStopFrame = null;
    this.captureSampleRate = 0;
    this.inputChannelCount = 0;
    this.captureChannelCount = null;
    this.preservePausedTimeline = false;
    this.starting = false;
    this.preparationAbort = null;
    this.preparationPromise = null;
    this.readyDeferred = null;
    this.primedDeferred = null;
    this.releaseActiveSessionToken?.();
    this.releaseActiveSessionToken = null;
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream) return;
    try {
      stream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) { /* best effort */ }
      });
    } catch (_) { /* a partially-constructed stream may not expose tracks */ }
  }

  private notifyError(error: Error): void {
    try {
      this.onError?.(error);
    } catch (callbackError) {
      console.error('[Apex Studio] Recording error callback failed.', callbackError);
    }
  }
}
