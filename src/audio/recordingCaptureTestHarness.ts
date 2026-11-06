import { runInNewContext } from 'node:vm';
import {
  RECORDING_CAPTURE_PACKET_FRAMES,
  RECORDING_CAPTURE_WORKLET_SOURCE,
} from './recordingCaptureWorklet';
import type {
  RecordingCaptureNodeLike,
  RecordingCapturePortLike,
  RecordingEngineOptions,
} from './recordingEngine';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

class HarnessPort {
  peer: HarnessPort | null = null;
  private handler: ((event: { data: unknown }) => void) | null = null;
  private queued: unknown[] = [];
  closed = false;

  get onmessage(): ((event: { data: unknown }) => void) | null { return this.handler; }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.handler = handler;
    if (handler) {
      const queued = this.queued;
      this.queued = [];
      for (const data of queued) handler({ data });
    }
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('MessagePort is closed');
    const target = this.peer;
    if (!target || target.closed) return;
    if (target.handler) target.handler({ data: message });
    else target.queued.push(message);
  }

  close(): void { this.closed = true; }
}

class HarnessAudioNode {
  disconnected = false;
  readonly connections: unknown[] = [];
  connect(destination: unknown): unknown {
    if (this.disconnected) throw new Error('AudioNode is disconnected');
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void { this.disconnected = true; }
}

class HarnessAnalyser extends HarnessAudioNode {
  fftSize = 1024;
  smoothingTimeConstant = 0;
  getByteTimeDomainData(data: Uint8Array): void { data.fill(128); }
}

class HarnessGain extends HarnessAudioNode {
  readonly gain = { value: 1 };
}

export class DeterministicCaptureNode implements RecordingCaptureNodeLike {
  readonly port: RecordingCapturePortLike;
  onprocessorerror: ((event: Event) => void) | null = null;
  readonly processorName = 'apex-recording-capture';
  readonly packetFrames: number;
  private readonly mainPort: HarnessPort;
  private readonly processorPort: HarnessPort;
  private readonly processor: { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
  private readonly sandbox: Record<string, unknown>;
  private connected = false;
  readonly commands: Array<Record<string, unknown>> = [];

  constructor(sampleRate: number, packetFrames = RECORDING_CAPTURE_PACKET_FRAMES) {
    this.packetFrames = packetFrames;
    this.mainPort = new HarnessPort();
    this.processorPort = new HarnessPort();
    this.mainPort.peer = this.processorPort;
    this.processorPort.peer = this.mainPort;
    this.port = this.mainPort as unknown as RecordingCapturePortLike;
    const mainPort = this.mainPort;
    const processorPort = this.processorPort;
    const owner = this;
    class AudioWorkletProcessorHarness {
      readonly port = processorPort;
    }
    const registry = new Map<string, new (options: unknown) => { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean }>();
    this.sandbox = {
      AudioWorkletProcessor: AudioWorkletProcessorHarness,
      sampleRate,
      currentFrame: 0,
      registerProcessor: (name: string, constructor: new (options: unknown) => { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean }) => {
        registry.set(name, constructor);
      },
    };
    runInNewContext(RECORDING_CAPTURE_WORKLET_SOURCE, this.sandbox);
    const Processor = registry.get(this.processorName);
    if (!Processor) throw new Error('The production capture worklet did not register its processor');
    this.processor = new Processor({ processorOptions: { packetFrames } });
    const originalPostMessage = processorPort.postMessage.bind(processorPort);
    processorPort.postMessage = (message: unknown): void => {
      owner.commands.push({ direction: 'processor-to-main', ...(message as Record<string, unknown>) });
      originalPostMessage(message);
    };
    const originalMainPostMessage = mainPort.postMessage.bind(mainPort);
    mainPort.postMessage = (message: unknown): void => {
      owner.commands.push({ direction: 'main-to-processor', ...(message as Record<string, unknown>) });
      originalMainPostMessage(message);
    };
  }

  connect(destination: AudioNode): AudioNode {
    this.connected = true;
    return destination;
  }

  disconnect(): void { this.connected = false; }

  processBlock(frameStart: number, inputs: Float32Array[][]): void {
    if (!this.connected) throw new Error('Cannot process capture audio before the worklet is connected');
    const frameCount = inputs[0]?.[0]?.length ?? 128;
    this.sandbox.currentFrame = frameStart;
    const outputs = [[new Float32Array(frameCount)]];
    this.processor.process(inputs, outputs);
  }
}

export type SampleFunction = (frame: number, channel: number) => number;

export class DeterministicAudioContext {
  state: AudioContextState = 'running';
  readonly sampleRate: number;
  readonly destination = new HarnessAudioNode() as unknown as AudioDestinationNode;
  captureNode: DeterministicCaptureNode | null = null;
  private frame = 0;
  private readonly stateListeners = new Set<() => void>();
  private readonly nodeReady = deferred<DeterministicCaptureNode>();
  readonly captureNodeReady = this.nodeReady.promise;
  resumeCalls = 0;

  constructor(sampleRate = 1000) { this.sampleRate = sampleRate; }
  get currentTime(): number { return this.frame / this.sampleRate; }
  get currentFrame(): number { return this.frame; }

