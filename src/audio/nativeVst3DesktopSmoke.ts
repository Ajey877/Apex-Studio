import { nativeTarget } from './nativeVst3Automation';
// Executed ONLY by the existing packaged-runtime smoke launch flag. This calls
// the production engine/registry/export path, not an alternate WAV renderer.
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { getVst3Bridge, type Vst3Effect } from './nativeVst3Types';
import { VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES, getNativeVst3MixerEffectSmokeTiming, getNativeVst3MixerEffectSmokeTimingDropped, resetNativeVst3MixerEffectSmokeTiming, getVst3MixerEffectDiagnostics } from './nativeVst3EffectRuntime';
import { getVst3Diagnostics } from './nativeVst3Runtime';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { persistProjectState, restorePersistedProjectState, serializeProjectState } from '../state/projectPersistence';
import type { Channel, FxSlot, MixerTrack, PlaylistClip } from '../types/daw';

type MixerCaptureBlock = { frame: number; samples: Float32Array };
type MixerCapture = { blocks: MixerCaptureBlock[]; node: AudioWorkletNode; sink: GainNode; source: AudioNode };
type MixerCaptureOptions = {
  durationMs?: number;
  inputBuffers?: Map<number, AudioBuffer>;
  includeMaster?: boolean;
  bypassMixerAfterMs?: number;
  bypassMixerTracks?: MixerTrack[];
  /** Smoke-only taps after each native insert for diagnosing silent stages. */
  includeNativeStages?: boolean;
};
type PlanarPcm = { left: Float32Array; right: Float32Array; frames: number; rms: number; startFrame: number | null };
const captureModuleByContext = new WeakMap<BaseAudioContext, Promise<string>>();

async function attachMixerCapture(instance: typeof audioEngine, trackId: number, sourceOverride?: AudioNode): Promise<MixerCapture> {
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
  const captureSource = sourceOverride ?? (trackId === 0 ? mixer.analyser : instance.getMixerRoutingOutputNode(trackId) ?? mixer.analyser);
  captureSource.connect(node); node.connect(sink); sink.connect(context.destination);
  return { blocks, node, sink, source: captureSource };
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

function compareMixerRuns(reference: any, candidate: any, trackId: number, label: string, expectedNormalizedLagFrames = 0) {
  const left = reference.pcm.get(trackId) as PlanarPcm | undefined;
  const right = candidate.pcm.get(trackId) as PlanarPcm | undefined;
  if (!left || !right || left.startFrame === null || right.startFrame === null) throw new Error(`${label}: packaged Mixer capture missing track ${trackId} PCM`);
  const playbackStartDeltaFrames = candidate.startedContextFrame - reference.startedContextFrame;
  // Align by the absolute AudioWorklet frame stamps and each run's scheduled
  // input frame. For insert-count comparisons, apply only the declared pipeline
  // offset. This avoids pure-tone correlation aliases that can hide 2048 frames.
  const offsetFrames = left.startFrame + playbackStartDeltaFrames + expectedNormalizedLagFrames - right.startFrame;
  const difference = alignedDifference(left, right, offsetFrames);
  const normalizedLagFrames = right.startFrame + offsetFrames - left.startFrame - playbackStartDeltaFrames;
  return { ...difference, offsetFrames, normalizedLagFrames, expectedNormalizedLagFrames, alignment: 'captured-context-frames' };
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianMs: null, p95Ms: null, maxMs: null };
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
  return { count: sorted.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted[sorted.length - 1]! };
}

function summarizeMixerTiming(events: ReturnType<typeof getNativeVst3MixerEffectSmokeTiming>, ipc: any, sampleRate: number, captureDurationMs: number, captureStartRendererMs: number, captureEndRendererMs: number, stopRequestedAtRendererMs: number) {
  const allSubmissions = new Map(events.filter(event => event.event === 'worklet-submit' && typeof event.requestId === 'string')
    .map(event => [event.requestId!, event]));
  const submissions = new Map([...allSubmissions].filter(([, event]) =>
    Number.isFinite(Number(event.rendererAtMs)) && Number(event.rendererAtMs) >= captureStartRendererMs &&
    Number(event.rendererAtMs) < captureEndRendererMs));
  const isMeasuredRequest = (requestId: unknown): requestId is string => typeof requestId === 'string' && submissions.has(requestId);
  const mapByRequestId = (records: Array<Record<string, any>> | undefined) => new Map((records ?? [])
    .filter(record => typeof record.requestId === 'string').map(record => [record.requestId, record]));
  const allResults = mapByRequestId(events.filter(event => event.event === 'worklet-result'));
  const results = new Map([...allResults].filter(([id]) => isMeasuredRequest(id)));
  const allRendererResponses = mapByRequestId(events.filter(event => event.event === 'renderer-bridge-response'));
  const rendererResponses = new Map([...allRendererResponses].filter(([id]) => isMeasuredRequest(id)));
  const allPreload = mapByRequestId(ipc?.preload);
  const preload = new Map([...allPreload].filter(([id]) => isMeasuredRequest(id)));
  const allMain = mapByRequestId(ipc?.main?.processAudio);
  const main = new Map([...allMain].filter(([id]) => isMeasuredRequest(id)));
  const requestEvents = new Map(events.filter(event => event.event === 'renderer-request-received' && isMeasuredRequest(event.requestId)).map(event => [event.requestId!, event]));
  const allBridgeStarts = new Map(events.filter(event => event.event === 'renderer-bridge-call-start' && typeof event.requestId === 'string').map(event => [event.requestId!, event]));
  const bridgeStarts = new Map([...allBridgeStarts].filter(([id]) => isMeasuredRequest(id)));
  const stopAcks = new Map(events.filter(event => event.event === 'worklet-stop-ack' && event.cancelled === true && event.reason === 'explicit-stop' && typeof event.requestId === 'string')
    .map(event => [event.requestId!, event]));
  const rendererStopCancellations = new Map(events.filter(event => event.event === 'renderer-request-cancelled-at-stop' && typeof event.requestId === 'string')
    .map(event => [event.requestId!, event]));
  const stopCancellationWindowMs = VST3_FX_BLOCK_FRAMES * 1000 / sampleRate + 2;
  const nativeCancelledAtStopRequestIds = new Set<string>();
  for (const [requestId, timing] of allMain) {
    const start = allBridgeStarts.get(requestId);
    const ageAtStopMs = stopRequestedAtRendererMs - Number(start?.bridgeCallStartedAt);
    if (timing.error === 'VST3 instance cancelled' && Number.isFinite(ageAtStopMs) &&
        ageAtStopMs >= 0 && ageAtStopMs <= stopCancellationWindowMs && stopAcks.has(requestId)) {
      nativeCancelledAtStopRequestIds.add(requestId);
    }
  }
  const workletCancelledAtStopRequestIds = new Set(stopAcks.keys());
  const rendererDiscardedAtStopRequestIds = new Set([...rendererStopCancellations]
    .filter(([requestId]) => stopAcks.has(requestId)).map(([requestId]) => requestId));
  const stopCancelledRequestIds = new Set([...workletCancelledAtStopRequestIds, ...nativeCancelledAtStopRequestIds, ...rendererDiscardedAtStopRequestIds]);
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
  const stopAckTimeouts = events.filter(event => event.event === 'renderer-stop-ack-timeout' && event.reason === 'explicit-stop').length;
  const lifecycleFor = (requestId: string, submit: Record<string, any>) => {
    const result = allResults.get(requestId), mainRecord = allMain.get(requestId), preloadRecord = allPreload.get(requestId);
    const rendererResponse = allRendererResponses.get(requestId), stopAck = stopAcks.get(requestId), stopCancel = rendererStopCancellations.get(requestId);
    const received = events.find(event => event.event === 'renderer-request-received' && event.requestId === requestId);
    const bridgeStart = events.find(event => event.event === 'renderer-bridge-call-start' && event.requestId === requestId);
    const phase = Number(submit.rendererAtMs) < captureStartRendererMs ? 'before-capture' :
      Number(submit.rendererAtMs) >= captureEndRendererMs ? 'stop-boundary' : 'measured-capture';
    const complete = mainRecord && !mainRecord.error && preloadRecord && rendererResponse && result?.accepted === true;
    return {
      requestId, sequence: submit.sequence, trackId: submit.trackId, slotId: submit.slotId, phase,
      rendererSubmitAtMs: submit.rendererAtMs, inputBlockStartContextFrame: submit.inputBlockStartContextFrame,
      dueContextFrame: submit.dueContextFrame,
      rendererReceivedAtMs: received?.requestReceivedAt, rendererBridgeStartedAtMs: bridgeStart?.bridgeCallStartedAt,
      preloadInvokedAtMs: preloadRecord?.invokeStartedAt, preloadReturnedAtMs: preloadRecord?.responseReceivedAt,
      mainReceivedAtMs: mainRecord?.ipcReceivedAtMainMs, nativeStartedAtMs: mainRecord?.serviceStartAtMainMs,
      nativeCompletedAtMs: mainRecord?.serviceCompletedAtMainMs,
      nativeInputRms: mainRecord?.nativeInputRms, nativeInputLeftRms: mainRecord?.nativeInputLeftRms,
      nativeInputRightRms: mainRecord?.nativeInputRightRms, nativeInputMonoSumRms: mainRecord?.nativeInputMonoSumRms,
      nativeInputMonoDifferenceRms: mainRecord?.nativeInputMonoDifferenceRms,
      nativeOutputRms: mainRecord?.nativeOutputRms, mainError: mainRecord?.error,
      rendererResponseAtMs: rendererResponse?.bridgeResponseAt, workletResultAtMs: result?.rendererAtMs,
      workletAccepted: result?.accepted, stopAck: stopAck ? { sequence: stopAck.sequence, reason: stopAck.reason } : null,
      stopCancellation: stopCancel ? { stage: stopCancel.cancellationStage, reason: stopCancel.reason } : null,
      accounted: !!complete || (!!stopAck && (!mainRecord?.error || nativeCancelledAtStopRequestIds.has(requestId))),
    };
  };
  const allLifecycle = [...allSubmissions].map(([id, submit]) => lifecycleFor(id, submit));
  const unaccountedRequests = allLifecycle.filter(item => !item.accounted);
  const preCaptureRequests = allLifecycle.filter(item => item.phase === 'before-capture');
  const teardownRequests = allLifecycle.filter(item => item.phase === 'stop-boundary');
  const measuredIds = new Set(submissions.keys());
  const measuredAckIds = new Set([...stopAcks.keys()].filter(id => measuredIds.has(id)));
  const measuredRuntimeCancelledBeforeNative = [...measuredAckIds].filter(id => !main.has(id)).length;
  const teardownIds = new Set(teardownRequests.map(item => item.requestId));
  const teardownCancelledBlocks = [...stopAcks.keys()].filter(id => teardownIds.has(id)).length;
  return {
    blockFrames: VST3_FX_BLOCK_FRAMES, pipelineFramesPerEffect: VST3_FX_PIPELINE_FRAMES,
    blockPeriodMs: VST3_FX_BLOCK_FRAMES * 1000 / sampleRate,
    captureDurationMs, captureStartRendererMs, captureEndRendererMs,
    processingBlocks: blocks, acceptedWorkletResults: acceptedResults,
    submittedBlocks: submissions.size, cancelledAtStopBlocks: measuredAckIds.size,
    measuredCancelledBeforeNativeBlocks: measuredRuntimeCancelledBeforeNative,
    nativeCancelledAtStopBlocks: [...nativeCancelledAtStopRequestIds].filter(id => measuredIds.has(id)).length,
    rendererDiscardedAtStopBlocks: [...rendererDiscardedAtStopRequestIds].filter(id => measuredIds.has(id)).length,
    preCaptureSubmittedBlocks: preCaptureRequests.length, preCaptureRequests,
    teardownSubmittedBlocks: teardownRequests.length, teardownCancelledAtStopBlocks: teardownCancelledBlocks,
    stopAcknowledgementTimeouts: stopAckTimeouts,
    unaccountedRequestCount: unaccountedRequests.length, unaccountedRequests,
    teardownRequests,
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
    profileEventCount: events.filter(event => event.requestId === undefined || allSubmissions.has(event.requestId)).length,
    requestFailures: [...main].filter(([, event]: [string, any]) => !!event.error && !nativeCancelledAtStopRequestIds.has(event.requestId)).map(([, event]: [string, any]) => event.error),
    unexpectedStopCancellations: [...main].filter(([requestId, event]: [string, any]) => event.error === 'VST3 instance cancelled' && !stopAcks.has(requestId)).map(([requestId]: [string, any]) => requestId),
    missingMainResponses: [...submissions.keys()].filter(requestId => !main.has(requestId) && !stopAcks.has(requestId)).length,
    missingWorkletResults: [...submissions.keys()].filter(requestId => !results.has(requestId) && !stopAcks.has(requestId)).length,
    rendererResponseCount: rendererResponses.size,
    smokeTimingDropped: getNativeVst3MixerEffectSmokeTimingDropped(),
    rendererResultPosted: events.filter(event => event.event === 'renderer-result-posted').length,
    rendererResultPostFailed: events.filter(event => event.event === 'renderer-result-post-failed').length,
    workletStopAcknowledgements: events.filter(event => event.event === 'worklet-stop-ack').map(event => ({
      slotId: event.slotId, runtimeId: event.runtimeId, sequence: event.sequence ?? null,
      cancelled: event.cancelled === true, reason: event.reason, requestId: event.requestId ?? null,
    })),
    nullSequenceStopAcknowledgements: events.filter(event => event.event === 'worklet-stop-ack' && event.sequence == null).length,
    rendererStopAckTimeouts: events.filter(event => event.event === 'renderer-stop-ack-timeout').map(event => ({
      slotId: event.slotId, runtimeId: event.runtimeId, reason: event.reason, error: event.error,
    })),
    shutdownEvents: events.filter(event => [
      'renderer-stop-requested', 'renderer-worklet-stop-posted', 'worklet-stop-received',
      'worklet-stop-ack', 'renderer-stop-acknowledged', 'renderer-stop-ack-timeout',
      'renderer-port-closing', 'renderer-port-closed', 'renderer-session-closed', 'renderer-tail-settled',
    ].includes(String(event.event))).map(event => ({
      event: event.event, slotId: event.slotId, runtimeId: event.runtimeId, requestId: event.requestId ?? null,
      sequence: event.sequence ?? null, pendingSequence: event.pendingSequence ?? null,
      cancelled: event.cancelled, reason: event.reason, stopContextFrame: event.stopContextFrame ?? null,
      cancelledSequences: event.cancelledSequences ?? null, rendererAtMs: event.rendererAtMs,
    })),
  };
}

