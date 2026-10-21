// Self-contained browser function: deliberately imports no application module.
export async function standaloneCapture(options: { seconds: number; workload: boolean; offlineWorkload?: boolean }) {
  const context = new AudioContext({ sampleRate: 44100 });
  await context.resume();
  const hash = (pcm: Float32Array) => {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let h = 2166136261;
    for (const byte of bytes) h = Math.imul(h ^ byte, 16777619) >>> 0;
    return h;
  };
  const code = `
    const hash = ${hash.toString()};
    class IntegrityTap extends AudioWorkletProcessor {
      constructor() {
        super(); this.sequence = 0; this.previous = null;
        this.port.onmessage = event => {
          this.window = event.data;
          this.port.postMessage({ kind: 'armed', frame: currentFrame, ...this.window });
        };
      }
      process(inputs, outputs) {
        const frame = currentFrame, time = currentTime;
        const output = outputs[0];
        for (const channel of output) channel.fill(0);
        if (!this.window || this.done) return true;
        const quantum = output[0].length;
        const input = inputs[0];
        const pcm = input[0] ? input[0].slice() : new Float32Array(quantum);
        const record = { kind: 'block', sequence: this.sequence++, frame,
          frameAfterCopy: currentFrame, time, quantum,
          inputChannels: input.length, inputLengths: input.map(c => c.length),
          deltaInProcessor: this.previous === null ? null : frame - this.previous,
          checksum: hash(pcm), pcm: pcm.buffer };
        this.previous = frame;
        this.port.postMessage(record, [pcm.buffer]);
        if (frame + quantum >= this.window.endFrame || this.sequence > this.window.maxBlocks) {
          this.done = true;
          this.port.postMessage({ kind: 'end', sequence: this.sequence,
            frame, quantum, reason: frame + quantum >= this.window.endFrame ? 'frame-end' : 'safety-limit' });
        }
        return true;
      }
    }
    registerProcessor('integrity-tap', IntegrityTap);
  `;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(context, 'integrity-tap', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit',
  });
  tap.connect(context.destination);
  const sr = context.sampleRate;
  // Select the window by frame after retaining messages, never by main-thread boolean.
  const startFrame = Math.ceil((context.currentTime + 0.2) * sr / 128) * 128;
  const endFrame = startFrame + Math.round(options.seconds * sr);
  const sourceStartFrame = startFrame + Math.round(0.15 * sr);
  const sourceFrames = Math.round((options.seconds - 0.3) * sr);
  const buffer = context.createBuffer(1, sourceFrames, sr);
  const sourcePcm = buffer.getChannelData(0);
  let seed = 0x7135ace1;
  for (let i = 0; i < sourceFrames; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    sourcePcm[i] = ((seed >>> 0) / 0x100000000 - 0.5) * 0.5;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(tap);
  const received: any[] = [];
  const storage = new Set<ArrayBuffer>();
  let aliasCount = 0;
  const messages: any[] = [];
  let resolveEnd!: () => void;
  const finished = new Promise<void>(resolve => { resolveEnd = resolve; });
  tap.port.onmessage = event => {
    const message = event.data;
    if (message.kind !== 'block') {
      messages.push(message);
      if (message.kind === 'end') resolveEnd();
      return;
    }
    const pcm = new Float32Array(message.pcm);
    if (storage.has(pcm.buffer)) aliasCount++;
    storage.add(pcm.buffer);
    // Private receiver storage, never exposed for mutation until serialization.
    const { pcm: transferred, ...metadata } = message;
    received.push(Object.freeze({ metadata: Object.freeze(metadata), pcm, initialHash: hash(pcm) }));
  };
  tap.port.postMessage({ startFrame, endFrame, maxBlocks: Math.ceil((options.seconds + 1) * sr / 128) + 1000 });
  source.start(sourceStartFrame / sr);
  let workTicks = 0;
  let offlineRenders = 0;
  let offlineActive = true;
  const offlineTask = options.offlineWorkload ? (async () => {
    while (offlineActive) {
      const offline = new OfflineAudioContext(1, 44100, 44100);
      const oscillator = offline.createOscillator();
      oscillator.connect(offline.destination); oscillator.start();
      await offline.startRendering(); offlineRenders++;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  })() : Promise.resolve();
  const workload = options.workload ? setInterval(() => {
    const until = performance.now() + 12;
    while (performance.now() < until) Math.sqrt(++workTicks);
  }, 20) : undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([finished, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Missing explicit worklet end marker')), (options.seconds + 10) * 1000);
    })]);
    // The end marker shares the FIFO port with all blocks. Leave an additional
    // drain interval, retaining all messages, and verify hashes after this delay.
    await new Promise(resolve => setTimeout(resolve, 100));
    const changedBlocks = received.filter(r => hash(r.pcm) !== r.initialHash).length;
    const checksumFailures = received.filter(r => hash(r.pcm) !== r.metadata.checksum).length;
    return {
      environment: { userAgent: navigator.userAgent, sampleRate: sr, contextState: context.state,
        baseLatency: context.baseLatency, outputLatency: context.outputLatency,
        channelCount: 1, durationSeconds: options.seconds, workload: options.workload, workTicks, offlineRenders },
      startFrame, endFrame, sourceStartFrame, sourceFrames, seed: '0x7135ace1',
      aliasCount, changedBlocks, checksumFailures, messages,
      records: received.map(r => ({ ...r.metadata, pcm: Array.from(r.pcm) })),
    };
  } finally {
    offlineActive = false;
    await offlineTask;
    clearTimeout(timeout);
    clearInterval(workload);
    source.disconnect(); tap.disconnect(); tap.port.close();
    await context.close();
  }
}
