// Small, explicit scheduling/source model for the prototype fixture.
// This is NOT Apex Studio's production project or instrument implementation.
import { biquadLowpass } from './reference.mjs';

export function compileProject(project) {
  if (!project || project.schemaVersion !== 1 || !Array.isArray(project.tracks) || !Array.isArray(project.buses)) {
    throw new TypeError('project must be a schema-v1 object with tracks and buses');
  }
  const sampleRate = Number(project.sampleRate);
  const tempoBpm = Number(project.tempoBpm);
  const beatsPerBar = Number(project.beatsPerBar);
  const bars = Number(project.bars);
  if (!(sampleRate >= 8000 && sampleRate <= 192000 && tempoBpm > 0 && beatsPerBar > 0 && bars > 0)) {
    throw new RangeError('invalid sample rate, tempo, meter, or bar count');
  }
  if (project.tracks.length < 1 || project.tracks.length > 64) throw new RangeError('project needs 1–64 tracks');
  if (project.buses.length < 1 || project.buses.length > 16) throw new RangeError('project needs 1–16 buses');

  const busIds = new Set();
  const buses = project.buses.map(bus => {
    if (!bus || typeof bus.id !== 'string' || busIds.has(bus.id)) throw new TypeError('bus ids must be unique strings');
    busIds.add(bus.id);
    const gain = Number(bus.gain ?? 1);
    const drive = Number(bus.drive ?? 0);
    if (!Number.isFinite(gain) || !Number.isFinite(drive) || drive < 0 || drive > 8) throw new RangeError(`invalid bus controls: ${bus.id}`);
    return { id: bus.id, gain, drive };
  });
  const busIndex = new Map(buses.map((bus, index) => [bus.id, index]));

  const secondsPerBeat = 60 / tempoBpm;
  const arrangementFrames = Math.round(bars * beatsPerBar * secondsPerBeat * sampleRate);
  const tailFrames = Math.round(Math.max(0, Number(project.tailSeconds) || 0) * sampleRate);
  const totalFrames = arrangementFrames + tailFrames;
  const seenTrackIds = new Set();
  let eventCount = 0;
  const tracks = project.tracks.map(track => {
    if (!track || typeof track.id !== 'string' || seenTrackIds.has(track.id)) throw new TypeError('track ids must be unique strings');
    seenTrackIds.add(track.id);
    if (!track.source || !['instrument', 'sample'].includes(track.source.kind)) throw new TypeError(`unsupported source kind in ${track.id}`);
    if (!['triangle', 'saw', 'square', 'noise', 'noise-sweep'].includes(track.source.waveform)) throw new TypeError(`unsupported source waveform in ${track.id}`);
    const routes = (track.routes || []).map(route => {
      if (!busIds.has(route.busId)) throw new TypeError(`track ${track.id} routes to missing bus ${route.busId}`);
      const gain = Number(route.gain ?? 1);
      if (!Number.isFinite(gain) || gain < 0 || gain > 4) throw new RangeError(`invalid route gain in ${track.id}`);
      return { busId: route.busId, busIndex: busIndex.get(route.busId), gain };
    });
    if (routes.length === 0) throw new TypeError(`track ${track.id} has no route`);
    const filter = track.filter || {};
    const cutoffHz = Number(filter.cutoffHz ?? sampleRate / 4);
    const q = Number(filter.q ?? Math.SQRT1_2);
    if (!(cutoffHz > 0 && cutoffHz < sampleRate / 2 && q > 0)) throw new RangeError(`invalid filter in ${track.id}`);
    const points = (track.automation || []).map(point => ({
      frame: Math.round(Number(point.beat) * secondsPerBeat * sampleRate),
      value: Number(point.value),
    })).sort((a, b) => a.frame - b.frame);
    if (!points.length) points.push({ frame: 0, value: 1 });
    if (points.some(p => !Number.isFinite(p.frame) || !Number.isFinite(p.value) || p.value < 0 || p.value > 4)) {
      throw new RangeError(`invalid gain automation in ${track.id}`);
    }

    const events = [];
    let localEvent = 0;
    for (const clip of track.clips || []) {
      if (!Number.isFinite(clip.startBeat) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0) {
        throw new RangeError(`invalid clip in ${track.id}`);
      }
      for (const event of clip.events || []) {
        const kind = event.kind || (track.source.kind === 'instrument' ? 'note' : 'hit');
        if (!['note', 'hit'].includes(kind)) throw new TypeError(`unsupported event kind ${kind}`);
        if (!Number.isFinite(event.atBeat) || event.atBeat < 0 || event.atBeat >= clip.lengthBeats) throw new RangeError(`event lies outside clip in ${track.id}`);
        const durationBeats = Number(event.durationBeats);
        const velocity = Number(event.velocity ?? 1);
        if (!(durationBeats > 0 && velocity >= 0 && velocity <= 1.5)) throw new RangeError(`invalid event duration/velocity in ${track.id}`);
        if (kind === 'note' && !(Number(event.midi) >= 0 && Number(event.midi) <= 127)) throw new RangeError(`invalid MIDI note in ${track.id}`);
        const startBeat = Number(clip.startBeat) + Number(event.atBeat);
        const durationFrames = Math.max(1, Math.round(durationBeats * secondsPerBeat * sampleRate));
        const releaseSeconds = kind === 'note'
          ? Math.max(0, Number(track.source.releaseSeconds) || 0)
          : Math.max(0, Number(track.source.decaySeconds) || 0.08) * 2.5;
        const releaseFrames = Math.round(releaseSeconds * sampleRate);
        events.push({
          kind,
          startFrame: Math.round(startBeat * secondsPerBeat * sampleRate),
          durationFrames,
          releaseFrames,
          velocity,
          midi: Number(event.midi) || 0,
          seed: ((Number(track.source.seed) || 0) ^ Math.imul(localEvent + 1, 0x9e3779b9)) >>> 0,
          eventIndex: localEvent++,
        });
        eventCount++;
      }
    }
    events.sort((a, b) => a.startFrame - b.startFrame || a.eventIndex - b.eventIndex);
    const pan = Math.max(-1, Math.min(1, Number(track.pan) || 0));
    const panAngle = (pan + 1) * Math.PI / 4;
    return {
      id: track.id,
      label: track.label || track.id,
      source: { ...track.source },
      preGain: Number(track.preGain ?? 1),
      coefficients: biquadLowpass(cutoffHz, q, sampleRate),
      cutoffHz,
      q,
      fader: Number(track.fader ?? 1),
      pan,
      panLeft: Math.cos(panAngle),
      panRight: Math.sin(panAngle),
      routes,
      automation: points,
      events,
    };
  });

  return {
    id: String(project.id || 'prototype-project'),
    name: String(project.name || 'prototype project'),
    sampleRate,
    tempoBpm,
    beatsPerBar,
    bars,
    secondsPerBeat,
    arrangementFrames,
    totalFrames,
    tailFrames,
    masterGain: Number(project.masterGain ?? 1),
    buses,
    tracks,
    eventCount,
  };
}