function correlatedTimingSamples(run: any) {
  const measuredRequestIds = new Set((run.runtimeEvents as Array<Record<string, any>>)
    .filter(event => event.event === 'worklet-submit' && typeof event.requestId === 'string' &&
      Number.isFinite(Number(event.rendererAtMs)) && Number(event.rendererAtMs) >= run.captureStartRendererMs &&
      Number(event.rendererAtMs) < run.captureEndRendererMs).map(event => event.requestId));
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
      trackId: event.trackId, slotId: event.slotId, sequence: event.sequence,
      runtimeId: typeof event.requestId === 'string' ? event.requestId.split(':')[0] : undefined,
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
      nativeServiceInputRms: event.nativeInputRms, nativeServiceInputLeftRms: event.nativeInputLeftRms,
      nativeServiceInputRightRms: event.nativeInputRightRms, nativeServiceInputMonoSumRms: event.nativeInputMonoSumRms,
      nativeServiceInputMonoDifferenceRms: event.nativeInputMonoDifferenceRms,
      nativeServiceOutputRms: event.nativeOutputRms,
      nativeServiceOutputLeftRms: event.nativeOutputLeftRms, nativeServiceOutputRightRms: event.nativeOutputRightRms,
      nativeServiceOutputMonoSumRms: event.nativeOutputMonoSumRms,
      nativeServiceOutputMonoDifferenceRms: event.nativeOutputMonoDifferenceRms,
      nativeProcessEvidence: event.nativeProcessEvidence, nativeFailureEvidence: event.nativeFailureEvidence,
      serviceSessionId: event.serviceSessionId,
      concurrentCallsForEffectAtStart: event.activeCallsForEffectAtStart, nativeServiceError: event.error,
    });
  }
  return [...samples.values()].slice(0, 8192);
}