  async resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    for (const listener of this.stateListeners) listener();
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
    for (const listener of this.stateListeners) listener();
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'statechange') this.stateListeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'statechange') this.stateListeners.delete(listener as () => void);
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return new HarnessAudioNode() as unknown as MediaStreamAudioSourceNode;
  }

  createAnalyser(): AnalyserNode { return new HarnessAnalyser() as unknown as AnalyserNode; }
  createGain(): GainNode { return new HarnessGain() as unknown as GainNode; }

  makeCaptureNode(options?: AudioWorkletNodeOptions): RecordingCaptureNodeLike {
    const packetFrames = Number((options?.processorOptions as { packetFrames?: number } | undefined)?.packetFrames)
      || RECORDING_CAPTURE_PACKET_FRAMES;
    const node = new DeterministicCaptureNode(this.sampleRate, packetFrames);
    this.captureNode = node;
    this.nodeReady.resolve(node);
    return node;
  }

  advanceToFrame(targetFrame: number, sample: SampleFunction = () => 0, inputChannels = 1): void {
    if (!Number.isSafeInteger(targetFrame) || targetFrame < this.frame) {
      throw new Error('The deterministic audio clock can only move forward to an integer frame');
    }
    if (!this.captureNode) throw new Error('The recording capture worklet has not been created');
    if (!Number.isSafeInteger(inputChannels) || inputChannels < 0 || inputChannels > 32) {
      throw new Error('The deterministic input channel count is invalid');
    }
    while (this.frame < targetFrame) {
      const frameStart = this.frame;
      const quantum = 128;
      const channels = Array.from({ length: inputChannels }, (_, channel) => {
        const values = new Float32Array(quantum);
        for (let offset = 0; offset < quantum; offset++) values[offset] = sample(frameStart + offset, channel);
        return values;
      });
      this.captureNode.processBlock(frameStart, [channels]);
      this.frame += quantum;
    }
  }
}

export class DeterministicMediaTrack {
  stopped = false;
  private readonly listeners = new Set<() => void>();
  onended: (() => void) | null = null;

  stop(): void { this.stopped = true; }
  addEventListener(type: string, listener: () => void): void { if (type === 'ended') this.listeners.add(listener); }
  removeEventListener(type: string, listener: () => void): void { if (type === 'ended') this.listeners.delete(listener); }
  triggerUnexpectedEnd(): void {
    this.stopped = true;
    for (const listener of [...this.listeners]) listener();
    this.onended?.();
  }
}

export class DeterministicMediaStream {
  readonly tracks = [new DeterministicMediaTrack()];
  getTracks(): DeterministicMediaTrack[] { return this.tracks; }
  getAudioTracks(): DeterministicMediaTrack[] { return this.tracks; }
}

export interface RecordingTestRig {
  context: DeterministicAudioContext;
  stream: DeterministicMediaStream;
  engineOptions: RecordingEngineOptions;
}

export const createRecordingTestRig = (options: {
  sampleRate?: number;
  stream?: DeterministicMediaStream;
  persistAudioClip?: (id: string, blob: Blob) => Promise<void>;
  onError?: (error: Error) => void;
  deviceManager?: RecordingEngineOptions['deviceManager'];
  getUserMedia?: RecordingEngineOptions['getUserMedia'];
} = {}): RecordingTestRig => {
  const context = new DeterministicAudioContext(options.sampleRate ?? 1000);
  const stream = options.stream ?? new DeterministicMediaStream();
  const engineOptions: RecordingEngineOptions = {
    persistAudioClip: options.persistAudioClip ?? (async () => undefined),
    onError: options.onError,
    deviceManager: options.deviceManager,
    getUserMedia: options.getUserMedia ?? (async () => stream as unknown as MediaStream),
    createInputSource: () => new HarnessAudioNode() as unknown as MediaStreamAudioSourceNode,
    createCaptureNode: (_context, _processorName, nodeOptions) => context.makeCaptureNode(nodeOptions),
  };
  return { context, stream, engineOptions };
};

export interface DecodedFloatWav {
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  samples: Float32Array;
}

/** Reads the float32 WAV produced by RecordingEngine for sample-level assertions. */
export const decodeFloatWav = async (blob: Blob): Promise<DecodedFloatWav> => {
  const data = await blob.arrayBuffer();
  const view = new DataView(data);
  const readText = (offset: number, length: number): string => {
    let value = '';
    for (let index = 0; index < length; index++) value += String.fromCharCode(view.getUint8(offset + index));
    return value;
  };
  if (readText(0, 4) !== 'RIFF' || readText(8, 4) !== 'WAVE' || readText(12, 4) !== 'fmt ' || readText(36, 4) !== 'data') {
    throw new Error('The recording is not a canonical 44-byte RIFF/WAVE file');
  }
  const format = view.getUint16(20, true);
  const channelCount = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const frameCount = view.getUint32(40, true) / (channelCount * 4);
  if (format !== 3 || !Number.isInteger(frameCount)) throw new Error('The recording is not 32-bit IEEE-float PCM');
  const samples = new Float32Array(frameCount * channelCount);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getFloat32(44 + index * 4, true);
  return { sampleRate, channelCount, frameCount, samples };
};
