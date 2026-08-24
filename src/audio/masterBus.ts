export interface MasterBusMeterLevels {
  peak: number;
  rms: number;
}

/**
 * Production master bus: one deterministic final gain stage followed by a
 * post-fader analyser. Track and bus outputs should feed `input`; `output`
 * is the only signal intended for the final audio destination.
 */
export class MasterBus {
  readonly input: GainNode;
  readonly gain: GainNode;
  readonly meter: AnalyserNode;
  readonly output: GainNode;

  constructor(private readonly context: AudioContext) {
    this.input = context.createGain();
    this.gain = context.createGain();
    this.meter = context.createAnalyser();
    this.output = context.createGain();

    this.meter.fftSize = 2048;
    this.meter.smoothingTimeConstant = 0.8;

    this.input.connect(this.gain);
    this.gain.connect(this.meter);
    this.meter.connect(this.output);
  }

  setGainDb(gainDb: number): void {
    if (!Number.isFinite(gainDb)) throw new Error('Master gain must be finite.');
    const clampedDb = Math.max(-60, Math.min(12, gainDb));
    const linear = clampedDb <= -60 ? 0 : Math.pow(10, clampedDb / 20);
    this.gain.gain.setValueAtTime(linear, this.context.currentTime);
  }

  connectDestination(destination: AudioNode): void {
    this.output.connect(destination);
  }

  getMeterLevels(): MasterBusMeterLevels {
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
    this.gain.disconnect();
    this.meter.disconnect();
    this.output.disconnect();
  }
}
