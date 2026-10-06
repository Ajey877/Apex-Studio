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

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed>0) process.exit(1);