function nativeServicePcmBySlot(run: any) {
  const grouped = new Map<string, Record<string, any>[]>();
  for (const sample of correlatedTimingSamples(run)) {
    if (sample.trackId !== 1 || typeof sample.slotId !== 'string') continue;
    const samples = grouped.get(sample.slotId) ?? [];
    samples.push(sample);
    grouped.set(sample.slotId, samples);
  }
  return Object.fromEntries([...grouped].map(([slotId, samples]) => {
    const summarize = (field: string) => {
      const values = samples.map(sample => Number(sample[field])).filter(Number.isFinite);
      return { count: values.length, nonzero: values.filter(value => value > 1e-8).length,
        min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
    };
    return [slotId, { requests: samples.length, inputRms: summarize('nativeServiceInputRms'),
      inputLeftRms: summarize('nativeServiceInputLeftRms'), inputRightRms: summarize('nativeServiceInputRightRms'),
      inputMonoSumRms: summarize('nativeServiceInputMonoSumRms'),
      inputMonoDifferenceRms: summarize('nativeServiceInputMonoDifferenceRms'),
      outputRms: summarize('nativeServiceOutputRms'), outputLeftRms: summarize('nativeServiceOutputLeftRms'),
      outputRightRms: summarize('nativeServiceOutputRightRms'), outputMonoSumRms: summarize('nativeServiceOutputMonoSumRms'),
      outputMonoDifferenceRms: summarize('nativeServiceOutputMonoDifferenceRms') }];
  }));
}

function nativeSessionEvidence(run: any) {
  const grouped = new Map<string, Record<string, any>[]>();
  for (const sample of correlatedTimingSamples(run)) {
    if (sample.trackId !== 1 || typeof sample.slotId !== 'string') continue;
    const rows = grouped.get(sample.slotId) ?? [];
    rows.push(sample);
    grouped.set(sample.slotId, rows);
  }
  return Object.fromEntries([...grouped].map(([slotId, rows]) => {
    const first = rows[0]!;
    const openEvent = (run.runtimeEvents as Array<Record<string, any>>).find(event => event.event === 'native-effect-open' &&
      event.trackId === first.trackId && event.slotId === slotId && event.runtimeId === first.runtimeId &&
      event.helperSessionId === first.serviceSessionId);
    const sessionProcessEvents = (run.ipc.main.processAudio as Array<Record<string, any>>)
      .filter(event => event.serviceSessionId === first.serviceSessionId);
    const firstProcessEvent = sessionProcessEvents.find(event => event.nativeProcessEvidence);
    const failureEvent = sessionProcessEvents.find(event => event.nativeFailureEvidence)?.nativeFailureEvidence as Record<string, any> | undefined;
    return [slotId, { serviceSessionId: first.serviceSessionId, runtimeId: first.runtimeId,
      helperProcessId: openEvent?.nativeOpenEvidence?.helperProcessId ?? firstProcessEvent?.nativeProcessEvidence?.helperProcessId ?? failureEvent?.helperProcessId ?? null,
      firstMeasuredRequestId: first.requestId, requestCount: rows.length,
      failureEvidenceCount: sessionProcessEvents.filter(event => event.nativeFailureEvidence).length,
      nativeOpenEvidence: openEvent?.nativeOpenEvidence ?? null,
      firstProcessEvidence: firstProcessEvent?.nativeProcessEvidence ?? null }];
  }));
}

function nativeEffectOpenEvidence(run: any) {
  const events = (run.runtimeEvents as Array<Record<string, any>>).filter(event => event.event === 'native-effect-open')
    .map(({ trackId, slotId, runtimeId, helperSessionId, classId, parameterEvidence, nativeOpenEvidence }) => ({
      trackId, slotId, runtimeId, helperSessionId, classId, parameterEvidence, nativeOpenEvidence,
    }));
  if (events.length) return events;
  return (run.diagnostics as Array<Record<string, any>>).flatMap(diagnostic => {
    if (typeof diagnostic.message !== 'string') return [];
    const match = diagnostic.message.match(/Smoke controller parameters at open: (\[.*\])\.$/);
    if (!match) return [];
    try {
      return [{ trackId: diagnostic.trackId, slotId: diagnostic.slotId, parameterEvidence: JSON.parse(match[1]!) }];
    } catch { return [{ trackId: diagnostic.trackId, slotId: diagnostic.slotId, parameterEvidence: null, invalidEvidence: true }]; }
  });
}

function correlatedNativeFailures(run: any) {
  const openEvents = (run.runtimeEvents as Array<Record<string, any>>).filter(event => event.event === 'native-effect-open');
  const sessionIds = new Set(openEvents.map(event => event.helperSessionId).filter((id): id is string => typeof id === 'string'));
  const runtimeIds = new Set((run.runtimeEvents as Array<Record<string, any>>)
    .filter(event => event.event === 'worklet-submit' && typeof event.requestId === 'string')
    .map(event => event.requestId.split(':')[0]));
  const mainRows = (run.ipc.main.processAudio as Array<Record<string, any>>).filter(event =>
    sessionIds.has(event.serviceSessionId) || (typeof event.requestId === 'string' && runtimeIds.has(event.requestId.split(':')[0])));
  return mainRows.flatMap(event => {
    const failure = event.nativeFailureEvidence as Record<string, any> | null;
    if (!failure) return [];
    const failureInputFrame = Number(failure.requestProfile?.inputBlockStartContextFrame ?? event.inputBlockStartContextFrame);
    const sameTrackUpstream = mainRows.filter(candidate => candidate.trackId === event.trackId && candidate.slotId !== event.slotId);
    const exactUpstream = sameTrackUpstream.filter(candidate => Number(candidate.dueContextFrame) === failureInputFrame);
    const upstream = (exactUpstream.length ? exactUpstream : sameTrackUpstream.filter(candidate => candidate.sequence === event.sequence))
      .map(candidate => ({ requestId: candidate.requestId, sequence: candidate.sequence, slotId: candidate.slotId,
        dueContextFrame: candidate.dueContextFrame, inputRms: candidate.nativeInputRms,
        outputRms: candidate.nativeOutputRms, outputLeftRms: candidate.nativeOutputLeftRms,
        outputRightRms: candidate.nativeOutputRightRms, outputMonoSumRms: candidate.nativeOutputMonoSumRms,
        correlation: Number(candidate.dueContextFrame) === failureInputFrame ? 'upstream-due-frame-equals-failing-input-frame' : 'same-track-sequence-fallback' }));
    const downstreamFrame = Number(failure.requestProfile?.dueContextFrame ?? event.dueContextFrame);
    const downstreamWindow = Number.isFinite(downstreamFrame) ? { startContextFrame: downstreamFrame,
      endContextFrame: downstreamFrame + VST3_FX_BLOCK_FRAMES } : null;
    return [{ failure,
      mainRequest: { requestId: event.requestId, sequence: event.sequence, slotId: event.slotId,
        serviceSessionId: event.serviceSessionId, inputRms: event.nativeInputRms,
        inputLeftRms: event.nativeInputLeftRms, inputRightRms: event.nativeInputRightRms,
        inputMonoSumRms: event.nativeInputMonoSumRms, outputRms: event.nativeOutputRms,
        outputLeftRms: event.nativeOutputLeftRms, outputRightRms: event.nativeOutputRightRms,
        outputMonoSumRms: event.nativeOutputMonoSumRms, error: event.error },
      upstreamStageRequests: upstream,
      downstreamCapture: { window: downstreamWindow,
        nativeStages: downstreamWindow ? [...run.nativeStageCaptures].map(([slotId, capture]: [string, MixerCapture]) => ({
          slotId, rms: capturedRmsInWindow(capture, downstreamWindow.startContextFrame, downstreamWindow.endContextFrame),
        })) : [],
        tracks: downstreamWindow ? [...run.captures].map(([trackId, capture]: [number, MixerCapture]) => ({
          trackId, rms: capturedRmsInWindow(capture, downstreamWindow.startContextFrame, downstreamWindow.endContextFrame),
        })) : [],
        overallTrackRms: run.trackRms, nativeStageRms: run.nativeStageRms },
    }];
  });
}

function compactMixerRunEvidence(run: any) {
  const nativeStages = [...run.nativeStageCaptures].map(([slotId, capture]: [string, MixerCapture], index: number) => {
    const onset = firstCapturedOnsetFrame(capture, run.sourceStartContextFrame,
      run.sourceStartContextFrame + run.sampleRate);
    const expectedRelativeOnsetFrame = 256 + (index + 1) * VST3_FX_PIPELINE_FRAMES;
    return { slotId, expectedRelativeOnsetFrame,
      actualRelativeOnsetFrame: onset === null ? null : onset - run.sourceStartContextFrame,
      pcmRms: run.nativeStageRms[slotId],
      signal: capturedSignalEvidence(capture, run.sourceStartContextFrame, expectedRelativeOnsetFrame, run.sampleRate) };
  });
  const timing = run.timing;
  return { trackRms: run.trackRms, nativeStages, nativeServicePcm: nativeServicePcmBySlot(run),
    nativeEffectOpenEvidence: nativeEffectOpenEvidence(run),
    timing: { requestCount: timing.requestCount, acceptedWorkletResults: timing.acceptedWorkletResults,
      missedDeadlines: timing.missedDeadlines, unaccountedRequestCount: timing.unaccountedRequestCount,
      missingMainResponses: timing.missingMainResponses, missingWorkletResults: timing.missingWorkletResults,
      maxConcurrentMainServiceCalls: timing.maxConcurrentMainServiceCalls,
      nativeServiceSessionCountAfterCleanup: timing.nativeServiceSessionCountAfterCleanup } };
}

function createDeterministicMixerInput(context: AudioContext): AudioBuffer {
  // Keep the control signal explicitly stereo so the comparison isolates the
  // insert's declared latency, not StereoPannerNode's mono-to-stereo pan law.
  const buffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  let state = 0x6d2b79f5;
  for (let frame = 0; frame < left.length; frame++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const sample = ((state >>> 0) / 0x80000000 - 1) * 0.1;
    left[frame] = sample; right[frame] = sample;
  }
  return buffer;
}

function createKnownOnsetInput(context: AudioContext, amplitude: number): AudioBuffer {
  const onsetFrame = 256;
  const buffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  let state = amplitude < 0.06 ? 0x51ed270b : 0x2c1b3c6d;
  for (let frame = onsetFrame; frame < left.length; frame++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const sample = ((state >>> 0) / 0x80000000 - 1) * amplitude;
    left[frame] = sample; right[frame] = sample;
  }
  return buffer;
}

function createKnownOnsetBurstInput(context: AudioContext, amplitude: number): AudioBuffer {
  const buffer = context.createBuffer(2, context.sampleRate * 2, context.sampleRate);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  const burstStarts = [256, 24_000, 48_000];
  for (let burst = 0; burst < burstStarts.length; burst++) {
    let state = (amplitude < 0.06 ? 0x51ed270b : 0x2c1b3c6d) ^ Math.imul(burst + 1, 0x9e3779b1);
    for (let frame = burstStarts[burst]!; frame < burstStarts[burst]! + 256; frame++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const sample = ((state >>> 0) / 0x80000000 - 1) * amplitude;
      left[frame] = sample; right[frame] = sample;
    }
  }
  return buffer;
}

function capturedOnsetInWindow(capture: MixerCapture, startFrame: number, endFrame: number, threshold = 1e-6): number | null {
  for (const block of [...capture.blocks].sort((left, right) => left.frame - right.frame)) {
    if (block.frame + VST3_FX_BLOCK_FRAMES <= startFrame || block.frame >= endFrame) continue;
    for (let offset = 0; offset < VST3_FX_BLOCK_FRAMES; offset++) {
      const frame = block.frame + offset;
      if (frame < startFrame || frame >= endFrame) continue;
      const left = block.samples[offset] ?? 0;
      const right = block.samples[VST3_FX_BLOCK_FRAMES + offset] ?? 0;
      if (Math.max(Math.abs(left), Math.abs(right)) >= threshold) return frame;
    }
  }
  return null;
}

function firstCapturedOnsetFrame(capture: MixerCapture, startFrame: number, endFrame: number, threshold = 1e-6): number | null {
  return capturedOnsetInWindow(capture, startFrame, endFrame, threshold);
}

function capturedRmsInWindow(capture: MixerCapture, startFrame: number, endFrame: number) {
  let square = 0, count = 0;
  for (const block of capture.blocks) {
    for (let offset = 0; offset < VST3_FX_BLOCK_FRAMES; offset++) {
      const frame = block.frame + offset;
      if (frame < startFrame || frame >= endFrame) continue;
      const left = block.samples[offset] ?? 0;
      const right = block.samples[VST3_FX_BLOCK_FRAMES + offset] ?? 0;
      square += left * left + right * right;
      count += 2;
    }
  }
  return count ? Math.sqrt(square / count) : 0;
}

function capturedSignalEvidence(capture: MixerCapture, sourceStartFrame: number, expectedRelativeOnsetFrame: number, sampleRate: number) {
  const expected = sourceStartFrame + expectedRelativeOnsetFrame;
  const windowFrames = [VST3_FX_BLOCK_FRAMES, VST3_FX_BLOCK_FRAMES * 4, VST3_FX_BLOCK_FRAMES * 8];
  return { onsetsByThreshold: Object.fromEntries([1e-12, 1e-9, 1e-6].map(threshold => {
    const onset = firstCapturedOnsetFrame(capture, sourceStartFrame, sourceStartFrame + sampleRate, threshold);
    return [String(threshold), onset === null ? null : onset - sourceStartFrame];
  })),
  windowRms: windowFrames.map(frames => ({ startRelativeFrame: expected, endRelativeFrame: expected + frames,
    rms: capturedRmsInWindow(capture, expected, expected + frames) })) };
}

function compareCapturedMasterToTrackSum(captures: Map<number, MixerCapture>, startFrame: number, endFrame: number) {
  const samplesByTrack = new Map([...captures].map(([trackId, capture]) => {
    const samples = new Map<number, readonly [number, number]>();
    for (const block of capture.blocks) {
      for (let offset = 0; offset < VST3_FX_BLOCK_FRAMES; offset++) {
        const frame = block.frame + offset;
        if (frame < startFrame || frame >= endFrame) continue;
        samples.set(frame, [block.samples[offset]!, block.samples[VST3_FX_BLOCK_FRAMES + offset]!]);
      }
    }
    return [trackId, samples] as const;
  }));
  const master = samplesByTrack.get(0), leftTrack = samplesByTrack.get(1), rightTrack = samplesByTrack.get(2);
  if (!master || !leftTrack || !rightTrack) throw new Error('Packaged latency acceptance did not capture master and both source tracks');
  let sumSquared = 0, count = 0;
  for (let frame = startFrame; frame < endFrame; frame++) {
    const masterSample = master.get(frame), leftSample = leftTrack.get(frame), rightSample = rightTrack.get(frame);
    if (!masterSample || !leftSample || !rightSample) continue;
    for (let channel = 0; channel < 2; channel++) {
      const delta = masterSample[channel]! - leftSample[channel]! - rightSample[channel]!;
      sumSquared += delta * delta;
      count++;
    }
  }
  return { comparedSamples: count, rmsDifference: count ? Math.sqrt(sumSquared / count) : Infinity };
}

async function captureLiveMixerRun(instance: typeof audioEngine, channels: Channel[], mixer: MixerTrack[], options: MixerCaptureOptions = {}) {
  const context = instance.getContext() as AudioContext;
  const durationMs = options.durationMs ?? 1600;
  await context.resume();
  const taps = new Map<number, MixerCapture>();
  const nativeStageTaps = new Map<string, MixerCapture>();
  const smokeApi = (globalThis as any).desktopApp?.vst3;
  if (typeof smokeApi?.smokeTimingSnapshot !== 'function') throw new Error('Smoke-only production IPC timing snapshot is unavailable');
  const targetSource = context.createBufferSource();
  targetSource.buffer = options.inputBuffers?.get(1) ?? createDeterministicMixerInput(context);
  const targetGain = context.createGain();
  const runtimeStart = getNativeVst3MixerEffectSmokeTiming().length;
  const controlBuffer = options.inputBuffers?.get(2);
  const controlSource: AudioBufferSourceNode | OscillatorNode = controlBuffer
    ? context.createBufferSource() : context.createOscillator();
  if (controlBuffer) (controlSource as AudioBufferSourceNode).buffer = controlBuffer;
  else {
    (controlSource as OscillatorNode).type = 'sine';
    (controlSource as OscillatorNode).frequency.value = 750;
  }
  const controlGain = context.createGain();
  targetGain.gain.value = 1;
  controlGain.gain.value = controlBuffer ? 1 : 0.1;
  await instance.play(channels, [], 'pat', undefined, mixer, 16);
  await context.resume();
  for (const trackId of options.includeMaster ? [0, 1, 2] : [1, 2]) taps.set(trackId, await attachMixerCapture(instance, trackId));
  if (options.includeNativeStages) {
    const nativeSlots = mixer.find(track => track.id === 1)?.fxSlots.filter(slot => slot.enabled && slot.type === 'vst3') ?? [];
    const effectNodes = (instance.getOrCreateMixerChannel(1) as any).fxNodes as AudioNode[];
    if (effectNodes.length !== nativeSlots.length) {
      throw new Error(`Smoke-only native-stage tap mapping mismatch: ${effectNodes.length} prepared nodes for ${nativeSlots.length} enabled VST3 slots`);
    }
    for (let index = 0; index < nativeSlots.length; index++) {
      const slot = nativeSlots[index]!;
      nativeStageTaps.set(slot.id, await attachMixerCapture(instance, 1, effectNodes[index]!));
    }
  }
  targetSource.connect(targetGain); targetGain.connect(instance.getOrCreateMixerChannel(1).input);
  controlSource.connect(controlGain); controlGain.connect(instance.getOrCreateMixerChannel(2).input);
  const sourceStartTime = context.currentTime + 0.05;
  const sourceStartContextFrame = Math.round(sourceStartTime * context.sampleRate);
  targetSource.start(sourceStartTime); controlSource.start(sourceStartTime);
  await new Promise(resolve => setTimeout(resolve, 300));
  await smokeApi.smokeTimingSnapshot(); // warm the authorized timing IPC before the measured window
  const startedAt = performance.now();
  const startedContextFrame = sourceStartContextFrame + Math.round(0.25 * context.sampleRate);
  let bypassUpdateAppliedContextFrame: number | null = null;
  const bypassUpdate = options.bypassMixerTracks && options.bypassMixerAfterMs !== undefined
    ? new Promise<void>(resolve => setTimeout(() => {
      instance.synchronizePlaybackState({ mixerTracks: options.bypassMixerTracks! });
      bypassUpdateAppliedContextFrame = Math.round(context.currentTime * context.sampleRate);
      resolve();
    }, options.bypassMixerAfterMs))
    : Promise.resolve();
  await Promise.all([new Promise<void>(resolve => setTimeout(resolve, durationMs)), bypassUpdate]);
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
    capture.node.port.close();
    try { capture.source.disconnect(capture.node); } catch { /* the source may already have been removed */ }
    capture.node.disconnect(); capture.sink.disconnect();
  }
  const nativeStagePcm = new Map<string, PlanarPcm>();
  for (const [slotId, capture] of nativeStageTaps) {
    nativeStagePcm.set(slotId, toPlanarPcm(capture.blocks, startedContextFrame, stoppedContextFrame));
    capture.node.port.close();
    try { capture.source.disconnect(capture.node); } catch { /* the source may already have been removed */ }
    capture.node.disconnect(); capture.sink.disconnect();
  }
  const ipcAfter = await smokeApi.smokeTimingSnapshot();
  const runtimeEvents = getNativeVst3MixerEffectSmokeTiming().slice(runtimeStart);
  const ipc = ipcAfter;
  const duration = stoppedAt - startedAt;
  const sampleRate = context.sampleRate;
  const timing = summarizeMixerTiming(runtimeEvents, ipc, sampleRate, duration, startedAt, stoppedAt, stopRequestedAtRendererMs);
  return { pcm, tailRms, sampleRate, durationMs: duration, captureStartRendererMs: startedAt,
    captureEndRendererMs: stoppedAt, startedContextFrame, stoppedContextFrame, sourceStartContextFrame,
    bypassUpdateAppliedContextFrame, playbackActiveAtEnd, captures: taps, nativeStageCaptures: nativeStageTaps,
    nativeStagePcm,
    trackRms: Object.fromEntries([...pcm].map(([trackId, audio]) => [trackId, audio.rms])),
    nativeStageRms: Object.fromEntries([...nativeStagePcm].map(([slotId, audio]) => [slotId, audio.rms])),
    diagnostics: getVst3MixerEffectDiagnostics(), timing, runtimeEvents, ipc };
}

