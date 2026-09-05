import { persistAudioClip } from './audioPersistence';
import { installAudioPlaybackLifecycle } from './audioPlaybackLifecycle';

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
}

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopping';

export interface RecordingEngineOptions {
  waveformSamples?: number;
  timesliceMs?: number;
  onError?: (error: Error) => void;
  persistAudioClip?: (id: string, blob: Blob) => Promise<void>;
}

export class RecordingEngine {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private chunks: Blob[] = [];
  private state: RecordingState = 'idle';
  private startedAt = 0;
  private pausedAt = 0;
  private pausedDurationMs = 0;
  private mimeType = '';
  private finalizationPromise: Promise<RecordingResult> | null = null;
  private cancellationRequested = false;
  private readonly waveformSamples: number;
  private readonly timesliceMs: number;
  private readonly onError?: (error: Error) => void;
  private readonly persistAudioClip: (id: string, blob: Blob) => Promise<void>;

  constructor(private readonly contextProvider: () => AudioContext, options: RecordingEngineOptions = {}) {
    this.waveformSamples = Math.max(32, Math.min(2048, Math.floor(options.waveformSamples ?? 512)));
    this.timesliceMs = Math.max(50, Math.floor(options.timesliceMs ?? 250));
    this.onError = options.onError;
    this.persistAudioClip = options.persistAudioClip ?? persistAudioClip;
  }

  getState(): RecordingState { return this.state; }
  getMimeType(): string { return this.mimeType; }

  getDurationSeconds(now = performance.now()): number {
    if (this.startedAt <= 0) return 0;
    const end = this.state === 'recording' || this.state === 'paused' || this.state === 'stopping' ? now : this.startedAt;
    const paused = this.pausedDurationMs + (this.state === 'paused' ? Math.max(0, now - this.pausedAt) : 0);
    return Math.max(0, (end - this.startedAt - paused) / 1000);
  }

