import type { MasteringSuiteState, MultibandBandSettings } from '../types/daw';
import {
  MASTERING_LIMITER_PROCESSOR,
  MASTERING_LIMITER_SOURCE,
  resolveLimiterLatencySamples,
  resolveLimiterLookaheadMs,
} from './masteringLimiter';

/**
 * What the mastering limiter is doing right now.
 *
 * `measured: false` is the honest "nothing has been measured yet" state — the
 * UI must render it as such instead of showing a plausible 0 dB.
 */
export interface MasteringLimiterStatus {
  /** True once the limiter worklet module is loaded in this context. */
  available: boolean;
  /** True when the limiter is both installed and the suite is not bypassed. */
  active: boolean;
  /** Lookahead the project asks for (ms). 0 = direct/causal. */
  lookaheadMs: number;
  /** Latency the limiter adds to the master chain, in samples. */
  latencySamples: number;
  /** Gain the audio thread applied most recently, in dB (>= 0 = reduction). */
  reductionDb: number | null;
  /** Largest reduction applied since the previous status report. */
  peakReductionDb: number | null;
  /** True once the processor has reported at least one measured value. */
  measured: boolean;
  /** Reconstruction factor used by the detector. */
  oversample: number;
  ceilingDb: number;
  /**
   * Why the real limiter is not running, when it is not. `null` means it is
   * running (or is about to, while the module loads).
   */
  fallbackReason: 'worklet-unavailable' | 'module-load-failed' | null;
}

/**
 * Real-time master processor.
 *
 * Three split-band compressor paths are summed, followed by mid/side width
 * control with low-frequency side reduction, an upstream maximizer compressor,
 * and the Phase 9B lookahead true-peak limiter. The same class is installed in
 * live and OfflineAudioContext graphs so export follows the current master
 * settings.
 *
 * Master path (Phase 9B):
 *
 *   input ─┬─ bypassGain ──────────────────────────────────────────→ output
 *          └─ [3-band comp] → [imager] → maximizer → limiter → wet → output
 *
 * The limiter is an AudioWorklet node. Until its module loads (or if it cannot
 * load at all) the processor runs the documented fallback: the maximizer
 * compressor followed by the legacy 4× oversampled hard peak guard at the
 * configured ceiling. That fallback is sample-peak only and adds no lookahead;
 * `getLimiterStatus()` says so instead of implying the true limiter is active.
 */
export class MasteringProcessor {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly bypassGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly bandGains: GainNode[] = [];
  private readonly bandSum: GainNode;
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
  /**
   * Placeholder edge between the maximizer and the safety guard. It carries the
   * signal while the limiter is not installed and is detached once the worklet
   * node takes over, so the two paths never sum.
   */
  private readonly limiterStage: GainNode;

  private state: MasteringSuiteState;
  private disposed = false;

  /** Worklet node, present only once the module loaded and the node is built. */
  private limiterNode: AudioWorkletNode | null = null;
  private limiterAvailable = false;
  private fallbackReason: MasteringLimiterStatus['fallbackReason'] = null;
  private moduleLoad: Promise<boolean> | null = null;
  private limiterReductionDb: number | null = null;
  private limiterPeakReductionDb: number | null = null;
  private limiterMeasured = false;

  constructor(private readonly context: AudioContext, state: MasteringSuiteState) {
    this.state = state;
    this.input = context.createGain();
    this.output = context.createGain();
    this.bypassGain = context.createGain();
    this.wetGain = context.createGain();

    this.input.connect(this.bypassGain);
    this.bypassGain.connect(this.output);

    this.bandSum = context.createGain();
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
      gain.connect(this.bandSum);
      this.crossoverNodes.push(filters);
      this.bandCompressors.push(compressor);
      this.bandGains.push(gain);
      void bandFallbacks;
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

    this.bandSum.connect(this.imagerSplitter);
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
    this.limiterStage = context.createGain();
    this.imagerMerger.connect(this.maximizer);
    this.maximizer.connect(this.limiterStage);
    this.limiterStage.connect(this.ceiling);
    this.ceiling.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.setState(state);
  }

