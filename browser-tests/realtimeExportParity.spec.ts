import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

// Real-browser regression coverage: capture production AudioEngine.play() from
// a running AudioContext with a test-only AudioWorklet tap and compare it with
// renderTimelineOffline. No engine implementation or browser audio engine is substituted.
test('real-time AudioContext capture versus production offline export', async ({ page }) => {
  test.setTimeout(120_000);
  // Keep the application React tree from asynchronously applying project
  // defaults while the engine-level playback/export fixture runs.
  await page.route(APP_URL, route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto(APP_URL);

  const results = await page.evaluate(async () => {
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { audioEngine: e } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore — browser-side imports are served by Vite at `/src/...`.
    const { DEFAULT_MASTERING_SUITE_STATE: masteringDefaults } = await import('/src/audio/masteringState.ts');
    const bpm = 120;
    const bars = 1;
    const requestedDuration = 3.55;
    const notes = [
      { id: 'n0', pitch: 60, start: 0, duration: 2, velocity: 0.85 },
      { id: 'n1', pitch: 64, start: 4, duration: 2, velocity: 0.85 },
      { id: 'n2', pitch: 67, start: 8, duration: 2, velocity: 0.85 },
      { id: 'n3', pitch: 72, start: 12, duration: 2, velocity: 0.85 },
    ];
    const channel: any = {
      id: 'rt-parity-synth', name: 'Parity Synth', color: '#10b981', instrumentType: 'minisynth',
      mixerTrackId: 1, volume: 0.8, pan: 0, pitch: 0, mute: false, solo: false,
      steps: Array(16).fill(false), notes, synthParams: e.getDefaultSynthParams(),
    };
    const clip: any = {
      id: 'rt-parity-clip', trackIndex: 0, startBar: 0, lengthBars: 1,
      type: 'pattern', channelId: channel.id, color: '#10b981', name: 'One-bar parity fixture',
    };
    const masterTrack: any = {
      id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false,
      fxSlots: [], peakL: 0, peakR: 0,
    };
    const tracksFor = (slot?: any) => [masterTrack, {
      id: 1, name: 'Parity Synth', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false,
      fxSlots: slot ? [slot] : [], peakL: 0, peakR: 0,
    }];

    // AudioWorklet capture is PCM from a parallel tap at the live master output
    // (post-mastering analyser, immediately before AudioContext.destination).
    const workletSource = `
      class ApexParityTap extends AudioWorkletProcessor {
        process(inputs, outputs) {
          const input = inputs[0] || [];
          const output = outputs[0] || [];
          for (const ch of output) ch.fill(0); // don't duplicate audio to speakers
          const leftInput = input[0];
          const rightInput = input[1] || leftInput;
          const left = (leftInput && leftInput.length ? leftInput : new Float32Array(128)).slice();
          const right = (rightInput && rightInput.length ? rightInput : new Float32Array(128)).slice();
          this.port.postMessage({ frame: currentFrame, left: left.buffer, right: right.buffer }, [left.buffer, right.buffer]);
          return true;
        }
      }
      registerProcessor('apex-parity-tap', ApexParityTap);
    `;
    const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    e.init();
    let liveCtx = e.getContext();
    await liveCtx.resume();
    const sr = liveCtx.sampleRate;
    await liveCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const tap = new AudioWorkletNode(liveCtx, 'apex-parity-tap', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit',
    });
    let captureActive = false;
    let blocks: Array<{ frame: number; left: Float32Array; right: Float32Array }> = [];
    tap.port.onmessage = (event: MessageEvent) => {
      if (!captureActive) return; // drain real-time messages during export without storing them
      blocks.push({
        frame: event.data.frame,
        left: new Float32Array(event.data.left),
        right: new Float32Array(event.data.right),
      });
    };
    e.masterAnalyser.connect(tap);
    tap.connect(liveCtx.destination);

    const captureAndExport = async (
      name: string,
      slot: any | undefined,
      masteringState: any,
      outputStage: 'master' | 'pre-master' = 'master',
      project: { channels: any[]; clips: any[]; sampleBuffers?: Map<string, AudioBuffer>; events?: Array<{ start: number; duration?: number }>; tailStartSeconds?: number } = { channels: [channel], clips: [clip], events: notes },
    ) => {
      e.stop();
      e.setBpm(bpm);
      e.setMasterVolume(1); // same persisted project master level on both paths
      e.setMasteringState(masteringState);
      e.sampleBuffers = project.sampleBuffers ?? new Map();
      const tracks = tracksFor(slot);
      try { e.masterAnalyser.disconnect(tap); } catch {}
      try { e.grossBeatNode.disconnect(tap); } catch {}
      try { tap.disconnect(); } catch {}
      if (outputStage === 'pre-master') e.grossBeatNode.connect(tap);
      else e.masterAnalyser.connect(tap);
      tap.connect(liveCtx.destination);
      blocks = [];
      captureActive = true;
      const playFrame = Math.round(liveCtx.currentTime * sr);
      e.play(project.channels, project.clips, 'song', undefined, tracks);
      // The production transport exposes its audio-clock origin in this test
      // fixture; this is the actual scheduled t=0, after graph setup time.
      const transportOriginFrame = Math.round(e.transport.clockOrigin * sr);
      const realtimeStart = liveCtx.currentTime;
      while (liveCtx.currentTime < realtimeStart + requestedDuration + 0.35) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      e.stop();
      captureActive = false;

      if (!blocks.length) throw new Error(`${name}: AudioWorklet captured no PCM blocks`);
      blocks.sort((a, b) => a.frame - b.frame);
      const firstFrame = blocks[0].frame;
      const last = blocks[blocks.length - 1];
      const liveL = new Float32Array(last.frame + last.left.length - firstFrame);
      const liveR = new Float32Array(liveL.length);
      for (const block of blocks) {
        const offset = block.frame - firstFrame;
        liveL.set(block.left, offset);
        liveR.set(block.right, offset);
      }
      const livePlayback = liveL.subarray(Math.max(0, playFrame - firstFrame));
      const liveRightPlayback = liveR.subarray(Math.max(0, playFrame - firstFrame));
      const liveGraphBeforeExport = {
        masterGain: e.masterGain.gain.value,
        grossBeatGain: e.grossBeatNode.gain.value,
        insertOutputGain: e.mixerChannels.get(1)?.output.gain.value,
        masterTrackOutputGain: e.mixerChannels.get(0)?.output.gain.value,
        bypassGain: e.masteringProcessor?.bypassGain.gain.value,
        wetGain: e.masteringProcessor?.wetGain.gain.value,
        channelVolume: e.activeChannels[0]?.volume,
      };
      const exported: AudioBuffer = await e.renderTimelineOffline(
        project.channels, project.clips, tracks, bpm, bars, sr, true, 'song', undefined, undefined,
        undefined, requestedDuration, undefined, outputStage,
      );
      const liveGraphAfterExport = {
        masterGain: e.masterGain.gain.value,
        grossBeatGain: e.grossBeatNode.gain.value,
        insertOutputGain: e.mixerChannels.get(1)?.output.gain.value,
        masterTrackOutputGain: e.mixerChannels.get(0)?.output.gain.value,
        bypassGain: e.masteringProcessor?.bypassGain.gain.value,
        wetGain: e.masteringProcessor?.wetGain.gain.value,
        channelVolume: e.activeChannels[0]?.volume,
      };
      const exportL = exported.getChannelData(0);
      const exportR = exported.getChannelData(1);

      // Align against the transport's actual AudioContext clock origin, then
      // permit only ±4 ms for sample/block boundary uncertainty. This is much
      // smaller than the 500 ms note spacing and cannot hide a missing event.
      const expectedOffset = transportOriginFrame - playFrame;
      const liveStartOffsetFrames = expectedOffset;
      const search = Math.round(0.004 * sr);
      const scoreLength = Math.min(Math.round(0.8 * sr), exportL.length, livePlayback.length - expectedOffset - search);
      let bestOffset = expectedOffset;
      let bestScore = -Infinity;
      for (let candidate = expectedOffset - search; candidate <= expectedOffset + search; candidate += 8) {
        let dot = 0, aa = 0, bb = 0;
        for (let i = 0; i < scoreLength; i += 8) {
          const a = exportL[i], b = livePlayback[candidate + i];
          dot += a * b; aa += a * a; bb += b * b;
        }
        const score = dot / Math.sqrt(Math.max(1e-30, aa * bb));
        if (score > bestScore) { bestScore = score; bestOffset = candidate; }
      }
      let sumSq = 0, maxDiff = 0, exportSq = 0, liveSq = 0, finite = true;
      const count = Math.min(exportL.length, livePlayback.length - bestOffset);
      let activeSamples = 0;
      for (let i = 0; i < count; i += 1) {
        const a = exportL[i], b = livePlayback[bestOffset + i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) finite = false;
        const d = a - b;
        sumSq += d * d; exportSq += a * a; liveSq += b * b;
        maxDiff = Math.max(maxDiff, Math.abs(d));
        if (Math.abs(a) > 1e-4 || Math.abs(b) > 1e-4) activeSamples += 1;
      }
      const rmsError = Math.sqrt(sumSq / Math.max(1, count));
      const exportRms = Math.sqrt(exportSq / Math.max(1, count));
      const liveRms = Math.sqrt(liveSq / Math.max(1, count));
      const peak = (data: Float32Array) => {
        let value = 0;
        for (const x of data) value = Math.max(value, Math.abs(x));
        return value;
      };
      const eventWindows = (project.events ?? []).map(note => {
        const start = Math.round(note.start * (60 / bpm / 4) * sr);
        const end = Math.min(exportL.length, start + Math.round(0.1 * sr));
        const eventSearch = Math.round(0.005 * sr);
        let eventLag = 0, eventCorr = -Infinity;
        for (let lag = -eventSearch; lag <= eventSearch; lag += 8) {
          let dot = 0, aa = 0, bb = 0;
          for (let i = start; i < end; i += 8) {
            const a = exportL[i], b = livePlayback[bestOffset + i + lag];
            dot += a * b; aa += a * a; bb += b * b;
          }
          const corr = dot / Math.sqrt(Math.max(1e-30, aa * bb));
          if (corr > eventCorr) { eventCorr = corr; eventLag = lag; }
        }
        let exp = 0, live = 0, dot = 0, diffSq = 0, windowMax = 0;
        for (let i = start; i < end; i += 1) {
          const a = exportL[i], b = livePlayback[bestOffset + i + eventLag];
          exp += a * a;
          live += b * b;
          dot += a * b;
          diffSq += (a - b) * (a - b);
          windowMax = Math.max(windowMax, Math.abs(a - b));
        }
        return {
          step: note.start, exportRms: Math.sqrt(exp / Math.max(1, end - start)),
          liveRms: Math.sqrt(live / Math.max(1, end - start)),
          eventLagMs: eventLag * 1000 / sr,
          corr: dot / Math.sqrt(Math.max(1e-30, exp * live)),
          relativeRmsError: Math.sqrt(diffSq / Math.max(1, end - start)) / Math.max(1e-12, Math.sqrt(exp / Math.max(1, end - start))),
          maxAbsDifference: windowMax,
        };
      });
      const windowFrames = Math.round(0.1 * sr);
      const hopFrames = Math.round(0.05 * sr);
      const eventTimes = (project.events ?? []).map(event => event.start * (60 / bpm / 4));
      const energyWindows: Array<{ startMs: number; exportDb: number; liveDb: number }> = [];
      for (let start = 0; start + windowFrames <= count; start += hopFrames) {
        const end = start + windowFrames;
        const centerSeconds = (start + windowFrames / 2) / sr;
        // Keep event-onset timing in the separate event table. Excluding these
        // edge windows prevents a few milliseconds of onset jitter from being
        // misreported as a large steady-state/tail level difference.
        if (eventTimes.some(time => Math.abs(centerSeconds - time) <= windowFrames / (2 * sr) + 0.005)) continue;
        let exp = 0, live = 0;
        for (let i = start; i < end; i += 1) {
          exp += exportL[i] * exportL[i];
          live += livePlayback[bestOffset + i] * livePlayback[bestOffset + i];
        }
        energyWindows.push({
          startMs: start * 1000 / sr,
          exportDb: 20 * Math.log10(Math.sqrt(exp / windowFrames) + 1e-30),
          liveDb: 20 * Math.log10(Math.sqrt(live / windowFrames) + 1e-30),
        });
      }
      const activeEnergyWindows = energyWindows.filter(window => Math.max(window.exportDb, window.liveDb) >= -60);
      const energyDeviation = activeEnergyWindows.map(window => Math.abs(window.exportDb - window.liveDb));
      const inferredTailStartSeconds = project.tailStartSeconds ?? Math.max(0, ...(project.events ?? []).map(event =>
        (event.start + (event.duration ?? 0)) * (60 / bpm / 4) + 0.2,
      ));
      const activeTailWindows = activeEnergyWindows.filter(window => window.startMs >= inferredTailStartSeconds * 1000);
      const lastActiveTailWindow = activeTailWindows.at(-1);
      const energyWindowSummary = {
        compared: activeEnergyWindows.length,
        maxDeviationDb: Math.max(0, ...energyDeviation),
        meanDeviationDb: energyDeviation.reduce((sum, value) => sum + value, 0) / Math.max(1, energyDeviation.length),
        tailStartMs: inferredTailStartSeconds * 1000,
        activeTailWindows: activeTailWindows.length,
        lastActiveTailWindowMs: lastActiveTailWindow?.startMs ?? null,
        lastActiveTailExportDb: lastActiveTailWindow?.exportDb ?? null,
        lastActiveTailLiveDb: lastActiveTailWindow?.liveDb ?? null,
        largestWindows: activeEnergyWindows.slice().sort((a, b) => Math.abs(b.exportDb - b.liveDb) - Math.abs(a.exportDb - a.liveDb)).slice(0, 3).map(window => ({
          startMs: window.startMs, exportDb: window.exportDb, liveDb: window.liveDb, differenceDb: window.liveDb - window.exportDb,
        })),
      };
      const liveTailStart = Math.min(livePlayback.length, bestOffset + exportL.length);
      const liveTailFrames = livePlayback.length - liveTailStart;
      let liveTailSq = 0, liveTailPeak = 0;
      for (let i = liveTailStart; i < livePlayback.length; i += 1) {
        const sample = livePlayback[i];
        liveTailSq += sample * sample;
        liveTailPeak = Math.max(liveTailPeak, Math.abs(sample));
      }
      const liveTailAfterExport = {
        durationSeconds: liveTailFrames / sr,
        rms: Math.sqrt(liveTailSq / Math.max(1, liveTailFrames)),
        peak: liveTailPeak,
      };
      return {
        name, sampleRate: sr, liveContextState: liveCtx.state,
        liveGraphBeforeExport, liveGraphAfterExport, energyWindowSummary, liveTailAfterExport,
        eventCount: eventWindows.length,
        exportFrames: exported.length, exportDuration: exported.duration,
        liveFrames: livePlayback.length, alignedSamples: count,
        liveStartOffsetFrames, alignOffsetFrames: bestOffset,
        residualFromExpectedMs: (bestOffset - expectedOffset) * 1000 / sr,
        normalizedCorrelation: bestScore,
        livePeak: peak(livePlayback), exportPeak: peak(exportL),
        liveRms, exportRms, rmsError, relativeRmsError: rmsError / Math.max(1e-12, exportRms),
        maxAbsDifference: maxDiff, activeSamples, finite,
        leftRightLiveDifference: (() => { let d = 0; for (let i = 0; i < Math.min(livePlayback.length, liveRightPlayback.length); i += 1) d = Math.max(d, Math.abs(livePlayback[i] - liveRightPlayback[i])); return d; })(),
        eventWindows,
        liveSamples: livePlayback.slice(),
      };
    };

    const stateBypass = { ...masteringDefaults, enabled: false };
    const delayA = { id: 'rt-delay-a', type: 'delay', name: 'Parity Delay', enabled: true, mix: 0.55, params: { time: 0.25, feedback: 0.35 } };
    const delayDisabled = { ...delayA, id: 'rt-delay-disabled', enabled: false };
    const delayB = { ...delayA, id: 'rt-delay-b', params: { ...delayA.params, feedback: 0.6 } };
    const mastered = {
      ...masteringDefaults, enabled: true, stereoSpread: 1.6, maximizerCeiling: -6,
      lowBand: { ...masteringDefaults.lowBand, gain: 3 },
    };
    const clipFrames = Math.round(0.65 * sr);
    const clipBuffer = new AudioBuffer({ numberOfChannels: 1, length: clipFrames, sampleRate: sr });
    const clipData = new Float32Array(clipFrames);
    for (let i = 0; i < clipFrames; i += 1) {
      const t = i / sr;
      clipData[i] = 0.45 * Math.sin(2 * Math.PI * 330 * t) * Math.exp(-3 * t);
    }
    clipBuffer.copyToChannel(clipData, 0);
    const audioClip: any = {
      id: 'rt-audio-clip', trackIndex: 0, startBar: 0, lengthBars: 1,
      type: 'audio', audioBufferId: 'rt-audio-buffer', color: '#f59e0b', name: 'Deterministic audio clip',
      fadeInBars: 0, fadeOutBars: 0, mute: false,
    };
    const audioClipProject = {
      channels: [], clips: [audioClip], sampleBuffers: new Map([['rt-audio-buffer', clipBuffer]]), events: [{ start: 0 }], tailStartSeconds: clipBuffer.duration,
    };

    const outputs = [];
    outputs.push(await captureAndExport('dry+master-bypass', undefined, stateBypass));
    outputs.push(await captureAndExport('dry-post-export-repeat', undefined, stateBypass));
    outputs.push(await captureAndExport('delay-disabled+master-bypass', delayDisabled, stateBypass));
    outputs.push(await captureAndExport('delay-A+master-bypass', delayA, stateBypass));
    outputs.push(await captureAndExport('delay-B-feedback-0.6+master-bypass', delayB, stateBypass));
    outputs.push(await captureAndExport('audio-clip+master-bypass', undefined, stateBypass, 'master', audioClipProject));
    outputs.push(await captureAndExport('dry+mastering', undefined, mastered));
    outputs.push(await captureAndExport('dry+mastering-repeat', undefined, mastered));
    for (const silenceMs of [30, 100]) {
      const offsetSteps = (silenceMs / 1000) / (60 / bpm / 4);
      const preRolledNotes = notes.map(note => ({ ...note, start: note.start + offsetSteps }));
      const preRolledProject = {
        channels: [{ ...channel, notes: preRolledNotes }], clips: [clip], events: preRolledNotes,
      };
      outputs.push(await captureAndExport(`mastering-first-event-after-${silenceMs}ms-silence`, undefined, mastered, 'master', preRolledProject));
    }
    outputs.push(await captureAndExport('dry+mastering-pre-master', undefined, mastered, 'pre-master'));
    const [dryA, dryB] = outputs;
    const expectedA = dryA.liveStartOffsetFrames;
    const expectedB = dryB.liveStartOffsetFrames;
    const predictedShift = expectedB - expectedA;
    const maxShift = Math.round(0.004 * sr);
    let repeatShift = predictedShift, repeatCorr = -Infinity;
    const repeatLength = Math.min(Math.round(0.8 * sr), dryA.liveSamples.length - expectedA - maxShift, dryB.liveSamples.length - expectedB - maxShift);
    for (let shift = predictedShift - maxShift; shift <= predictedShift + maxShift; shift += 8) {
      let dot = 0, aa = 0, bb = 0;
      for (let i = 0; i < repeatLength; i += 8) {
        const a = dryA.liveSamples[expectedA + i], b = dryB.liveSamples[expectedA + shift + i];
        dot += a * b; aa += a * a; bb += b * b;
      }
      const corr = dot / Math.sqrt(Math.max(1e-30, aa * bb));
      if (corr > repeatCorr) { repeatCorr = corr; repeatShift = shift; }
    }
    let repeatSq = 0, repeatMax = 0, repeatASq = 0;
    const repeatCount = Math.min(dryA.liveSamples.length - expectedA, dryB.liveSamples.length - (expectedA + repeatShift));
    for (let i = 0; i < repeatCount; i += 1) {
      const a = dryA.liveSamples[expectedA + i], b = dryB.liveSamples[expectedA + repeatShift + i];
      repeatSq += (a - b) * (a - b); repeatASq += a * a;
      repeatMax = Math.max(repeatMax, Math.abs(a - b));
    }
    const liveRepeat = {
      shiftMs: repeatShift * 1000 / sr, correlation: repeatCorr,
      relativeRmsError: Math.sqrt(repeatSq / repeatCount) / Math.sqrt(repeatASq / repeatCount),
      maxAbsDifference: repeatMax,
    };
    tap.disconnect();
    tap.port.close();
    liveCtx = e.getContext();
    return { scenarios: outputs.map(({ liveSamples, ...result }) => result), liveRepeat };
  });

  console.log('REALTIME_AUDIO_PARITY', JSON.stringify(results, null, 2));
  for (const result of results.scenarios) {
    expect(result.liveContextState).toBe('running');
    expect(result.finite).toBe(true);
    expect(result.livePeak).toBeGreaterThan(1e-4);
    expect(result.exportPeak).toBeGreaterThan(1e-4);
    expect(result.activeSamples).toBeGreaterThan(100);
    expect(result.exportFrames).toBe(Math.ceil(result.sampleRate * 3.55));
    expect(Math.abs(result.residualFromExpectedMs)).toBeLessThanOrEqual(5);
    expect(result.livePeak).toBeLessThanOrEqual(1);
    expect(result.exportPeak).toBeLessThanOrEqual(1);
    expect(result.eventWindows).toHaveLength(result.eventCount);
    expect(result.eventWindows.every(window => Math.abs(window.eventLagMs) <= 5)).toBe(true);
    const expectedEventCount = result.name === 'audio-clip+master-bypass' ? 1 : 4;
    expect(result.eventWindows.length).toBe(expectedEventCount);
    expect(result.eventWindows.every(window => window.exportRms > 1e-3 && window.liveRms > 1e-3)).toBe(true);
  }
  // Confirm the tested FX/mastering settings change live output rather than
  // allowing two silent or identical branches to satisfy parity checks.
  const byName = Object.fromEntries(results.scenarios.map(result => [result.name, result]));
  const masteringFirstEvent = byName['dry+mastering'].eventWindows[0];
  const masteringFirstEventLevelDifferenceDb = 20 * Math.log10(masteringFirstEvent.liveRms / masteringFirstEvent.exportRms);
  expect(Math.abs(masteringFirstEventLevelDifferenceDb), 'first mastered event level must match after event-local alignment').toBeLessThanOrEqual(0.25);
  expect(Math.abs(byName['delay-A+master-bypass'].liveRms - byName['delay-disabled+master-bypass'].liveRms)).toBeGreaterThan(1e-3);
  expect(Math.abs(byName['delay-B-feedback-0.6+master-bypass'].liveRms - byName['delay-A+master-bypass'].liveRms)).toBeGreaterThan(1e-3);
  expect(Math.abs(byName['dry+mastering'].liveRms - byName['dry+master-bypass'].liveRms)).toBeGreaterThan(1e-3);
  expect(Number.isFinite(results.liveRepeat.relativeRmsError)).toBe(true);
});
