import type { MasteringSuiteState, MultibandBandSettings } from '../types/daw';

/**
 * Real-time master processor. Three split-band compressor paths are summed,
 * followed by mid/side width control with low-frequency side reduction and a
 * final dynamics/ceiling stage. The same class is installed in live and
 * OfflineAudioContext graphs so export follows the current master settings.
 */
export class MasteringProcessor {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly bypassGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly bandGains: GainNode[] = [];
  private readonly bandCompressors: DynamicsCompressorNode[] = [];
  private readonly crossoverNodes: BiquadFilterNode[][] = [];
  private readonly imagerSplitter: ChannelSplitterNode;
  private readonly midLeft: GainNode;
  private readonly midRight: GainNode;
  private readonly sideLeft: GainNode;
  private readonly sideRight: GainNode;
  private readonly midBus: GainNode;
  private readonly sideBus: GainNode;
  private readonly sideHighPass: BiquadFilterNode;
  private readonly midToLeft: GainNode;
  private readonly midToRight: GainNode;
  private readonly sideToLeft: GainNode;
  private readonly sideToRight: GainNode;
  private readonly imagerMerger: ChannelMergerNode;
  private readonly maximizer: DynamicsCompressorNode;
  private readonly ceiling: WaveShaperNode;
  private disposed = false;

  constructor(private readonly context: AudioContext, state: MasteringSuiteState) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.bypassGain = context.createGain();
    this.wetGain = context.createGain();

    this.input.connect(this.bypassGain);
    this.bypassGain.connect(this.output);

    const sum = context.createGain();
    const bandFallbacks = [state.lowBand, state.midBand, state.highBand];
    for (let i = 0; i < 3; i++) {
      const filters: BiquadFilterNode[] = [];
      if (i > 0) {
        const highpass = context.createBiquadFilter();
        highpass.type = 'highpass';
        filters.push(highpass);
      }
      if (i < 2) {
        const lowpass = context.createBiquadFilter();
        lowpass.type = 'lowpass';
        filters.push(lowpass);
      }
      const compressor = context.createDynamicsCompressor();
      const gain = context.createGain();
      let previous: AudioNode = this.input;
      for (const filter of filters) {
        previous.connect(filter);
        previous = filter;
      }
      previous.connect(compressor);
      compressor.connect(gain);
      gain.connect(sum);
      this.crossoverNodes.push(filters);
      this.bandCompressors.push(compressor);
      this.bandGains.push(gain);
    }

    this.imagerSplitter = context.createChannelSplitter(2);
    this.midLeft = context.createGain();
    this.midRight = context.createGain();
    this.sideLeft = context.createGain();
    this.sideRight = context.createGain();
    this.midBus = context.createGain();
    this.sideBus = context.createGain();
    this.sideHighPass = context.createBiquadFilter();
    this.sideHighPass.type = 'highpass';
    this.midToLeft = context.createGain();
    this.midToRight = context.createGain();
    this.sideToLeft = context.createGain();
    this.sideToRight = context.createGain();
    this.imagerMerger = context.createChannelMerger(2);

    sum.connect(this.imagerSplitter);
    this.imagerSplitter.connect(this.midLeft, 0);
    this.imagerSplitter.connect(this.midRight, 1);
    this.imagerSplitter.connect(this.sideLeft, 0);
    this.imagerSplitter.connect(this.sideRight, 1);
    this.midLeft.connect(this.midBus);
    this.midRight.connect(this.midBus);
    this.sideLeft.connect(this.sideBus);
    this.sideRight.connect(this.sideBus);
    this.sideBus.connect(this.sideHighPass);
    this.midBus.connect(this.midToLeft);
    this.midBus.connect(this.midToRight);
    this.sideHighPass.connect(this.sideToLeft);
    this.sideHighPass.connect(this.sideToRight);
    this.midToLeft.connect(this.imagerMerger, 0, 0);
    this.sideToLeft.connect(this.imagerMerger, 0, 0);
    this.midToRight.connect(this.imagerMerger, 0, 1);
    this.sideToRight.connect(this.imagerMerger, 0, 1);

