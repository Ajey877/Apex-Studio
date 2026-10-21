// Test-only browser function; no Apex import. All invocations, even startup,
// are captured before readiness, arm and end markers are interpreted.
export async function captureWithReadiness(options: { runId: string; seconds: number; workload: boolean; mode?: 'lead' | 'no-ready' | 'immediate' | 'generated' }) {
  const mode = options.mode ?? 'lead';
  const lifecycle: any[] = [];
  const ctx = new AudioContext({ sampleRate: 44100 });
  const rate = ctx.sampleRate;
  const requiredQuanta = 32;
  const trace = (name: string, detail: any = {}) => lifecycle.push({ name, runId: options.runId,
    contextId: options.runId, frame: Math.round(ctx.currentTime * rate), state: ctx.state, time: performance.now(), ...detail });
  trace('context-created');
  const checksum = (pcm: Float32Array) => {
    let hash = 2166136261;
    for (const byte of new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
  };
  const code = `
    const checksum = ${checksum.toString()};
    class ReadyTap extends AudioWorkletProcessor {
      constructor(options) {
        super(); this.id = options.processorOptions.runId;
        this.required = options.processorOptions.requiredQuanta;
        this.mode = options.processorOptions.mode; this.instanceId = this.id + ':processor-0';
        this.lastTransferBytes = null;
        this.sequence = 0; this.previousEnd = null; this.streak = 0; this.ready = false;
        this.port.onmessage = event => {
          const command = event.data;
          if (command.runId !== this.id || this.window || (!this.ready && this.mode !== 'no-ready')) {
            this.port.postMessage({ kind: 'protocol-error', runId: this.id, command }); return;
          }
          this.window = command;
          this.port.postMessage({ kind: 'armed', runId: this.id, instanceId: this.instanceId, callbackCount: this.sequence, frame: currentFrame, currentTime,
            tooLate: currentFrame >= command.startFrame, ...command });
        };
      }
      process(inputs, outputs) {
        const frame = currentFrame;
        const output = outputs[0] || [];
        const quantum = output[0]?.length || 0;
        for (const channel of output) channel.fill(0);
        const input = inputs[0] || [];
        const pcm = input[0] ? input[0].slice() : new Float32Array(quantum);
        if (this.mode === 'generated') {
          for (let i = 0; i < quantum; i++) {
            let x = ((frame + i) ^ 0x7135ace1) >>> 0;
            x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
            pcm[i] = ((x >>> 0) / 0x100000000 - 0.5) * 0.5;
          }
          output[0].set(pcm);
        }
        const contiguous = this.previousEnd === null || frame === this.previousEnd;
        this.streak = contiguous ? this.streak + 1 : 1;
        const sequence = this.sequence++;
        this.port.postMessage({ kind: 'block', runId: this.id, instanceId: this.instanceId, sequence, callbackCount: this.sequence, frame,
          currentTime, frameAtExit: currentFrame, previousTransferBytes: this.lastTransferBytes,
          frameAfterCopy: currentFrame, sampleRate, quantum,
          inputChannels: input.length, inputLengths: input.map(c => c.length),
          outputChannels: output.length, outputLengths: output.map(c => c.length),
          previousEnd: this.previousEnd, contiguous, streak: this.streak,
          processorState: this.window ? 'armed' : this.ready ? 'ready' : 'warming',
          checksum: checksum(pcm), pcm: pcm.buffer }, [pcm.buffer]);
        this.lastTransferBytes = pcm.byteLength;
        this.previousEnd = frame + quantum;
        if (!this.ready && this.streak >= this.required && quantum > 0) {
          this.ready = true;
          this.port.postMessage({ kind: 'ready', runId: this.id, sequence, frame,
            endFrame: frame + quantum, streak: this.streak, required: this.required, sampleRate });
        }
        if (this.window && frame + quantum >= this.window.endFrame) {
          this.port.postMessage({ kind: 'end', runId: this.id, frame, quantum,
            blocks: this.sequence, instanceId: this.instanceId, lastTransferBytes: this.lastTransferBytes, endFrame: this.window.endFrame });
          return false;
        }
        return true;
      }
    }
    registerProcessor('ready-tap', ReadyTap);
  `;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(ctx, 'ready-tap', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit',
    processorOptions: { runId: options.runId, requiredQuanta, mode },
  });
  const blocks: any[] = [], markers: any[] = [], stateChanges: any[] = [];
  const storage = new Set<ArrayBuffer>();
  let aliasCount = 0, wrongRunIds = 0, readyAck: any;
  let resolveReady!: () => void, resolveEnd!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const end = new Promise<void>(resolve => { resolveEnd = resolve; });
  const arrival = () => ({ mainContextState: ctx.state, arrivalTime: performance.now() });
  tap.port.onmessage = event => {
    const record = event.data;
    if (record.runId !== options.runId) wrongRunIds++;
    if (record.kind === 'block') {
      const pcm = new Float32Array(record.pcm);
      if (storage.has(pcm.buffer)) aliasCount++;
      storage.add(pcm.buffer);
      const { pcm: transferred, ...metadata } = record;
      blocks.push(Object.freeze({ metadata: Object.freeze({ ...metadata, ...arrival() }), pcm, initialHash: checksum(pcm) }));
    } else {
      markers.push(Object.freeze({ ...record, ...arrival() }));
      if (record.kind === 'ready') { trace('ready-received', { acknowledgement: record }); readyAck = record; resolveReady(); }
      if (record.kind === 'armed') trace('arm-received', { acknowledgement: record });
      if (record.kind === 'end') { trace('end-received', { acknowledgement: record }); resolveEnd(); }
    }
  };
  ctx.onstatechange = () => { stateChanges.push({ state: ctx.state, time: ctx.currentTime }); trace('context-statechange'); };
  const sourceFrames = Math.round(options.seconds * rate);
  const buffer = ctx.createBuffer(1, sourceFrames, rate);
  let seed = 0x7135ace1;
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    data[i] = ((seed >>> 0) / 0x100000000 - 0.5) * 0.5;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (mode !== 'generated') source.connect(tap);
  tap.connect(ctx.destination); trace('graph-connected');
  const timers: ReturnType<typeof setTimeout>[] = [];
  const wait = (promise: Promise<void>, label: string) => Promise.race([promise,
    new Promise<void>((_, reject) => { timers.push(setTimeout(() => reject(new Error(label)), (options.seconds + 10) * 1000)); })]);
  let window: any = null, error: string | null = null, workTicks = 0;
  let workload: ReturnType<typeof setInterval> | undefined;
  try {
    trace('resume-requested'); await ctx.resume(); trace('resume-resolved');
    if (mode !== 'no-ready') await wait(ready, 'readiness-timeout');
    if (ctx.state !== 'running') throw new Error('Context not running at scheduling');
    // No fixed quantum assumption: sample-frame schedule, 250 ms scheduling lead,
    // 100 ms checked silence before the source, 150 ms checked tail afterward.
    const startFrame = Math.ceil((ctx.currentTime + (mode === 'immediate' ? 0 : 0.25)) * rate);
    const sourceStartFrame = startFrame + Math.round((mode === 'immediate' ? 0 : 0.1) * rate);
    const endFrame = sourceStartFrame + sourceFrames + Math.round(0.15 * rate);
    window = { runId: options.runId, startFrame, sourceStartFrame, sourceFrames, endFrame,
      scheduledAtFrame: Math.round(ctx.currentTime * rate), readyEndFrame: readyAck?.endFrame ?? null };
    trace('arm-sent', { window }); tap.port.postMessage(window);
    if (mode !== 'generated') { trace('source-start-call', { sourceStartFrame }); source.start(sourceStartFrame / rate); trace('source-start-return'); }
    else trace('no-buffer-source');
    workload = options.workload ? setInterval(() => {
      const until = performance.now() + 12;
      while (performance.now() < until) Math.sqrt(++workTicks);
    }, 20) : undefined;
    await wait(end, 'end-marker-timeout');
    await new Promise(resolve => setTimeout(resolve, 100)); trace('drain-complete');
  } catch (failure) { error = String(failure); }
  finally {
    clearInterval(workload); for (const timer of timers) clearTimeout(timer);
    trace('disconnect-call'); source.disconnect(); tap.disconnect();
    trace('close-call'); await ctx.close(); trace('close-resolved');
    // Retain all queued messages, even after close. No main-thread capture flag.
    await new Promise(resolve => setTimeout(resolve, 100));
    trace('port-close-call'); tap.port.close();
  }
  return {
    protocol: 'readiness-v2', mode, lifecycle, contextId: options.runId, runId: options.runId, requiredQuanta, window, error,
    sampleRate: rate, seed: '0x7135ace1', sourceFrames, stateChanges, markers,
    environment: { userAgent: navigator.userAgent, sampleRate: rate, channelCount: 1,
      seconds: options.seconds, workload: options.workload, workTicks, baseLatency: ctx.baseLatency },
    aliasCount, wrongRunIds,
    changedBlocks: blocks.filter(b => checksum(b.pcm) !== b.initialHash).length,
    checksumFailures: blocks.filter(b => checksum(b.pcm) !== b.metadata.checksum).length,
    records: blocks.map(b => ({ ...b.metadata, pcm: Array.from(b.pcm) })),
  };
}
