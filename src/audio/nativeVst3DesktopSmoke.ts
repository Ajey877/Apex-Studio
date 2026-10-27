import { nativeTarget } from './nativeVst3Automation';
// Executed ONLY by the existing packaged-runtime smoke launch flag. This calls
// the production engine/registry/export path, not an alternate WAV renderer.
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { getVst3Bridge, type Vst3Effect } from './nativeVst3Types';
import { VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES, getNativeVst3MixerEffectSmokeTiming, resetNativeVst3MixerEffectSmokeTiming, getVst3MixerEffectDiagnostics } from './nativeVst3EffectRuntime';
import { getVst3Diagnostics } from './nativeVst3Runtime';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { persistProjectState, restorePersistedProjectState, serializeProjectState } from '../state/projectPersistence';
import type { Channel, FxSlot, MixerTrack, PlaylistClip } from '../types/daw';

type MixerCaptureBlock = { frame: number; samples: Float32Array };
type MixerCapture = { blocks: MixerCaptureBlock[]; node: AudioWorkletNode; sink: GainNode };
type PlanarPcm = { left: Float32Array; right: Float32Array; frames: number; rms: number; startFrame: number | null };
const captureModuleByContext = new WeakMap<BaseAudioContext, Promise<string>>();

async function attachMixerCapture(instance: typeof audioEngine, trackId: number): Promise<MixerCapture> {
  const context = instance.getContext() as AudioContext;
  const mixer = instance.getOrCreateMixerChannel(trackId);
  let module = captureModuleByContext.get(context);
  if (!module) {
    module = (async () => {
      const name = `apex-packaged-mixer-capture-${crypto.randomUUID().replaceAll('-', '')}`;
      const source = `class ApexPackagedMixerCapture extends AudioWorkletProcessor {
        constructor(){super();this.left=new Float32Array(1024);this.right=new Float32Array(1024);this.fill=0;}
        process(inputs,outputs){const output=outputs[0];if(output)for(const channel of output)channel.fill(0);
          const input=inputs[0],left=input&&input[0],right=input&&(input[1]||input[0]);if(left&&right){
            for(let i=0;i<left.length;i++){this.left[this.fill]=left[i];this.right[this.fill]=right[i];
              if(++this.fill===1024){const pcm=new Float32Array(2048);pcm.set(this.left);pcm.set(this.right,1024);
                this.port.postMessage({frame:currentFrame+i+1-1024,samples:pcm},[pcm.buffer]);this.fill=0;}}
          }return true;}
      } registerProcessor('${name}',ApexPackagedMixerCapture);`;
      const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      return name;
    })();
    captureModuleByContext.set(context, module);
  }
  const name = await module;
  const node = new AudioWorkletNode(context, name, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
    channelCountMode: 'explicit', channelInterpretation: 'speakers',
  });
  const blocks: MixerCaptureBlock[] = [];
  node.port.onmessage = event => {
    const value = event.data;
    if (value && Number.isInteger(value.frame) && value.samples instanceof Float32Array && blocks.length < 512) {
      blocks.push({ frame: value.frame, samples: value.samples });
    }
  };
  const sink = context.createGain();
  sink.gain.value = 0;
  mixer.analyser.connect(node); node.connect(sink); sink.connect(context.destination);
  return { blocks, node, sink };
}

function toPlanarPcm(blocks: MixerCaptureBlock[], startFrame = -Infinity, endFrame = Infinity): PlanarPcm {
  const selected = blocks.filter(block => block.frame >= startFrame && block.frame + VST3_FX_BLOCK_FRAMES <= endFrame);
  const frames = selected.length * VST3_FX_BLOCK_FRAMES;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  let square = 0, samples = 0;
  selected.forEach(({ samples: block }, index) => {
    if (block.length !== VST3_FX_BLOCK_FRAMES * 2) throw new Error('Packaged Mixer capture returned malformed stereo PCM');
    left.set(block.subarray(0, VST3_FX_BLOCK_FRAMES), index * VST3_FX_BLOCK_FRAMES);
    right.set(block.subarray(VST3_FX_BLOCK_FRAMES), index * VST3_FX_BLOCK_FRAMES);
    for (const value of block) { square += value * value; samples++; }
  });
  return { left, right, frames, rms: samples ? Math.sqrt(square / samples) : 0, startFrame: selected[0]?.frame ?? null };
}

function findPcmAlignment(reference: PlanarPcm, candidate: PlanarPcm, maximumOffsetFrames: number, label: string): number {
  let bestOffset = 0, bestScore = -Infinity;
  const stride = 32, lagStep = 32;
  for (let offset = -maximumOffsetFrames; offset <= maximumOffsetFrames; offset += lagStep) {
    const refStart = Math.max(0, -offset), candidateStart = Math.max(0, offset);
    const count = Math.min(reference.frames - refStart, candidate.frames - candidateStart);
    if (count < 1024) continue;
    let dot = 0, refEnergy = 0, candidateEnergy = 0;
    for (let frame = 0; frame < count; frame += stride) {
      const a = (reference.left[refStart + frame]! + reference.right[refStart + frame]!) * 0.5;
      const b = (candidate.left[candidateStart + frame]! + candidate.right[candidateStart + frame]!) * 0.5;
      dot += a * b; refEnergy += a * a; candidateEnergy += b * b;
    }
    const score = dot / Math.sqrt(Math.max(1e-30, refEnergy * candidateEnergy));
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  if (bestScore < 0.2) throw new Error(`${label} Mixer PCM could not be aligned deterministically (correlation=${bestScore}, referenceRms=${reference.rms}, candidateRms=${candidate.rms})`);
  return bestOffset;
}

function alignedDifference(reference: PlanarPcm, candidate: PlanarPcm, offsetFrames: number) {
  const refStart = Math.max(0, -offsetFrames), candidateStart = Math.max(0, offsetFrames);
  const frames = Math.min(reference.frames - refStart, candidate.frames - candidateStart);
  let difference = 0, energy = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (const [a, b] of [[reference.left[refStart + frame]!, candidate.left[candidateStart + frame]!],
      [reference.right[refStart + frame]!, candidate.right[candidateStart + frame]!] ] as const) {
      difference += (a - b) ** 2; energy += a * a;
    }
  }
  return { frames, rmsDifference: frames ? Math.sqrt(difference / (frames * 2)) : 0,
    referenceRms: frames ? Math.sqrt(energy / (frames * 2)) : 0 };
}

