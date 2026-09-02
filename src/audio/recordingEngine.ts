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
  private readonly waveformSamples: number;
  private readonly timesliceMs: number;

  constructor(private readonly contextProvider: () => AudioContext, options: RecordingEngineOptions = {}) {
    this.waveformSamples = Math.max(32, Math.min(2048, Math.floor(options.waveformSamples ?? 512)));
    this.timesliceMs = Math.max(50, Math.floor(options.timesliceMs ?? 250));
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
    try {
      const context = this.contextProvider();
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      const mimeType = this.selectMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = event => { if (event.data.size > 0) this.chunks.push(event.data); };
      recorder.onerror = () => this.failAndCleanup(new Error('Audio recording failed'));
      this.stream = stream;
      this.analyserSource = source;
      this.analyser = analyser;
      this.recorder = recorder;
      this.mimeType = recorder.mimeType || mimeType || 'audio/webm';
      this.chunks = [];
      this.startedAt = performance.now();
      this.pausedAt = 0;
      this.pausedDurationMs = 0;
      this.state = 'recording';
      recorder.start(this.timesliceMs);
      return stream;
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
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

  async stop(): Promise<RecordingResult> {
    if (!this.recorder || (this.state !== 'recording' && this.state !== 'paused')) throw new Error('No active recording');
    const recorder = this.recorder;
    this.state = 'stopping';
    if (recorder.state !== 'inactive') recorder.stop();

    const result = await new Promise<RecordingResult>((resolve, reject) => {
      recorder.onstop = async () => {
        try {
          const blob = new Blob(this.chunks, { type: this.mimeType || recorder.mimeType || 'audio/webm' });
          if (!blob.size) throw new Error('Audio recording produced no data');
          const waveform = await this.buildWaveform(blob);
          const durationSeconds = this.getDurationSeconds();
          const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const resultValue: RecordingResult = { id, name: `Audio Take ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, timestamp: Date.now(), durationSeconds, blob, url: URL.createObjectURL(blob), waveform, mimeType: blob.type };
          try {
            await persistAudioClip(`recording-${id}`, blob);
          } catch (storageError) {
            console.warn('[Apex Studio] Local audio persistence failed; recording remains available for this session.', storageError);
          }
          resolve(resultValue);
        } catch (error) {
          reject(error);
        }
      };
      recorder.onerror = () => reject(new Error('Audio recording failed'));
    });

    this.cleanup();
    return result;
  }

  cancel(): void {
    const recorder = this.recorder;
    if (!recorder) {
      this.cleanup();
      return;
    }
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } finally {
      this.cleanup();
    }
  }

  dispose(): void { this.cancel(); }

  private failAndCleanup(error: Error): void {
    this.cleanup();
    console.error('[Apex Studio] Recording failed.', error);
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
    this.state = 'idle';
  }
}
