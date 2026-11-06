import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const APP_URL = 'http://localhost:3000';

async function unlockAudio(page: Page, createCaptureContext = true) {
  await page.waitForFunction(() => !!document.body);
  await page.evaluate((withCaptureContext) => {
    const prior = document.getElementById('recording-alignment-unlock');
    prior?.remove();
    const button = document.createElement('button');
    button.id = 'recording-alignment-unlock';
    button.textContent = 'Unlock recording test audio';
    button.style.cssText = 'position:fixed;z-index:2147483647;left:12px;top:12px;padding:12px;background:#ff6e00;color:#111;font:600 14px sans-serif;border:0;border-radius:8px';
    button.addEventListener('click', async () => {
      const activationContext = new AudioContext();
      try {
        // Resume a context synchronously under the trusted click before any Vite
        // module awaits, so Chromium's autoplay policy is exercised correctly.
        await activationContext.resume();
        // @ts-ignore Vite browser module import in the real application page
        const { audioEngine } = await import('/src/audio/audioEngine.ts');
        // @ts-ignore
        const { installSampleBufferPersistence } = await import('/src/audio/sampleBufferPersistence.ts');
        installSampleBufferPersistence(audioEngine);
        audioEngine.init();
        const engineContext = audioEngine.getContext();
        await engineContext.resume();
        let captureContext: AudioContext | null = null;
        if (withCaptureContext) {
          captureContext = activationContext;
          if (captureContext.sampleRate !== engineContext.sampleRate) {
            throw new Error(`Test and engine AudioContexts use different sample rates (${captureContext.sampleRate} vs ${engineContext.sampleRate}).`);
          }
          await captureContext.suspend();
        } else {
          await activationContext.close();
        }
        (window as any).__recordingAlignment = { audioEngine, engineContext, captureContext };
        (window as any).__recordingAlignmentUnlockError = null;
      } catch (error) {
        (window as any).__recordingAlignmentUnlockError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      } finally {
        button.remove();
      }
    }, { once: true });
    document.body.appendChild(button);
  }, createCaptureContext);
  await page.getByRole('button', { name: 'Unlock recording test audio' }).click();
  await page.waitForFunction(() => !!(window as any).__recordingAlignment || !!(window as any).__recordingAlignmentUnlockError);
  const unlockError = await page.evaluate(() => (window as any).__recordingAlignmentUnlockError);
  expect(unlockError, 'AudioContext unlock failed').toBeNull();
}