function hashNoise(seed, index) {
  let x = Math.imul((seed ^ index) >>> 0, 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 2147483648 - 1;
}

function periodicWaveform(waveform, phase) {
  const p = phase - Math.floor(phase);
  if (waveform === 'saw') return 2 * p - 1;
  if (waveform === 'square') return p < 0.5 ? 1 : -1;
  return 1 - 4 * Math.abs(p - 0.5); // triangle; deterministic, no libm oscillator
}

function eventSample(track, event, ageFrames, sampleRate) {
  const ageSeconds = ageFrames / sampleRate;
  const source = track.source;
  if (event.kind === 'hit') {
    const decay = Math.max(0.006, Number(source.decaySeconds) || 0.08);
    const envelope = Math.exp(-ageSeconds / decay);
    if (source.waveform === 'noise') return hashNoise(event.seed, ageFrames) * envelope * event.velocity * 0.42;
    const startHz = Number(source.startHz) || 80;
    const sweepHz = Number(source.sweepHz) || 0;
    const phase = ageSeconds * startHz + 0.5 * sweepHz * ageSeconds * ageSeconds;
    const tone = periodicWaveform('triangle', phase);
    const noise = hashNoise(event.seed, ageFrames);
    return (tone * 0.78 + noise * 0.22) * envelope * event.velocity * 0.72;
  }

  const attackFrames = Math.max(1, Math.round((Number(source.attackSeconds) || 0.01) * sampleRate));
  const sustainEnd = event.durationFrames;
  const releaseFrames = Math.max(1, event.releaseFrames);
  let envelope;
  if (ageFrames < attackFrames) envelope = ageFrames / attackFrames;
  else if (ageFrames < sustainEnd) envelope = 1;
  else envelope = Math.max(0, 1 - (ageFrames - sustainEnd) / releaseFrames);
  const frequency = 440 * (2 ** ((event.midi - 69) / 12));
  const phase = ageFrames * frequency / sampleRate;
  return periodicWaveform(source.waveform, phase) * envelope * event.velocity * 0.34;
}

/** Fill one independent, deterministic mono input for a track render interval. */
export function renderTrackSourceChunk(track, startFrame, frameCount, sampleRate, target = new Float32Array(frameCount)) {
  target.fill(0, 0, frameCount);
  const endFrame = startFrame + frameCount;
  for (const event of track.events) {
    const eventEnd = event.startFrame + event.durationFrames + event.releaseFrames;
    if (eventEnd <= startFrame || event.startFrame >= endFrame) continue;
    const from = Math.max(startFrame, event.startFrame);
    const to = Math.min(endFrame, eventEnd);
    for (let absoluteFrame = from; absoluteFrame < to; absoluteFrame++) {
      const age = absoluteFrame - event.startFrame;
      target[absoluteFrame - startFrame] += eventSample(track, event, age, sampleRate);
    }
  }
  return target;
}

export function renderProjectSources(compiled) {
  return compiled.tracks.map(track => renderTrackSourceChunk(track, 0, compiled.totalFrames, compiled.sampleRate));
}

export function automationAtFrame(points, frame) {
  if (frame <= points[0].frame) return points[0].value;
  let lo = 0;
  while (lo + 1 < points.length && frame >= points[lo + 1].frame) lo++;
  if (lo + 1 >= points.length) return points[lo].value;
  const a = points[lo];
  const b = points[lo + 1];
  const t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
  return a.value + (b.value - a.value) * t;
}

export function trackGainAtFrame(track, frame, baseFader = track.fader) {
  return baseFader * automationAtFrame(track.automation, frame);
}

export function softClip(value, drive) {
  return drive > 0 ? value / (1 + drive * Math.abs(value)) : value;
}

export function projectInfo(compiled) {
  return {
    id: compiled.id,
    name: compiled.name,
    sampleRate: compiled.sampleRate,
    tempoBpm: compiled.tempoBpm,
    bars: compiled.bars,
    durationFrames: compiled.totalFrames,
    durationSeconds: compiled.totalFrames / compiled.sampleRate,
    trackIds: compiled.tracks.map(track => track.id),
    sourceKinds: compiled.tracks.map(track => track.source.kind),
    clipEventCount: compiled.eventCount,
    busIds: compiled.buses.map(bus => bus.id),
    effects: ['per-track WASM gain+biquad', 'sample-accurate track fader automation', 'track pan/route', 'per-bus soft clip', 'master gain'],
  };
}
