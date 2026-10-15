/**
 * Phase 86 — Real Offline Rendering Node Fallback (web-audio-engine)
 * Pure-JS Web Audio implementation that does real DSP without browser/native libs.
 * Used when Playwright Chromium is unavailable (sandbox) — validates same
 * production path (audioEngine.renderTimelineOffline) via web-audio-engine polyfill.
 * CI still runs Playwright Chromium; this is local proof that production export
 * generates audible correctly-routed audio.
 */
import * as Engine from 'web-audio-engine';

const OfflineAudioContext = Engine.OfflineAudioContext;
const AudioContext = Engine.WebAudioContext || Engine.StreamAudioContext || Engine.RenderingAudioContext;

// Polyfill global for audioEngine
globalThis.OfflineAudioContext = OfflineAudioContext;
globalThis.AudioContext = AudioContext;
if (!globalThis.window) globalThis.window = globalThis;
globalThis.window.OfflineAudioContext = OfflineAudioContext;
globalThis.window.AudioContext = AudioContext;
globalThis.window.webkitAudioContext = AudioContext;
globalThis.window.webkitOfflineAudioContext = OfflineAudioContext;
if (!globalThis.document) globalThis.document = { createElement: () => ({}) };
try { if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' }; } catch (e) { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, writable: true, configurable: true }); }

const { audioEngine } = await import('../src/audio/audioEngine.ts');

function stats(buffer) {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  let max=0, sum=0, finite=true;
  let maxL=0, maxR=0;
  for (let i=0;i<ch0.length;i++){ const v=ch0[i]; if(!Number.isFinite(v)) finite=false; const a=Math.abs(v); if(a>max) max=a; if(a>maxL) maxL=a; sum+=a; }
  for (let i=0;i<ch1.length;i++){ const a=Math.abs(ch1[i]); if(a>maxR) maxR=a; }
  return { channels: buffer.numberOfChannels, length: buffer.length, sr: buffer.sampleRate, duration: buffer.duration, max, meanAbs: sum/ch0.length, finite, maxL, maxR };
}

function assert(cond, msg){ if(!cond) throw new Error(msg); }

const baseSynthParams = audioEngine.getDefaultSynthParams ? audioEngine.getDefaultSynthParams() : {
  osc1Type: 'sawtooth', osc1Octave: 0, osc1Detune: 0, osc1Mix: 1,
  osc2Type: 'sine', osc2Octave: 0, osc2Detune: 0, osc2Mix: 0,
  filterType: 'lowpass', filterCutoff: 20000, filterResonance: 0, filterEnvAmount: 0,
  attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.1,
  lfoRate: 0, lfoDepth: 0, lfoTarget: 'none',
  fmCarrierMultiplier: 1, fmModulatorMultiplier: 1, fmModulationIndex: 0, fmFeedback: 0,
  sampleRootNote: 60, sampleGlide: 0, sampleReverse: false, sampleLoop: false, sampleDrive: 0,
};

const mixerTracks = [
  { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL:0, peakR:0 },
  { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL:0, peakR:0 },
];
const playlistTracks = [{id:0,name:'Track 1',color:'#fff',volume:1,pan:0,mute:false,solo:false}];

let passed=0, failed=0;
function pass(name){ console.log(`✓ ${name}`); passed++; }
function fail(name, err){ console.error(`✗ ${name}: ${err.message}`); console.error(err.stack); failed++; }

console.log('=== Phase 86 Node Real Offline Render (web-audio-engine) ===');
console.log('Engine', OfflineAudioContext.name, '| AudioContext', AudioContext.name);

// 1. Harness — oscillator → gain → destination
try {
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const osc = ctx.createOscillator();
  osc.type='sine'; osc.frequency.value=440;
  const gain = ctx.createGain(); gain.gain.value=0.5;
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(0); osc.stop(0.5);
  const buf = await ctx.startRendering();
  const s = stats(buf);
  assert(s.channels===2, `expected 2 channels got ${s.channels}`);
  assert(s.sr===48000, `expected 48000 got ${s.sr}`);
  assert(s.length===48000, `expected 48000 got ${s.length}`);
  assert(s.finite, 'non-finite');
  assert(s.max>0.05, `expected audible max>0.05 got ${s.max}`);
  pass('harness: oscillator renders stereo audible finite');
} catch(e){ fail('harness: oscillator', e); }

// 2. Muted gain near-silence
try {
  const ctxA = new OfflineAudioContext(2, 9600, 48000);
  const oscA = ctxA.createOscillator(); oscA.frequency.value=440; const gA = ctxA.createGain(); gA.gain.value=0.5; oscA.connect(gA); gA.connect(ctxA.destination); oscA.start(0); oscA.stop(0.2); const bufA = await ctxA.startRendering();
  const ctxB = new OfflineAudioContext(2, 9600, 48000);
  const oscB = ctxB.createOscillator(); oscB.frequency.value=440; const gB = ctxB.createGain(); gB.gain.value=0; oscB.connect(gB); gB.connect(ctxB.destination); oscB.start(0); oscB.stop(0.2); const bufB = await ctxB.startRendering();
  const sA = stats(bufA); const sB = stats(bufB);
  assert(sA.max>0.05, `audible max ${sA.max}`);
  assert(sB.max<1e-6, `silent max ${sB.max}`);
  pass('harness: muted gain near-silence');
} catch(e){ fail('harness: muted', e); }

// 3. Determinism
try {
  async function renderOnce(){
    const ctx = new OfflineAudioContext(2, 4800, 48000);
    const osc = ctx.createOscillator(); osc.frequency.value=440; osc.type='sine';
    const g = ctx.createGain(); g.gain.value=0.3;
    osc.connect(g); g.connect(ctx.destination); osc.start(0); osc.stop(0.1);
    const buf = await ctx.startRendering();
    return Array.from(buf.getChannelData(0).slice(0,100)).join(',');
  }
  const a = await renderOnce(); const b = await renderOnce();
  assert(a===b, 'determinism fingerprint mismatch');
  pass('harness: deterministic');
} catch(e){ fail('harness: deterministic', e); }

// 4. Production inline note → non-silent
try {
  const ch = { id:'ch-test', name:'Test Synth', color:'#10b981', instrumentType:'minisynth', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[{id:'n1', pitch:60, start:0, duration:4, velocity:0.9}], synthParams: baseSynthParams };
  const clip = { id:'clip-1', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-test', color:'#10b981', name:'Test Clip' };
  const buf = await audioEngine.renderTimelineOffline([ch],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const s = stats(buf);
  assert(s.channels===2, `channels ${s.channels}`);
  assert(s.sr===48000, `sr ${s.sr}`);
  assert(s.finite, 'non-finite');
  assert(s.max>1e-4, `expected non-silent got ${s.max}`);
  pass(`production: instrument note audible (max=${s.max.toFixed(4)} mean=${s.meanAbs.toFixed(4)})`);
} catch(e){ fail('production: instrument note', e); }

// 5. Muted channel → silence
try {
  const chAud = { id:'ch-test', name:'Test Synth', color:'#10b981', instrumentType:'minisynth', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[{id:'n1', pitch:60, start:0, duration:4, velocity:0.9}], synthParams: baseSynthParams };
  const chMut = { ...chAud, mute:true };
  const clip = { id:'clip-1', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-test', color:'#10b981', name:'Test Clip' };
  const bufAud = await audioEngine.renderTimelineOffline([chAud],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const bufMut = await audioEngine.renderTimelineOffline([chMut],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const sAud = stats(bufAud); const sMut = stats(bufMut);
  assert(sAud.max>1e-4, `audible ${sAud.max}`);
  assert(sMut.max<1e-4, `muted should be silent got ${sMut.max}`);
  pass(`production: mute → silence (audible ${sAud.max.toFixed(4)} muted ${sMut.max.toFixed(6)})`);
} catch(e){ fail('production: mute', e); }

// 6. FX diff
try {
  const ch = { id:'ch-test', name:'Test Synth', color:'#10b981', instrumentType:'minisynth', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[{id:'n1', pitch:60, start:0, duration:4, velocity:0.9}], synthParams: baseSynthParams };
  const clip = { id:'clip-1', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-test', color:'#10b981', name:'Test Clip' };
  const dryTracks = [{ id:0, name:'Master', color:'#3b82f6', volume:1, pan:0, mute:false, solo:false, fxSlots:[], peakL:0, peakR:0 },{ id:1, name:'Ch1', color:'#10b981', volume:1, pan:0, mute:false, solo:false, fxSlots:[], peakL:0, peakR:0 }];
  const wetTracks = [{ id:0, name:'Master', color:'#3b82f6', volume:1, pan:0, mute:false, solo:false, fxSlots:[], peakL:0, peakR:0 },{ id:1, name:'Ch1', color:'#10b981', volume:1, pan:0, mute:false, solo:false, fxSlots:[{ id:'fx-delay', type:'delay', name:'Delay', enabled:true, mix:0.5, params:{ time:0.25, feedback:0.3 } }], peakL:0, peakR:0 }];
  const dry = await audioEngine.renderTimelineOffline([ch],[clip],dryTracks,120,1,48000,true);
  const wet = await audioEngine.renderTimelineOffline([ch],[clip],wetTracks,120,1,48000,true);
  const d0 = dry.getChannelData(0); const w0 = wet.getChannelData(0);
  let diffEnergy=0, maxDiff=0;
  for(let i=0;i<d0.length;i++){ const diff=Math.abs(w0[i]-d0[i]); diffEnergy+=diff*diff; if(diff>maxDiff) maxDiff=diff; }
  assert(maxDiff>1e-4, `FX diff maxDiff ${maxDiff}`);
  assert(diffEnergy>1e-6, `energy ${diffEnergy}`);
  pass(`production: FX param diff (maxDiff=${maxDiff.toFixed(5)} energy=${diffEnergy.toFixed(5)})`);
} catch(e){ fail('production: FX diff', e); }

// 6b. Offline reverb determinism (Audio Integrity Fix 4): repeated renders of
// the same project must be sample-identical, which requires the seeded
// offline impulse on the native FX path; the wet render must also differ
// from dry so the determinism check cannot pass vacuously.
try {
  const ch = { id:'ch-test', name:'Test Synth', color:'#7e57c2', instrumentType:'minisynth', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[{id:'n1', pitch:60, start:0, duration:4, velocity:0.9}], synthParams: baseSynthParams };
  const clip = { id:'clip-1', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-test', color:'#7e57c2', name:'Test Clip' };
  // Send -> return topology, mirroring browser-tests/realOfflineRender.spec.ts.
  const verbSlot = { id:'fx-8-verb', type:'reverb', name:'Studio Reverb', enabled:true, mix:1.0, params:{ roomSize:0.7, decay:2.2 } };
  const dryTracks = [
    { id:0, name:'Master', color:'#3b82f6', volume:1, pan:0, mute:false, solo:false, peakL:0, peakR:0, fxSlots:[] },
    { id:1, name:'Dry Source', color:'#7e57c2', volume:1, pan:0, mute:false, solo:false, peakL:0, peakR:0, fxSlots:[], auxSends:[] },
    { id:8, name:'Reverb Return', color:'#7e57c2', volume:0.85, pan:0, mute:false, solo:false, peakL:0, peakR:0, isAux:true, fxSlots:[verbSlot] },
  ];
  const wetTracks = [
    { id:0, name:'Master', color:'#3b82f6', volume:1, pan:0, mute:false, solo:false, peakL:0, peakR:0, fxSlots:[] },
    { id:1, name:'Wet Source', color:'#7e57c2', volume:1, pan:0, mute:false, solo:false, peakL:0, peakR:0, fxSlots:[], auxSends:[{ targetId:8, amount:0.8 }] },
    { id:8, name:'Reverb Return', color:'#7e57c2', volume:0.85, pan:0, mute:false, solo:false, peakL:0, peakR:0, isAux:true, fxSlots:[verbSlot] },
  ];
  const dry = await audioEngine.renderTimelineOffline([ch],[clip],dryTracks,120,1,48000,true);
  const wetA = await audioEngine.renderTimelineOffline([ch],[clip],wetTracks,120,1,48000,true);
  const wetB = await audioEngine.renderTimelineOffline([ch],[clip],wetTracks,120,1,48000,true);
  const maxDiffOf = (a, b) => { const a0=a.getChannelData(0), b0=b.getChannelData(0); let m=0; for(let i=0;i<Math.min(a0.length,b0.length);i++) m=Math.max(m, Math.abs(a0[i]-b0[i])); return m; };
  const sWet = stats(wetA);
  assert(sWet.max>1e-4, `wet render should be audible got ${sWet.max}`);
  const wetVsDry = maxDiffOf(wetA, dry);
  assert(wetVsDry>1e-4, `reverb should differ from dry, maxDiff ${wetVsDry}`);
  const repeatDiff = maxDiffOf(wetA, wetB);
  assert(repeatDiff<1e-6, `repeated offline reverb renders diverged, maxDiff ${repeatDiff}`);
  pass(`production: offline reverb deterministic (repeat maxDiff=${repeatDiff.toExponential(2)} wetVsDry=${wetVsDry.toFixed(5)})`);
} catch(e){ fail('production: offline reverb deterministic', e); }

// 7. Missing buffer throws descriptive
try {
  const ch = { id:'ch-audio', name:'Audio Ch', color:'#f59e0b', instrumentType:'sampler', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[], synthParams:{} };
  const clip = { id:'clip-missing', trackIndex:0, startBar:0, lengthBars:1, type:'audio', channelId:'ch-audio', audioBufferId:'missing-buffer-id-999', audioName:'Missing Take', color:'#f59e0b', name:'Missing Take', mute:false };
  let threw=false, msg='';
  try { await audioEngine.renderTimelineOffline([ch],[clip],mixerTracks,120,1,48000,false); } catch(err){ threw=true; msg=err.message||String(err); }
  assert(threw, 'should throw');
  assert(/missing.*buffer|audioBufferId|Missing audio buffer/i.test(msg), `not descriptive: ${msg}`);
  pass(`production: missing buffer throws descriptive ("${msg.slice(0,80)}")`);
} catch(e){ fail('production: missing buffer', e); }

// 8. Deterministic production render
try {
  const ch = { id:'ch-test', name:'Test Synth', color:'#10b981', instrumentType:'minisynth', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[{id:'n1', pitch:60, start:0, duration:4, velocity:0.9}], synthParams: baseSynthParams };
  const clip = { id:'clip-1', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-test', color:'#10b981', name:'Test Clip' };
  const a = await audioEngine.renderTimelineOffline([ch],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const b = await audioEngine.renderTimelineOffline([ch],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const da = a.getChannelData(0), db = b.getChannelData(0);
  let maxDiff=0; for(let i=0;i<da.length;i++) maxDiff=Math.max(maxDiff, Math.abs(da[i]-db[i]));
  assert(maxDiff<1e-6, `determinism diff ${maxDiff}`);
  pass(`production: deterministic (maxDiff=${maxDiff.toExponential(2)})`);
} catch(e){ fail('production: deterministic', e); }

// 9. Phase 1I — real 7/8 offline render and bounce retain audible audio
try {
  audioEngine.setTimeSignature([7,8]);
  const ch = {
    id:'ch-78', name:'7/8 Synth', color:'#10b981', instrumentType:'minisynth', mixerTrackId:1,
    volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(14).fill(false),
    notes:[
      {id:'n-downbeat', pitch:60, start:0, duration:1, velocity:0.9},
      {id:'n-final-eighth', pitch:67, start:13, duration:0.5, velocity:0.9},
    ],
    synthParams:baseSynthParams,
  };
  const clip = { id:'clip-78', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-78', color:'#10b981', name:'7/8 bar' };
  const rendered = await audioEngine.renderTimelineOffline(
    [ch], [clip], mixerTracks, 120, 1, 48000, false, 'song', undefined, undefined, undefined, 0
  );
  const renderStats = stats(rendered);
  assert(Math.abs(rendered.duration - 1.75) < 1e-9, `7/8 render duration ${rendered.duration}, expected 1.75 s`);
  assert(renderStats.finite, '7/8 render contains non-finite samples');
  assert(renderStats.max > 1e-4, `7/8 render should be audible, max=${renderStats.max}`);

  const bounced = await audioEngine.bounceChannelToAudioClip(ch, 120, 1);
  const bounceStats = stats(bounced.buffer);
  assert(bounced.lengthBars === 1, `7/8 bounce length ${bounced.lengthBars} bars, expected 1`);
  assert(Math.abs(bounced.buffer.duration - 1.75) < 1e-9, `7/8 bounce duration ${bounced.buffer.duration}, expected 1.75 s`);
  assert(bounceStats.finite, '7/8 bounce contains non-finite samples');
  assert(bounceStats.max > 1e-4, `7/8 bounce should be audible, max=${bounceStats.max}`);
  pass(`Phase 1I: real 7/8 render + bounce audible (duration=${rendered.duration.toFixed(2)}s, max=${Math.max(renderStats.max, bounceStats.max).toFixed(4)})`);
} catch(e){ fail('Phase 1I: real 7/8 render and bounce', e); }

// 10. MIDI-recorded performance -> committed Piano Roll notes -> offline export
// The recorder is fed the same normalized events the engine's MIDI listener
// dispatches, stamped with deterministic transport steps (120 BPM: 0.125 s
// per 16th step). The committed channel must render audibly, and a control
// channel that received no recorded notes must stay silent — proving the
// recorded gates, not the harness, produce the audio.
try {
  audioEngine.setTimeSignature([4,4]);
  const { MidiPerformanceRecorder, appendRecordedNotesToChannelInProjectState, transportPositionToSteps } = await import('../src/audio/midiRecording.ts');
  const recorder = new MidiPerformanceRecorder({ createNoteId: s => `node-rec-${s}` });
  const at = s => ({ positionSteps: transportPositionToSteps(s, 120) });
  recorder.start({ channelId: 'ch-rec', patternId: 'pat-1', patternLengthSteps: 16, bpm: 120 }, at(0));
  recorder.handleMidiEvent({ type: 'noteOn', note: 60, velocity: 100 / 127, midiChannel: 1 }, at(0));
  recorder.handleMidiEvent({ type: 'noteOn', note: 64, velocity: 80 / 127, midiChannel: 1 }, at(0.25));
  recorder.handleMidiEvent({ type: 'noteOff', note: 60, midiChannel: 1 }, at(0.5));
  recorder.handleMidiEvent({ type: 'noteOff', note: 64, midiChannel: 1 }, at(0.75));
  const recordedNotes = recorder.stop(at(0.75));
  assert(recordedNotes.length === 2, `expected 2 recorded notes, got ${recordedNotes.length}`);
  assert(recordedNotes[0].start === 0 && recordedNotes[0].duration === 4, `note 1 timing ${JSON.stringify(recordedNotes[0])}`);
  assert(recordedNotes[1].start === 2 && recordedNotes[1].duration === 4, `note 2 timing ${JSON.stringify(recordedNotes[1])}`);

  const baseChannel = { id:'ch-rec', name:'Recorded Synth', color:'#10b981', instrumentType:'minisynth', mixerTrackId:1, volume:0.9, pan:0, pitch:0, mute:false, solo:false, steps:Array(16).fill(false), notes:[], synthParams: baseSynthParams };
  const projectLike = { channels: [baseChannel], patterns: [{ id:'pat-1', name:'Pattern 1', color:'#fff', lengthSteps:16 }], selectedPatternId: 'pat-1' };
  const committed = appendRecordedNotesToChannelInProjectState(projectLike, 'ch-rec', recordedNotes);
  const recordedChannel = committed.channels[0];
  assert(recordedChannel.notes.length === 2, 'recorded notes were not committed to the channel');

  const clip = { id:'clip-rec', trackIndex:0, startBar:0, lengthBars:1, type:'pattern', channelId:'ch-rec', color:'#10b981', name:'Recorded Clip' };
  const withNotes = await audioEngine.renderTimelineOffline([recordedChannel],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const silent = await audioEngine.renderTimelineOffline([baseChannel],[clip],mixerTracks,120,1,48000,false,'song',undefined,undefined,4);
  const sWith = stats(withNotes); const sSilent = stats(silent);
  assert(sWith.finite, 'recorded render contains non-finite samples');
  assert(sWith.max > 1e-4, `recorded notes should render audibly, max=${sWith.max}`);
  assert(sSilent.max < 1e-4, `control channel without recorded notes should be silent, max=${sSilent.max}`);
  pass(`MIDI recording: recorded performance exports audibly (max=${sWith.max.toFixed(4)}, control=${sSilent.max.toFixed(6)})`);
} catch(e){ fail('MIDI recording: recorded performance exports audibly', e); }

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed>0) process.exit(1);