async function captureScenario(page: Page, scenario: 'count-in' | 'punch') {
  const evidence = await page.evaluate(async (scenario) => {
    // @ts-ignore Vite browser module imports in the real application page
    const { RecordingEngine } = await import('/src/audio/recordingEngine.ts');
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    const state = (window as any).__recordingAlignment;
    const context: AudioContext = state.captureContext;
    const sampleRate = context.sampleRate;
    const micInitializationDelayMs = 90;
    const resumePromiseDelayMs = 120;
    const schedulerCallbackDelayMs = 120;
    const baseSetTimeout = window.setTimeout.bind(window);
    const originalSetTimeout = window.setTimeout;
    const originalResume = context.resume.bind(context);
    let resumeCalls = 0;
    let measuredResumeDelayMs = 0;
    let measuredMicInitializationDelayMs = 0;
    let deferredSchedulerTimers = 0;
    const errors: string[] = [];
    let inputBus: GainNode | null = null;
    let source: AudioBufferSourceNode | null = null;
    const mockMicDestination = context.createMediaStreamDestination();

    const schedulerConstructor = (audioEngine as any).constructor;
    const scheduler = new schedulerConstructor();
    (scheduler as any).ctx = context;
    const silentMaster = context.createGain();
    silentMaster.gain.value = 0;
    silentMaster.connect(context.destination);
    (scheduler as any).masterGain = silentMaster;
    scheduler.setBpm(120);
    scheduler.setTimeSignature([4, 4]);

    await context.suspend();
    (context as any).resume = async () => {
      const started = performance.now();
      resumeCalls++;
      await originalResume();
      await new Promise<void>(resolve => baseSetTimeout(resolve, resumePromiseDelayMs));
      measuredResumeDelayMs += performance.now() - started;
    };

    // Keep microphone initialization deterministic while feeding known PCM into
    // the real RecordingEngine/AudioWorklet graph; no test-only capture worker
    // or codec participates in the measured path.
    const recorder = new RecordingEngine(() => context, {
      getUserMedia: async () => {
        const started = performance.now();
        await new Promise<void>(resolve => baseSetTimeout(resolve, micInitializationDelayMs));
        measuredMicInitializationDelayMs += performance.now() - started;
        return mockMicDestination.stream;
      },
      createInputSource: (audioContext: AudioContext) => {
        inputBus = audioContext.createGain();
        inputBus.channelCount = 2;
        inputBus.channelCountMode = 'explicit';
        inputBus.channelInterpretation = 'discrete';
        return inputBus;
      },
      onError: error => errors.push(error.message),
    });

    const prepareStarted = performance.now();
    await recorder.prepare();
    const prepareElapsedMs = performance.now() - prepareStarted;
    if (!inputBus) throw new Error('The production capture input node was not created.');

    const originalSetTimeoutBound = originalSetTimeout.bind(window);
    const patchedSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const requestedDelay = Number.isFinite(timeout) ? Math.max(0, Number(timeout)) : 0;
      if (requestedDelay >= 500) {
        deferredSchedulerTimers++;
        return originalSetTimeoutBound(handler, requestedDelay + schedulerCallbackDelayMs, ...args);
      }
      return originalSetTimeoutBound(handler, requestedDelay, ...args);
    }) as typeof window.setTimeout;
    window.setTimeout = patchedSetTimeout;

    let pendingBoundary: Promise<any>;
    let plannedCaptureTime: number | null = null;
    let plannedWindowFrames = 0;
    let clipStartBar = 0;
    let punchPlan: any = null;
    if (scenario === 'count-in') {
      pendingBoundary = scheduler.beginRecordingCountIn(1);
      plannedCaptureTime = (scheduler as any).countInScheduler?.captureTime ?? null;
    } else {
      const settings = { enabled: true, inBar: 2, inBeat: 1, outBar: 3, outBeat: 1 };
      pendingBoundary = scheduler.beginPunchRecording({ settings, countInBars: 1, totalBars: 4 });
      plannedCaptureTime = (scheduler as any).countInScheduler?.captureTime ?? null;
      punchPlan = scheduler.getActivePunchPlan();
      if (!punchPlan) throw new Error('The production punch scheduler did not expose an armed capture plan.');
    }
    void pendingBoundary.catch(() => undefined);
    if (plannedCaptureTime === null || !Number.isFinite(plannedCaptureTime)) {
      throw new Error('The production scheduler did not establish an AudioContext capture boundary.');
    }

    const expectedStartFrame = Math.round(plannedCaptureTime * sampleRate);
    plannedWindowFrames = scenario === 'count-in'
      ? Math.round(sampleRate * 0.5)
      : Math.round(punchPlan.captureDurationSeconds * sampleRate);
    const expectedStopTime = plannedCaptureTime + plannedWindowFrames / sampleRate;
    const expectedStopFrame = Math.round(expectedStopTime * sampleRate);
    const preRollFrames = 64;
    const sourceStartFrame = expectedStartFrame - preRollFrames;
    const sourceBuffer = context.createBuffer(2, preRollFrames + plannedWindowFrames + 128, sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const pcm = sourceBuffer.getChannelData(channel);
      for (let frame = preRollFrames; frame < preRollFrames + plannedWindowFrames; frame++) {
        const offset = frame - preRollFrames;
        const phase = (2 * Math.PI * 440 * offset) / sampleRate + channel * 0.37;
        pcm[frame] = (channel === 0 ? 0.045 : 0.035) * Math.sin(phase);
      }
      pcm[preRollFrames - 1] = channel === 0 ? 0.91 : -0.89; // Must be excluded: one frame before the take.
      pcm[preRollFrames] = channel === 0 ? 0.75 : -0.625;
      pcm[preRollFrames + 31] = channel === 0 ? -0.5 : 0.375;
      pcm[preRollFrames + 4096] = channel === 0 ? 0.25 : -0.25;
      pcm[preRollFrames + plannedWindowFrames - 1] = channel === 0 ? 0.375 : -0.1875;
      pcm[preRollFrames + plannedWindowFrames] = channel === 0 ? 0.625 : -0.3125; // Exclusive stop frame.
    }
    source = context.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(inputBus);
    source.start(sourceStartFrame / sampleRate);

    const callbackCapture = await pendingBoundary;
    const captureTime = callbackCapture.captureTime;
    clipStartBar = scenario === 'count-in' ? callbackCapture.clipStartBar : callbackCapture.plan.clipStartBar;
    const callbackLatenessMs = Math.max(0, (context.currentTime - captureTime) * 1000);
    await recorder.start(captureTime);

    let stopTime = expectedStopTime;
    if (scenario === 'punch') {
      const punchOut = await callbackCapture.punchOut;
      stopTime = punchOut.stopTime;
    }
    const result = await recorder.stop(stopTime);
    const wavBytes = await result.blob.arrayBuffer();
    const header = new DataView(wavBytes);
    const decoded = await context.decodeAudioData(await result.blob.arrayBuffer());
    const markerSpecs = [
      { offset: 0, left: 0.75, right: -0.625 },
      { offset: 31, left: -0.5, right: 0.375 },
      { offset: 4096, left: 0.25, right: -0.25 },
      { offset: plannedWindowFrames - 1, left: 0.375, right: -0.1875 },
    ];
    const findMarker = (samples: Float32Array, value: number) => {
      for (let frame = 0; frame < samples.length; frame++) {
        if (Math.abs(samples[frame] - value) < 1e-6) return frame;
      }
      return -1;
    };
    const left = decoded.getChannelData(0);
    const right = decoded.getChannelData(1);
    const markerMeasurements = markerSpecs.map(marker => {
      const measuredLeftFrame = findMarker(left, marker.left);
      const measuredRightFrame = findMarker(right, marker.right);
      const leftErrorFrames = measuredLeftFrame - marker.offset;
      const rightErrorFrames = measuredRightFrame - marker.offset;
      return {
        expectedOffsetFrames: marker.offset,
        measuredLeftFrame,
        measuredRightFrame,
        leftErrorFrames,
        rightErrorFrames,
        leftErrorSamples: leftErrorFrames,
        rightErrorSamples: rightErrorFrames,
        leftErrorMs: (leftErrorFrames / sampleRate) * 1000,
        rightErrorMs: (rightErrorFrames / sampleRate) * 1000,
      };
    });
    const measuredStartFrame = result.captureStartFrame;
    const measuredStopFrame = result.captureEndFrame;
    const summary = {
      scenario,
      sampleRate,
      channelCount: decoded.numberOfChannels,
      wavFormatTag: header.getUint16(20, true),
      wavBitsPerSample: header.getUint16(34, true),
      mimeType: result.mimeType,
      expectedStartFrame,
      measuredStartFrame,
      startErrorFrames: measuredStartFrame - expectedStartFrame,
      startErrorSamples: measuredStartFrame - expectedStartFrame,
      startErrorMs: ((measuredStartFrame - expectedStartFrame) / sampleRate) * 1000,
      expectedStopFrame,
      measuredStopFrame,
      stopErrorFrames: measuredStopFrame - expectedStopFrame,
      stopErrorSamples: measuredStopFrame - expectedStopFrame,
      stopErrorMs: ((measuredStopFrame - expectedStopFrame) / sampleRate) * 1000,
      expectedOutputFrames: expectedStopFrame - expectedStartFrame,
      measuredOutputFrames: decoded.length,
      capturedFrames: result.capturedFrames,
      outputFrameError: decoded.length - (expectedStopFrame - expectedStartFrame),
      firstLeftSample: left[0],
      firstRightSample: right[0],
      lastLeftSample: left[left.length - 1],
      lastRightSample: right[right.length - 1],
      preBoundaryMarkerIncluded: findMarker(left, 0.91) !== -1 || findMarker(right, -0.89) !== -1,
      exclusiveStopMarkerIncluded: findMarker(left, 0.625) !== -1 || findMarker(right, -0.3125) !== -1,
      markerMeasurements,
      micInitializationDelayMs: measuredMicInitializationDelayMs,
      resumePromiseDelayMs: measuredResumeDelayMs,
      resumeCalls,
      prepareElapsedMs,
      schedulerCallbackLatenessMs: callbackLatenessMs,
      deferredSchedulerTimers,
      clipStartBar,
      errors,
    };
    window.setTimeout = originalSetTimeout;
    (context as any).resume = originalResume;
    source.disconnect();
    inputBus.disconnect();
    silentMaster.disconnect();
    (window as any).__recordingAlignmentResults ??= {};
    (window as any).__recordingAlignmentResults[scenario] = { result, summary, decoded };
    return summary;
  }, scenario);
  console.log('[recording-alignment]', evidence);
  expect(evidence.resumeCalls).toBeGreaterThan(0);
  expect(evidence.resumePromiseDelayMs).toBeGreaterThanOrEqual(100);
  expect(evidence.micInitializationDelayMs).toBeGreaterThanOrEqual(70);
  expect(evidence.deferredSchedulerTimers).toBeGreaterThanOrEqual(scenario === 'punch' ? 2 : 1);
  expect(evidence.schedulerCallbackLatenessMs).toBeGreaterThanOrEqual(80);
  expect(evidence.wavFormatTag).toBe(3);
  expect(evidence.wavBitsPerSample).toBe(32);
  expect(evidence.channelCount).toBe(2);
  expect(evidence.mimeType).toBe('audio/wav');
  expect(evidence.startErrorFrames).toBe(0);
  expect(evidence.stopErrorFrames).toBe(0);
  expect(evidence.outputFrameError).toBe(0);
  expect(evidence.capturedFrames).toBe(evidence.expectedOutputFrames);
  expect(evidence.firstLeftSample).toBeCloseTo(0.75, 6);
  expect(evidence.firstRightSample).toBeCloseTo(-0.625, 6);
  expect(evidence.lastLeftSample).toBeCloseTo(0.375, 6);
  expect(evidence.lastRightSample).toBeCloseTo(-0.1875, 6);
  expect(evidence.preBoundaryMarkerIncluded).toBe(false);
  expect(evidence.exclusiveStopMarkerIncluded).toBe(false);
  expect(evidence.errors).toEqual([]);
  for (const marker of evidence.markerMeasurements) {
    expect(marker.measuredLeftFrame).toBe(marker.expectedOffsetFrames);
    expect(marker.measuredRightFrame).toBe(marker.expectedOffsetFrames);
    expect(marker.leftErrorFrames).toBe(0);
    expect(marker.rightErrorFrames).toBe(0);
  }
  return evidence;
}

