import type { Channel } from '../types/daw';
import type { InstrumentVoiceContext, InstrumentVoiceHandle } from './instrumentRegistry';
import { resolveGateSeconds } from './noteGate';
import { assertVst3Instrument, getVst3Bridge, type Vst3Bridge, type Vst3Event } from './nativeVst3Types';

export interface Vst3Diagnostic { channelId: string; message: string; inputLatencyMs?: number }
let diagnostics: readonly Vst3Diagnostic[] = [];
const listeners = new Set<() => void>();
export const getVst3Diagnostics = () => diagnostics;
export const subscribeVst3Diagnostics = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function reportVst3(channelId: string, message: string, inputLatencyMs?: number) {
  diagnostics = [...diagnostics.filter(item => item.channelId !== channelId), { channelId, message, inputLatencyMs }].slice(-16);
  listeners.forEach(listener => listener());
}
export function reconcileVst3Diagnostics(channels: Channel[]) {
  const retained = diagnostics.filter(item => channels.some(channel => channel.id === item.channelId && channel.instrumentType === 'vst3'));
  if (retained.length !== diagnostics.length) { diagnostics = retained; listeners.forEach(listener => listener()); }
}
function bridgeOrThrow(bridge?: Vst3Bridge): Vst3Bridge {
  if (!bridge) throw new Error('VST3 instruments require the Windows desktop application. Plugin identity/state is retained in this project.');
  return bridge;
}
// Project configurations are immutable snapshots. Avoid repeatedly serializing
// up-to-MiB state streams on the realtime control/scheduler path.
const configurationKeys = new WeakMap<object, string>();
export const nativeInstrumentKey = (channel: Channel): string => {
  const instrument = channel.vst3;
  if (!instrument || typeof instrument !== 'object') return JSON.stringify(instrument);
  let key = configurationKeys.get(instrument);
  if (key === undefined) { key = JSON.stringify(instrument); configurationKeys.set(instrument, key); }
  return key;
};
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const MAX_EVENTS = 8192;
const BLOCK = 1024;
const BUFFER_SECONDS = 0.05;
const RELEASE_LIMIT_SECONDS = 10;
function midiEvent(context: InstrumentVoiceContext, id: number): Vst3Event {
  return { type: 'on', pitch: clamp(Math.round(context.note.pitch + (context.channel.pitch || 0)), 0, 127),
    velocity: clamp(context.note.velocity, 0, 1), channel: context.midiChannel ?? 0, noteId: id, offset: 0 };
}
function pcmBuffer(context: BaseAudioContext, samples: Float32Array, frames: number): AudioBuffer {
  if (samples.length !== frames * 2 || samples.some(sample => !Number.isFinite(sample))) throw new Error('Invalid VST3 PCM batch');
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  buffer.getChannelData(0).set(samples.subarray(0, frames));
  buffer.getChannelData(1).set(samples.subarray(frames));
  return buffer;
}
interface QueuedEvent { time: number; input: boolean; inputTime?: number; event: Vst3Event }

/** One polyphonic native instance and one output gain per CHANNEL, never per note.
 * The audio render thread only reads scheduled AudioBuffers. Async IPC and the
 * bounded producer run on the control thread, not in an audio callback. Main
 * thread stalls can underrun: they fail/stop visibly rather than replay stale PCM.
 */
