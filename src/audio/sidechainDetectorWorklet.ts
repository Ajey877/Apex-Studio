/**
 * Phase 9A — real level-detected sidechain detector.
 *
 * ## What runs where
 *
 * The detector is an `AudioWorkletProcessor`. It is the only component in the
 * sidechain that *listens* to audio: its input is the source track's post-fader
 * mixer output (`MixerChannel.output`), so it sees exactly the samples the user
 * hears from that track — instrument voices, sustained notes and audio clips
 * alike. There is no MIDI-event trigger, no `setInterval` and no main-thread
 * polling anywhere in this path; the envelope is measured sample-by-sample on
 * the audio thread.
 *
 * The worklet does not create sound. Its single mono output carries the
 * *computed gain* (0..1) and is wired to the destination channel's
 * `duckingGain.gain` AudioParam, which therefore has an intrinsic value of 0
 * while a detector is attached. An AudioParam sums its connected inputs, so the
 * destination is attenuated by exactly the detected envelope. Because the
 * connection is an AudioParam (not an audible edge), the detector adds no
 * signal to the mix and cannot feed back into the source.
 *
 * The same source string is used for live playback and for
 * `OfflineAudioContext` renders, so an export applies the identical detector
 * math as monitoring.
 *
 * ## Gain-reduction curve (documented, deterministic)
 *
 * For each sample the detector takes the peak absolute input across the source
 * channels, then follows it with a one-pole envelope: the rising edge uses
 * `attackMs`, the falling edge uses `releaseMs` (both are time constants to
 * 63 %, not 90 % settle times). The envelope becomes a level in dBFS:
 *
 *   levelDb   = 20 * log10(envelope)
 *   overDb    = levelDb - thresholdDb                     (<= 0 → no reduction)
 *   targetDb  = min(maxReductionDb, overDb * (1 - 1 / ratio))
 *   targetGain = 10 ^ (-targetDb / 20)
 *
 * `maxReductionDb` is derived from the project's duck amount by
 * `amountToMaxReductionDb()` so the legacy `amount` field keeps its meaning:
 * amount 0.75 is a 12 dB maximum duck in both modes. The gain itself is then
 * smoothed with the same attack/release constants (closing = attack, opening =
 * release) so a fast level change cannot step the destination gain.
 *
 * Every block the processor posts a `{ reductionDb, gain }` metering message
 * (about 30 ms apart). That message is a measurement of the applied envelope —
 * the UI meter displays it, it never generates it.
 */

export const SIDECHAIN_DETECTOR_PROCESSOR = 'apex-sidechain-detector';

/** Metering cadence of the detector's `port.postMessage` (audio-thread measured). */
export const SIDECHAIN_DETECTOR_REPORT_INTERVAL_SECONDS = 0.03;

/**
 * Processor source. Kept as a string (rather than a separate worklet file) so
 * live playback, offline export and the unit tests can load the exact same code
 * without depending on bundler asset URLs — a Blob URL works in a normal
 * `AudioContext`, in an `OfflineAudioContext`, and the source is directly
 * executable by the Node test harness.
 */
export const SIDECHAIN_DETECTOR_SOURCE = `
class ApexSidechainDetectorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'thresholdDb', defaultValue: -18, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'maxReductionDb', defaultValue: 12, minValue: 0, maxValue: 48, automationRate: 'k-rate' },
      { name: 'attackMs', defaultValue: 5, minValue: 0.5, maxValue: 100, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 140, minValue: 5, maxValue: 1000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.envelope = 0;
    this.gain = 1;
    this.reductionDb = 0;
    this.reportIntervalBlocks = Math.max(1, Math.round(sampleRate * 0.03 / 128));
    this.blocksUntilReport = this.reportIntervalBlocks;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    const input = inputs[0];
    const channelCount = input ? input.length : 0;
    const frames = output.length;

    const thresholdDb = parameters.thresholdDb[0];
    const ratio = parameters.ratio[0];
    const maxReductionDb = parameters.maxReductionDb[0];
    const attackMs = parameters.attackMs[0];
    const releaseMs = parameters.releaseMs[0];

    const attackCoef = Math.exp(-1 / (Math.max(0.0005, attackMs * 0.001) * sampleRate));
    const releaseCoef = Math.exp(-1 / (Math.max(0.0005, releaseMs * 0.001) * sampleRate));
    const slope = 1 - 1 / Math.max(1, ratio);

    for (let i = 0; i < frames; i += 1) {
      let peak = 0;
      for (let c = 0; c < channelCount; c += 1) {
        const data = input[c];
        if (!data) continue;
        const value = data[i] < 0 ? -data[i] : data[i];
        if (value > peak) peak = value;
      }

      // Peak follower: attack while the level rises, release while it falls.
      const levelCoef = peak > this.envelope ? attackCoef : releaseCoef;
      this.envelope = levelCoef * this.envelope + (1 - levelCoef) * peak;

      const levelDb = 20 * Math.log10(this.envelope > 1e-7 ? this.envelope : 1e-7);
      const overDb = levelDb - thresholdDb;
      let targetReductionDb = 0;
      if (overDb > 0) {
        targetReductionDb = overDb * slope;
        if (targetReductionDb > maxReductionDb) targetReductionDb = maxReductionDb;
      }

      const targetGain = Math.pow(10, -targetReductionDb / 20);
      // Smooth the applied gain: closing follows attack, opening follows release.
      const gainCoef = targetGain < this.gain ? attackCoef : releaseCoef;
      this.gain = gainCoef * this.gain + (1 - gainCoef) * targetGain;
      output[i] = this.gain;
    }

    this.reductionDb = this.gain > 0 ? -20 * Math.log10(this.gain) : 48;

    this.blocksUntilReport -= 1;
    if (this.blocksUntilReport <= 0) {
      this.blocksUntilReport = this.reportIntervalBlocks;
      // Measured envelope, not a synthesised meter value.
      this.port.postMessage({ reductionDb: this.reductionDb, gain: this.gain });
    }

    return true;
  }
}

registerProcessor('${SIDECHAIN_DETECTOR_PROCESSOR}', ApexSidechainDetectorProcessor);
`;