function compareMixerRuns(reference: any, candidate: any, trackId: number, maximumOffsetFrames: number, label: string) {
  const left = reference.pcm.get(trackId) as PlanarPcm | undefined;
  const right = candidate.pcm.get(trackId) as PlanarPcm | undefined;
  if (!left || !right || left.startFrame === null || right.startFrame === null) throw new Error(`Packaged Mixer capture missing track ${trackId} PCM`);
  const offsetFrames = findPcmAlignment(left, right, maximumOffsetFrames, `${label}, track ${trackId}`);
  const difference = alignedDifference(left, right, offsetFrames);
  const playbackStartDeltaFrames = candidate.startedContextFrame - reference.startedContextFrame;
  const normalizedLagFrames = right.startFrame + offsetFrames - left.startFrame - playbackStartDeltaFrames;
  return { ...difference, offsetFrames, normalizedLagFrames };
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianMs: null, p95Ms: null, maxMs: null };
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
  return { count: sorted.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted[sorted.length - 1]! };
}

function summarizeMixerTiming(events: ReturnType<typeof getNativeVst3MixerEffectSmokeTiming>, ipc: any, sampleRate: number, captureDurationMs: number, stopRequestedAtRendererMs: number) {
  const submissions = new Map(events.filter(event => event.event === 'worklet-submit' && typeof event.requestId === 'string').map(event => [event.requestId!, event]));
  const isMeasuredRequest = (requestId: unknown): requestId is string => typeof requestId === 'string' && submissions.has(requestId);
  const results = new Map(events.filter(event => event.event === 'worklet-result' && isMeasuredRequest(event.requestId)).map(event => [event.requestId!, event]));
  const rendererResponses = new Map(events.filter(event => event.event === 'renderer-bridge-response' && isMeasuredRequest(event.requestId)).map(event => [event.requestId!, event]));
  const preload = new Map<string, any>((ipc?.preload ?? []).filter((event: any) => isMeasuredRequest(event.requestId)).map((event: any) => [event.requestId, event]));
  const main = new Map<string, any>((ipc?.main?.processAudio ?? []).filter((event: any) => isMeasuredRequest(event.requestId)).map((event: any) => [event.requestId, event]));
  const requestEvents = new Map(events.filter(event => event.event === 'renderer-request-received' && isMeasuredRequest(event.requestId)).map(event => [event.requestId!, event]));
  const bridgeStarts = new Map(events.filter(event => event.event === 'renderer-bridge-call-start' && isMeasuredRequest(event.requestId)).map(event => [event.requestId!, event]));
  const stopCancellationWindowMs = VST3_FX_BLOCK_FRAMES * 1000 / sampleRate + 2;
  const nativeCancelledAtStopRequestIds = new Set<string>();
  const rendererDiscardedAtStopRequestIds = new Set<string>();
  const unexpectedDisposalDiscardRequestIds = new Set<string>();
  for (const [requestId, timing] of main) {
    const start = bridgeStarts.get(requestId);
    const ageAtStopMs = stopRequestedAtRendererMs - Number(start?.bridgeCallStartedAt);
    if (timing.error === 'VST3 instance cancelled' && !rendererResponses.has(requestId) &&
        Number.isFinite(ageAtStopMs) && ageAtStopMs >= 0 && ageAtStopMs <= stopCancellationWindowMs) {
      nativeCancelledAtStopRequestIds.add(requestId);
    }
  }
  for (const event of events.filter(event => event.event === 'result-discarded-after-disposal' && isMeasuredRequest(event.requestId))) {
    const start = bridgeStarts.get(event.requestId!);
    const ageAtStopMs = stopRequestedAtRendererMs - Number(start?.bridgeCallStartedAt);
    const responseAgeMs = Number(event.rendererAtMs) - stopRequestedAtRendererMs;
    if (Number.isFinite(ageAtStopMs) && ageAtStopMs >= 0 && ageAtStopMs <= stopCancellationWindowMs &&
        Number.isFinite(responseAgeMs) && responseAgeMs >= 0 && responseAgeMs <= stopCancellationWindowMs) {
      rendererDiscardedAtStopRequestIds.add(event.requestId!);
    } else {
      unexpectedDisposalDiscardRequestIds.add(event.requestId!);
    }
  }
  const stopCancelledRequestIds = new Set([...nativeCancelledAtStopRequestIds, ...rendererDiscardedAtStopRequestIds]);
  const workletReceiptMs: number[] = [], rendererDispatchMs: number[] = [], rendererQueueWaitMs: number[] = [];
  const rendererBridgeRoundTripMs: number[] = [], preloadIpcRttMs: number[] = [], mainDispatchMs: number[] = [], helperServiceMs: number[] = [];
  const scheduledOutputSlackMs: number[] = [];
  let missedDeadlines = events.filter(event => event.event === 'deadline-miss' || event.event === 'pending-deadline-miss').length;
  let acceptedResults = 0;
  for (const [requestId, result] of results) {
    if (result.accepted === true) acceptedResults++;
    const submit = submissions.get(requestId);
    if (!submit) continue;
    const latency = (Number(result.receivedOutputFrame) - Number(submit.submittedOutputFrame)) * 1000 / sampleRate;
    if (Number.isFinite(latency) && latency >= 0) workletReceiptMs.push(latency);
    const slack = (Number(result.dueOutputFrame) - Number(result.receivedOutputFrame)) * 1000 / sampleRate;
    if (Number.isFinite(slack)) scheduledOutputSlackMs.push(slack);
    if (Number(result.receivedOutputFrame) > Number(result.dueOutputFrame)) missedDeadlines++;
  }
  for (const [requestId, request] of requestEvents) {
    const contextFrames = Number(request.requestReceivedContextFrame) - Number(request.submittedContextFrame);
    if (Number.isFinite(contextFrames) && contextFrames >= 0) rendererDispatchMs.push(contextFrames * 1000 / sampleRate);
    const start = bridgeStarts.get(requestId);
    if (start && Number.isFinite(Number(start.bridgeCallStartedAt) - Number(request.requestReceivedAt))) {
      rendererQueueWaitMs.push(Number(start.bridgeCallStartedAt) - Number(request.requestReceivedAt));
    }
  }
  for (const event of events) if (event.event === 'renderer-bridge-response' && isMeasuredRequest(event.requestId) && Number.isFinite(Number(event.bridgeRoundTripMs))) rendererBridgeRoundTripMs.push(Number(event.bridgeRoundTripMs));
  for (const timing of preload.values()) if (Number.isFinite(timing.rendererIpcRttMs)) preloadIpcRttMs.push(timing.rendererIpcRttMs);
  const cancellationServiceMs: number[] = [];
  for (const [requestId, timing] of main) {
    if (Number.isFinite(timing.nativeServiceCallMs)) {
      if (nativeCancelledAtStopRequestIds.has(requestId)) cancellationServiceMs.push(timing.nativeServiceCallMs);
      else if (!timing.error) helperServiceMs.push(timing.nativeServiceCallMs);
    }
    const dispatchMs = Number(timing.serviceStartAtMainMs) - Number(timing.ipcReceivedAtMainMs);
    if (Number.isFinite(dispatchMs) && dispatchMs >= 0) mainDispatchMs.push(dispatchMs);
  }
  const queueDepths = [...requestEvents.values()].map(event => Number(event.queueDepth)).filter(Number.isFinite);
  const blocks = [...main.values()].filter((event: any) => !event.error).length;
  return {
    blockFrames: VST3_FX_BLOCK_FRAMES, pipelineFramesPerEffect: VST3_FX_PIPELINE_FRAMES,
    blockPeriodMs: VST3_FX_BLOCK_FRAMES * 1000 / sampleRate,
    captureDurationMs, processingBlocks: blocks, acceptedWorkletResults: acceptedResults,
    submittedBlocks: submissions.size, cancelledAtStopBlocks: stopCancelledRequestIds.size,
    nativeCancelledAtStopBlocks: nativeCancelledAtStopRequestIds.size,
    rendererDiscardedAtStopBlocks: rendererDiscardedAtStopRequestIds.size,
    unexpectedDisposalDiscards: [...unexpectedDisposalDiscardRequestIds],
    stopCancellationWindowMs, stopCancellationServiceCall: distribution(cancellationServiceMs),
    throughputBlocksPerSecond: captureDurationMs > 0 ? blocks * 1000 / captureDurationMs : 0,
    workletSubmissionToReceipt: distribution(workletReceiptMs),
    rendererAudioDispatch: distribution(rendererDispatchMs), rendererSerializedQueueWait: distribution(rendererQueueWaitMs),
    rendererBridgeRoundTrip: distribution(rendererBridgeRoundTripMs),
    rendererPreloadIpcRoundTrip: distribution(preloadIpcRttMs), mainIpcDispatch: distribution(mainDispatchMs),
    mainNativeServiceCall: distribution(helperServiceMs), scheduledOutputSlack: distribution(scheduledOutputSlackMs),
    maxPerInstanceQueueDepth: queueDepths.length ? Math.max(...queueDepths) : 0,
    maxConcurrentMainServiceCalls: ipc?.main?.maximumConcurrentProcessAudioCalls ?? 0,
    maxConcurrentCallsPerEffect: ipc?.main?.maximumConcurrentCallsPerEffect ?? 0,
    nativeServiceSessionCountAfterCleanup: ipc?.main?.nativeServiceSessionCount ?? -1,
    missedDeadlines, requestCount: submissions.size,
    profileEventCount: events.filter(event => event.requestId === undefined || isMeasuredRequest(event.requestId)).length,
    requestFailures: [...main].filter(([requestId, event]: [string, any]) => !!event.error && !stopCancelledRequestIds.has(requestId)).map(([, event]: [string, any]) => event.error),
    unexpectedStopCancellations: [...main].filter(([requestId, event]: [string, any]) => event.error === 'VST3 instance cancelled' && !nativeCancelledAtStopRequestIds.has(requestId)).map(([requestId]: [string, any]) => requestId),
    missingMainResponses: [...submissions.keys()].filter(requestId => !main.has(requestId)).length,
    missingWorkletResults: [...submissions.keys()].filter(requestId => !results.has(requestId) && !stopCancelledRequestIds.has(requestId)).length,
    rendererResponseCount: rendererResponses.size,
  };
}