class LiveVst3Session {
  readonly key: string;
  readonly ready: Promise<void>;
  disposed = false;
  private closed: Promise<void> = Promise.resolve();
  private id?: string;
  private gain: GainNode;
  private destination: AudioNode;
  private queue: QueuedEvent[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private voices = new Map<number, { on: QueuedEvent; ended?: ReturnType<typeof setTimeout>; onEnded?: () => void }>();
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private pendingPump: Promise<void> = Promise.resolve();
  private started = false;
  private epoch = 0;
  private cursor = 0;
  private nextId = 1;
  private bpm = 120;
  private lastEventTime = 0;
  constructor(private bridge: Vst3Bridge, readonly context: BaseAudioContext, channel: Channel, destination: AudioNode) {
    assertVst3Instrument(channel.vst3);
    this.key = nativeInstrumentKey(channel);
    this.destination = destination;
    this.gain = context.createGain();
    this.gain.gain.value = channel.volume;
    this.gain.connect(destination);
    this.ready = bridge.open(channel.vst3, context.sampleRate, 'realtime').then(async result => {
      if (this.disposed) { await bridge.close(result.id); throw new Error('VST3 load cancelled'); }
      this.id = result.id;
    });
    // ready is also awaited by preparation; this handler prevents an unhandled
    // rejection when a project is replaced during a lazy MIDI-monitoring load.
    this.ready.catch(() => {});
  }
  update(channel: Channel, destination: AudioNode, time = this.context.currentTime) {
    if (destination !== this.destination) { this.gain.disconnect(); this.gain.connect(destination); this.destination = destination; }
    this.volume(channel.volume, time);
  }
  volume(value: number, time: number) { this.gain.gain.setValueAtTime(Math.max(0, value), time); }
  note(context: InstrumentVoiceContext): InstrumentVoiceHandle {
    if (this.disposed) throw new Error('VST3 session is closed; retry playback');
    if (this.voices.size >= 1024 || this.queue.length > MAX_EVENTS - 2) throw new Error('VST3 MIDI queue/voice limit exceeded');
    this.bpm = context.bpm;
    const id = this.nextId++;
    if (this.nextId >= 0x7fffffff) throw new Error('VST3 note identity limit reached; restart playback');
    // Hardware MIDI is an explicit held voice. Virtual keyboard/previews without
    // a MIDI channel retain their existing notated-duration gate.
    const input = context.midiChannel !== undefined || context.time <= this.context.currentTime + 0.002;
    const on: QueuedEvent = { time: context.time, input, inputTime: input ? context.time : undefined, event: midiEvent(context, id) };
    this.voices.set(id, { on, onEnded: context.onEnded });
    this.queue.push(on);
    const release = (time: number, inputRelease = true) => {
      if (this.disposed) return;
      const voice = this.voices.get(id);
      if (!voice) return;
      // Replace a pre-scheduled notated gate with the actual hardware/manual
      // release. Never release another overlapping note of the same pitch.
      this.queue = this.queue.filter(item => !(item.event.noteId === id && item.event.type === 'off'));
      this.queue.push({ time: Math.max(time, on.time), input: inputRelease, event: { ...on.event, type: 'off', velocity: 0 } });
      if (this.queue.length > MAX_EVENTS) return this.fail(context.channel.id, new Error('VST3 MIDI queue overflow'));
      if (voice.ended) clearTimeout(voice.ended);
      voice.ended = setTimeout(() => { this.voices.delete(id); voice.onEnded?.(); },
        Math.max(0, time - this.context.currentTime + RELEASE_LIMIT_SECONDS) * 1000);
    };
    if (context.midiChannel === undefined) release(context.time + resolveGateSeconds(context.note.duration, context.bpm), false);
    if (!this.started) {
      this.started = true;
      void this.ready.then(() => {
        if (this.disposed) return;
        const now = this.context.currentTime;
        // Scheduled transport notes retain their exact audio times. Direct MIDI
        // monitoring needs a startup lead; its bounded buffered latency is
        // reported rather than advertised as zero latency.
        if (!on.input && on.time < now + 0.005) throw new Error('VST3 was not prepared before the transport deadline; stop and retry.');
        this.epoch = on.input ? Math.max(on.time, now + 0.04) : on.time;
        if (on.input) {
          const shift = this.epoch - on.time;
          for (const item of this.queue) item.time += shift;
        }
        this.lastEventTime = this.epoch;
        return this.pump(context.channel.id);
      }).catch(error => this.fail(context.channel.id, error));
    }
    return { stop: (time = this.context.currentTime) => release(time) };
  }
  pump(channelId: string): Promise<void> {
    if (this.pumping) return this.pendingPump;
    this.pendingPump = this.produce(channelId);
    return this.pendingPump;
  }
  private async produce(channelId: string): Promise<void> {
    if (this.disposed || this.pumping || !this.id || !this.started) return;
    this.pumping = true;
    clearTimeout(this.timer);
    try {
      if (this.context.state === 'closed') throw new Error('VST3 audio context closed; retry the instrument.');
      // Bound work per turn. Never drain an unbounded native queue or block UI.
      for (let batch = 0; batch < 4 && !this.disposed; ++batch) {
        const now = this.context.currentTime;
        const audioTime = this.epoch + this.cursor / this.context.sampleRate;
        if (this.cursor > 0 && audioTime >= now + BUFFER_SECONDS) break;
        if (audioTime < now - 0.005) throw new Error('VST3 audio underrun: native/IPC/UI missed its buffer deadline. Audio stopped; retry playback.');
        const end = this.cursor + BLOCK;
        this.queue.sort((a, b) => a.time - b.time || (a.event.type === b.event.type ? 0 : a.event.type === 'off' ? -1 : 1));
        const events: Vst3Event[] = [];
        while (this.queue.length) {
          const item = this.queue[0];
          let frame = Math.round((item.time - this.epoch) * this.context.sampleRate);
          if (frame >= end) break;
          this.queue.shift();
          if (frame < this.cursor) {
            if (!item.input && this.cursor > 0) throw new Error('Scheduled MIDI arrived behind the VST3 render horizon; retry playback.');
            frame = this.cursor;
          }
          if (item.input && item.event.type === 'on') {
            const latency = Math.max(0, (this.epoch + frame / this.context.sampleRate - (item.inputTime ?? item.time)) * 1000);
            reportVst3(channelId, 'VST3 active (buffered desktop audio)', Math.round(latency));
          }
          this.lastEventTime = this.epoch + frame / this.context.sampleRate;
          events.push({ ...item.event, offset: frame - this.cursor });
        }
        events.sort((a, b) => a.offset - b.offset || (a.type === b.type ? 0 : a.type === 'off' ? -1 : 1));
        const samples = await this.bridge.process(this.id, BLOCK, events, this.bpm);
        if (this.disposed) break; // generation fencing: late PCM is NEVER played
        if (audioTime < this.context.currentTime - 0.005) throw new Error('VST3 PCM arrived after its audio deadline; audio stopped.');
        const source = this.context.createBufferSource();
        source.buffer = pcmBuffer(this.context, samples, BLOCK);
        source.connect(this.gain);
        this.sources.add(source);
        source.onended = () => { source.disconnect(); this.sources.delete(source); };
        // A sub-5ms scheduling slip is trimmed, not time-shifted/replayed.
        const offset = Math.max(0, this.context.currentTime - audioTime);
        source.start(Math.max(audioTime, this.context.currentTime), offset, BLOCK / this.context.sampleRate - offset);
        this.cursor = end;
        if (!this.queue.length && !this.voices.size && now > this.lastEventTime + RELEASE_LIMIT_SECONDS) { this.dispose(); break; }
      }
    } catch (error) { this.fail(channelId, error); }
    finally {
      this.pumping = false;
      if (!this.disposed) this.timer = setTimeout(() => { void this.pump(channelId); }, 5);
    }
  }
  private fail(channelId: string, error: unknown) {
    if (this.disposed) return;
    reportVst3(channelId, error instanceof Error ? error.message : String(error));
    this.dispose();
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.closed;
    this.disposed = true;
    clearTimeout(this.timer);
    this.queue = [];
    for (const voice of this.voices.values()) { clearTimeout(voice.ended); voice.onEnded?.(); }
    this.voices.clear();
    for (const source of this.sources) { try { source.stop(); } catch { /* ended */ } source.disconnect(); }
    this.sources.clear();
    this.gain.disconnect();
    this.closed = this.id
      ? this.bridge.close(this.id).catch(() => {})
      : this.ready.catch(() => {});
    return this.closed;
  }
}

export class NativeVst3Runtime {
  private sessions = new Map<string, LiveVst3Session>();
  private closing = new Set<Promise<void>>();
  private disposeSession(session: LiveVst3Session): Promise<void> {
    const closing = session.dispose();
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing));
    return closing;
  }
  constructor(private getBridge: () => Vst3Bridge | undefined = getVst3Bridge) {}
  private session(channel: Channel, context: BaseAudioContext, destination: AudioNode, time = context.currentTime) {
    let session = this.sessions.get(channel.id);
    if (session && (session.disposed || session.context !== context || session.key !== nativeInstrumentKey(channel))) { this.disposeSession(session); this.sessions.delete(channel.id); session = undefined; }
    if (!session) {
      if (this.sessions.size >= 8) throw new Error('At most 8 live VST3 instrument channels are supported');
      session = new LiveVst3Session(bridgeOrThrow(this.getBridge()), context, channel, destination);
      this.sessions.set(channel.id, session);
    }
    session.update(channel, destination, time);
    return session;
  }
  async prepare(channel: Channel, context: BaseAudioContext, destination: AudioNode) {
    const session = this.session(channel, context, destination);
    try { await session.ready; if (session.disposed || this.sessions.get(channel.id) !== session) throw new Error('VST3 load cancelled'); reportVst3(channel.id, 'VST3 ready'); }
    catch (error) { this.disposeSession(session); if (this.sessions.get(channel.id) === session) this.sessions.delete(channel.id); throw error; }
  }
  render(context: InstrumentVoiceContext): InstrumentVoiceHandle {
    return this.session(context.channel, context.audioContext, context.destination, context.time).note(context);
  }
  volume(id: string, value: number, time: number) { this.sessions.get(id)?.volume(value, time); }
  reconcile(channels: Channel[]) {
    let changed = false;
    for (const [id, session] of this.sessions) {
      const channel = channels.find(channel => channel.id === id && channel.instrumentType === 'vst3');
      if (!channel || session.key !== nativeInstrumentKey(channel)) { this.close(id); changed = true; }
    }
    return changed;
  }
  closeIfMatches(channel: Channel) { if (this.sessions.get(channel.id)?.key === nativeInstrumentKey(channel)) this.close(channel.id); }
  close(id: string) { const session = this.sessions.get(id); if (session) this.disposeSession(session); this.sessions.delete(id); }
  async stop(): Promise<void> { for (const session of this.sessions.values()) this.disposeSession(session); this.sessions.clear(); await Promise.all([...this.closing]); }
  /** Deterministic control-thread pump for real audio integration tests. */
  async flushLive() { await Promise.all([...this.sessions].map(([id, session]) => session.pump(id))); }
}