test('production AudioWorklet recording stays frame-aligned through count-in, punch, float32 edit, playback, reload, render, export and bundle', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route(`${APP_URL}/recording-alignment-harness`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Recording alignment harness</title></head><body></body></html>',
  }));
  await page.goto(`${APP_URL}/recording-alignment-harness`);
  await unlockAudio(page);

  const countIn = await captureScenario(page, 'count-in');
  const punch = await captureScenario(page, 'punch');

  const compatibility = await page.evaluate(async ({ countInEvidence }) => {
    // @ts-ignore Vite browser modules exercised in the real application page
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { getPersistedAudioClip, getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    // @ts-ignore
    const { waitForSampleBufferPersistence } = await import('/src/audio/sampleBufferPersistence.ts');
    // @ts-ignore
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    // @ts-ignore
    const { persistProjectState, restorePersistedProjectState, getAudioIdsForProject } = await import('/src/state/projectPersistence.ts');
    // @ts-ignore
    const { getRecordingAudioBufferId, createRecordingPlaylistClip } = await import('/src/audio/recordingPipeline.ts');
    // @ts-ignore
    const { openWaveformSession, commitWaveformSession } = await import('/src/audio/waveformEditorCommit.ts');
    // @ts-ignore
    const { editWaveform } = await import('/src/audio/waveformEditing.ts');
    // @ts-ignore
    const { collectBundleAudioAssets } = await import('/src/components/projectBundleAudioAssets.ts');
    // @ts-ignore
    const { DEFAULT_MASTERING_SUITE_STATE } = await import('/src/audio/masteringState.ts');

    const capture = (window as any).__recordingAlignmentResults['count-in'];
    if (!capture?.result || !capture?.decoded) throw new Error('The count-in WAV was not retained for compatibility checks.');
    const recording = capture.result;
    const context = audioEngine.getContext();
    if (context.state !== 'running') await context.resume();
    const baseId = getRecordingAudioBufferId(recording.id);
    const storedCapture = await getPersistedAudioClip(baseId);
    if (!storedCapture) throw new Error('RecordingEngine did not persist its float32 WAV asset.');
    const sourceHeader = new DataView(await storedCapture.arrayBuffer());
    const loaded = await audioEngine.loadAudioFile(storedCapture, baseId);
    await waitForSampleBufferPersistence(audioEngine, baseId);
    const loadedBuffer = audioEngine.getSampleBuffer(baseId);
    if (!loadedBuffer) throw new Error('AudioEngine did not register the decoded recording buffer.');

    const project = createDefaultProjectState();
    const channel = {
      ...project.channels[0],
      instrumentType: 'minisynth',
      mixerTrackId: 1,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      steps: Array(16).fill(false),
      notes: [],
      drumPads: [],
      sampleZones: [],
      customSample: undefined,
    };
    project.channels = [channel];
    project.selectedChannelId = channel.id;
    project.meta = { ...project.meta, bpm: 120, timeSignature: [4, 4] };
    project.totalBars = 3;
    project.mixerTracks = project.mixerTracks.map((track: any) => ({
      ...track,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      fxSlots: [],
    }));
    project.masteringSuiteState = { ...DEFAULT_MASTERING_SUITE_STATE, enabled: false };
    audioEngine.setBpm(120);
    audioEngine.setTimeSignature([4, 4]);
    audioEngine.setMasteringState(project.masteringSuiteState);

    const audioRecording = {
      id: recording.id,
      name: recording.name,
      timestamp: recording.timestamp,
      durationSeconds: recording.durationSeconds,
      waveform: loaded.peaks,
      audioBufferId: baseId,
      audioBlob: recording.blob,
      audioUrl: recording.url,
    };
    const recordingClip = createRecordingPlaylistClip(
      audioRecording,
      { id: baseId, buffer: loadedBuffer, peaks: loaded.peaks, duration: loaded.duration },
      project.playlistTracks,
      0,
      120,
      'captured-float32-clip',
      [4, 4],
      countInEvidence.clipStartBar,
    );
    recordingClip.channelId = channel.id;

    const session = await openWaveformSession(recordingClip, 120, [4, 4], audioEngine);
    const editedPcm = editWaveform(
      session.buffer,
      { start: 0, end: session.buffer.length },
      { type: 'gain', db: -6 },
      (channels: number, frames: number, rate: number) => context.createBuffer(channels, frames, rate),
    );
    const editedClip = await commitWaveformSession(session, editedPcm, audioEngine, {
      isCurrent: () => true,
      publish: () => undefined,
    });
    const editedAsset = await getPersistedAudioClip(editedClip.audioBufferId!);
    if (!editedAsset) throw new Error('Waveform editing did not persist its float32 WAV asset.');
    const editedHeader = new DataView(await editedAsset.arrayBuffer());
    const editedBuffer = audioEngine.getSampleBuffer(editedClip.audioBufferId!);
    if (!editedBuffer) throw new Error('Waveform editing did not register its committed AudioBuffer.');

    const playbackClip = { ...recordingClip, id: 'float32-live-playback', startBar: 0, lengthBars: 0.25 };
    audioEngine.stop();
    const originalMasterGain = (audioEngine as any).masterGain?.gain?.value ?? 1;
    if ((audioEngine as any).masterGain) (audioEngine as any).masterGain.gain.value = originalMasterGain;
    audioEngine.play([channel], [playbackClip], 'song', undefined, project.mixerTracks, undefined, project.playlistTracks);
    const analyser = new Uint8Array(512);
    let livePeak = 0;
    const playbackDeadline = performance.now() + 1200;
    while (performance.now() < playbackDeadline && livePeak < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      audioEngine.getMasterWaveformData(analyser);
      livePeak = analyser.reduce((peak: number, sample: number) => Math.max(peak, Math.abs(sample - 128)), 0);
    }
    audioEngine.stop();
    if (livePeak < 2) throw new Error('Float32 WAV produced no measurable live playback at the master analyser.');

    const editedForProject = { ...editedClip, id: 'edited-float32-clip', startBar: countInEvidence.clipStartBar + 1, channelId: channel.id };
    project.recordings = [audioRecording];
    project.playlistClips = [recordingClip, editedForProject];
    audioEngine.setProjectSampleBufferOwnership(getAudioIdsForProject(project));
    await persistProjectState(project);
    const savedRecord = await getPersistedProjectStateRecord();
    const savedState = JSON.parse(savedRecord).state;
    const savedClipIds = savedState.playlistClips.map((clip: any) => clip.id);
    const savedAudioIds = getAudioIdsForProject(project);
    const assets = await collectBundleAudioAssets(savedAudioIds, getPersistedAudioClip);
    const bundleAssets = await Promise.all(assets.map(async (asset: any) => {
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
      }
      return { id: asset.id, path: asset.path, mimeType: asset.mimeType, size: asset.size, base64: btoa(binary) };
    }));

    const offline = await audioEngine.renderTimelineOffline(
      project.channels,
      project.playlistClips,
      project.mixerTracks,
      120,
      project.totalBars,
      context.sampleRate,
      false,
      'song',
      undefined,
      undefined,
      project.playlistTracks,
    );
    const peakInRegion = (buffer: AudioBuffer, startSeconds: number, endSeconds: number) => {
      let peak = 0;
      const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
      const end = Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate));
      for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
        const pcm = buffer.getChannelData(channelIndex);
        for (let frame = start; frame < end; frame++) peak = Math.max(peak, Math.abs(pcm[frame]));
      }
      return peak;
    };
    const offlinePeaks = {
      original: peakInRegion(offline, countInEvidence.clipStartBar * 2 + 0.05, countInEvidence.clipStartBar * 2 + 0.45),
      edited: peakInRegion(offline, (countInEvidence.clipStartBar + 1) * 2 + 0.05, (countInEvidence.clipStartBar + 1) * 2 + 0.45),
    };
    const exportBlob = await audioEngine.renderProjectToWav(
      project.channels,
      project.playlistClips,
      120,
      project.totalBars,
      32,
      project.mixerTracks,
      false,
      project.playlistTracks,
      project.patterns,
    );
    const exportBytes = await exportBlob.arrayBuffer();
    const exportHeader = new DataView(exportBytes);
    const exportedDecode = await context.decodeAudioData(await exportBlob.arrayBuffer());
    const exportPeak = peakInRegion(exportedDecode, countInEvidence.clipStartBar * 2 + 0.05, countInEvidence.clipStartBar * 2 + 0.45);
    (window as any).__recordingAlignmentProject = { baseId, editedId: editedClip.audioBufferId, project };

    return {
      baseId,
      editedId: editedClip.audioBufferId,
      savedClipIds,
      savedAudioIds,
      sourceFormatTag: sourceHeader.getUint16(20, true),
      sourceBitsPerSample: sourceHeader.getUint16(34, true),
      sourceMimeType: storedCapture.type,
      loadedBuffer: { frames: loadedBuffer.length, channels: loadedBuffer.numberOfChannels, sampleRate: loadedBuffer.sampleRate, peak: Math.max(...loaded.peaks) },
      recordingWaveformPeak: Math.max(...recording.waveform),
      editedFormatTag: editedHeader.getUint16(20, true),
      editedBitsPerSample: editedHeader.getUint16(34, true),
      editedMimeType: editedAsset.type,
      editedBuffer: { frames: editedBuffer.length, channels: editedBuffer.numberOfChannels, sampleRate: editedBuffer.sampleRate },
      livePlaybackPeak: livePeak,
      offlinePeaks,
      export: {
        formatTag: exportHeader.getUint16(20, true),
        bitsPerSample: exportHeader.getUint16(34, true),
        sampleRate: exportHeader.getUint32(24, true),
        channels: exportHeader.getUint16(22, true),
        frames: exportedDecode.length,
        peak: exportPeak,
      },
      bundleAssets,
    };
  }, { countInEvidence: countIn });

  console.log('[float32-recording-compatibility]', {
    baseId: compatibility.baseId,
    editedId: compatibility.editedId,
    sourceFormatTag: compatibility.sourceFormatTag,
    loadedBuffer: compatibility.loadedBuffer,
    editedFormatTag: compatibility.editedFormatTag,
    editedBuffer: compatibility.editedBuffer,
    livePlaybackPeak: compatibility.livePlaybackPeak,
    offlinePeaks: compatibility.offlinePeaks,
    export: compatibility.export,
    bundleAssets: compatibility.bundleAssets.map(({ id, path, mimeType, size }: any) => ({ id, path, mimeType, size })),
  });
  expect(compatibility.sourceFormatTag).toBe(3);
  expect(compatibility.sourceBitsPerSample).toBe(32);
  expect(compatibility.sourceMimeType).toBe('audio/wav');
  expect(compatibility.loadedBuffer.channels).toBe(2);
  expect(compatibility.loadedBuffer.frames).toBe(countIn.expectedOutputFrames);
  expect(compatibility.loadedBuffer.sampleRate).toBe(countIn.sampleRate);
  expect(compatibility.loadedBuffer.peak).toBeGreaterThan(0.7);
  expect(compatibility.recordingWaveformPeak).toBeGreaterThan(0.7);
  expect(compatibility.editedFormatTag).toBe(3);
  expect(compatibility.editedBitsPerSample).toBe(32);
  expect(compatibility.editedMimeType).toBe('audio/wav');
  expect(compatibility.editedBuffer.frames).toBe(compatibility.loadedBuffer.frames);
  expect(compatibility.editedBuffer.channels).toBe(2);
  expect(compatibility.editedBuffer.sampleRate).toBe(compatibility.loadedBuffer.sampleRate);
  expect(compatibility.livePlaybackPeak).toBeGreaterThan(2);
  expect(compatibility.offlinePeaks.original).toBeGreaterThan(0.02);
  expect(compatibility.offlinePeaks.edited).toBeGreaterThan(0.01);
  expect(compatibility.export.formatTag).toBe(3);
  expect(compatibility.export.bitsPerSample).toBe(32);
  expect(compatibility.export.channels).toBe(2);
  expect(compatibility.export.sampleRate).toBe(countIn.sampleRate);
  expect(compatibility.export.peak).toBeGreaterThan(0.02);
  expect(compatibility.savedClipIds).toEqual(['captured-float32-clip', 'edited-float32-clip']);
  expect(compatibility.savedAudioIds).toContain(compatibility.baseId);
  expect(compatibility.savedAudioIds).toContain(compatibility.editedId);
  expect(compatibility.bundleAssets.map((asset: any) => asset.id)).toContain(compatibility.baseId);
  expect(compatibility.bundleAssets.map((asset: any) => asset.id)).toContain(compatibility.editedId);

  // Exercise the same JSZip folder paths and manifest asset records used by the
  // portable project-bundle exporter, then verify the archived PCM bytes.
  const zip = new JSZip();
  const audioFolder = zip.folder('audio');
  expect(audioFolder).not.toBeNull();
  const manifestAudioFiles = compatibility.bundleAssets.map((asset: any) => ({
    id: asset.id,
    path: asset.path,
    mimeType: asset.mimeType,
    size: asset.size,
  }));
  for (const asset of compatibility.bundleAssets as any[]) {
    audioFolder!.file(asset.path.slice('audio/'.length), Buffer.from(asset.base64, 'base64'));
  }
  zip.file('bundle_manifest.json', JSON.stringify({ format: 'apex-studio-project-bundle', formatVersion: 2, audioFiles: manifestAudioFiles }));
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const reopenedZip = await JSZip.loadAsync(archive);
  const archivedManifest = JSON.parse(await reopenedZip.file('bundle_manifest.json')!.async('string'));
  expect(archivedManifest.audioFiles).toEqual(manifestAudioFiles);
  for (const asset of compatibility.bundleAssets as any[]) {
    const archived = await reopenedZip.file(asset.path)!.async('nodebuffer');
    const original = Buffer.from(asset.base64, 'base64');
    expect(archived.compare(original), `Float32 WAV bytes changed in bundle for ${asset.id}`).toBe(0);
    expect(archived.readUInt16LE(20), `Bundled asset ${asset.id} is not IEEE-float WAV`).toBe(3);
  }
  console.log('[float32-project-bundle]', { zipBytes: archive.byteLength, assets: manifestAudioFiles });

  await page.reload();
  await unlockAudio(page, false);
  const reopened = await page.evaluate(async ({ baseId, editedId }) => {
    // @ts-ignore Vite browser module imports after the real document reload
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { getPersistedAudioClip, getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    // @ts-ignore
    const { restorePersistedProjectState } = await import('/src/state/projectPersistence.ts');
    // @ts-ignore
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    const stored = await getPersistedProjectStateRecord();
    if (!stored) throw new Error('The project state did not survive reload.');
    const restored = await restorePersistedProjectState(audioEngine, createDefaultProjectState());
    const project = restored.state;
    const baseBlob = await getPersistedAudioClip(baseId);
    const editedBlob = await getPersistedAudioClip(editedId);
    const baseBuffer = audioEngine.getSampleBuffer(baseId);
    const editedBuffer = audioEngine.getSampleBuffer(editedId);
    if (!baseBlob || !editedBlob || !baseBuffer || !editedBuffer) throw new Error('A float32 asset did not hydrate after project reopen.');
    const context = audioEngine.getContext();
    const baseHeader = new DataView(await baseBlob.arrayBuffer());
    const editedHeader = new DataView(await editedBlob.arrayBuffer());
    const pcm = await context.decodeAudioData(await baseBlob.arrayBuffer());
    audioEngine.setBpm(120);
    audioEngine.setTimeSignature([4, 4]);
    audioEngine.setMasteringState(project.masteringSuiteState);
    const offline = await audioEngine.renderTimelineOffline(
      project.channels,
      project.playlistClips,
      project.mixerTracks,
      project.meta.bpm,
      project.totalBars,
      context.sampleRate,
      false,
      'song',
      undefined,
      undefined,
      project.playlistTracks,
    );
    const peak = (buffer: AudioBuffer, startSeconds: number, endSeconds: number) => {
      let maximum = 0;
      const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
      const end = Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate));
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let frame = start; frame < end; frame++) maximum = Math.max(maximum, Math.abs(data[frame]));
      }
      return maximum;
    };
    const exportBlob = await audioEngine.renderProjectToWav(
      project.channels,
      project.playlistClips,
      project.meta.bpm,
      project.totalBars,
      32,
      project.mixerTracks,
      false,
      project.playlistTracks,
      project.patterns,
    );
    const exportHeader = new DataView(await exportBlob.arrayBuffer());
    const exportDecode = await context.decodeAudioData(await exportBlob.arrayBuffer());
    const clip = project.playlistClips.find((candidate: any) => candidate.id === 'captured-float32-clip');
    const playbackClip = { ...clip, id: 'reopened-float32-live-playback', startBar: 0, lengthBars: 0.25 };
    audioEngine.stop();
    audioEngine.play([project.channels[0]], [playbackClip], 'song', undefined, project.mixerTracks, undefined, project.playlistTracks);
    const analyser = new Uint8Array(512);
    let livePeakAfterReload = 0;
    const playbackDeadline = performance.now() + 1200;
    while (performance.now() < playbackDeadline && livePeakAfterReload < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      audioEngine.getMasterWaveformData(analyser);
      livePeakAfterReload = analyser.reduce((maximum: number, sample: number) => Math.max(maximum, Math.abs(sample - 128)), 0);
    }
    audioEngine.stop();
    return {
      restored: restored.restored,
      hydratedAudioIds: restored.hydratedAudioIds,
      missingAudioIds: restored.missingAudioIds,
      baseFormatTag: baseHeader.getUint16(20, true),
      editedFormatTag: editedHeader.getUint16(20, true),
      decodedFrames: pcm.length,
      registeredBaseFrames: baseBuffer.length,
      registeredEditedFrames: editedBuffer.length,
      clipBufferId: clip?.audioBufferId,
      offlinePeakOriginal: peak(offline, clip.startBar * 2 + 0.05, clip.startBar * 2 + 0.45),
      offlinePeakEdited: peak(offline, (clip.startBar + 1) * 2 + 0.05, (clip.startBar + 1) * 2 + 0.45),
      exportFormatTag: exportHeader.getUint16(20, true),
      exportDecodeChannels: exportDecode.numberOfChannels,
      exportPeak: peak(exportDecode, clip.startBar * 2 + 0.05, clip.startBar * 2 + 0.45),
      livePeakAfterReload,
    };
  }, { baseId: compatibility.baseId, editedId: compatibility.editedId });
  console.log('[float32-project-reopen]', reopened);
  expect(reopened.restored).toBe(true);
  expect(reopened.hydratedAudioIds).toContain(compatibility.baseId);
  expect(reopened.hydratedAudioIds).toContain(compatibility.editedId);
  expect(reopened.missingAudioIds).toEqual([]);
  expect(reopened.baseFormatTag).toBe(3);
  expect(reopened.editedFormatTag).toBe(3);
  expect(reopened.decodedFrames).toBe(countIn.expectedOutputFrames);
  expect(reopened.registeredBaseFrames).toBe(countIn.expectedOutputFrames);
  expect(reopened.registeredEditedFrames).toBe(countIn.expectedOutputFrames);
  expect(reopened.clipBufferId).toBe(compatibility.baseId);
  expect(reopened.offlinePeakOriginal).toBeGreaterThan(0.02);
  expect(reopened.offlinePeakEdited).toBeGreaterThan(0.01);
  expect(reopened.exportFormatTag).toBe(3);
  expect(reopened.exportDecodeChannels).toBe(2);
  expect(reopened.exportPeak).toBeGreaterThan(0.02);
  expect(reopened.livePeakAfterReload).toBeGreaterThan(2);
});