function correlatedTimingSamples(run: any) {
  const measuredRequestIds = new Set((run.runtimeEvents as Array<Record<string, any>>)
    .filter(event => event.event === 'worklet-submit' && typeof event.requestId === 'string').map(event => event.requestId));
  const samples = new Map<string, Record<string, unknown>>();
  const sampleFor = (requestId: string) => {
    let sample = samples.get(requestId);
    if (!sample) { sample = { requestId }; samples.set(requestId, sample); }
    return sample;
  };
  for (const event of run.runtimeEvents as Array<Record<string, any>>) {
    if (typeof event.requestId !== 'string' || !measuredRequestIds.has(event.requestId)) continue;
    const sample = sampleFor(event.requestId);
    if (event.event === 'worklet-submit') Object.assign(sample, {
      inputBlockStartContextFrame: event.inputBlockStartContextFrame,
      rendererSubmissionContextFrame: event.submittedContextFrame,
      submittedOutputFrame: event.submittedOutputFrame, dueOutputFrame: event.dueOutputFrame,
      dueContextFrame: event.dueContextFrame, submitProfileReceivedAtRendererMs: event.rendererAtMs,
    });
    if (event.event === 'renderer-request-received') Object.assign(sample, {
      rendererRequestReceivedAtMs: event.requestReceivedAt, rendererRequestReceivedContextFrame: event.requestReceivedContextFrame,
      rendererQueueDepth: event.queueDepth,
    });
    if (event.event === 'renderer-bridge-call-start') sample.rendererBridgeCallStartedAtMs = event.bridgeCallStartedAt;
    if (event.event === 'renderer-bridge-response') Object.assign(sample, {
      rendererBridgeResponseAtMs: event.bridgeResponseAt, rendererBridgeResponseContextFrame: event.bridgeResponseContextFrame,
      rendererBridgeRoundTripMs: event.bridgeRoundTripMs,
    });
    if (event.event === 'worklet-result') Object.assign(sample, {
      workletReceiptOutputFrame: event.receivedOutputFrame, workletScheduledOutputFrame: event.dueOutputFrame,
      workletResultAccepted: event.accepted, resultProfileReceivedAtRendererMs: event.rendererAtMs,
    });
  }
  for (const event of run.ipc.preload as Array<Record<string, any>>) {
    if (typeof event.requestId !== 'string' || !measuredRequestIds.has(event.requestId)) continue;
    Object.assign(sampleFor(event.requestId), {
      preloadInvokeStartedAtMs: event.invokeStartedAt, preloadResponseReceivedAtMs: event.responseReceivedAt,
      rendererIpcRoundTripMs: event.rendererIpcRttMs,
    });
  }
  for (const event of run.ipc.main.processAudio as Array<Record<string, any>>) {
    if (typeof event.requestId !== 'string' || !measuredRequestIds.has(event.requestId)) continue;
    Object.assign(sampleFor(event.requestId), {
      mainIpcReceivedAtMs: event.ipcReceivedAtMainMs, mainNativeServiceStartedAtMs: event.serviceStartAtMainMs,
      mainNativeServiceCompletedAtMs: event.serviceCompletedAtMainMs, nativeServiceCallMs: event.nativeServiceCallMs,
      concurrentCallsForEffectAtStart: event.activeCallsForEffectAtStart, nativeServiceError: event.error,
    });
  }
  return [...samples.values()].slice(0, 8192);
}

