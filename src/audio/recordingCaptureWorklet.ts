/**
 * Sample-clocked microphone capture used by RecordingEngine.
 *
 * MediaRecorder has neither a sample-frame start API nor timestamps for its
 * encoded payload, so a blob cannot be trimmed back to a trustworthy musical
 * boundary after an asynchronous start. This worklet forwards input PCM in
 * ordered blocks stamped with AudioWorklet's `currentFrame`; the main thread
 * keeps a bounded pre-roll and selects the exact frame window before WAV
 * encoding. The worklet is deliberately free of project/UI policy.
 */
export const RECORDING_CAPTURE_PROCESSOR = 'apex-recording-capture';
export const RECORDING_CAPTURE_PACKET_FRAMES = 2048;

/**
 * Maximum retained pre-roll in RecordingEngine. Two 4/4 bars at the minimum
 * supported 20 BPM take 24 seconds; 60 seconds leaves room for late JS delivery
 * while remaining a bounded buffer (about 23 MiB for 48 kHz stereo float PCM).
 */
export const RECORDING_CAPTURE_PREROLL_SECONDS = 60;

/** Loaded into each AudioContext with `audioWorklet.addModule`. */
export const RECORDING_CAPTURE_WORKLET_SOURCE = `
class ApexRecordingCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options && options.processorOptions ? options.processorOptions : {};
    this.packetFrames = Math.max(128, Math.floor(processorOptions.packetFrames || ${RECORDING_CAPTURE_PACKET_FRAMES}));
    this.inputChannels = 0;
    this.packetChannels = 0;
    this.packet = null;
    this.packetFill = 0;
    this.packetStartFrame = 0;
    this.captureStartFrame = null;
    this.stopFrame = null;
    this.pauseStartFrame = null;
    this.resumeFrame = null;
    this.sessionId = 0;
    this.nextFrame = null;
    this.stopped = false;
    this.port.onmessage = event => this.handleCommand(event && event.data);
    this.port.postMessage({ type: 'ready', sampleRate: sampleRate });
  }

  process(inputs, outputs) {
    const output = outputs && outputs[0] ? outputs[0] : [];
    for (const channel of output) channel.fill(0);
    if (this.stopped) return true;

    const input = inputs && inputs[0] ? inputs[0] : [];
    const frameCount = output[0] ? output[0].length : (input[0] ? input[0].length : 128);
    const frameStart = currentFrame;
    const channelCount = input.length || this.inputChannels || 1;
    if (channelCount > 32) {
      this.fail('The selected input exposes more than 32 channels, which this capture path cannot store.');
      return true;
    }
    if (channelCount !== this.inputChannels) {
      if (this.inputChannels !== 0 && this.captureStartFrame !== null) {
        this.fail('The input channel layout changed during recording; the take was discarded.');
        return true;
      }
      this.flushPacket();
      this.inputChannels = channelCount;
      this.packetChannels = channelCount;
      this.packet = new Float32Array(this.packetFrames * channelCount);
    }

    for (let offset = 0; offset < frameCount; offset++) {
      const frame = frameStart + offset;
      if (this.stopFrame !== null && frame >= this.stopFrame) {
        this.nextFrame = frame;
        this.finishAtStop(frame);
        return true;
      }

      // Keep frame coverage continuous even while the UI is paused. The main
      // thread applies the exact pause intervals at finalization; suppressing
      // samples here would make a late resume message create an unrecoverable
      // hole around the resume boundary.
      const inCaptureRange = this.captureStartFrame === null || frame >= this.captureStartFrame;
      if (inCaptureRange) {
        if (this.packetFill > 0 && this.packetStartFrame + this.packetFill !== frame) this.flushPacket();
        if (this.packetFill === 0) this.packetStartFrame = frame;
        for (let channel = 0; channel < channelCount; channel++) {
          const sample = input[channel] && offset < input[channel].length ? input[channel][offset] : 0;
          this.packet[this.packetFill * channelCount + channel] = Number.isFinite(sample) ? sample : 0;
        }
        this.packetFill++;
        if (this.packetFill >= this.packetFrames) this.flushPacket();
      }
    }

    this.nextFrame = frameStart + frameCount;
    if (this.stopFrame !== null && this.nextFrame >= this.stopFrame) this.finishAtStop(this.stopFrame);
    return true;
  }

  handleCommand(command) {
    if (!command || typeof command !== 'object' || this.stopped) return;
    if (command.type === 'start') {
      if (!Number.isSafeInteger(command.startFrame) || command.startFrame < 0) {
        this.fail('The requested capture start frame is invalid.');
        return;
      }
      this.flushPacket();
      this.sessionId = command.sessionId;
      this.captureStartFrame = command.startFrame;
      this.stopFrame = null;
      this.pauseStartFrame = null;
      this.resumeFrame = null;
      this.port.postMessage({ type: 'started', sessionId: this.sessionId, startFrame: this.captureStartFrame });
      return;
    }
    if (command.sessionId !== this.sessionId) return;
    if (command.type === 'pause') {
      if (!Number.isSafeInteger(command.frame)) return;
      this.flushPacket();
      this.pauseStartFrame = command.frame;
      this.resumeFrame = null;
      this.port.postMessage({ type: 'paused', sessionId: this.sessionId, frame: command.frame });
      return;
    }
    if (command.type === 'resume') {
      if (!Number.isSafeInteger(command.frame)) return;
      this.flushPacket();
      this.resumeFrame = command.frame;
      this.port.postMessage({ type: 'resumed', sessionId: this.sessionId, frame: command.frame });
      return;
    }
    if (command.type === 'stop') {
      if (!Number.isSafeInteger(command.stopFrame) || this.captureStartFrame === null) {
        this.fail('The requested capture stop frame is invalid.');
        return;
      }
      this.stopFrame = command.stopFrame;
      if (this.nextFrame !== null && this.nextFrame >= this.stopFrame) this.finishAtStop(this.nextFrame);
      return;
    }
    if (command.type === 'cancel') {
      this.packetFill = 0;
      this.stopped = true;
    }
  }

  flushPacket() {
    if (this.packetFill <= 0 || !this.packet || this.packetChannels <= 0) return;
    const sampleCount = this.packetFill * this.packetChannels;
    const samples = this.packetFill === this.packetFrames
      ? this.packet
      : this.packet.slice(0, sampleCount);
    if (samples === this.packet) this.packet = new Float32Array(this.packetFrames * this.packetChannels);
    this.port.postMessage({
      type: 'samples',
      frameStart: this.packetStartFrame,
      frameCount: this.packetFill,
      channelCount: this.packetChannels,
      samples: samples,
    }, [samples.buffer]);
    this.packetFill = 0;
  }

  finishAtStop(processedThroughFrame) {
    if (this.stopped) return;
    this.flushPacket();
    this.stopped = true;
    this.port.postMessage({
      type: 'stopped',
      sessionId: this.sessionId,
      stopFrame: this.stopFrame,
      processedThroughFrame: processedThroughFrame,
      channelCount: this.inputChannels || 1,
    });
  }

  fail(message) {
    if (this.stopped) return;
    this.stopped = true;
    this.packetFill = 0;
    this.port.postMessage({ type: 'failure', sessionId: this.sessionId, message: message });
  }
}

registerProcessor('${RECORDING_CAPTURE_PROCESSOR}', ApexRecordingCaptureProcessor);
`;