    this.maximizer = context.createDynamicsCompressor();
    this.ceiling = context.createWaveShaper();
    this.imagerMerger.connect(this.maximizer);
    this.maximizer.connect(this.ceiling);
    this.ceiling.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.setState(state);
  }

  setState(state: MasteringSuiteState): void {
    if (this.disposed) return;
    this.bypassGain.gain.setValueAtTime(state.enabled ? 0 : 1, this.context.currentTime);
    this.wetGain.gain.setValueAtTime(state.enabled ? 1 : 0, this.context.currentTime);

    const lowCross = Math.min(state.lowCrossFreq, state.highCrossFreq - 100);
    const highCross = Math.max(state.highCrossFreq, lowCross + 100);
    this.crossoverNodes[0][0].frequency.setValueAtTime(Math.max(20, lowCross), this.context.currentTime);
    this.crossoverNodes[1][0].frequency.setValueAtTime(Math.max(20, lowCross), this.context.currentTime);
    this.crossoverNodes[1][1].frequency.setValueAtTime(Math.min(this.context.sampleRate * 0.49, highCross), this.context.currentTime);
    this.crossoverNodes[2][0].frequency.setValueAtTime(Math.min(this.context.sampleRate * 0.49, highCross), this.context.currentTime);

    const bands = [state.lowBand, state.midBand, state.highBand];
    const anySolo = bands.some(band => band.solo);
    bands.forEach((band, index) => this.applyBand(band, index, anySolo));
    this.midLeft.gain.setValueAtTime(0.5, this.context.currentTime);
    this.midRight.gain.setValueAtTime(0.5, this.context.currentTime);
    this.sideLeft.gain.setValueAtTime(state.stereoSpread * 0.5, this.context.currentTime);
    this.sideRight.gain.setValueAtTime(-state.stereoSpread * 0.5, this.context.currentTime);
    this.sideHighPass.frequency.setValueAtTime(Math.min(state.monoSubFreq, this.context.sampleRate * 0.49), this.context.currentTime);
    this.midToLeft.gain.setValueAtTime(1, this.context.currentTime);
    this.midToRight.gain.setValueAtTime(1, this.context.currentTime);
    this.sideToLeft.gain.setValueAtTime(1, this.context.currentTime);
    this.sideToRight.gain.setValueAtTime(-1, this.context.currentTime);

    this.maximizer.threshold.setValueAtTime(state.maximizerThreshold, this.context.currentTime);
    this.maximizer.knee.setValueAtTime(0, this.context.currentTime);
    this.maximizer.ratio.setValueAtTime(20, this.context.currentTime);
    this.maximizer.attack.setValueAtTime(state.maximizerLookahead ? 0.001 : 0.005, this.context.currentTime);
    this.maximizer.release.setValueAtTime(state.maximizerRelease / 1000, this.context.currentTime);
    const ceilingLinear = Math.pow(10, state.maximizerCeiling / 20);
    const curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) {
      const sample = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.max(-ceilingLinear, Math.min(ceilingLinear, sample));
    }
    this.ceiling.curve = curve;
    this.ceiling.oversample = '4x';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.output.disconnect();
    this.bypassGain.disconnect();
    this.wetGain.disconnect();
    for (const filters of this.crossoverNodes) for (const filter of filters) filter.disconnect();
    for (const compressor of this.bandCompressors) compressor.disconnect();
    for (const gain of this.bandGains) gain.disconnect();
    this.imagerSplitter.disconnect();
    for (const node of [
      this.midLeft, this.midRight, this.sideLeft, this.sideRight, this.midBus, this.sideBus,
      this.sideHighPass, this.midToLeft, this.midToRight, this.sideToLeft, this.sideToRight,
      this.imagerMerger, this.maximizer, this.ceiling,
    ]) node.disconnect();
  }

  private applyBand(band: MultibandBandSettings, index: number, anySolo: boolean): void {
    const compressor = this.bandCompressors[index];
    const gain = this.bandGains[index];
    const audible = !band.mute && (!anySolo || band.solo);
    gain.gain.setValueAtTime(audible ? Math.pow(10, band.gain / 20) : 0, this.context.currentTime);
    compressor.threshold.setValueAtTime(band.enabled ? band.threshold : 0, this.context.currentTime);
    compressor.ratio.setValueAtTime(band.enabled ? band.ratio : 1, this.context.currentTime);
    compressor.attack.setValueAtTime(band.attack / 1000, this.context.currentTime);
    compressor.release.setValueAtTime(band.release / 1000, this.context.currentTime);
    compressor.knee.setValueAtTime(band.knee, this.context.currentTime);
  }
}