function compactNativeSessionAudit(run: any) {
  const opens = (run.runtimeEvents as Array<Record<string, any>>).filter(event =>
    event.event === 'native-effect-open' && event.trackId === 1);
  const samples = correlatedTimingSamples(run);
  const processEvents = run.ipc.main.processAudio as Array<Record<string, any>>;
  return Object.fromEntries(opens.map((openEvent: Record<string, any>) => {
    const slotId = String(openEvent.slotId);
    const sessionId = openEvent.helperSessionId;
    const sessionSamples = samples.filter(sample => sample.serviceSessionId === sessionId);
    const sessionProcessEvents = processEvents.filter(event => event.serviceSessionId === sessionId);
    const firstProcess = sessionProcessEvents.find(event => event.nativeProcessEvidence)?.nativeProcessEvidence ?? {};
    const open = openEvent.nativeOpenEvidence ?? {};
    const audit = open.stateApplication ?? {};
    const firstAudit = firstProcess.stateApplication?.firstProcess ?? null;
    return [slotId, { serviceSessionId: sessionId, runtimeId: openEvent.runtimeId,
      helperProcessId: open.helperProcessId ?? firstProcess.helperProcessId ?? null,
      requestCount: sessionSamples.length,
      failureEvidenceCount: sessionProcessEvents.filter(event => event.nativeFailureEvidence).length,
      openAudit: audit.classId ? { classId: audit.classId, stateProvided: audit.stateProvided,
        controllerAvailable: audit.controllerAvailable, componentStateInput: audit.componentStateInput,
        controllerStateInput: audit.controllerStateInput, componentStateApplied: audit.componentStateApplied,
        controllerComponentStateApplied: audit.controllerComponentStateApplied,
        controllerStateApplied: audit.controllerStateApplied, normalizedOverridesApplied: audit.normalizedOverridesApplied,
        lifecycleOrder: audit.lifecycleOrder, errors: audit.errors } : null,
      firstProcess: firstProcess.pluginClassId ? { requestProfile: firstProcess.requestProfile,
        frameIndex: firstProcess.frameIndex, blockIndex: firstProcess.blockIndex, frames: firstProcess.frames,
        processorCallResult: firstProcess.processorCallResult, queueAndOverrides: firstAudit,
        stateSnapshot: firstProcess.stateSnapshot } : null }];
  }));
}

function frameDelta(from: unknown, to: unknown) {
  const start = Number(from), end = Number(to);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
}

function sameProcessDeltaMs(from: unknown, to: unknown) {
  const start = Number(from), end = Number(to);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
}