  // ---------------------------------------------------------------------------
  // Limiter lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Loads the limiter worklet module into this processor's context.
   *
   * Pure I/O: it touches no node, so it is safe to await while a render holds
   * the graph fence. `installLimiter()` performs the (synchronous) graph work.
   */
  loadLimiterModule(): Promise<boolean> {
    if (this.limiterAvailable) return Promise.resolve(true);
    if (this.moduleLoad) return this.moduleLoad;

    const worklet = (this.context as unknown as {
      audioWorklet?: { addModule?: (url: string) => Promise<void> };
    }).audioWorklet;
    const canLoad =
      !!worklet &&
      typeof worklet.addModule === 'function' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      typeof AudioWorkletNode !== 'undefined';

    if (!canLoad) {
      this.fallbackReason = 'worklet-unavailable';
      this.moduleLoad = Promise.resolve(false);
      return this.moduleLoad;
    }

    this.moduleLoad = (async () => {
      let url: string | null = null;
      try {
        url = URL.createObjectURL(new Blob([MASTERING_LIMITER_SOURCE], { type: 'application/javascript' }));
        await worklet!.addModule!(url);
        this.limiterAvailable = true;
        this.fallbackReason = null;
        return true;
      } catch {
        this.limiterAvailable = false;
        this.fallbackReason = 'module-load-failed';
        return false;
      } finally {
        if (url) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Revocation is best effort; the module is already registered.
          }
        }
      }
    })();
    return this.moduleLoad;
  }

  /**
   * Builds the limiter node and splices it into the master path.
   *
   * Idempotent. When `ready` is false the chain keeps its documented fallback
   * (compressor + hard peak guard at the ceiling) and reports why.
   */
  installLimiter(ready: boolean): void {
    if (this.disposed) return;
    if (!ready) {
      this.limiterAvailable = false;
      if (!this.fallbackReason) this.fallbackReason = 'module-load-failed';
      this.applySafetyCurve();
      return;
    }
    this.limiterAvailable = true;
    if (!this.limiterNode) {
      try {
        const node = new AudioWorkletNode(this.context, MASTERING_LIMITER_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        node.port.onmessage = (event: MessageEvent) => {
          const payload = event.data as { type?: string; reductionDb?: unknown; peakReductionDb?: unknown } | null;
          if (!payload || payload.type !== 'limiter') return;
          if (typeof payload.reductionDb === 'number' && Number.isFinite(payload.reductionDb)) {
            this.limiterReductionDb = Math.max(0, payload.reductionDb);
            this.limiterMeasured = true;
          }
          if (typeof payload.peakReductionDb === 'number' && Number.isFinite(payload.peakReductionDb)) {
            this.limiterPeakReductionDb = Math.max(0, payload.peakReductionDb);
          }
        };
        // Splice: maximizer → limiter → wet, and retire the placeholder edge so
        // the limited and unlimited signals can never sum.
        this.maximizer.disconnect(this.limiterStage);
        this.limiterStage.disconnect();
        this.maximizer.connect(node);
        node.connect(this.wetGain);
        this.limiterNode = node;
      } catch {
        this.limiterAvailable = false;
        this.fallbackReason = 'module-load-failed';
        this.applySafetyCurve();
        return;
      }
    }
    this.applyLimiterParameters();
    this.applySafetyCurve();
  }

  /** Latency in samples the master chain now runs behind its input. */
  getLimiterLatencySamples(): number {
    if (!this.limiterNode || !this.state.enabled) return 0;
    return resolveLimiterLatencySamples(this.state, this.context.sampleRate);
  }

  getLimiterLatencySeconds(): number {
    const sampleRate = this.context.sampleRate || 44100;
    return this.getLimiterLatencySamples() / sampleRate;
  }

  getLimiterStatus(): MasteringLimiterStatus {
    const lookaheadMs = resolveLimiterLookaheadMs(this.state);
    return {
      available: this.limiterAvailable && !!this.limiterNode,
      active: this.limiterAvailable && !!this.limiterNode && this.state.enabled,
      lookaheadMs,
      latencySamples: this.getLimiterLatencySamples(),
      reductionDb: this.limiterMeasured ? this.limiterReductionDb : null,
      peakReductionDb: this.limiterMeasured ? this.limiterPeakReductionDb : null,
      measured: this.limiterMeasured,
      oversample: 4,
      ceilingDb: this.state.maximizerCeiling,
      fallbackReason: this.limiterAvailable && this.limiterNode ? null : this.fallbackReason,
    };
  }

  private applyLimiterParameters(): void {
    const node = this.limiterNode;
    if (!node) return;
    const now = this.context.currentTime;
    const sampleRate = this.context.sampleRate || 44100;
    const setParam = (name: string, value: number) => {
      const param = node.parameters?.get?.(name);
      if (!param) return;
      try {
        param.setValueAtTime(value, now);
      } catch {
        param.value = value;
      }
    };
    setParam('ceilingDb', Math.max(-24, Math.min(0, this.state.maximizerCeiling)));
    setParam('releaseMs', Math.max(5, Math.min(2000, this.state.maximizerRelease)));
    setParam('lookaheadSamples', resolveLimiterLatencySamples(this.state, sampleRate));
  }

  /**
   * Peak guard.
   *
   * When the real limiter is installed this guard is **removed from the signal
   * path** (`installLimiter()` routes the worklet straight to `wetGain`). Its
   * table is finite, so an identity curve below full scale would still quantise
   * the master; and the limiter's per-sample cap is already the ceiling
   * guarantee, so a clipper there would only add a distortion stage that never
   * fires. The node stays allocated but unconnected, which is also why the
   * ceiling tests measure the limiter and not a clipper.
   *
   * Without a limiter (worklet unavailable) the guard *is* the master path, and
   * it falls back to the pre-9B behaviour: a 4× oversampled hard clip exactly at
   * the configured ceiling. That is a sample-domain guard, not a true-peak
   * limiter — the UI and `getLimiterStatus().fallbackReason` say so.
   */
  private applySafetyCurve(): void {
    if (this.disposed) return;
    const limiterActive = this.limiterAvailable && !!this.limiterNode;
    const ceilingDb = limiterActive ? 0 : Math.max(-24, Math.min(0, this.state.maximizerCeiling));
    const ceilingLinear = Math.pow(10, ceilingDb / 20);
    const curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) {
      const sample = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.max(-ceilingLinear, Math.min(ceilingLinear, sample));
    }
    this.ceiling.curve = curve;
    try {
      // `none` when the limiter is live: the guard must not add an unreported
      // resampling latency of its own to a chain whose latency is compensated.
      this.ceiling.oversample = limiterActive ? 'none' : '4x';
    } catch {
      // Older contexts may reject the enum; the curve is what matters.
    }
  }

  setState(state: MasteringSuiteState): void {
    if (this.disposed) return;
    this.state = state;
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

    // Upstream maximizer: a compressor that shapes drive *before* the limiter.
    // Its threshold is the only thing `maximizerThreshold` sets; the ceiling is
    // the limiter's job, and `maximizerLookahead` no longer changes an attack —
    // it selects the limiter's lookahead mode (see `masteringLimiter.ts`).
    this.maximizer.threshold.setValueAtTime(state.maximizerThreshold, this.context.currentTime);
    this.maximizer.knee.setValueAtTime(0, this.context.currentTime);
    this.maximizer.ratio.setValueAtTime(20, this.context.currentTime);
    this.maximizer.attack.setValueAtTime(0.003, this.context.currentTime);
    this.maximizer.release.setValueAtTime(state.maximizerRelease / 1000, this.context.currentTime);

    this.applyLimiterParameters();
    this.applySafetyCurve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.output.disconnect();
    this.bypassGain.disconnect();
    this.wetGain.disconnect();
    this.bandSum.disconnect();
    for (const filters of this.crossoverNodes) for (const filter of filters) filter.disconnect();
    for (const compressor of this.bandCompressors) compressor.disconnect();
    for (const gain of this.bandGains) gain.disconnect();
    this.imagerSplitter.disconnect();
    for (const node of [
      this.midLeft, this.midRight, this.sideLeft, this.sideRight, this.midBus, this.sideBus,
      this.sideHighPass, this.midToLeft, this.midToRight, this.sideToLeft, this.sideToRight,
      this.imagerMerger, this.maximizer, this.ceiling, this.limiterStage,
    ]) node.disconnect();
    if (this.limiterNode) {
      try {
        this.limiterNode.port.onmessage = null;
      } catch {
        // A closed port cannot be reassigned; teardown continues.
      }
      try {
        this.limiterNode.disconnect();
      } catch {
        // Already detached by the context teardown.
      }
      try {
        this.limiterNode.port.close();
      } catch {
        // Port already closed.
      }
      this.limiterNode = null;
    }
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
