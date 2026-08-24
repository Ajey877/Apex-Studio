import {
  MixerChannelState,
  createMixerChannel,
  dbToGain,
  isChannelAudible,
} from './mixerChannel';
import { ChannelInsertRack } from './insertRack';

export interface ChannelStripNodes {
  input: AudioNode;
  output: AudioNode;
  meter: AnalyserNode;
}

/** A production channel strip: inserts -> gain -> pan -> output, with a post-strip meter. */
export class MixerChannelStrip {
  state: MixerChannelState;
  readonly input: GainNode;
  readonly inserts: ChannelInsertRack;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  readonly output: GainNode;
  readonly meter: AnalyserNode;

  private hasSolo = false;

  constructor(
    private readonly context: AudioContext,
    id: number,
    name = `Track ${id}`,
  ) {
    this.state = createMixerChannel(id, name);
    this.input = context.createGain();
    this.inserts = new ChannelInsertRack(context);
    this.gain = context.createGain();
    this.panner = context.createStereoPanner();
    this.output = context.createGain();
    this.meter = context.createAnalyser();
    this.meter.fftSize = 2048;
    this.meter.smoothingTimeConstant = 0.8;

    this.input.connect(this.inserts.input);
    this.inserts.output.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(this.output);
    this.output.connect(this.meter);
    this.applyState();
  }

  getNodes(): ChannelStripNodes {
    return { input: this.input, output: this.output, meter: this.meter };
  }

  setVolumeDb(volumeDb: number): void {
    if (!Number.isFinite(volumeDb)) throw new Error('Mixer volume must be finite.');
    this.state = { ...this.state, volumeDb: Math.max(-60, Math.min(12, volumeDb)) };
    this.applyState();
  }

  setPan(pan: number): void {
    if (!Number.isFinite(pan)) throw new Error('Mixer pan must be finite.');
    this.state = { ...this.state, pan: Math.max(-1, Math.min(1, pan)) };
    this.applyState();
  }

  setMuted(muted: boolean): void {
    this.state = { ...this.state, muted };
    this.applyState();
  }

  setSoloed(soloed: boolean): void {
    this.state = { ...this.state, soloed };
    this.applyState();
  }

  setSoloState(hasSolo: boolean): void {
    this.hasSolo = hasSolo;
    this.applyState();
  }

  getMeterLevels(): { peak: number; rms: number } {
    const samples = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(samples);
    let peak = 0;
    let sum = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      sum += sample * sample;
    }
    return { peak, rms: Math.sqrt(sum / samples.length) };
  }

  dispose(): void {
    this.input.disconnect();
    this.inserts.dispose();
    this.gain.disconnect();
    this.panner.disconnect();
    this.output.disconnect();
    this.meter.disconnect();
  }

  private applyState(): void {
    const audible = isChannelAudible(this.state, this.hasSolo);
    this.gain.gain.setValueAtTime(
      audible ? dbToGain(this.state.volumeDb) : 0,
      this.context.currentTime,
    );
    this.panner.pan.setValueAtTime(this.state.pan, this.context.currentTime);
  }
}