function deadlineRequestEvidence(run: any) {
  const events = run.runtimeEvents as Array<Record<string, any>>;
  const ipc = run.ipc;
  const requestEvidence = (requestId: string) => {
    const find = (name: string) => events.find(event => event.event === name && event.requestId === requestId);
    const submit = find('worklet-submit');
    const received = find('renderer-request-received');
    const bridgeStart = find('renderer-bridge-call-start');
    const bridgeResponse = find('renderer-bridge-response');
    const result = find('worklet-result');
    const preload = (ipc.preload as Array<Record<string, any>>).find(event => event.requestId === requestId);
    const main = (ipc.main.processAudio as Array<Record<string, any>>).find(event => event.requestId === requestId);
    const resultPosted = find('renderer-result-posted');
    const resultPostFailed = find('renderer-result-post-failed');
    const stopAck = events.find(event => event.event === 'worklet-stop-ack' && event.requestId === requestId);
    const cancellation = events.find(event => event.event === 'renderer-request-cancelled-at-stop' && event.requestId === requestId);
    const orderedEvents = events.filter(event => event.requestId === requestId).map(event => ({
      event: event.event, sequence: event.sequence ?? null, accepted: event.accepted ?? null,
      reason: event.reason ?? null, cancellationStage: event.cancellationStage ?? null,
      resultPostedContextFrame: event.resultPostedContextFrame ?? null,
      bridgeResponseContextFrame: event.bridgeResponseContextFrame ?? null,
      rendererAtMs: event.rendererAtMs ?? null,
    }));
    const expected = ['worklet-submit', 'renderer-request-received', 'renderer-bridge-call-start',
      'renderer-bridge-response', 'renderer-result-posted', 'worklet-result'];
    const present = new Set(orderedEvents.map(event => event.event));
    if (preload) present.add('preload-ipc');
    if (main) present.add('main-processAudio');
    const confirmed = ['worklet-submit', 'renderer-request-received', 'preload-ipc', 'renderer-bridge-call-start',
      'main-processAudio', 'renderer-bridge-response', 'renderer-result-posted', 'worklet-result']
      .filter(name => present.has(name));
    const lastConfirmedEvent = confirmed.at(-1) ?? null;
    const firstMissingEvent = expected.find(name => !present.has(name)) ?? null;
    const submittedContextFrame = submit?.submittedContextFrame ?? received?.submittedContextFrame;
    const dueContextFrame = submit?.dueContextFrame ?? received?.dueContextFrame ?? bridgeResponse?.dueContextFrame;
    const submittedOutputFrame = submit?.submittedOutputFrame ?? received?.submittedOutputFrame;
    const dueOutputFrame = submit?.dueOutputFrame ?? result?.dueOutputFrame;
    const requestReceivedContextFrame = received?.requestReceivedContextFrame;
    const bridgeResponseContextFrame = bridgeResponse?.bridgeResponseContextFrame;
    const receivedOutputFrame = result?.receivedOutputFrame;
    return {
      requestId, sequence: submit?.sequence ?? received?.sequence ?? result?.sequence,
      slotId: submit?.slotId ?? received?.slotId,
      workletSubmission: {
        submittedContextFrame, dueContextFrame, submittedOutputFrame, dueOutputFrame,
        inputBlockStartContextFrame: submit?.inputBlockStartContextFrame ?? received?.inputBlockStartContextFrame,
      },
      rendererReceipt: {
        requestReceivedContextFrame, queueDepth: received?.queueDepth,
        submitToReceiptFrames: frameDelta(submittedContextFrame, requestReceivedContextFrame),
        receiptToDueContextFrames: frameDelta(requestReceivedContextFrame, dueContextFrame),
        origin: 'audio-context-frames',
      },
      rendererBridge: {
        roundTripMs: bridgeResponse?.bridgeRoundTripMs,
        queueWaitMs: sameProcessDeltaMs(received?.requestReceivedAt, bridgeStart?.bridgeCallStartedAt),
        responseContextFrame: bridgeResponseContextFrame,
        responseToDueContextFrames: frameDelta(bridgeResponseContextFrame, dueContextFrame),
        queueDepth: bridgeStart?.queueDepth ?? received?.queueDepth,
        origin: 'renderer-process-and-audio-context-frames',
      },
      preloadIpc: {
        roundTripMs: preload?.rendererIpcRttMs,
        origin: 'preload-process',
      },
      mainService: {
        dispatchMs: sameProcessDeltaMs(main?.ipcReceivedAtMainMs, main?.serviceStartAtMainMs),
        nativeServiceCallMs: main?.nativeServiceCallMs,
        activeCallsForEffectAtStart: main?.activeCallsForEffectAtStart,
        inputRms: main?.nativeInputRms, outputRms: main?.nativeOutputRms, error: main?.error,
        origin: 'main-process',
      },
      workletResult: {
        receivedOutputFrame, dueOutputFrame: result?.dueOutputFrame ?? dueOutputFrame,
        accepted: result?.accepted, pendingSequence: result?.pendingSequence,
        outputSlackFrames: frameDelta(receivedOutputFrame, result?.dueOutputFrame ?? dueOutputFrame),
        origin: 'audio-worklet-frames',
      },
      rendererResultPost: resultPosted || resultPostFailed ? {
        posted: !!resultPosted, failed: !!resultPostFailed, contextFrame: resultPosted?.resultPostedContextFrame ?? null,
        stopping: resultPosted?.stopping ?? resultPostFailed?.stopping ?? null,
        disposed: resultPosted?.disposed ?? resultPostFailed?.disposed ?? null,
        error: resultPostFailed?.error ?? null, origin: 'renderer-process',
      } : null,
      stopAck: stopAck ? { sequence: stopAck.sequence ?? null, reason: stopAck.reason, cancelled: stopAck.cancelled === true } : null,
      cancellation: cancellation ? { stage: cancellation.cancellationStage, reason: cancellation.reason } : null,
      orderedEvents, lastConfirmedEvent, firstMissingEvent,
    };
  };
  const requestGroup = (slotId: unknown, requestId: string, sequence: number) => {
    const runtimeId = requestId.includes(':') ? requestId.slice(0, requestId.lastIndexOf(':')) : '';
    const relevant = events.filter(event => event.event === 'worklet-submit' && event.slotId === slotId &&
      (runtimeId ? event.requestId?.startsWith(`${runtimeId}:`) : true) &&
      Number(event.sequence) >= Math.max(0, sequence - 2) && Number(event.sequence) <= sequence);
    const requests = relevant.map(event => requestEvidence(String(event.requestId)));
    if (requestId && !requests.some(row => row.requestId === requestId)) requests.push(requestEvidence(requestId));
    return requests;
  };
  const misses = events.filter(event => event.event === 'pending-deadline-miss' || event.event === 'deadline-miss');
  if (misses.length) {
    return misses.map(miss => {
      const requestId = String(miss.requestId ?? '');
      return { event: miss.event, trackId: miss.trackId, slotId: miss.slotId, requestId,
        pendingSequence: miss.sequence, nextSequence: miss.nextSequence,
        inputContextFrame: miss.inputContextFrame, currentOutputFrame: miss.currentOutputFrame,
        dueOutputFrame: miss.dueOutputFrame, readySequences: miss.readySequences, drySequences: miss.drySequences,
        requests: requestGroup(miss.slotId, requestId, Number(miss.sequence)) };
    });
  }
  const unresolved = (run.timing?.unaccountedRequests ?? []).filter((item: any) => typeof item.requestId === 'string');
  if (unresolved.length) {
    return unresolved.map((item: any) => ({
      event: 'unaccounted-request', trackId: item.trackId, slotId: item.slotId, requestId: String(item.requestId),
      pendingSequence: item.sequence, phase: item.phase,
      requests: requestGroup(item.slotId, String(item.requestId), Number(item.sequence)),
    }));
  }
  if (run.playbackActiveAtEnd === false) {
    const submits = events.filter(event => event.event === 'worklet-submit');
    const bySlot = new Map<string, Array<Record<string, any>>>();
    for (const event of submits) {
      const slotId = String(event.slotId ?? '');
      const list = bySlot.get(slotId) ?? [];
      list.push(event);
      bySlot.set(slotId, list);
    }
    return [...bySlot].map(([slotId, slotSubmits]) => {
      const latest = slotSubmits[slotSubmits.length - 1];
      const requestId = String(latest?.requestId ?? '');
      return { event: 'transport-stopped-without-deadline-event', trackId: latest?.trackId, slotId, requestId,
        pendingSequence: latest?.sequence, requests: requestGroup(slotId, requestId, Number(latest?.sequence)) };
    });
  }
  return [];
}

function compactDeadlineFrameSlack(run: any) {
  return deadlineRequestEvidence(run).map(miss => ({
    event: miss.event, slotId: miss.slotId, requestId: miss.requestId, pendingSequence: miss.pendingSequence,
    requests: miss.requests.map(request => ({
      requestId: request.requestId, sequence: request.sequence, slotId: request.slotId,
      submittedContextFrame: request.workletSubmission.submittedContextFrame,
      dueContextFrame: request.workletSubmission.dueContextFrame,
      submittedOutputFrame: request.workletSubmission.submittedOutputFrame,
      dueOutputFrame: request.workletSubmission.dueOutputFrame,
      requestReceivedContextFrame: request.rendererReceipt.requestReceivedContextFrame,
      submitToReceiptFrames: request.rendererReceipt.submitToReceiptFrames,
      receiptToDueContextFrames: request.rendererReceipt.receiptToDueContextFrames,
      rendererQueueDepth: request.rendererReceipt.queueDepth,
      bridgeResponseContextFrame: request.rendererBridge.responseContextFrame,
      bridgeResponseToDueContextFrames: request.rendererBridge.responseToDueContextFrames,
      rendererQueueWaitMs: request.rendererBridge.queueWaitMs,
      rendererBridgeRoundTripMs: request.rendererBridge.roundTripMs,
      preloadRoundTripMs: request.preloadIpc.roundTripMs,
      mainDispatchMs: request.mainService.dispatchMs,
      nativeServiceCallMs: request.mainService.nativeServiceCallMs,
      receivedOutputFrame: request.workletResult.receivedOutputFrame,
      outputSlackFrames: request.workletResult.outputSlackFrames,
      accepted: request.workletResult.accepted,
      cancellation: request.cancellation,
      resultPosted: request.rendererResultPost?.posted ?? false,
      lastConfirmedEvent: request.lastConfirmedEvent,
      firstMissingEvent: request.firstMissingEvent,
      orderedEvents: request.orderedEvents,
    })),
  }));
}