/** Offline registry collector: the existing scheduler supplies every MIDI event,
 * including arrangement, fractional onsets, swing, arpeggiation and lane mutes.
 * A separate native instance is rendered and its actual PCM scheduled into the
 * existing offline mixer graph BEFORE OfflineAudioContext.startRendering(). */
export class NativeVst3OfflineRender {
  private channels = new Map<string, { channel: Channel; gain: GainNode; events: Array<Vst3Event & { frame: number }> }>();
  private nextId = 1;
  constructor(private context: BaseAudioContext, private frames: number, private bridge = getVst3Bridge()) {}
  render(context: InstrumentVoiceContext): InstrumentVoiceHandle {
    assertVst3Instrument(context.channel.vst3);
    bridgeOrThrow(this.bridge);
    let entry = this.channels.get(context.channel.id);
    if (!entry) {
      if ((this.channels.size + 1) * this.frames * 8 > 128 * 1024 * 1024) throw new Error('VST3 export PCM exceeds the 128 MiB preparation limit; reduce export length or number of native channels.');
      const gain = this.context.createGain();
      gain.gain.value = context.channel.volume;
      gain.connect(context.destination);
      entry = { channel: structuredClone(context.channel), gain, events: [] };
      this.channels.set(context.channel.id, entry);
    }
    if (entry.events.length >= 200000) throw new Error('VST3 export MIDI event limit exceeded');
    const id = this.nextId++, event = midiEvent(context, id);
    const start = Math.round(context.time * this.context.sampleRate);
    const end = Math.max(start + 1, Math.round((context.time + resolveGateSeconds(context.note.duration, context.bpm)) * this.context.sampleRate));
    entry.events.push({ ...event, frame: start });
    const release = { ...event, type: 'off' as const, velocity: 0, frame: end };
    entry.events.push(release);
    return { stop: (time = context.time) => { release.frame = Math.min(release.frame, Math.max(start + 1, Math.round(time * this.context.sampleRate))); } };
  }
  volume(id: string, value: number, time: number) { this.channels.get(id)?.gain.gain.setValueAtTime(Math.max(0, value), time); }
  async flush(bpm: number) {
    const bridge = this.channels.size ? bridgeOrThrow(this.bridge) : this.bridge;
    for (const entry of this.channels.values()) {
      const { id } = await bridge!.open(entry.channel.vst3!, this.context.sampleRate, 'offline');
      try {
        entry.events.sort((a, b) => a.frame - b.frame || (a.type === b.type ? 0 : a.type === 'off' ? -1 : 1));
        let eventIndex = 0;
        for (let cursor = 0; cursor < this.frames; cursor += 16384) {
          const frames = Math.min(16384, this.frames - cursor), events: Vst3Event[] = [];
          while (eventIndex < entry.events.length && entry.events[eventIndex].frame < cursor + frames) {
            const { frame, ...event } = entry.events[eventIndex++];
            if (frame >= cursor) events.push({ ...event, offset: frame - cursor });
          }
          const samples = await bridge!.process(id, frames, events, bpm);
          const source = this.context.createBufferSource();
          source.buffer = pcmBuffer(this.context, samples, frames);
          source.connect(entry.gain);
          source.start(cursor / this.context.sampleRate);
        }
      } finally { await bridge!.close(id); }
    }
  }
  dispose() { for (const entry of this.channels.values()) entry.gain.disconnect(); this.channels.clear(); }
}