async function captureLiveMixerRun(instance: typeof audioEngine, channels: Channel[], mixer: MixerTrack[], durationMs = 1600) {
  const context = instance.getContext() as AudioContext;
  await context.resume();
  const taps = new Map<number, MixerCapture>();
  for (const trackId of [1, 2]) taps.set(trackId, await attachMixerCapture(instance, trackId));
  const smokeApi = (globalThis as any).desktopApp?.vst3;
  if (typeof smokeApi?.smokeTimingSnapshot !== 'function') throw new Error('Smoke-only production IPC timing snapshot is unavailable');
  const targetSource = context.createOscillator();
  const targetGain = context.createGain();
  const controlSource = context.createOscillator();
  const controlGain = context.createGain();
  targetSource.type = 'sine'; targetSource.frequency.value = 375; targetGain.gain.value = 0.1;
  controlSource.type = 'sine'; controlSource.frequency.value = 750; controlGain.gain.value = 0.1;
  await instance.play(channels, [], 'pat', undefined, mixer, 16);
  await context.resume();
  targetSource.connect(targetGain); targetGain.connect(instance.getOrCreateMixerChannel(1).input);
  controlSource.connect(controlGain); controlGain.connect(instance.getOrCreateMixerChannel(2).input);
  const sourceStartTime = context.currentTime + 0.05;
  const sourceStartContextFrame = Math.round(sourceStartTime * context.sampleRate);
  targetSource.start(sourceStartTime); controlSource.start(sourceStartTime);
  await new Promise(resolve => setTimeout(resolve, 300));
  const runtimeStart = getNativeVst3MixerEffectSmokeTiming().length;
  const ipcBefore = await smokeApi.smokeTimingSnapshot();
  const startedAt = performance.now();
  const startedContextFrame = sourceStartContextFrame + Math.round(0.25 * context.sampleRate);
  await new Promise(resolve => setTimeout(resolve, durationMs));
  const stoppedAt = performance.now();
  const stoppedContextFrame = Math.round(context.currentTime * context.sampleRate);
  const playbackActiveAtEnd = instance.isPlaybackActive();
  const stopRequestedAtRendererMs = performance.now();
  instance.stop();
  targetSource.stop(context.currentTime); controlSource.stop(context.currentTime);
  targetSource.disconnect(); targetGain.disconnect(); controlSource.disconnect(); controlGain.disconnect();
  const immediateEnd = performance.now() + 160;
  while (performance.now() < immediateEnd) await new Promise(resolve => setTimeout(resolve, 8));
  const immediateEndContextFrame = Math.round(context.currentTime * context.sampleRate);
  await instance.releaseNativeInstruments();
  const settleEnd = performance.now() + 120;
  while (performance.now() < settleEnd) await new Promise(resolve => setTimeout(resolve, 8));
  const settledStartContextFrame = Math.round(context.currentTime * context.sampleRate);
  const settledEnd = performance.now() + 100;
  while (performance.now() < settledEnd) await new Promise(resolve => setTimeout(resolve, 8));
  const settledEndContextFrame = Math.round(context.currentTime * context.sampleRate);
  const pcm = new Map<number, PlanarPcm>();
  const tailRms: Record<string, { immediate: number; settled: number }> = {};
  for (const [trackId, capture] of taps) {
    pcm.set(trackId, toPlanarPcm(capture.blocks, startedContextFrame, stoppedContextFrame));
    tailRms[String(trackId)] = {
      immediate: toPlanarPcm(capture.blocks, stoppedContextFrame, immediateEndContextFrame).rms,
      settled: toPlanarPcm(capture.blocks, settledStartContextFrame, settledEndContextFrame).rms,
    };
    capture.node.port.close(); capture.node.disconnect(); capture.sink.disconnect();
  }
  const ipcAfter = await smokeApi.smokeTimingSnapshot();
  const runtimeEvents = getNativeVst3MixerEffectSmokeTiming().slice(runtimeStart);
  const ipc = { preload: ipcAfter.preload.slice(ipcBefore.preload.length), main: { ...ipcAfter.main,
    processAudio: ipcAfter.main.processAudio.slice(ipcBefore.main.processAudio.length) } };
  const duration = stoppedAt - startedAt;
  const sampleRate = context.sampleRate;
  const timing = summarizeMixerTiming(runtimeEvents, ipc, sampleRate, duration, stopRequestedAtRendererMs);
  return { pcm, tailRms, sampleRate, durationMs: duration, startedContextFrame, stoppedContextFrame, playbackActiveAtEnd,
    trackRms: Object.fromEntries([...pcm].map(([trackId, audio]) => [trackId, audio.rms])),
    diagnostics: getVst3MixerEffectDiagnostics(), timing, runtimeEvents, ipc };
}