function assertPackagedMixerRun(run: any, label: string) {
  const timing = run.timing;
  const failures = correlatedNativeFailures(run);
  const deadlineRequests = deadlineRequestEvidence(run);
  const deadlineFrameSlack = compactDeadlineFrameSlack(run);
  const lifecycleCounts = {
    playbackActiveAtEnd: run.playbackActiveAtEnd, requestCount: timing.requestCount,
    submittedBlocks: timing.submittedBlocks, processingBlocks: timing.processingBlocks,
    acceptedWorkletResults: timing.acceptedWorkletResults, cancelledAtStopBlocks: timing.cancelledAtStopBlocks,
    measuredCancelledBeforeNativeBlocks: timing.measuredCancelledBeforeNativeBlocks,
    nativeCancelledAtStopBlocks: timing.nativeCancelledAtStopBlocks,
    rendererDiscardedAtStopBlocks: timing.rendererDiscardedAtStopBlocks,
    missedDeadlines: timing.missedDeadlines, unaccountedRequestCount: timing.unaccountedRequestCount,
    missingMainResponses: timing.missingMainResponses, missingWorkletResults: timing.missingWorkletResults,
    requestFailures: timing.requestFailures, unexpectedStopCancellations: timing.unexpectedStopCancellations,
    maxPerInstanceQueueDepth: timing.maxPerInstanceQueueDepth,
    maxConcurrentCallsPerEffect: timing.maxConcurrentCallsPerEffect,
    workletSubmissionToReceipt: timing.workletSubmissionToReceipt,
    rendererSerializedQueueWait: timing.rendererSerializedQueueWait,
    rendererBridgeRoundTrip: timing.rendererBridgeRoundTrip,
    mainNativeServiceCall: timing.mainNativeServiceCall, scheduledOutputSlack: timing.scheduledOutputSlack,
    smokeTimingDropped: timing.smokeTimingDropped,
    rendererResultPosted: timing.rendererResultPosted,
    rendererResultPostFailed: timing.rendererResultPostFailed,
    nullSequenceStopAcknowledgements: timing.nullSequenceStopAcknowledgements,
    stopAcknowledgementTimeouts: timing.stopAcknowledgementTimeouts,
    teardownCancelledAtStopBlocks: timing.teardownCancelledAtStopBlocks,
    workletStopAcknowledgements: timing.workletStopAcknowledgements,
    rendererStopAckTimeouts: timing.rendererStopAckTimeouts,
    shutdownEvents: timing.shutdownEvents,
  };
  const evidence = JSON.stringify({ nativeFailureEvidence: failures,
    nativeSessions: compactNativeSessionAudit(run), deadlineRequests, deadlineFrameSlack, lifecycleCounts,
    nativeServicePcm: nativeServicePcmBySlot(run),
    timing: { blockPeriodMs: timing.blockPeriodMs, captureDurationMs: timing.captureDurationMs,
      playbackActiveAtEnd: run.playbackActiveAtEnd, requestCount: timing.requestCount,
      submittedBlocks: timing.submittedBlocks, processingBlocks: timing.processingBlocks,
      acceptedWorkletResults: timing.acceptedWorkletResults, missedDeadlines: timing.missedDeadlines,
      maxPerInstanceQueueDepth: timing.maxPerInstanceQueueDepth, maxConcurrentCallsPerEffect: timing.maxConcurrentCallsPerEffect,
      maxConcurrentMainServiceCalls: timing.maxConcurrentMainServiceCalls,
      nativeServiceSessionCountAfterCleanup: timing.nativeServiceSessionCountAfterCleanup,
      unaccountedRequestCount: timing.unaccountedRequestCount, missingMainResponses: timing.missingMainResponses,
      missingWorkletResults: timing.missingWorkletResults, requestFailures: timing.requestFailures,
      unexpectedStopCancellations: timing.unexpectedStopCancellations,
      preCaptureSubmittedBlocks: timing.preCaptureSubmittedBlocks,
      workletSubmissionToReceipt: timing.workletSubmissionToReceipt,
      rendererSerializedQueueWait: timing.rendererSerializedQueueWait,
      rendererBridgeRoundTrip: timing.rendererBridgeRoundTrip,
      mainNativeServiceCall: timing.mainNativeServiceCall, scheduledOutputSlack: timing.scheduledOutputSlack },
    diagnostics: run.diagnostics, tailRms: run.tailRms, trackRms: run.trackRms });
  const fail = (reason: string) => {
    throw new Error(`${label}: ${reason}; lifecycleCounts=${JSON.stringify(lifecycleCounts)}; deadlineFrameSlack=${JSON.stringify(deadlineFrameSlack)}; bounded production timing evidence=${evidence}`);
  };
  if (run.sampleRate !== 48000) fail(`expected the packaged AudioContext at 48 kHz, got ${run.sampleRate}`);
  if (!run.playbackActiveAtEnd) fail(`production Mixer transport stopped during capture; diagnostics=${JSON.stringify(run.diagnostics)}`);
  if (timing.requestCount < 10 || timing.acceptedWorkletResults + timing.cancelledAtStopBlocks !== timing.requestCount ||
      timing.processingBlocks + timing.nativeCancelledAtStopBlocks + timing.measuredCancelledBeforeNativeBlocks !== timing.requestCount ||
      timing.cancelledAtStopBlocks > 2 || timing.teardownCancelledAtStopBlocks > 2 || timing.stopAcknowledgementTimeouts !== 0 ||
      timing.unaccountedRequestCount !== 0 || timing.missingMainResponses !== 0 || timing.missingWorkletResults !== 0 ||
      timing.requestFailures.length !== 0 || timing.unexpectedStopCancellations.length !== 0) {
    fail('production request lifecycle did not resolve each submission or receive an explicit, sequence-matched stop acknowledgement');
  }
  if (timing.missedDeadlines !== 0) fail('production Mixer deadline failure(s)');
  if (timing.maxConcurrentCallsPerEffect > 1 || timing.maxPerInstanceQueueDepth > 1) {
    fail('per-effect native helper processing was not serialized/bounded');
  }
  if (timing.nativeServiceSessionCountAfterCleanup !== 0) fail('native helper sessions leaked after stop/disposal');
  const blockPeriodMs = VST3_FX_BLOCK_FRAMES * 1000 / run.sampleRate;
  if (timing.workletSubmissionToReceipt.maxMs === null || timing.workletSubmissionToReceipt.maxMs > blockPeriodMs + 1e-6) {
    fail('worklet result missed the 21.33 ms 1024-frame scheduling window');
  }
  for (const trackId of [1, 2]) {
    const tail = run.tailRms[String(trackId)];
    if (!tail || tail.settled > 1e-5) fail(`stale PCM remained on track ${trackId} after stop/disposal: ${JSON.stringify(tail)}`);
  }
}

