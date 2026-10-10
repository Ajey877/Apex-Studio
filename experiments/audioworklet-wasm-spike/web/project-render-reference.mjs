// Independent, non-WASM reference path for the synthetic project fixture.
// The shared input model/scheduler is intentional; filter math is the scalar JS
// implementation in reference.mjs, and bus/mix processing is implemented here.
import { compileProject, projectInfo, renderProjectSources, softClip, trackGainAtFrame } from './project-model.mjs';
import { referenceProcess } from './reference.mjs';

export function renderProjectReference(project, { captureStems = true, automationBeforeInsert = false } = {}) {
  const compiled = compileProject(project);
  const sources = renderProjectSources(compiled);
  const trackResults = [];
  const busIndex = new Map(compiled.buses.map((bus, i) => [bus.id, i]));
  const busLeft = compiled.buses.map(() => new Float32Array(compiled.totalFrames));
  const busRight = compiled.buses.map(() => new Float32Array(compiled.totalFrames));

  for (let t = 0; t < compiled.tracks.length; t++) {
    const track = compiled.tracks[t];
    const source = sources[t];
    let filterInput = source;
    if (automationBeforeInsert) {
      filterInput = new Float32Array(source.length);
      for (let frame = 0; frame < source.length; frame++) filterInput[frame] = source[frame] * trackGainAtFrame(track, frame);
    }
    const filteredLeft = referenceProcess(filterInput, track.preGain, track.coefficients);
    const filteredRight = referenceProcess(filterInput, track.preGain, track.coefficients);
    const left = new Float32Array(compiled.totalFrames);
    const right = new Float32Array(compiled.totalFrames);
    for (let frame = 0; frame < compiled.totalFrames; frame++) {
      const gain = automationBeforeInsert ? 1 : trackGainAtFrame(track, frame);
      left[frame] = filteredLeft[frame] * gain * track.panLeft;
      right[frame] = filteredRight[frame] * gain * track.panRight;
    }
    for (const route of track.routes) {
      const index = busIndex.get(route.busId);
      const l = busLeft[index];
      const r = busRight[index];
      for (let frame = 0; frame < compiled.totalFrames; frame++) {
        l[frame] += left[frame] * route.gain;
        r[frame] += right[frame] * route.gain;
      }
    }
    if (captureStems) trackResults.push({ id: track.id, left, right });
  }

  const masterLeft = new Float32Array(compiled.totalFrames);
  const masterRight = new Float32Array(compiled.totalFrames);
  const busResults = [];
  for (let b = 0; b < compiled.buses.length; b++) {
    const bus = compiled.buses[b];
    const left = busLeft[b];
    const right = busRight[b];
    for (let frame = 0; frame < compiled.totalFrames; frame++) {
      left[frame] = softClip(left[frame] * bus.gain, bus.drive);
      right[frame] = softClip(right[frame] * bus.gain, bus.drive);
      masterLeft[frame] += left[frame];
      masterRight[frame] += right[frame];
    }
    if (captureStems) busResults.push({ id: bus.id, left: left.slice(), right: right.slice() });
  }
  for (let frame = 0; frame < compiled.totalFrames; frame++) {
    masterLeft[frame] *= compiled.masterGain;
    masterRight[frame] *= compiled.masterGain;
  }

  return {
    info: projectInfo(compiled),
    master: { left: masterLeft, right: masterRight },
    tracks: trackResults,
    buses: busResults,
    sourceStats: sources.map((source, index) => ({ id: compiled.tracks[index].id, peak: peak(source), rms: rms(source) })),
  };
}

export function summarizeStereo(stereo) {
  return {
    frames: stereo.left.length,
    left: { peak: peak(stereo.left), rms: rms(stereo.left), nonFinite: countNonFinite(stereo.left) },
    right: { peak: peak(stereo.right), rms: rms(stereo.right), nonFinite: countNonFinite(stereo.right) },
  };
}

export function maxAbsDifference(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return { lengthMatch: false, maxAbsDiff: Infinity, index: -1, nonFinite: 0 };
  let maxAbsDiff = 0;
  let index = -1;
  let nonFinite = 0;
  for (let i = 0; i < actual.length; i++) {
    if (!Number.isFinite(actual[i])) nonFinite++;
    const difference = Math.abs(actual[i] - expected[i]);
    if (difference > maxAbsDiff || Number.isNaN(difference)) {
      maxAbsDiff = Number.isNaN(difference) ? Infinity : difference;
      index = i;
    }
  }
  return { lengthMatch: true, maxAbsDiff, index, nonFinite };
}

function peak(buffer) {
  let value = 0;
  for (let i = 0; i < buffer.length; i++) if (Number.isFinite(buffer[i])) value = Math.max(value, Math.abs(buffer[i]));
  return value;
}

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) if (Number.isFinite(buffer[i])) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

function countNonFinite(buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) if (!Number.isFinite(buffer[i])) count++;
  return count;
}