function assertPackagedMixerRun(run: any, label: string) {
  const timing = run.timing;
  const evidence = JSON.stringify({ timing, timingSamples: correlatedTimingSamples(run).slice(0, 24),
    diagnostics: run.diagnostics, tailRms: run.tailRms, trackRms: run.trackRms });
  const fail = (reason: string) => { throw new Error(`${label}: ${reason}; bounded production timing evidence=${evidence}`); };
  if (run.sampleRate !== 48000) fail(`expected the packaged AudioContext at 48 kHz, got ${run.sampleRate}`);
  if (!run.playbackActiveAtEnd) fail(`production Mixer transport stopped during capture; diagnostics=${JSON.stringify(run.diagnostics)}`);
  if (timing.requestCount < 10 || timing.acceptedWorkletResults + timing.cancelledAtStopBlocks !== timing.requestCount ||
      timing.processingBlocks + timing.nativeCancelledAtStopBlocks !== timing.requestCount || timing.cancelledAtStopBlocks > 2 ||
      timing.missingMainResponses !== 0 || timing.missingWorkletResults !== 0 ||
      timing.requestFailures.length !== 0 || timing.unexpectedStopCancellations.length !== 0 || timing.unexpectedDisposalDiscards.length !== 0) {
    fail(`production worklet/IPC/helper response correlation failed (only the final in-flight request per insert may be canceled by explicit stop): ${JSON.stringify(timing)}`);
  }
  if (timing.missedDeadlines !== 0) fail(`production Mixer deadline failure(s): ${JSON.stringify(timing)}`);
  if (timing.maxConcurrentCallsPerEffect > 1 || timing.maxPerInstanceQueueDepth > 1) {
    fail(`per-effect native helper processing was not serialized/bounded: ${JSON.stringify(timing)}`);
  }
  if (timing.nativeServiceSessionCountAfterCleanup !== 0) fail(`native helper sessions leaked after stop/disposal: ${JSON.stringify(timing)}`);
  const blockPeriodMs = VST3_FX_BLOCK_FRAMES * 1000 / run.sampleRate;
  if (timing.workletSubmissionToReceipt.maxMs === null || timing.workletSubmissionToReceipt.maxMs > blockPeriodMs + 1e-6) {
    fail(`worklet result missed the 21.33 ms 1024-frame scheduling window: ${JSON.stringify(timing.workletSubmissionToReceipt)}`);
  }
  for (const trackId of [1, 2]) {
    const tail = run.tailRms[String(trackId)];
    if (!tail || tail.settled > 1e-5) fail(`stale PCM remained on track ${trackId} after stop/disposal: ${JSON.stringify(tail)}`);
  }
}