async function runPackagedMixerAcceptance(instance: typeof audioEngine, persistedMixerTracks?: MixerTrack[]) {
  const desktopApi = (globalThis as any).desktopApp;
  if (desktopApi?.smokeTest !== true || typeof desktopApi?.vst3?.smokeTimingSnapshot !== 'function') {
    return { status: 'not-run', reason: 'Mixer production IPC/timing acceptance is restricted to the explicit packaged smoke-test launch.' };
  }
  resetNativeVst3MixerEffectSmokeTiming();
  const bridge = getVst3Bridge();
  if (!bridge) throw new Error('Packaged production VST3 preload bridge missing for Mixer acceptance');
  const context = instance.getContext() as AudioContext;
  const discovered = await bridge.discoverEffects();
  const delayIdentity = discovered.plugins.find(plugin => plugin.name === 'mda Delay');
  const filterIdentity = discovered.plugins.find(plugin => plugin.name === 'mda RezFilter');
  if (!delayIdentity || !filterIdentity) throw new Error(`Redistributable MDA Mixer fixtures unavailable through packaged production IPC: ${JSON.stringify(discovered.errors)}`);
  const delay = await bridge.inspectEffect(delayIdentity);
  const inspectedRezFilter = await bridge.inspectEffect(filterIdentity);
  // The pinned mda RezFilter leaves its LFO phase as processing-instance state.
  // Its default envelope/LFO modulation can hold the cutoff closed for a
  // nondeterministic startup interval, which is not native bridge latency. For
  // onset/ordering acceptance only, disable both modulators and use a fixed,
  // positive cutoff so the real effect is audibly responsive from its first
  // processed block. This is a test-fixture state, not a change to user audio.
  const rezFilterLatencyParameters = [
    { id: 0, value: 0.8 },  // fixed cutoff above zero
    { id: 1, value: 0.25 }, // stable, modest resonance
    { id: 3, value: 0.5 },  // disable envelope-to-filter modulation
    { id: 6, value: 0.5 },  // disable LFO-to-filter modulation
    { id: 8, value: 0 },    // disable trigger mode
    { id: 9, value: 1 },    // keep maximum cutoff above the fixed setting
  ];
  const rezFilterParameterMap = new Map<number, { id: number; value: number }>(
    inspectedRezFilter.state.parameters.map(parameter => [parameter.id, parameter]));
  for (const parameter of rezFilterLatencyParameters) rezFilterParameterMap.set(parameter.id, parameter);
  const rezFilter = await bridge.inspectEffect(filterIdentity, {
    ...inspectedRezFilter.state, parameters: [...rezFilterParameterMap.values()],
  });
  let restoredMixerParameterEvidence: Record<string, unknown> | undefined;
  if (persistedMixerTracks) {
    const savedTrack = persistedMixerTracks.find(track => track.id === 1);
    const savedSlots = savedTrack?.fxSlots.filter(slot => slot.type === 'vst3' && slot.enabled) ?? [];
    const savedFilterSlot = savedSlots.find(slot => slot.id === 'smoke-rezfilter');
    if (savedSlots.length !== 2 || savedSlots[0]?.id !== 'smoke-delay' || !savedFilterSlot?.vst3Effect ||
        savedFilterSlot.vst3Effect.classId !== filterIdentity.classId) {
      throw new Error(`Saved-project Mixer inserts did not reopen in the original Delay → RezFilter order: ${JSON.stringify(savedSlots.map(slot => ({ id: slot.id, classId: slot.vst3Effect?.classId })))}`);
    }
    const savedParameters = new Map(savedFilterSlot.vst3Effect.state.parameters.map(parameter => [parameter.id, parameter.value]));
    for (const { id, value } of rezFilterLatencyParameters) {
      if (Math.abs((savedParameters.get(id) ?? -1) - value) > 1e-7) {
        throw new Error(`Saved-project RezFilter normalized state changed for parameter ${id}: ${savedParameters.get(id)}`);
      }
    }
    const restoredMetadata = await bridge.describeEffect(savedFilterSlot.vst3Effect);
    for (const { id, value } of rezFilterLatencyParameters) {
      if (Math.abs((restoredMetadata.parameters.find(parameter => parameter.id === id)?.currentValue ?? -1) - value) > 1e-7) {
        throw new Error(`Saved-project RezFilter controller metadata changed for parameter ${id}`);
      }
    }
    restoredMixerParameterEvidence = {
      projectTrackId: savedTrack!.id, slotOrder: savedSlots.map(slot => slot.id), classId: savedFilterSlot.vst3Effect.classId,
      requestedParameters: rezFilterLatencyParameters, restoredControllerValues: Object.fromEntries(
        rezFilterLatencyParameters.map(({ id }) => [id, restoredMetadata.parameters.find(parameter => parameter.id === id)?.currentValue])),
    };
  }
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
  const run = async (mixer: MixerTrack[], label: string, options: MixerCaptureOptions = {}) => {
    const result = await captureLiveMixerRun(instance, channels, mixer, options);
    if (mixer.some(track => track.fxSlots.some(slot => slot.enabled && slot.type === 'vst3'))) assertPackagedMixerRun(result, label);
    else {
      if (!result.playbackActiveAtEnd || result.timing.nativeServiceSessionCountAfterCleanup !== 0 ||
          result.tailRms['1']!.settled > 1e-5 || result.tailRms['2']!.settled > 1e-5) {
        throw new Error(`${label}: cleanup/removal/restart left stale PCM or helper sessions: ${JSON.stringify({ active: result.playbackActiveAtEnd, sessions: result.timing.nativeServiceSessionCountAfterCleanup, tailRms: result.tailRms })}`);
      }
    }
    return result;
  };

  const orderA = await run(ordered, 'Mixer order Delay → RezFilter', { includeNativeStages: true });
  const orderB = await run(reversed, 'Mixer order RezFilter → Delay', { includeNativeStages: true });
  const delayProcessed = await run(delayOnly, 'Mixer processed Delay', { includeNativeStages: true });
  const delayPassThrough = await run(delayBypassed, 'Mixer native Delay Fb Mix=0 bypass', { includeNativeStages: true });
  const removed = await run(noEffects, 'Mixer effect removal/restart');

  // Known-onset stereo buffers exercise the real per-track → routed master
  // path. The no-insert, one-insert, and two-insert cases have the same source
  // onset on tracks 1 and 2; the per-track taps and master tap are read at their
  // actual AudioWorklet frame stamps, with no comparison-side offset.
  const onsetInputs = () => new Map([[1, createKnownOnsetInput(context, 0.08)], [2, createKnownOnsetInput(context, 0.035)]]);
  const oneNativeInsert = withSlots([makeSlot('latency-one-delay', bypassDelay)]);
  const twoNativeInserts = withSlots([makeSlot('latency-two-delay', bypassDelay), makeSlot('latency-two-filter', rezFilter)]);
  const alignmentOptions = (): MixerCaptureOptions => ({ durationMs: 1050, inputBuffers: onsetInputs(), includeMaster: true, includeNativeStages: true });
  const zeroInsertAlignment = await run(noEffects, 'Mixer onset alignment zero inserts', alignmentOptions());
  const oneInsertAlignment = await run(oneNativeInsert, 'Mixer onset alignment one insert', alignmentOptions());
  const twoInsertAlignments = [await run(twoNativeInserts, 'Mixer onset alignment two inserts attempt 1', alignmentOptions())];
  for (let attempt = 2; attempt <= 8; attempt++) {
    twoInsertAlignments.push(await run(twoNativeInserts, `Mixer onset alignment two inserts attempt ${attempt}`, alignmentOptions()));
  }
  const onsetFramesFor = (result: any) => Object.fromEntries([0, 1, 2].map(trackId => [trackId,
    firstCapturedOnsetFrame(result.captures.get(trackId), result.sourceStartContextFrame,
      result.sourceStartContextFrame + result.sampleRate)]));
  const alignmentRows = [
    { label: 'zero-insert', result: zeroInsertAlignment, expectedPipelineFrames: 0 },
    { label: 'one-insert', result: oneInsertAlignment, expectedPipelineFrames: VST3_FX_PIPELINE_FRAMES },
    ...twoInsertAlignments.map((result, index) => ({
      label: `two-insert-attempt-${index + 1}`, result, expectedPipelineFrames: VST3_FX_PIPELINE_FRAMES * 2,
    })),
  ].map(({ label, result, expectedPipelineFrames }) => {
    const onsets = onsetFramesFor(result);
    const expectedRelativeOnsetFrame = 256 + expectedPipelineFrames;
    const actualRelativeOnsets = [1, 2].map(trackId => onsets[String(trackId)] === null ? null :
      Number(onsets[String(trackId)]) - result.sourceStartContextFrame);
    const masterRelativeOnset = onsets['0'] === null ? null : Number(onsets['0']) - result.sourceStartContextFrame;
    const nativeStageRows = [...result.nativeStageCaptures].map(([slotId, capture]: [string, MixerCapture], index) => {
      const onset = firstCapturedOnsetFrame(capture, result.sourceStartContextFrame,
        result.sourceStartContextFrame + result.sampleRate);
      const expectedRelativeOnsetFrame = 256 + (index + 1) * VST3_FX_PIPELINE_FRAMES;
      return { slotId, expectedRelativeOnsetFrame,
        actualRelativeOnsetFrame: onset === null ? null : onset - result.sourceStartContextFrame,
        pcmRms: result.nativeStageRms[slotId],
        signal: capturedSignalEvidence(capture, result.sourceStartContextFrame, expectedRelativeOnsetFrame, result.sampleRate) };
    });
    const nativeServicePcm = nativeServicePcmBySlot(result);
    const tapSignalEvidence = Object.fromEntries([0, 1, 2].map(trackId => [trackId,
      capturedSignalEvidence(result.captures.get(trackId), result.sourceStartContextFrame, expectedRelativeOnsetFrame, result.sampleRate)]));
    const masterSum = compareCapturedMasterToTrackSum(result.captures, result.sourceStartContextFrame + expectedRelativeOnsetFrame,
      result.sourceStartContextFrame + expectedRelativeOnsetFrame + VST3_FX_BLOCK_FRAMES * 8);
    const nativeStageServiceValid = nativeStageRows.every((stage: any) => {
      const row = nativeServicePcm[stage.slotId];
      return row?.requests >= 10 && row.inputRms.nonzero === row.requests && row.outputRms.nonzero === row.requests;
    });
    const expectedNativeSlots = expectedPipelineFrames === 0 ? [] : expectedPipelineFrames === VST3_FX_PIPELINE_FRAMES
      ? ['latency-one-delay'] : ['latency-two-delay', 'latency-two-filter'];
    const nativeStageOrderValid = nativeStageRows.map((stage: any) => stage.slotId).join('|') === expectedNativeSlots.join('|');
    if (actualRelativeOnsets.some(frame => frame !== expectedRelativeOnsetFrame) || masterRelativeOnset !== expectedRelativeOnsetFrame ||
        !nativeStageOrderValid || nativeStageRows.some((stage: any) => stage.actualRelativeOnsetFrame !== stage.expectedRelativeOnsetFrame) ||
        !nativeStageServiceValid || masterSum.comparedSamples < VST3_FX_BLOCK_FRAMES * 2 || masterSum.rmsDifference > 1e-5) {
      const evidence = { nativeFailureEvidence: correlatedNativeFailures(result), nativeSessions: nativeSessionEvidence(result),
        onsets, sourceStartContextFrame: result.sourceStartContextFrame, expectedRelativeOnsetFrame,
        actualRelativeOnsets, masterRelativeOnset, nativeStageRows, nativeServicePcm,
        nativeStageOrderValid, nativeStageServiceValid,
        nativeEffectOpenEvidence: nativeEffectOpenEvidence(result), tapSignalEvidence, masterSum,
        trackRms: result.trackRms, diagnostics: result.diagnostics,
        timing: { requestCount: result.timing.requestCount, acceptedWorkletResults: result.timing.acceptedWorkletResults,
          missedDeadlines: result.timing.missedDeadlines, requestFailures: result.timing.requestFailures,
          unaccountedRequestCount: result.timing.unaccountedRequestCount, missingMainResponses: result.timing.missingMainResponses,
          missingWorkletResults: result.timing.missingWorkletResults, maxConcurrentMainServiceCalls: result.timing.maxConcurrentMainServiceCalls },
        recentRuntimeEvents: result.runtimeEvents.slice(-12).map((event: any) => ({
          event: event.event, trackId: event.trackId, slotId: event.slotId, sequence: event.sequence,
          reason: event.reason, error: event.error, accepted: event.accepted,
          dueOutputFrame: event.dueOutputFrame, receivedOutputFrame: event.receivedOutputFrame,
        })) };
      throw new Error(`Production Mixer ${label} alignment failed: expected all three measured taps and each native insert output at their calibrated source offsets: ${JSON.stringify(evidence)}`);
    }
    return { label, expectedPipelineFrames, sourceStartContextFrame: result.sourceStartContextFrame,
      expectedRelativeOnsetFrame, onsetContextFrames: onsets, relativeOnsetFrames: {
        track1: actualRelativeOnsets[0], track2: actualRelativeOnsets[1], master: masterRelativeOnset,
      }, nativeStageRows, nativeStageServiceValid, nativeServicePcm, nativeSessions: nativeSessionEvidence(result),
      nativeFailureEvidence: correlatedNativeFailures(result),
      masterSumPcmDifferenceRms: masterSum.rmsDifference, masterSumComparedSamples: masterSum.comparedSamples };
  });
  let savedProjectReopenEvidence: Record<string, unknown> | undefined;
  if (persistedMixerTracks) {
    const reopenedMixer = await run(persistedMixerTracks, 'Mixer saved-project reopen after a separate app process', alignmentOptions());
    const expectedRelativeOnsetFrame = 256 + VST3_FX_PIPELINE_FRAMES * 2;
    const onsets = onsetFramesFor(reopenedMixer);
    const relativeOnsets = Object.fromEntries([0, 1, 2].map(trackId => [trackId,
      onsets[String(trackId)] === null ? null : Number(onsets[String(trackId)]) - reopenedMixer.sourceStartContextFrame]));
    const nativeStageRows = [...reopenedMixer.nativeStageCaptures].map(([slotId, capture]: [string, MixerCapture], index) => {
      const onset = firstCapturedOnsetFrame(capture, reopenedMixer.sourceStartContextFrame,
        reopenedMixer.sourceStartContextFrame + reopenedMixer.sampleRate);
      return { slotId, expectedRelativeOnsetFrame: 256 + (index + 1) * VST3_FX_PIPELINE_FRAMES,
        actualRelativeOnsetFrame: onset === null ? null : onset - reopenedMixer.sourceStartContextFrame,
        pcmRms: reopenedMixer.nativeStageRms[slotId] };
    });
    const nativeServicePcm = nativeServicePcmBySlot(reopenedMixer);
    const expectedSlots = ['smoke-delay', 'smoke-rezfilter'];
    const serviceRequestsValid = expectedSlots.every(slotId => {
      const row = nativeServicePcm[slotId];
      return row?.requests === 50 && row.inputRms.nonzero === row.requests && row.outputRms.nonzero === row.requests;
    });
    const masterSum = compareCapturedMasterToTrackSum(reopenedMixer.captures,
      reopenedMixer.sourceStartContextFrame + expectedRelativeOnsetFrame,
      reopenedMixer.sourceStartContextFrame + expectedRelativeOnsetFrame + VST3_FX_BLOCK_FRAMES * 8);
    if (Object.values(relativeOnsets).some(frame => frame !== expectedRelativeOnsetFrame) ||
        nativeStageRows.length !== 2 || nativeStageRows.some((stage: any, index: number) =>
          stage.slotId !== expectedSlots[index] || stage.actualRelativeOnsetFrame !== stage.expectedRelativeOnsetFrame) ||
        !serviceRequestsValid || masterSum.comparedSamples < VST3_FX_BLOCK_FRAMES * 2 || masterSum.rmsDifference > 1e-5) {
      throw new Error(`Persisted Mixer Delay → RezFilter state failed after separate application reopen: ${JSON.stringify({
        nativeFailureEvidence: correlatedNativeFailures(reopenedMixer),
        nativeSessions: nativeSessionEvidence(reopenedMixer),
        expectedRelativeOnsetFrame, relativeOnsets, nativeStageRows, nativeServicePcm,
        restoredState: restoredMixerParameterEvidence,
        nativeEffectOpenEvidence: nativeEffectOpenEvidence(reopenedMixer), masterSum,
        sourceStartContextFrame: reopenedMixer.sourceStartContextFrame,
        timing: { requestCount: reopenedMixer.timing.requestCount, missedDeadlines: reopenedMixer.timing.missedDeadlines,
          requestFailures: reopenedMixer.timing.requestFailures, nativeServiceSessionCountAfterCleanup: reopenedMixer.timing.nativeServiceSessionCountAfterCleanup },
      })}`);
    }
    savedProjectReopenEvidence = {
      restoredState: restoredMixerParameterEvidence,
      nativeEffectOpenEvidence: nativeEffectOpenEvidence(reopenedMixer),
      nativeSessions: nativeSessionEvidence(reopenedMixer),
      nativeFailureEvidence: correlatedNativeFailures(reopenedMixer),
      sourceStartContextFrame: reopenedMixer.sourceStartContextFrame,
      expectedRelativeOnsetFrame, relativeOnsets, nativeStageRows, nativeServicePcm,
      masterSumPcmDifferenceRms: masterSum.rmsDifference, masterSumComparedSamples: masterSum.comparedSamples,
    };
  }
  const bypassedOneNativeInsert = oneNativeInsert.map(track => track.id === 1
    ? { ...track, fxSlots: track.fxSlots.map(slot => ({ ...slot, enabled: false })) } : track);
  const dynamicBypass = await run(oneNativeInsert, 'Mixer live slot bypass retains its prepared pipeline', {
    durationMs: 1150,
    inputBuffers: new Map([[1, createKnownOnsetBurstInput(context, 0.08)], [2, createKnownOnsetBurstInput(context, 0.035)]]),
    includeMaster: true, bypassMixerAfterMs: 80, bypassMixerTracks: bypassedOneNativeInsert,
  });
  if (dynamicBypass.bypassUpdateAppliedContextFrame === null) {
    throw new Error('Packaged live Mixer bypass mutation was not applied during the prepared native pipeline.');
  }
  const bypassBurstRows = [256, 24_000, 48_000].map(inputFrame => {
    const expected = dynamicBypass.sourceStartContextFrame + inputFrame + VST3_FX_PIPELINE_FRAMES;
    const onsets = Object.fromEntries([0, 1, 2].map(trackId => [trackId, capturedOnsetInWindow(
      dynamicBypass.captures.get(trackId), expected - 32, expected + VST3_FX_BLOCK_FRAMES)]));
    const masterSum = compareCapturedMasterToTrackSum(dynamicBypass.captures, expected,
      expected + VST3_FX_BLOCK_FRAMES * 2);
    if (Object.values(onsets).some(frame => frame !== expected) || masterSum.rmsDifference > 1e-5) {
      throw new Error(`Dynamic live bypass changed the prepared pipeline alignment at input frame ${inputFrame}: ${JSON.stringify({ inputFrame, expected, onsets, bypassUpdateAppliedContextFrame: dynamicBypass.bypassUpdateAppliedContextFrame, masterSum })}`);
    }
    return { inputFrame, expectedContextFrame: expected, measuredOnsetContextFrames: onsets,
      masterSumPcmDifferenceRms: masterSum.rmsDifference, masterSumComparedSamples: masterSum.comparedSamples };
  });
  const firstBypassBurstFrame = dynamicBypass.sourceStartContextFrame + 256 + VST3_FX_PIPELINE_FRAMES;
  const secondBypassBurstFrame = dynamicBypass.sourceStartContextFrame + 24_000 + VST3_FX_PIPELINE_FRAMES;
  if (!(dynamicBypass.bypassUpdateAppliedContextFrame > firstBypassBurstFrame &&
        dynamicBypass.bypassUpdateAppliedContextFrame < secondBypassBurstFrame)) {
    throw new Error(`Dynamic bypass did not occur between the two deterministic source bursts: ${JSON.stringify({ applied: dynamicBypass.bypassUpdateAppliedContextFrame, firstBypassBurstFrame, secondBypassBurstFrame })}`);
  }
  const acceptanceTimingEvidence = JSON.stringify(Object.fromEntries(Object.entries({ orderA, orderB, delayProcessed, delayPassThrough, removed })
    .map(([label, result]) => [label, compactMixerRunEvidence(result)])));
  let orderDifference: ReturnType<typeof compareMixerRuns>, controlDifference: ReturnType<typeof compareMixerRuns>;
  let processedVsBypass: ReturnType<typeof compareMixerRuns>, bypassVsRemoved: ReturnType<typeof compareMixerRuns>;
  try {
    orderDifference = compareMixerRuns(orderA, orderB, 1, 'order reversal');
    controlDifference = compareMixerRuns(orderA, orderB, 2, 'control-track isolation');
    processedVsBypass = compareMixerRuns(delayProcessed, delayPassThrough, 1, 'processed vs native bypass');
    bypassVsRemoved = compareMixerRuns(delayPassThrough, removed, 1, 'native bypass vs removed insert', -VST3_FX_PIPELINE_FRAMES);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; per-request input/output and timing evidence=${acceptanceTimingEvidence}`);
  }
  const controlRmsDifference = Math.abs(orderA.trackRms['2'] - orderB.trackRms['2']);
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
    latencyCompensation: 'Before each Mixer bus FX chain, direct producers and every routed/aux child branch are delayed to the slowest incoming fixed native-bridge path. Each prepared native insert contributes exactly 2048 frames; bypass retains that budget while its prepared worklet remains in the chain. Plugin-reported nonzero latency remains unsupported. Offline rendering sets this live-only compensation budget to zero and processes effects on project frames.',
    latencyFixture: { plugin: rezFilter.name, parameters: rezFilterLatencyParameters,
      reason: 'LFO/envelope modulation disabled and cutoff fixed positive so onset timing measures the bridge pipeline, not variable plugin startup silence.' },
    reopenedMixerParameterAudit: savedProjectReopenEvidence ? {
      savedState: savedProjectReopenEvidence.restoredState,
      openedInstances: savedProjectReopenEvidence.nativeEffectOpenEvidence,
    } : null,
    twoInsertFreshInstanceAttempts: twoInsertAlignments.map((result, index) => ({ attempt: index + 1,
      sourceStartContextFrame: result.sourceStartContextFrame, nativeSessions: nativeSessionEvidence(result),
      failureEvidenceCount: correlatedNativeFailures(result).length })),
    latencyAlignmentRegression: alignmentRows,
    savedProjectReopen: savedProjectReopenEvidence,
    persistedProjectMixerTracks: ordered,
    priorPlaywrightBridgeReference: { approximatelyMs: 28, measurement: 'test-only page.exposeFunction bridge; separate from this production IPC/preload/helper measurement' },
    orderDifferenceRms: orderDifference.rmsDifference, orderOffsetFrames: orderDifference.normalizedLagFrames,
    controlTrackRmsDifference: controlRmsDifference, controlTrackPcmDifferenceRms: controlDifference.rmsDifference,
    controlTrackRms: { orderA: orderA.trackRms['2'], orderB: orderB.trackRms['2'] },
    controlTrackIsolationMethod: 'A smoke-only phase-reset 750 Hz oscillator is routed through production track 2; compare PCM at exact AudioWorklet context-frame alignment across effect-order captures.',
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
    proof: 'Packaged Electron production AudioWorklet → authorized main IPC → native VST3 helper → production preload → worklet PCM, captured from per-track and master production Mixer analysers. Deterministic broadband stereo target input preserves the mono-pan-law regression fix. A separate non-periodic known-onset stereo stimulus verifies zero/one/two-insert alignment from actual captured frame positions, with no assertion-side offsets; the master PCM is checked against the exact-frame sum of both track taps. A phase-reset control signal still checks isolation; no exposeFunction processing bridge.'
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
  let savedMixerTracks: MixerTrack[] | undefined;
  const reopening = (globalThis as unknown as { desktopApp?: { smokeReopen?: boolean } }).desktopApp?.smokeReopen === true;
  if (reopening) {
    const saved = await restorePersistedProjectState(instance, createDefaultProjectState());
    if (!saved.restored || saved.recovered || saved.state.channels[0]?.instrumentType !== 'vst3') throw new Error('Native project did not reopen from the real current-project IndexedDB record');
    channel = saved.state.channels[0];
    savedAutomation = saved.state.playlistClips.find(c => c.automationTarget?.type === 'vst3_param');
    if (!savedAutomation) throw new Error('Native automation lane did not survive application restart');
    savedMixerTracks = saved.state.mixerTracks;
    if (!Array.isArray(savedMixerTracks) || savedMixerTracks.length === 0) throw new Error('Saved Mixer effect project did not reopen from the real current-project IndexedDB record');
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
    const mixerAcceptance = await runPackagedMixerAcceptance(instance, savedMixerTracks);
    const { persistedProjectMixerTracks, ...mixerEffects } = mixerAcceptance;
    if (!reopening) savedMixerTracks = persistedProjectMixerTracks;
    if (reopening && mixerEffects.status === 'passed' && !mixerEffects.savedProjectReopen) throw new Error('Saved Mixer effect state was not processed through the production graph after application restart');
    if (reopening && !document.body.textContent?.includes(channel.name)) throw new Error('The actual Apex application UI did not restore the saved native channel');
    if (!reopening) {
      const project = createDefaultProjectState();
      await persistProjectState({ ...project, meta: { ...project.meta, bpm: 120 }, selectedChannelId: channel.id, channels: [channel], mixerTracks: savedMixerTracks ?? mixer, playlistClips: [clip, automation] });
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