  async start(): Promise<MediaStream> {
    if (this.state !== 'idle') throw new Error(`Cannot start recording while state is ${this.state}`);
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is not supported in this environment');
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not supported in this environment');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      const context = this.contextProvider();
      if (context.state === 'suspended') await context.resume();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      const mimeType = this.selectMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = event => { if (event.data.size > 0) this.chunks.push(event.data); };
      recorder.onerror = () => this.handleRecorderError(new Error('Audio recording failed'));
      this.stream = stream;
      this.analyserSource = source;
      this.analyser = analyser;
      this.recorder = recorder;
      this.mimeType = recorder.mimeType || mimeType || 'audio/webm';
      this.chunks = [];
      this.startedAt = performance.now();
      this.pausedAt = 0;
      this.pausedDurationMs = 0;
      this.cancellationRequested = false;
      this.finalizationPromise = null;
      this.state = 'recording';
      recorder.start(this.timesliceMs);
      return stream;
    } catch (error) {
      try { source?.disconnect(); } catch (_) { /* best effort */ }
      try { analyser?.disconnect(); } catch (_) { /* best effort */ }
      stream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) { /* best effort */ }
      });
      this.stream = null;
      this.analyserSource = null;
      this.analyser = null;
      this.recorder = null;
      this.chunks = [];
      this.state = 'idle';
      throw error;
    }
  }

  pause(): void {
    if (!this.recorder || this.state !== 'recording') return;
    this.recorder.pause();
    this.pausedAt = performance.now();
    this.state = 'paused';
  }

  resume(): void {
    if (!this.recorder || this.state !== 'paused') return;
    this.pausedDurationMs += Math.max(0, performance.now() - this.pausedAt);
    this.pausedAt = 0;
    this.recorder.resume();
    this.state = 'recording';
  }

  getPeak(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
    return peak;
  }

  stop(): Promise<RecordingResult> {
    if (this.finalizationPromise) return this.finalizationPromise;
    if (!this.recorder || (this.state !== 'recording' && this.state !== 'paused')) throw new Error('No active recording');
    return this.beginFinalization(false);
  }

  private beginFinalization(cancelled: boolean): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error('No active recording'));
    this.cancellationRequested = cancelled;
    this.state = 'stopping';

    this.finalizationPromise = new Promise<RecordingResult>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        const normalized = error instanceof Error ? error : new Error('Audio recording failed');
        this.cleanup();
        this.notifyError(normalized);
        reject(normalized);
      };

      recorder.onstop = async () => {
        if (settled) return;
        try {
          if (this.cancellationRequested) throw new Error('Audio recording was cancelled');
          const blob = new Blob(this.chunks, { type: this.mimeType || recorder.mimeType || 'audio/webm' });
          if (!blob.size) throw new Error('Audio recording produced no data');
          const waveform = await this.buildWaveform(blob);
          const durationSeconds = this.getDurationSeconds();
          const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await this.persistAudioClip(`recording-${id}`, blob);
          if (this.cancellationRequested) throw new Error('Audio recording was cancelled');
          const resultValue: RecordingResult = { id, name: `Audio Take ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, timestamp: Date.now(), durationSeconds, blob, url: URL.createObjectURL(blob), waveform, mimeType: blob.type };
          settled = true;
          this.cleanup();
          resolve(resultValue);
        } catch (error) {
          fail(error);
        }
      };
      recorder.onerror = () => fail(new Error('Audio recording failed'));

      try {
        if (recorder.state !== 'inactive') recorder.stop();
        else queueMicrotask(() => fail(new Error('Recording stopped before finalization')));
      } catch (error) {
        fail(error);
      }
    });
    return this.finalizationPromise;
  }

  cancel(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) {
      this.cleanup();
      return Promise.resolve();
    }
    if (this.finalizationPromise) return this.finalizationPromise.then(() => undefined, error => { throw error; });
    try {
      return this.beginFinalization(true).then(() => undefined, error => { throw error; });
    } catch (error) {
      this.handleRecorderError(error instanceof Error ? error : new Error('Audio recording failed'));
      return Promise.reject(error);
    }
  }

  dispose(): Promise<void> {
    if (this.recorder && !this.finalizationPromise) this.cancel();
    else if (!this.finalizationPromise) this.cleanup();
    return this.finalizationPromise?.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  private handleRecorderError(error: Error): void {
    if (this.finalizationPromise) return;
    this.cleanup();
    this.notifyError(error);
    console.error('[Apex Studio] Recording failed.', error);
  }

  private notifyError(error: Error): void {
    try {
      this.onError?.(error);
    } catch (callbackError) {
      console.error('[Apex Studio] Recording error callback failed.', callbackError);
    }
  }

  private selectMimeType(): string | undefined {
    const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
    return candidates.find(type => MediaRecorder.isTypeSupported(type));
  }

  private async buildWaveform(blob: Blob): Promise<number[]> {
    if (!blob.size) return new Array(this.waveformSamples).fill(0);
    try {
      const context = this.contextProvider();
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      const waveform = new Array(this.waveformSamples).fill(0);
      for (let bucket = 0; bucket < waveform.length; bucket++) {
        const start = Math.floor((bucket * decoded.length) / waveform.length);
        const end = Math.max(start + 1, Math.floor(((bucket + 1) * decoded.length) / waveform.length));
        let peak = 0;
        for (let frame = start; frame < end; frame++) for (const channel of channels) peak = Math.max(peak, Math.abs(channel[frame] ?? 0));
        waveform[bucket] = Math.min(1, peak);
      }
      return waveform;
    } catch {
      return [];
    }
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach(track => {
      try { track.stop(); } catch (_) { /* best effort */ }
    });
    try { this.analyserSource?.disconnect(); } catch (_) { /* best effort */ }
    try { this.analyser?.disconnect(); } catch (_) { /* best effort */ }
    this.stream = null;
    this.analyserSource = null;
    this.analyser = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedDurationMs = 0;
    this.mimeType = '';
    this.cancellationRequested = false;
    this.state = 'idle';
  }
}