async function runPackagedMixerAcceptance(instance: typeof audioEngine) {
  const desktopApi = (globalThis as any).desktopApp;
  if (desktopApi?.smokeTest !== true || typeof desktopApi?.vst3?.smokeTimingSnapshot !== 'function') {
    return { status: 'not-run', reason: 'Mixer production IPC/timing acceptance is restricted to the explicit packaged smoke-test launch.' };
  }
  resetNativeVst3MixerEffectSmokeTiming();
  const bridge = getVst3Bridge();
  if (!bridge) throw new Error('Packaged production VST3 preload bridge missing for Mixer acceptance');
  const discovered = await bridge.discoverEffects();
  const delayIdentity = discovered.plugins.find(plugin => plugin.name === 'mda Delay');
  const filterIdentity = discovered.plugins.find(plugin => plugin.name === 'mda RezFilter');
  if (!delayIdentity || !filterIdentity) throw new Error(`Redistributable MDA Mixer fixtures unavailable through packaged production IPC: ${JSON.stringify(discovered.errors)}`);
  const delay = await bridge.inspectEffect(delayIdentity);
  const rezFilter = await bridge.inspectEffect(filterIdentity);
  const delayParameters = await bridge.describeEffect(delay);
  const feedbackMix = delayParameters.parameters.find(parameter => parameter.id === 4 && parameter.name === 'Fb Mix');
  if (!feedbackMix) throw new Error('The pinned mda Delay fixture no longer exposes the verified Fb Mix bypass parameter id 4');
  const bypassDelay = await bridge.inspectEffect(delayIdentity, {
    ...delay.state,
    parameters: [...delay.state.parameters.filter(parameter => parameter.id !== feedbackMix.id), { id: feedbackMix.id, value: 0 }],
  });

  const channels: Channel[] = [];
  const tracks: MixerTrack[] = [0, 1, 2].map(id => ({ id, name: `Packaged smoke track ${id}`, color: '#fff',
    volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 }));
  const makeSlot = (id: string, effect: Vst3Effect): FxSlot => ({ id, type: 'vst3', name: effect.name,
    enabled: true, mix: 1, params: {}, vst3Effect: effect });
  const withSlots = (slots: FxSlot[]): MixerTrack[] => tracks.map(track => track.id === 1 ? { ...track, fxSlots: slots } : { ...track, fxSlots: [] });
  const noEffects = withSlots([]);
  const ordered = withSlots([makeSlot('smoke-delay', delay), makeSlot('smoke-rezfilter', rezFilter)]);
  const reversed = withSlots([makeSlot('smoke-rezfilter', rezFilter), makeSlot('smoke-delay', delay)]);
  const delayOnly = withSlots([makeSlot('smoke-delay', delay)]);
  const delayBypassed = withSlots([makeSlot('smoke-delay-bypass', bypassDelay)]);
  const run = async (mixer: MixerTrack[], label: string) => {
    const result = await captureLiveMixerRun(instance, channels, mixer);
    if (mixer.some(track => track.fxSlots.some(slot => slot.enabled && slot.type === 'vst3'))) assertPackagedMixerRun(result, label);
    else {
      if (!result.playbackActiveAtEnd || result.timing.nativeServiceSessionCountAfterCleanup !== 0 ||
          result.tailRms['1']!.settled > 1e-5 || result.tailRms['2']!.settled > 1e-5) {
        throw new Error(`${label}: cleanup/removal/restart left stale PCM or helper sessions: ${JSON.stringify({ active: result.playbackActiveAtEnd, sessions: result.timing.nativeServiceSessionCountAfterCleanup, tailRms: result.tailRms })}`);
      }
    }
    return result;
  };

  const orderA = await run(ordered, 'Mixer order Delay → RezFilter');
  const orderB = await run(reversed, 'Mixer order RezFilter → Delay');
  const delayProcessed = await run(delayOnly, 'Mixer processed Delay');
  const delayPassThrough = await run(delayBypassed, 'Mixer native Delay Fb Mix=0 bypass');
  const removed = await run(noEffects, 'Mixer effect removal/restart');
  const acceptanceTimingEvidence = JSON.stringify(Object.fromEntries(Object.entries({ orderA, orderB, delayProcessed, delayPassThrough, removed })
    .map(([label, result]) => [label, { timing: result.timing, timingSamples: correlatedTimingSamples(result).slice(0, 16) }])));
  const alignmentWindow = Math.round(0.5 * orderA.sampleRate);
  const orderDifference = compareMixerRuns(orderA, orderB, 1, alignmentWindow, 'order reversal');
  const controlDifference = compareMixerRuns(orderA, orderB, 2, alignmentWindow, 'control-track isolation');
  const controlRmsDifference = Math.abs(orderA.trackRms['2'] - orderB.trackRms['2']);
  const processedVsBypass = compareMixerRuns(delayProcessed, delayPassThrough, 1, alignmentWindow, 'processed vs native bypass');
  const bypassVsRemoved = compareMixerRuns(delayPassThrough, removed, 1, alignmentWindow, 'native bypass vs removed insert');
  const controlTolerance = Math.max(0.005, orderA.trackRms['2'] * 0.15);
  const bypassOutputTolerance = Math.max(0.005, delayPassThrough.trackRms['1'] * 0.15);
  if ([orderA, orderB, delayProcessed, delayPassThrough, removed].some(result => result.trackRms['1'] <= 0.001 || result.trackRms['2'] <= 0.001)) {
    throw new Error(`Packaged Mixer live track PCM was silent or disappeared after removal/restart: ${JSON.stringify({ orderA: orderA.trackRms, orderB: orderB.trackRms, delayProcessed: delayProcessed.trackRms, delayPassThrough: delayPassThrough.trackRms, removed: removed.trackRms })}; bounded timing evidence=${acceptanceTimingEvidence}`);
  }
  if (orderDifference.rmsDifference <= 1e-4) throw new Error(`Reversing the production Mixer VST3 order did not change target PCM: ${JSON.stringify(orderDifference)}; bounded timing evidence=${acceptanceTimingEvidence}`);
  if (controlRmsDifference > controlTolerance || controlDifference.rmsDifference > controlTolerance) {
    throw new Error(`Mixer effect order changed unaffected control-track PCM beyond tolerance ${controlTolerance}: ${JSON.stringify({ controlRmsDifference, alignedPcmDifferenceRms: controlDifference.rmsDifference, controlTrackRms: { orderA: orderA.trackRms['2'], orderB: orderB.trackRms['2'] } })}; bounded timing evidence=${acceptanceTimingEvidence}`);
  }
  if (processedVsBypass.rmsDifference <= 1e-4) throw new Error(`Native MDA bypass and processed live output were indistinguishable: ${JSON.stringify(processedVsBypass)}; bounded timing evidence=${acceptanceTimingEvidence}`);
  if (bypassVsRemoved.rmsDifference > bypassOutputTolerance) throw new Error(`MDA Fb Mix=0 bypass did not match the no-insert production Mixer signal within tolerance ${bypassOutputTolerance}: ${JSON.stringify(bypassVsRemoved)}; bounded timing evidence=${acceptanceTimingEvidence}`);
  if (Math.abs(processedVsBypass.normalizedLagFrames) > 256) throw new Error(`Delay bypass and processed runs did not align after their shared ${VST3_FX_PIPELINE_FRAMES}-frame pipeline: ${JSON.stringify(processedVsBypass)}; bounded timing evidence=${acceptanceTimingEvidence}`);
  if (Math.abs(bypassVsRemoved.normalizedLagFrames + VST3_FX_PIPELINE_FRAMES) > 256) {
    throw new Error(`Removing the effect did not remove exactly its declared ${VST3_FX_PIPELINE_FRAMES}-frame pipeline (after run-start normalization): ${JSON.stringify(bypassVsRemoved)}; bounded timing evidence=${acceptanceTimingEvidence}`);
  }
  const runs = { orderA, orderB, delayProcessed, delayPassThrough, removed };
  for (const [label, result] of Object.entries(runs)) {
    if (label !== 'removed') assertPackagedMixerRun(result, label);
  }
  return {
    status: 'passed', sampleRate: orderA.sampleRate, blockFrames: VST3_FX_BLOCK_FRAMES,
    blockPeriodMs: VST3_FX_BLOCK_FRAMES * 1000 / orderA.sampleRate,
    pipelineFramesPerEffect: VST3_FX_PIPELINE_FRAMES,
    pipelineMsPerEffect: VST3_FX_PIPELINE_FRAMES * 1000 / orderA.sampleRate,
    deadlineReference: '1024 frames = 21.33 ms at 48 kHz; existing two-block Mixer pipeline = 2048 frames = 42.67 ms per effect; no delay increase was made.',
    latencyCompensation: 'Not provided. Tracks with different counts of native Mixer inserts are not sample-aligned; each insert contributes the declared fixed 2048-frame live pipeline.',
    priorPlaywrightBridgeReference: { approximatelyMs: 28, measurement: 'test-only page.exposeFunction bridge; separate from this production IPC/preload/helper measurement' },
    orderDifferenceRms: orderDifference.rmsDifference, orderOffsetFrames: orderDifference.normalizedLagFrames,
    controlTrackRmsDifference: controlRmsDifference, controlTrackPcmDifferenceRms: controlDifference.rmsDifference,
    controlTrackRms: { orderA: orderA.trackRms['2'], orderB: orderB.trackRms['2'] },
    controlTrackIsolationMethod: 'A smoke-only 750 Hz oscillator is routed through the production track-2 input; compare aligned live track PCM and RMS across effect-order captures.',
    controlIsolationToleranceRms: controlTolerance,
    bypassVsProcessedDifferenceRms: processedVsBypass.rmsDifference,
    bypassVsProcessedLagAfterRunStartNormalizationFrames: processedVsBypass.normalizedLagFrames,
    bypassVsRemovedDifferenceRms: bypassVsRemoved.rmsDifference, bypassVsRemovedToleranceRms: bypassOutputTolerance,
    bypassVsRemovedLagAfterRunStartNormalizationFrames: bypassVsRemoved.normalizedLagFrames,
    targetTrackRms: { processed: delayProcessed.trackRms['1'], bypass: delayPassThrough.trackRms['1'], removed: removed.trackRms['1'] },
    settledTailRms: Object.fromEntries(Object.entries(runs).map(([label, result]) => [label, result.tailRms])),
    timing: { orderA: orderA.timing, orderB: orderB.timing, delayProcessed: delayProcessed.timing, delayBypassed: delayPassThrough.timing,
      cleanupAfterRemoval: removed.timing },
    timingSamples: { orderA: correlatedTimingSamples(orderA), orderB: correlatedTimingSamples(orderB),
      delayProcessed: correlatedTimingSamples(delayProcessed), delayBypassed: correlatedTimingSamples(delayPassThrough),
      cleanupAfterRemoval: correlatedTimingSamples(removed) },
    proof: 'Packaged Electron production AudioWorklet → authorized main IPC → native VST3 helper → production preload → worklet PCM, captured from production Mixer analysers. Smoke-only 375/750 Hz oscillators provide deterministic track inputs; no exposeFunction processing bridge.'
  };
}

export async function runDesktopVst3Smoke() {
  const bridge = getVst3Bridge();
  if (!bridge) throw new Error('Packaged VST3 preload bridge missing');
  const discovered = await bridge.discover();
  const plugin = discovered.plugins.find(item => item.name === 'mda JX10');
  if (!plugin) throw new Error(`Real MDA fixture not discovered through packaged IPC: ${JSON.stringify(discovered.errors)}`);
  const initial = await bridge.inspect(plugin);
  const instrument = await bridge.inspect(plugin, { ...initial.state, parameters: [{ id: 14, value: 0 }, { id: 18, value: 0 }] });
  const instance = new (audioEngine.constructor as { new(): typeof audioEngine })();
  instance.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  instance.setBpm(120);
  let channel: Channel = {
    ...createDefaultProjectState().channels[0], id: 'packaged-native', name: 'Real packaged MDA JX10',
    instrumentType: 'vst3', vst3: instrument, volume: 1, pan: 0, pitch: 0, mute: false, solo: false, mixerTrackId: 1,
    steps: Array(16).fill(false), notes: [{ id: 'native-smoke-note', pitch: 60, start: 1, duration: 1, velocity: 0.8 }],
  };
  const mixer = [0, 1].map(id => ({ id, name: 'Smoke insert', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 })) as MixerTrack[];
  const clip: PlaylistClip = { id: 'native-smoke-clip', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern', channelId: channel.id, name: 'Native smoke', color: '#fff' };
  let savedAutomation: PlaylistClip | undefined;
  const reopening = (globalThis as unknown as { desktopApp?: { smokeReopen?: boolean } }).desktopApp?.smokeReopen === true;
  if (reopening) {
    const saved = await restorePersistedProjectState(instance, createDefaultProjectState());
    if (!saved.restored || saved.recovered || saved.state.channels[0]?.instrumentType !== 'vst3') throw new Error('Native project did not reopen from the real current-project IndexedDB record');
    channel = saved.state.channels[0];
    savedAutomation = saved.state.playlistClips.find(c => c.automationTarget?.type === 'vst3_param');
    if (!savedAutomation) throw new Error('Native automation lane did not survive application restart');
    if (channel.vst3?.classId !== plugin.classId) throw new Error('Reopened project selected the wrong native class');
  }
  function digest(bytes: Uint8Array): string {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
    return value.toString(16).padStart(8, '0');
  }
  const render = (value: Channel) => instance.renderTimelineOffline([value], [clip], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 0.5);
  try {
    const reference = await render({ ...channel, vst3: instrument });
    if (!reopening) {
      await instance.editVst3Parameters(channel, [{ id: 6, value: .05 }], () => true, vst3 => { channel = { ...channel, vst3 }; });
      await instance.releaseNativeInstruments();
    }
    if (channel.vst3?.state.parameters.find(p => p.id === 6)?.value !== .05) throw new Error('Edited native parameter did not survive application restart');
    const metadata = await bridge.describe(channel.vst3);
    if (Math.abs((metadata.parameters.find(p => p.id === 6)?.currentValue ?? -1) - .05) > 1e-7) throw new Error('Packaged native controller did not restore the edited value');
    const frequency = metadata.parameters.find(p => p.id === 6)!;
    const automation: PlaylistClip = savedAutomation ?? { id: 'packaged-vcf-automation', type: 'automation', trackIndex: 1,
      startBar: 0, lengthBars: 1, name: 'VCF automation', color: '#fff', automationTarget: nativeTarget(channel, frequency),
      automationPoints: [{ x: 0, y: .9 }, { x: 1, y: .05 }] };
    const automated = await instance.renderTimelineOffline([channel], [clip, automation], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, .5);
    const output = await render(channel);
    const samples = output.getChannelData(0);
    let differenceSum = 0;
    const before = reference.getChannelData(0);
    for (let i = 0; i < samples.length; i++) differenceSum += (samples[i] - before[i]) ** 2;
    const parameterExportDifferenceRms = Math.sqrt(differenceSum / samples.length);
    if (parameterExportDifferenceRms < .001) throw new Error('Packaged parameter edit did not alter real production PCM');
    const automatedPcm = automated.getChannelData(0);
    let automationDifference = 0;
    for (let i = 0; i < samples.length; i++) automationDifference += (automatedPcm[i] - samples[i]) ** 2;
    const automationExportDifferenceRms = Math.sqrt(automationDifference / samples.length);
    if (automationExportDifferenceRms < .001) throw new Error('Packaged Playlist automation did not affect real native export');
    const automationPcmChecksum = digest(new Uint8Array(automatedPcm.buffer, automatedPcm.byteOffset, automatedPcm.byteLength));
    const automationStateChecksum = digest(new TextEncoder().encode(JSON.stringify(automation)));
    const onsetFrame = samples.findIndex(value => Math.abs(value) > 1e-7);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    if (onsetFrame < 6000 || onsetFrame > 6064 || rms < 0.001) throw new Error(`Packaged production export failed: onset=${onsetFrame}, rms=${rms}`);
    const json = serializeProjectState({ ...createDefaultProjectState(), channels: [channel], mixerTracks: mixer, playlistClips: [clip, automation] });
    const restored = normalizeProjectState(JSON.parse(json).state).channels[0];
    const reopened = await render(restored);
    const after = reopened.getChannelData(0);
    if (after.length !== samples.length || after.some((value, index) => value !== samples[index])) throw new Error('Packaged state reopen did not reproduce native PCM');
    let rejected = false;
    try { await render({ ...channel, vst3: { ...instrument, path: `${instrument.path}.missing.vst3` } }); }
    catch { rejected = true; }
    if (!rejected) throw new Error('Missing native instrument silently succeeded');
    await instance.play([channel], [], 'pat', undefined, mixer, 16);
    const context = instance.getContext();
    await Promise.race([context.resume(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Packaged live AudioContext did not resume')), 3000))]);
    const live = new Uint8Array(512);
    let livePeak = 0;
    const end = performance.now() + 600;
    while (performance.now() < end) {
      instance.getMasterWaveformData(live);
      for (const value of live) livePeak = Math.max(livePeak, Math.abs((value - 128) / 128));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const errors = getVst3Diagnostics().filter(item => item.channelId === channel.id && !item.message.startsWith('VST3 ready') && !item.message.startsWith('VST3 active'));
    if (livePeak < 0.001 || errors.length) throw new Error(`Packaged live graph failed: peak=${livePeak}, diagnostics=${JSON.stringify(errors)}`);
    const mixerEffects = await runPackagedMixerAcceptance(instance);
    if (reopening && !document.body.textContent?.includes(channel.name)) throw new Error('The actual Apex application UI did not restore the saved native channel');
    if (!reopening) {
      const project = createDefaultProjectState();
      await persistProjectState({ ...project, meta: { ...project.meta, bpm: 120 }, selectedChannelId: channel.id, channels: [channel], mixerTracks: mixer, playlistClips: [clip, automation] });
    }
    return { automationExportDifferenceRms, automationPcmChecksum, automationStateChecksum, parameterValue: .05, parameterExportDifferenceRms, plugin: plugin.name, classId: plugin.classId, onsetFrame, rms, livePeak, stateReopenEqual: true, missingRejected: rejected,
      applicationStage: reopening ? 'reopened-from-indexeddb-after-process-exit' : 'saved-to-production-indexeddb',
      uiRestored: reopening ? true : undefined,
      pcmChecksum: digest(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)),
      savedStateChecksum: digest(new TextEncoder().encode(JSON.stringify(channel.vst3))),
      mixerEffects,
      proof: 'Packaged helper + real preload IPC + AudioClockTransport/live master graph + production song export (Chromium Web Audio); not physical-device listening' };
  } finally {
    instance.stop();
    await instance.releaseNativeInstruments();
    await instance.getContext().close();
  }
}
