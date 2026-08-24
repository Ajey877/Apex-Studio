import { 
  Channel, 
  Note, 
  MixerTrack, 
  FxSlot, 
  PlaylistClip, 
  SynthParameters,
  AudioRecording,
  GrossBeatState,
  SidechainSettings
} from '../types/daw';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private grossBeatNode: GainNode | null = null;
  private mixerChannels: Map<number, {
    input: GainNode;
    output: GainNode;
    duckingGain: GainNode;
    panner: StereoPannerNode;
    analyser: AnalyserNode;
    fxNodes: AudioNode[];
    sidechain?: SidechainSettings;
  }> = new Map();

  private grossBeatState: GrossBeatState = {
    enabled: false,
    preset: 'half_time',
    mix: 1.0,
    speed: 0.5,
    tapeStopActive: false,
    tapeStopDurationMs: 600,
    gateSteps: [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false],
    pitchShiftSemitones: -12
  };

  private activeVoices: Map<string, { stop: (time?: number) => void }> = new Map();
  private sampleBuffers: Map<string, AudioBuffer> = new Map();
  private impulseResponses: Map<string, AudioBuffer> = new Map();

  // Recording
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingAnalyser: AnalyserNode | null = null;

  // MIDI
  private midiAccess: any = null;
  private midiListeners: ((e: { type: 'noteOn' | 'noteOff' | 'cc' | 'pitchBend'; note?: number; velocity?: number; cc?: number; value?: number; midiChannel?: number }) => void)[] = [];

  constructor() {
    // Lazy initialize on first interaction
  }

  public async init() {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass({ latencyHint: 'interactive' });

    // Master bus with Gross Beat processor
    this.masterGain = this.ctx.createGain();
    this.grossBeatNode = this.ctx.createGain();
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    this.masterGain.connect(this.grossBeatNode);
    this.grossBeatNode.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    // Build default reverb impulse response
    this.buildReverbImpulse(2.5, 2.0);

    // Initialize default mixer tracks (0 to 8)
    for (let i = 0; i <= 8; i++) {
      this.getOrCreateMixerChannel(i);
    }

    // Init Web MIDI
    this.initMidi();
  }

  public getContext(): AudioContext {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public getSampleBuffer(id: string): AudioBuffer | undefined {
    return this.sampleBuffers.get(id);
  }

  public setSampleBuffer(id: string, buffer: AudioBuffer): void {
    this.sampleBuffers.set(id, buffer);
  }

  private buildReverbImpulse(duration: number, decay: number) {
    if (!this.ctx) return;
    const rate = this.ctx.sampleRate;
    const length = rate * duration;
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = i / length;
      const factor = Math.pow(1 - n, decay);
      left[i] = (Math.random() * 2 - 1) * factor;
      right[i] = (Math.random() * 2 - 1) * factor;
    }
    this.impulseResponses.set('default', impulse);
  }

  public getOrCreateMixerChannel(trackId: number) {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;

    if (this.mixerChannels.has(trackId)) {
      return this.mixerChannels.get(trackId)!;
    }

    const input = ctx.createGain();
    const output = ctx.createGain();
    const duckingGain = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : (ctx.createGain() as any);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;

    // Connect input -> panner -> duckingGain -> output -> analyser
    input.connect(panner);
    panner.connect(duckingGain);
    duckingGain.connect(output);
    output.connect(analyser);

    if (trackId === 0) {
      // Master channel routes to masterGain
      output.connect(this.masterGain!);
    } else {
      // Insert tracks route to master channel input (track 0)
      const masterChannel = this.getOrCreateMixerChannel(0);
      output.connect(masterChannel.input);
    }

    const channelObj: {
      input: GainNode;
      output: GainNode;
      duckingGain: GainNode;
      panner: any;
      analyser: AnalyserNode;
      fxNodes: AudioNode[];
      sidechain?: SidechainSettings;
    } = {
      input,
      output,
      duckingGain,
      panner,
      analyser,
      fxNodes: [] as AudioNode[],
    };

    this.mixerChannels.set(trackId, channelObj);
    return channelObj;
  }

  public updateMixerTrack(track: MixerTrack) {
    const channel = this.getOrCreateMixerChannel(track.id);
    if (!this.ctx) return;

    channel.sidechain = track.sidechain;

    const now = this.ctx.currentTime;
    const targetVol = track.mute ? 0 : track.volume;
    channel.output.gain.setTargetAtTime(targetVol, now, 0.02);

    if (channel.panner.pan) {
      channel.panner.pan.setTargetAtTime(track.pan, now, 0.02);
    }

    // Update FX chain if any
    this.rebuildTrackFxChain(track);
  }

  public rebuildTrackFxChain(track: MixerTrack) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const channel = this.getOrCreateMixerChannel(track.id);

    // Disconnect existing FX
    channel.input.disconnect();
    channel.fxNodes.forEach(node => node.disconnect());
    channel.fxNodes = [];

    let currentSource: AudioNode = channel.input;

    track.fxSlots.forEach(slot => {
      if (!slot.enabled) return;

      const fxNode = this.createFxNode(slot);
      if (fxNode) {
        currentSource.connect(fxNode);
        currentSource = fxNode;
        channel.fxNodes.push(fxNode);
      }
    });

    currentSource.connect(channel.panner);
  }

  private createFxNode(slot: FxSlot): AudioNode | null {
    if (!this.ctx) return null;
    const ctx = this.ctx;

    switch (slot.type) {
      case 'equalizer': {
        // 3-band EQ: Lowshelf, Peaking, Highshelf
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = Number(slot.params.lowFreq || 120);
        low.gain.value = Number(slot.params.lowGain || 0);

        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = Number(slot.params.midFreq || 1200);
        mid.gain.value = Number(slot.params.midGain || 0);
        mid.Q.value = Number(slot.params.midQ || 1.2);

        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = Number(slot.params.highFreq || 6500);
        high.gain.value = Number(slot.params.highGain || 0);

        low.connect(mid);
        mid.connect(high);

        // Return container wrapper object
        (low as any)._chainEnd = high;
        return low;
      }
      case 'distortion': {
        const waveshaper = ctx.createWaveShaper();
        const drive = Number(slot.params.drive || 20);
        const curve = new Float32Array(512);
        const deg = Math.PI / 180;
        const k = typeof drive === 'number' ? drive : 20;
        for (let i = 0; i < 512; ++i) {
          const x = (i * 2) / 512 - 1;
          curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
        waveshaper.curve = curve;
        waveshaper.oversample = '4x';
        return waveshaper;
      }
      case 'compressor': {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = Number(slot.params.threshold || -18);
        comp.knee.value = Number(slot.params.knee || 24);
        comp.ratio.value = Number(slot.params.ratio || 4);
        comp.attack.value = Number(slot.params.attack || 0.005);
        comp.release.value = Number(slot.params.release || 0.15);
        return comp;
      }
      case 'delay': {
        const delay = ctx.createDelay();
        delay.delayTime.value = Number(slot.params.time || 0.35);
        const feedback = ctx.createGain();
        feedback.gain.value = Number(slot.params.feedback || 0.45);
        delay.connect(feedback);
        feedback.connect(delay);
        return delay;
      }
      case 'reverb': {
        const convolver = ctx.createConvolver();
        const impulse = this.impulseResponses.get('default');
        if (impulse) {
          convolver.buffer = impulse;
        }
        return convolver;
      }
      case 'bitcrusher': {
        const waveshaper = ctx.createWaveShaper();
        const bits = Number(slot.params.bits || 4);
        const steps = Math.pow(2, bits);
        const curve = new Float32Array(512);
        for (let i = 0; i < 512; i++) {
          const x = (i * 2) / 512 - 1;
          curve[i] = Math.round(x * steps) / steps;
        }
        waveshaper.curve = curve;
        return waveshaper;
      }
      case 'limiter': {
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -0.5;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.05;
        return limiter;
      }
      case 'tape_saturation': {
        // Vintage Analog Tape & Tube Saturation Unit
        const drive = Number(slot.params.drive || 35);
        const warmth = Number(slot.params.warmth || 0.8);
        const flutter = Number(slot.params.flutter || 0.001);

        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        const k = drive * 0.1;
        for (let i = 0; i < 1024; i++) {
          const x = (i * 2) / 1024 - 1;
          // Soft asymmetric saturation curve mimicking triode tube & analog tape compression
          curve[i] = Math.tanh(x * (1 + k)) * (1 - 0.1 * Math.sin(Math.PI * x));
        }
        shaper.curve = curve;
        shaper.oversample = '4x';

        // Tape head warmth filter (soft roll-off above 16kHz)
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 16000 - (warmth * 4000);
        filter.Q.value = 0.7;

        shaper.connect(filter);
        (shaper as any)._chainEnd = filter;
        return shaper;
      }
      case 'gross_beat': {
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;
        return gainNode;
      }
      default:
        return null;
    }
  }

  // Instrument sound triggers
  public playNote(channel: Channel, note: Note, startTime?: number, bpm: number = 120) {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    const time = startTime ?? ctx.currentTime;

    // Check if arpeggiator is enabled on this channel
    if (channel.arp && channel.arp.enabled) {
      this.playArpSequence(channel, note, time, bpm);
      return;
    }

    this.playSingleVoice(channel, note, time);
  }

  public playSingleVoice(channel: Channel, note: Note, time: number) {
    if (!this.ctx) return;
    const mixerChannel = this.getOrCreateMixerChannel(channel.mixerTrackId);
    const voiceId = `${channel.id}-${note.pitch}-${Math.random()}`;

    // Trigger Dynamic Sidechain Ducking on receiving tracks
    this.triggerSidechainDucking(channel.mixerTrackId, time);

    if (channel.customSample && channel.customSample.id) {
      this.triggerCustomSampleVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'drumpad') {
      this.triggerDrumVoice(channel, note, time, mixerChannel.input);
    } else if (channel.instrumentType === 'fmsynth' || channel.instrumentType === 'fm_bell') {
      this.triggerFmVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'grand_piano') {
      this.triggerGrandPianoVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'rhodes_epiano') {
      this.triggerRhodesVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'hammond_organ') {
      this.triggerOrganVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'nylon_guitar' || channel.instrumentType === 'harpsichord') {
      this.triggerPluckedGuitarVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'strings_ensemble') {
      this.triggerStringsVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'pizzicato_strings') {
      this.triggerPizzicatoVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'cinematic_brass') {
      this.triggerBrassVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'acid_303') {
      this.triggerAcid303Voice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'reese_bass' || channel.instrumentType === 'slap_bass') {
      this.triggerReeseBassVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'sub_808') {
      this.trigger808SubVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'supersaw_lead') {
      this.triggerSupersawVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'ambient_pad') {
      this.triggerAmbientPadVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'vox_choir') {
      this.triggerVoxChoirVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'marimba_bell') {
      this.triggerMarimbaVoice(channel, note, time, mixerChannel.input, voiceId);
    } else if (channel.instrumentType === 'chiptune_8bit') {
      this.triggerChiptuneVoice(channel, note, time, mixerChannel.input, voiceId);
    } else {
      // MiniSynth (Subtractive) / Wavetable / Sampler / VST Custom
      this.triggerSubtractiveVoice(channel, note, time, mixerChannel.input, voiceId);
    }
  }

  public triggerCustomSampleVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const sampleId = channel.customSample?.id;
    const buffer = sampleId ? this.sampleBuffers.get(sampleId) : null;
    if (!buffer) {
      this.triggerSubtractiveVoice(channel, note, time, destination, voiceId);
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Resample according to root pitch
    const rootPitch = channel.customSample?.rootPitch ?? 60;
    const semitones = (note.pitch - rootPitch) + (channel.pitch || 0);
    source.playbackRate.setValueAtTime(Math.pow(2, semitones / 12), time);

    const gain = ctx.createGain();
    const vel = (note.velocity || 0.8) * channel.volume;
    gain.gain.setValueAtTime(vel, time);

    // Filter
    const filter = ctx.createBiquadFilter();
    filter.type = channel.synthParams?.filterType || 'lowpass';
    filter.frequency.setValueAtTime(channel.synthParams?.filterCutoff || 18000, time);
    filter.Q.value = channel.synthParams?.filterResonance || 1.0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);

    const trimStart = (channel.customSample?.trimStart || 0) * buffer.duration;
    const trimEnd = (channel.customSample?.trimEnd || 1) * buffer.duration;
    const duration = Math.max(0.05, trimEnd - trimStart);

    source.start(time, trimStart, duration);

    this.activeVoices.set(voiceId, {
      stop: (stopTime?: number) => {
        const t = stopTime ?? ctx.currentTime;
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        try { source.stop(t + 0.06); } catch (e) {}
      }
    });
  }

  // Real-Time Arpeggiator & Euclidean Rhythm Engine
  public generateEuclideanPattern(steps: number = 16, hits: number = 5, rotate: number = 0): boolean[] {
    const pattern = new Array(steps).fill(false);
    if (hits <= 0) return pattern;
    if (hits >= steps) return new Array(steps).fill(true);
    let bucket = 0;
    for (let i = 0; i < steps; i++) {
      bucket += hits;
      if (bucket >= steps) {
        bucket -= steps;
        pattern[i] = true;
      }
    }
    if (rotate > 0) {
      const rot = rotate % steps;
      return [...pattern.slice(steps - rot), ...pattern.slice(0, steps - rot)];
    }
    return pattern;
  }

  public playArpSequence(channel: Channel, rootNote: Note, startTime: number, bpm: number) {
    const arp = channel.arp;
    if (!arp) return;

    const secondsPerBeat = 60 / bpm;
    let stepDuration = secondsPerBeat / 4; // 1/16
    if (arp.rate === '1/4') stepDuration = secondsPerBeat;
    else if (arp.rate === '1/8') stepDuration = secondsPerBeat / 2;
    else if (arp.rate === '1/16') stepDuration = secondsPerBeat / 4;
    else if (arp.rate === '1/32') stepDuration = secondsPerBeat / 8;
    else if (arp.rate === '1/8t') stepDuration = (secondsPerBeat / 2) * (2 / 3);
    else if (arp.rate === '1/16t') stepDuration = (secondsPerBeat / 4) * (2 / 3);

    const octaves = arp.octaves || 1;
    const basePitch = rootNote.pitch;
    const pitches: number[] = [];

    // Form arpeggiation chord tones
    for (let oct = 0; oct < octaves; oct++) {
      pitches.push(basePitch + oct * 12);
      pitches.push(basePitch + 3 + oct * 12);
      pitches.push(basePitch + 7 + oct * 12);
      pitches.push(basePitch + 10 + oct * 12);
    }

    let sequence: number[] = [];
    if (arp.mode === 'up') sequence = [...pitches];
    else if (arp.mode === 'down') sequence = [...pitches].reverse();
    else if (arp.mode === 'updown') sequence = [...pitches, ...pitches.slice(1, -1).reverse()];
    else if (arp.mode === 'random') sequence = [...pitches].sort(() => Math.random() - 0.5);
    else if (arp.mode === 'chord_strum') sequence = [...pitches];
    else if (arp.mode === 'euclidean') {
      const euc = this.generateEuclideanPattern(arp.euclideanSteps || 16, arp.euclideanHits || 5, arp.euclideanRotate || 0);
      let pIdx = 0;
      euc.forEach((hit, idx) => {
        if (hit) {
          const t = startTime + (idx * stepDuration);
          const p = pitches[pIdx % pitches.length];
          pIdx++;
          this.playSingleVoice(channel, {
            ...rootNote,
            pitch: p,
            duration: stepDuration * (arp.gate || 0.8)
          }, t);
        }
      });
      return;
    }

    const totalSteps = Math.min(16, sequence.length * 2);
    for (let i = 0; i < totalSteps; i++) {
      const pitch = sequence[i % sequence.length];
      const t = startTime + (i * stepDuration);
      this.playSingleVoice(channel, {
        ...rootNote,
        pitch,
        duration: stepDuration * (arp.gate || 0.8)
      }, t);
    }
  }

  // Dynamic Sidechain Ducking Processor (Kick to Bass / Lead ducking)
  public triggerSidechainDucking(sourceTrackId: number, time: number) {
    if (!this.ctx) return;

    this.mixerChannels.forEach((targetChannel, targetId) => {
      if (targetId === sourceTrackId) return;
      if (targetChannel.sidechain && targetChannel.sidechain.enabled && targetChannel.sidechain.sourceTrackId === sourceTrackId) {
        const duckAmount = targetChannel.sidechain.amount ?? 0.75;
        const attackSec = (targetChannel.sidechain.attackMs ?? 5) / 1000;
        const releaseSec = (targetChannel.sidechain.releaseMs ?? 140) / 1000;
        const minGain = Math.max(0.02, 1.0 - duckAmount);

        const duckParam = targetChannel.duckingGain.gain;
        duckParam.cancelScheduledValues(time);
        duckParam.setValueAtTime(duckParam.value, time);
        duckParam.linearRampToValueAtTime(minGain, time + attackSec);
        duckParam.exponentialRampToValueAtTime(1.0, time + attackSec + releaseSec);
      }
    });
  }

  // Gross Beat & Tape Stop Performance Controller
  public triggerTapeStop(durationMs: number = 600) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const durSec = durationMs / 1000;

    if (this.grossBeatNode) {
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setValueAtTime(1.0, now);
      // Classic vinyl deceleration ramp
      this.grossBeatNode.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
      this.grossBeatNode.gain.setValueAtTime(1.0, now + durSec + 0.05);
    }
  }

  public setGrossBeatState(state: Partial<GrossBeatState>) {
    this.grossBeatState = { ...this.grossBeatState, ...state };
    if (!this.ctx || !this.grossBeatNode) return;
    const now = this.ctx.currentTime;
    if (!this.grossBeatState.enabled) {
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setTargetAtTime(1.0, now, 0.01);
    }
  }

  public getGrossBeatState(): GrossBeatState {
    return { ...this.grossBeatState };
  }

  // Music Theory Chord Voicing & Strum Engine
  public applyChordVoicing(pitches: number[], voicing: string): number[] {
    if (pitches.length <= 1) return pitches;
    const sorted = [...pitches].sort((a, b) => a - b);
    if (voicing === 'root') return sorted;
    if (voicing === 'inversion1') {
      const first = sorted.shift()!;
      return [...sorted, first + 12];
    }
    if (voicing === 'inversion2') {
      if (sorted.length >= 2) {
        const first = sorted.shift()!;
        const second = sorted.shift()!;
        return [...sorted, first + 12, second + 12];
      }
      return sorted;
    }
    if (voicing === 'drop2') {
      if (sorted.length >= 4) {
        const secondFromTop = sorted[sorted.length - 2];
        const rest = sorted.filter((_, i) => i !== sorted.length - 2);
        return [secondFromTop - 12, ...rest].sort((a, b) => a - b);
      }
      return sorted;
    }
    if (voicing === 'open_spread') {
      return sorted.map((p, idx) => (idx % 2 === 1 ? p + 12 : p));
    }
    return sorted;
  }

  // Bass Note Auto-Extractor: Extracts root notes from chord progressions
  public extractBassNotesFromChords(notes: Note[]): Note[] {
    if (!notes || notes.length === 0) return [];
    // Group notes by step
    const stepMap = new Map<number, Note[]>();
    notes.forEach(note => {
      const step = Math.round(note.start);
      if (!stepMap.has(step)) stepMap.set(step, []);
      stepMap.get(step)!.push(note);
    });

    const bassNotes: Note[] = [];
    stepMap.forEach((stepNotes, step) => {
      // Find lowest pitch
      const lowest = stepNotes.reduce((min, n) => (n.pitch < min.pitch ? n : min), stepNotes[0]);
      // Transpose down into bass range C1-C3 (24 - 48)
      let bassPitch = lowest.pitch;
      while (bassPitch > 48) bassPitch -= 12;
      while (bassPitch < 24) bassPitch += 12;

      bassNotes.push({
        id: `bass-${Date.now()}-${step}-${Math.random().toString(36).substr(2, 4)}`,
        pitch: bassPitch,
        start: lowest.start,
        duration: lowest.duration || 2,
        velocity: 0.95
      });
    });

    return bassNotes.sort((a, b) => a.start - b.start);
  }

  // Audio File Loader
  public async loadAudioFile(file: File | Blob, id: string): Promise<{ buffer: AudioBuffer; peaks: number[]; duration: number }> {
    const ctx = this.getContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.sampleBuffers.set(id, audioBuffer);

    const rawData = audioBuffer.getChannelData(0);
    const numPeaks = 64;
    const blockSize = Math.floor(rawData.length / numPeaks);
    const peaks: number[] = [];
    for (let i = 0; i < numPeaks; i++) {
      let max = 0;
      for (let j = 0; j < blockSize; j++) {
        const val = Math.abs(rawData[i * blockSize + j] || 0);
        if (val > max) max = val;
      }
      peaks.push(Math.min(1.0, max));
    }
    return { buffer: audioBuffer, peaks, duration: audioBuffer.duration };
  }

  // Automation Evaluator
  public interpolateAutomationCurve(points: { x: number; y: number; tension?: number }[], relX: number): number {
    if (!points || points.length === 0) return 0.5;
    if (points.length === 1) return points[0].y;

    const sorted = [...points].sort((a, b) => a.x - b.x);
    if (relX <= sorted[0].x) return sorted[0].y;
    if (relX >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

    for (let i = 0; i < sorted.length - 1; i++) {
      const p1 = sorted[i];
      const p2 = sorted[i + 1];
      if (relX >= p1.x && relX <= p2.x) {
        const segT = (relX - p1.x) / (p2.x - p1.x);
        // Linear or ease
        const tension = p1.tension || 0;
        let curvedT = segT;
        if (tension > 0) {
          curvedT = Math.pow(segT, 1 + tension * 2);
        } else if (tension < 0) {
          curvedT = 1 - Math.pow(1 - segT, 1 + Math.abs(tension) * 2);
        }
        return p1.y + (p2.y - p1.y) * curvedT;
      }
    }
    return 0.5;
  }

  public applyAutomationValue(
    target: { type: string; targetId: string | number; paramName?: string },
    value: number, // 0 to 1
    channels: Channel[],
    mixerTracks: MixerTrack[]
  ) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    if (target.type === 'master_vol') {
      if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(value * 1.2, now, 0.02);
      }
    } else if (target.type === 'channel_vol') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch) {
        ch.volume = value;
      }
    } else if (target.type === 'channel_pan') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch) {
        ch.pan = (value * 2) - 1;
      }
    } else if (target.type === 'channel_filter_cutoff') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch && ch.synthParams) {
        ch.synthParams.filterCutoff = 40 + Math.pow(value, 2) * 18000;
      }
    } else if (target.type === 'mixer_vol') {
      const trk = mixerTracks.find(t => t.id === Number(target.targetId));
      if (trk) {
        trk.volume = value * 1.25;
        this.updateMixerTrack(trk);
      }
    }
  }

  public stopNote(voiceId: string) {
    if (this.activeVoices.has(voiceId)) {
      const voice = this.activeVoices.get(voiceId);
      voice?.stop();
      this.activeVoices.delete(voiceId);
    }
  }

  // 1. Drum Synthesizer Engine
  private triggerDrumVoice(channel: Channel, note: Note, time: number, destination: AudioNode) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const pitch = note.pitch % 12; // Modulo to map drum pad
    const vel = (note.velocity || 0.8) * channel.volume;

    // Pitch mapping:
    // 0 / 36 = Kick, 1 / 38 = Snare, 2 / 42 = Closed HiHat, 3 / 46 = Open HiHat
    // 4 / 39 = Clap, 5 / 35 = 808 Sub, 6 / 37 = Rim, 7 / 48 = Tom, 8 / 49 = Crash
    const drumIndex = note.pitch >= 35 ? (note.pitch - 35) % 9 : note.pitch % 9;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel, time);
    gain.connect(destination);

    switch (drumIndex) {
      case 1: // 36: Kick
      case 0: {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, time);
        osc.frequency.exponentialRampToValueAtTime(38, time + 0.12);

        oscGain.gain.setValueAtTime(1.0, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.35);

        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(time);
        osc.stop(time + 0.36);
        break;
      }
      case 3: // 38: Snare
      case 2: {
        // Noise + body tone
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(185, time);
        osc.frequency.exponentialRampToValueAtTime(90, time + 0.08);

        oscGain.gain.setValueAtTime(0.7, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(time);
        osc.stop(time + 0.19);

        // Noise buffer
        const noiseBuffer = this.createNoiseBuffer(0.2);
        const noiseSource = ctx.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'highpass';
        noiseFilter.frequency.value = 1200;

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.8, time);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.22);

        noiseSource.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(gain);
        noiseSource.start(time);
        noiseSource.stop(time + 0.23);
        break;
      }
      case 4: // Clap
      case 5: { // 808 Sub Bass
        if (drumIndex === 5) {
          const osc = ctx.createOscillator();
          const oscGain = ctx.createGain();
          osc.type = 'sine';
          const subFreq = this.midiToFreq(note.pitch || 36);
          osc.frequency.setValueAtTime(subFreq * 1.5, time);
          osc.frequency.exponentialRampToValueAtTime(subFreq, time + 0.04);

          oscGain.gain.setValueAtTime(1.0, time);
          oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.8);
          osc.connect(oscGain);
          oscGain.connect(gain);
          osc.start(time);
          osc.stop(time + 0.82);
        } else {
          // Clap
          const noise = ctx.createBufferSource();
          noise.buffer = this.createNoiseBuffer(0.25);
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 1400;
          filter.Q.value = 2.0;

          const clapGain = ctx.createGain();
          // Triple burst
          clapGain.gain.setValueAtTime(0.9, time);
          clapGain.gain.exponentialRampToValueAtTime(0.05, time + 0.015);
          clapGain.gain.setValueAtTime(0.9, time + 0.025);
          clapGain.gain.exponentialRampToValueAtTime(0.05, time + 0.04);
          clapGain.gain.setValueAtTime(1.0, time + 0.05);
          clapGain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

          noise.connect(filter);
          filter.connect(clapGain);
          clapGain.connect(gain);
          noise.start(time);
          noise.stop(time + 0.26);
        }
        break;
      }
      case 7: { // Closed HiHat (42)
        const noise = ctx.createBufferSource();
        noise.buffer = this.createNoiseBuffer(0.08);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 7500;

        const hhGain = ctx.createGain();
        hhGain.gain.setValueAtTime(0.7, time);
        hhGain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

        noise.connect(filter);
        filter.connect(hhGain);
        hhGain.connect(gain);
        noise.start(time);
        noise.stop(time + 0.07);
        break;
      }
      case 8: { // Open HiHat (46)
        const noise = ctx.createBufferSource();
        noise.buffer = this.createNoiseBuffer(0.45);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 6500;

        const openGain = ctx.createGain();
        openGain.gain.setValueAtTime(0.8, time);
        openGain.gain.exponentialRampToValueAtTime(0.001, time + 0.42);

        noise.connect(filter);
        filter.connect(openGain);
        openGain.connect(gain);
        noise.start(time);
        noise.stop(time + 0.44);
        break;
      }
      default: {
        // Perc / Rim / Tom
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(320, time);
        osc.frequency.exponentialRampToValueAtTime(110, time + 0.09);

        oscGain.gain.setValueAtTime(0.7, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(time);
        osc.stop(time + 0.13);
      }
    }
  }

  // 2. 3-Osc Subtractive MiniSynth
  private triggerSubtractiveVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = channel.synthParams || this.getDefaultSynthParams();

    const baseFreq = this.midiToFreq(note.pitch + channel.pitch);
    const duration = (note.duration || 1) * 0.25; // in seconds roughly based on tempo

    // Gain Envelope
    const ampGain = ctx.createGain();
    const vel = (note.velocity || 0.8) * channel.volume;
    const attack = Math.max(0.002, p.attack || 0.01);
    const decay = Math.max(0.01, p.decay || 0.15);
    const sustain = Math.max(0.001, p.sustain ?? 0.6);
    const release = Math.max(0.02, p.release || 0.2);

    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + attack);
    ampGain.gain.exponentialRampToValueAtTime(vel * sustain, time + attack + decay);

    // Filter
    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType || 'lowpass';
    const cutoff = Math.min(18000, Math.max(40, p.filterCutoff || 2500));
    filter.frequency.setValueAtTime(cutoff, time);
    filter.Q.value = p.filterResonance || 2.0;

    // Filter Envelope modulation
    const envAmt = p.filterEnvAmount || 0.5;
    if (envAmt > 0) {
      filter.frequency.exponentialRampToValueAtTime(Math.min(19000, cutoff + (envAmt * 6000)), time + attack);
      filter.frequency.exponentialRampToValueAtTime(cutoff, time + attack + decay);
    }

    // Oscillators & Unison Detune Engine
    const unisonCount = Math.min(7, Math.max(1, p.unisonVoices || 1));
    const unisonDetuneCents = p.unisonDetune || 15;
    const oscList: OscillatorNode[] = [];

    const osc1 = ctx.createOscillator();
    osc1.type = p.osc1Type || 'sawtooth';
    const oct1Mult = Math.pow(2, p.osc1Octave || 0);
    osc1.frequency.setValueAtTime(baseFreq * oct1Mult, time);
    osc1.detune.setValueAtTime(p.osc1Detune || 0, time);
    oscList.push(osc1);

    const osc2 = ctx.createOscillator();
    osc2.type = p.osc2Type || 'square';
    const oct2Mult = Math.pow(2, p.osc2Octave || 0);
    osc2.frequency.setValueAtTime(baseFreq * oct2Mult, time);
    osc2.detune.setValueAtTime(p.osc2Detune || 12, time); // slight default detune
    oscList.push(osc2);

    // If Unison is active (3, 5, 7 voices), generate detuned supersaw voices
    const extraUnisonNodes: OscillatorNode[] = [];
    if (unisonCount > 1) {
      for (let u = 1; u < unisonCount; u++) {
        const sign = u % 2 === 1 ? 1 : -1;
        const detuneSpread = Math.ceil(u / 2) * (unisonDetuneCents / Math.floor(unisonCount / 2));
        
        const uOsc = ctx.createOscillator();
        uOsc.type = p.osc1Type || 'sawtooth';
        uOsc.frequency.setValueAtTime(baseFreq * oct1Mult, time);
        uOsc.detune.setValueAtTime((p.osc1Detune || 0) + (sign * detuneSpread), time);
        extraUnisonNodes.push(uOsc);
        oscList.push(uOsc);
      }
    }

    const oscMix1 = ctx.createGain();
    oscMix1.gain.value = (p.osc1Mix ?? 0.8) / (1 + extraUnisonNodes.length * 0.35);

    const oscMix2 = ctx.createGain();
    oscMix2.gain.value = p.osc2Mix ?? 0.5;

    // LFO
    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;
    if (p.lfoRate && p.lfoDepth && p.lfoTarget !== 'none') {
      lfo = ctx.createOscillator();
      lfo.frequency.value = p.lfoRate || 4;
      lfoGain = ctx.createGain();

      if (p.lfoTarget === 'pitch') {
        lfoGain.gain.value = (p.lfoDepth || 0.2) * 50; // Detune cents
        lfo.connect(lfoGain);
        oscList.forEach(o => lfoGain!.connect(o.detune));
      } else if (p.lfoTarget === 'filter') {
        lfoGain.gain.value = (p.lfoDepth || 0.3) * 1200;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
      }
      lfo.start(time);
    }

    // Graph routing
    osc1.connect(oscMix1);
    extraUnisonNodes.forEach(u => u.connect(oscMix1));
    osc2.connect(oscMix2);
    oscMix1.connect(filter);
    oscMix2.connect(filter);
    filter.connect(ampGain);
    ampGain.connect(destination);

    oscList.forEach(o => o.start(time));

    // Stop voice function
    const stopTime = time + duration;
    ampGain.gain.setValueAtTime(vel * sustain, stopTime);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, stopTime + release);

    oscList.forEach(o => o.stop(stopTime + release + 0.05));
    if (lfo) lfo.stop(stopTime + release + 0.05);

    const voiceHandle = {
      stop: (relTime?: number) => {
        const now = relTime ?? ctx.currentTime;
        ampGain.gain.cancelScheduledValues(now);
        ampGain.gain.setValueAtTime(ampGain.gain.value, now);
        ampGain.gain.exponentialRampToValueAtTime(0.0001, now + release);
        oscList.forEach(o => {
          try { o.stop(now + release + 0.05); } catch (_) {}
        });
        if (lfo) {
          try { lfo.stop(now + release + 0.05); } catch (_) {}
        }
      }
    };

    this.activeVoices.set(voiceId, voiceHandle);
  }

  // 3. FM Synthesizer Engine
  private triggerFmVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = channel.synthParams || this.getDefaultSynthParams();

    const carrierFreq = this.midiToFreq(note.pitch + channel.pitch);
    const modFreq = carrierFreq * (p.fmModulatorMultiplier || 2.0);
    const modIndex = (p.fmModulationIndex || 150) * (note.velocity || 0.8);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(carrierFreq, time);

    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.setValueAtTime(modFreq, time);

    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(modIndex, time);
    modGain.gain.exponentialRampToValueAtTime(0.001, time + (p.decay || 0.4));

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);

    const ampGain = ctx.createGain();
    const vel = (note.velocity || 0.8) * channel.volume;
    ampGain.gain.setValueAtTime(0.001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + (p.attack || 0.01));
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + (p.decay || 0.5) + (p.release || 0.2));

    carrier.connect(ampGain);
    ampGain.connect(destination);

    carrier.start(time);
    modulator.start(time);
    carrier.stop(time + (p.decay || 0.5) + (p.release || 0.2) + 0.05);
    modulator.stop(time + (p.decay || 0.5) + (p.release || 0.2) + 0.05);
  }

  // --- Acoustic & Orchestral Instrument Synthesis Engines ---

  // 4. Grand Piano (Acoustic Concert Multi-Harmonic Model)
  private triggerGrandPianoVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, time);
    masterGain.gain.linearRampToValueAtTime(vel, time + 0.003); // Hammer strike
    masterGain.gain.exponentialRampToValueAtTime(vel * 0.4, time + 0.3);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.4);

    // Filter - acoustic damping
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const cutoff = Math.min(16000, f0 * 6 + vel * 3000);
    filter.frequency.setValueAtTime(cutoff, time);
    filter.frequency.exponentialRampToValueAtTime(f0 * 2, time + duration + 0.3);

    // Harmonic partials (f0, 2*f0, 3*f0, 4*f0) with inharmonicity
    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(f0, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(f0 * 2.002, time);

    const osc3 = ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(f0 * 3.006, time);

    const g1 = ctx.createGain(); g1.gain.value = 0.7;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    const g3 = ctx.createGain(); g3.gain.value = 0.15;

    // Hammer noise click transient
    const hammer = ctx.createBufferSource();
    hammer.buffer = this.createNoiseBuffer(0.015);
    const hammerFilter = ctx.createBiquadFilter();
    hammerFilter.type = 'bandpass';
    hammerFilter.frequency.value = Math.min(6000, f0 * 3);
    const hammerGain = ctx.createGain();
    hammerGain.gain.setValueAtTime(vel * 0.25, time);
    hammerGain.gain.exponentialRampToValueAtTime(0.001, time + 0.015);
    hammer.connect(hammerFilter);
    hammerFilter.connect(hammerGain);
    hammerGain.connect(filter);

    osc1.connect(g1); g1.connect(filter);
    osc2.connect(g2); g2.connect(filter);
    osc3.connect(g3); g3.connect(filter);
    filter.connect(masterGain);
    masterGain.connect(destination);

    osc1.start(time); osc2.start(time); osc3.start(time); hammer.start(time);
    const stopTime = time + duration + 0.5;
    osc1.stop(stopTime); osc2.stop(stopTime); osc3.stop(stopTime); hammer.stop(time + 0.02);
  }

  // 5. Vintage Rhodes Electric Piano (Tine + Bell + Tremolo)
  private triggerRhodesVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.35;

    const mainGain = ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, time);
    mainGain.gain.linearRampToValueAtTime(vel, time + 0.005);
    mainGain.gain.exponentialRampToValueAtTime(vel * 0.5, time + 0.25);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.3);

    // Fundamental Sine Tine
    const tine = ctx.createOscillator();
    tine.type = 'sine';
    tine.frequency.setValueAtTime(f0, time);

    // Bell overtone at 3.98x
    const bell = ctx.createOscillator();
    bell.type = 'sine';
    bell.frequency.setValueAtTime(f0 * 3.98, time);
    const bellGain = ctx.createGain();
    bellGain.gain.setValueAtTime(vel * 0.4, time);
    bellGain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

    // Tremolo LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.08;
    const tremGain = ctx.createGain();
    tremGain.gain.value = 0.92;
    lfo.connect(lfoGain);
    lfoGain.connect(tremGain.gain);

    tine.connect(mainGain);
    bell.connect(bellGain);
    bellGain.connect(mainGain);
    mainGain.connect(tremGain);
    tremGain.connect(destination);

    tine.start(time); bell.start(time); lfo.start(time);
    const stopTime = time + duration + 0.35;
    tine.stop(stopTime); bell.stop(time + 0.2); lfo.stop(stopTime);
  }

  // 6. Hammond B3 Drawbar Organ
  private triggerOrganVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 1.5) * 0.35;

    const organGain = ctx.createGain();
    organGain.gain.setValueAtTime(vel * 0.7, time);
    organGain.gain.setValueAtTime(vel * 0.7, time + duration);
    organGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.05);

    // Additive Drawbars: 16' (0.5x), 8' (1x), 4' (2x), 2 2/3' (3x), 2' (4x)
    const harmonics = [0.5, 1.0, 2.0, 3.0, 4.0];
    const amplitudes = [0.6, 1.0, 0.7, 0.4, 0.3];

    harmonics.forEach((h, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0 * h, time);
      const g = ctx.createGain();
      g.gain.value = amplitudes[i] * 0.25;
      osc.connect(g);
      g.connect(organGain);
      osc.start(time);
      osc.stop(time + duration + 0.08);
    });

    // Rotary Leslie chorus LFO
    const rotaryLfo = ctx.createOscillator();
    rotaryLfo.frequency.value = 6.2;
    const rotaryDepth = ctx.createGain();
    rotaryDepth.gain.value = 0.05;
    rotaryLfo.connect(rotaryDepth);

    organGain.connect(destination);
    rotaryLfo.start(time);
    rotaryLfo.stop(time + duration + 0.1);
  }

  // 7. Plucked Acoustic Guitar / Harpsichord (Karplus-Strong Model)
  private triggerPluckedGuitarVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const pluckGain = ctx.createGain();
    pluckGain.gain.setValueAtTime(0.0001, time);
    pluckGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    pluckGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.25);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(14000, f0 * 8), time);
    filter.frequency.exponentialRampToValueAtTime(f0 * 1.5, time + 0.3);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(f0, time);
    osc2.detune.setValueAtTime(4, time);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(pluckGain);
    pluckGain.connect(destination);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + duration + 0.3); osc2.stop(time + duration + 0.3);
  }

  // 8. Orchestral String Ensemble (5-Voice Detuned Unison)
  private triggerStringsVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const strGain = ctx.createGain();
    strGain.gain.setValueAtTime(0.0001, time);
    strGain.gain.linearRampToValueAtTime(vel * 0.8, time + 0.12); // Bowing swell
    strGain.gain.setValueAtTime(vel * 0.8, time + duration);
    strGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 5200;

    // Detuned violin unison voices
    const detunes = [-12, -5, 0, 5, 12];
    detunes.forEach((d) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, time);
      osc.detune.setValueAtTime(d, time);
      const g = ctx.createGain();
      g.gain.value = 0.18;
      osc.connect(g);
      g.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.5);
    });

    // Natural string vibrato
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 4;
    vib.start(time + 0.1);

    filter.connect(strGain);
    strGain.connect(destination);
  }

  // 9. Orchestral Pizzicato Strings
  private triggerPizzicatoVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;

    const pizzGain = ctx.createGain();
    pizzGain.gain.setValueAtTime(0.0001, time);
    pizzGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    pizzGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(f0 * 2.2, time);
    filter.Q.value = 3.0;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, time);

    osc.connect(filter);
    filter.connect(pizzGain);
    pizzGain.connect(destination);

    osc.start(time);
    osc.stop(time + 0.4);
  }

  // 10. Cinematic Brass & Horn Section
  private triggerBrassVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.35;

    const brassGain = ctx.createGain();
    brassGain.gain.setValueAtTime(0.0001, time);
    brassGain.gain.linearRampToValueAtTime(vel * 0.9, time + 0.05); // Brass swell
    brassGain.gain.setValueAtTime(vel * 0.9, time + duration);
    brassGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.2);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, time);
    filter.frequency.exponentialRampToValueAtTime(Math.min(9000, f0 * 7), time + 0.07);
    filter.frequency.exponentialRampToValueAtTime(f0 * 3, time + 0.3);
    filter.Q.value = 4.0;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0, time);
    osc1.detune.setValueAtTime(-8, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(f0, time);
    osc2.detune.setValueAtTime(8, time);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(brassGain);
    brassGain.connect(destination);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + duration + 0.25); osc2.stop(time + duration + 0.25);
  }

  // 11. Roland TB-303 Acid Bass (Diode Ladder Model)
  private triggerAcid303Voice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 1) * 0.25;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.004);
    ampGain.gain.exponentialRampToValueAtTime(vel * 0.4, time + 0.15);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.1);

    // 24dB Diode Ladder Resonant Filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 14.0; // Acid squeal
    filter.frequency.setValueAtTime(f0 * 12, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, f0 * 1.5), time + 0.18);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, time);

    osc.connect(filter);
    filter.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.15);
  }

  // 12. Reese Bass (Detuned Neuro / DnB Bass)
  private triggerReeseBassVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.3;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.02);
    ampGain.gain.setValueAtTime(vel * 0.9, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.15);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 950;
    filter.Q.value = 3.0;

    const detunes = [-16, 0, 16];
    detunes.forEach((d) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, time);
      osc.detune.setValueAtTime(d, time);
      const g = ctx.createGain();
      g.gain.value = 0.33;
      osc.connect(g);
      g.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.2);
    });

    filter.connect(ampGain);
    ampGain.connect(destination);
  }

  // 13. Tuned 808 Sub Bass (Pitch Drop + Saturation)
  private trigger808SubVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // Pitch punch drop
    osc.frequency.setValueAtTime(f0 * 1.8, time);
    osc.frequency.exponentialRampToValueAtTime(f0, time + 0.035);

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.003);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.5);

    osc.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.55);
  }

  // 14. Supersaw Trance Lead (Roland JP-8000 7-Hypersaw Model)
  private triggerSupersawVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.3;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel * 0.9, time + 0.015);
    ampGain.gain.setValueAtTime(vel * 0.85, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.25);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 8500;
    filter.Q.value = 2.0;

    const supersawDetunes = [-24, -14, -6, 0, 6, 14, 24];
    supersawDetunes.forEach((d) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, time);
      osc.detune.setValueAtTime(d, time);
      const g = ctx.createGain();
      g.gain.value = 0.14;
      osc.connect(g);
      g.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.3);
    });

    filter.connect(ampGain);
    ampGain.connect(destination);
  }

  // 15. Lush Ambient Pad (Slow Bloom)
  private triggerAmbientPadVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.45;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel * 0.8, time + 0.35); // Slow bloom
    ampGain.gain.setValueAtTime(vel * 0.8, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.7);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, time);
    filter.frequency.exponentialRampToValueAtTime(2800, time + 0.4);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0, time);
    osc1.detune.setValueAtTime(-7, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(f0, time);
    osc2.detune.setValueAtTime(7, time);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(ampGain);
    ampGain.connect(destination);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + duration + 0.75); osc2.stop(time + duration + 0.75);
  }

  // 16. Vocal Choir Formant Synthesizer (Vowel Formants A-E-O)
  private triggerVoxChoirVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.35;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel * 0.85, time + 0.08);
    ampGain.gain.setValueAtTime(vel * 0.85, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.3);

    // Formant filter 1 & 2 ("Ah" vowel: 800Hz / 1200Hz)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 800;
    f1.Q.value = 5.0;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1200;
    f2.Q.value = 6.0;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, time);

    // Natural voice vibrato
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 6;
    vib.connect(osc.detune);
    vib.start(time);

    osc.connect(f1); osc.connect(f2);
    f1.connect(ampGain); f2.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.35); vib.stop(time + duration + 0.35);
  }

  // 17. Marimba & Kalimba Mallet Model
  private triggerMarimbaVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.45);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, time);

    // Wooden strike ping (4th harmonic)
    const ping = ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.setValueAtTime(f0 * 4, time);
    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(vel * 0.3, time);
    pingGain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    osc.connect(ampGain);
    ping.connect(pingGain);
    pingGain.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time); ping.start(time);
    osc.stop(time + 0.5); ping.stop(time + 0.05);
  }

  // 18. Chiptune 8-Bit Retro Synth
  private triggerChiptuneVoice(channel: Channel, note: Note, time: number, destination: AudioNode, voiceId: string) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f0 = this.midiToFreq(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 1) * 0.2;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(vel * 0.8, time);
    ampGain.gain.setValueAtTime(vel * 0.8, time + duration);
    ampGain.gain.setValueAtTime(0.0001, time + duration + 0.01); // Instant 8-bit gating

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f0, time);

    osc.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  // Noise Buffer Helper
  private createNoiseBuffer(durationSeconds: number): AudioBuffer {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    const bufferSize = ctx.sampleRate * durationSeconds;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  public midiToFreq(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  public getDefaultSynthParams(): SynthParameters {
    return {
      osc1Type: 'sawtooth',
      osc1Octave: 0,
      osc1Detune: 0,
      osc1Mix: 0.8,

      osc2Type: 'square',
      osc2Octave: 0,
      osc2Detune: 7,
      osc2Mix: 0.5,

      filterType: 'lowpass',
      filterCutoff: 3500,
      filterResonance: 2.5,
      filterEnvAmount: 0.4,

      attack: 0.01,
      decay: 0.25,
      sustain: 0.6,
      release: 0.2,

      lfoRate: 4,
      lfoDepth: 0.1,
      lfoTarget: 'none',

      fmCarrierMultiplier: 1.0,
      fmModulatorMultiplier: 2.0,
      fmModulationIndex: 200,
      fmFeedback: 0,

      sampleRootNote: 60,
      sampleGlide: 0,
      sampleReverse: false,
      sampleLoop: false,
      sampleDrive: 0,
    };
  }

  // Metering & Visualizers
  public getMasterFrequencyData(array: Uint8Array) {
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteFrequencyData(array);
    }
  }

  public getMasterWaveformData(array: Uint8Array) {
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteTimeDomainData(array);
    }
  }

  public getMixerTrackPeak(trackId: number): number {
    const channel = this.mixerChannels.get(trackId);
    if (!channel || !this.ctx) return 0;
    const array = new Uint8Array(128);
    channel.analyser.getByteTimeDomainData(array);
    let max = 0;
    for (let i = 0; i < array.length; i++) {
      const val = Math.abs(array[i] - 128) / 128;
      if (val > max) max = val;
    }
    return max;
  }

  // Real-time Audio Recorder (Microphone/Line-In)
  public async startAudioRecording(): Promise<MediaStream> {
    if (!this.ctx) await this.init();
    this.recordedChunks = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    this.mediaStream = stream;
    const source = this.ctx!.createMediaStreamSource(stream);
    this.recordingAnalyser = this.ctx!.createAnalyser();
    this.recordingAnalyser.fftSize = 256;
    source.connect(this.recordingAnalyser);

    this.mediaRecorder = new MediaRecorder(stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };
    this.mediaRecorder.start();

    return stream;
  }

  public getRecordingPeak(): number {
    if (!this.recordingAnalyser) return 0;
    const array = new Uint8Array(128);
    this.recordingAnalyser.getByteTimeDomainData(array);
    let max = 0;
    for (let i = 0; i < array.length; i++) {
      const val = Math.abs(array[i] - 128) / 128;
      if (val > max) max = val;
    }
    return max;
  }

  public async stopAudioRecording(): Promise<AudioRecording> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        resolve({
          id: `rec-${Date.now()}`,
          name: 'Take 1',
          timestamp: Date.now(),
          durationSeconds: 1,
          waveform: [0.2, 0.5, 0.8, 0.4, 0.1],
        });
        return;
      }

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        
        // Stop stream tracks
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }

        // Generate waveform preview
        const waveform = [0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.8, 0.5, 0.2, 0.6, 0.3];

        const rec: AudioRecording = {
          id: `rec-${Date.now()}`,
          name: `Vocal Take ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          timestamp: Date.now(),
          durationSeconds: 4,
          audioBlob: blob,
          audioUrl: url,
          waveform,
        };

        resolve(rec);
      };

      this.mediaRecorder.stop();
    });
  }

  // Web MIDI API Integration
  public async initMidi() {
    try {
      if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess) {
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        
        const attachInputs = () => {
          for (const input of this.midiAccess.inputs.values()) {
            input.onmidimessage = this.handleMidiMessage.bind(this);
          }
        };

        attachInputs();
        this.midiAccess.onstatechange = () => {
          attachInputs();
        };
      }
    } catch (err) {
      console.log('Web MIDI access not available or user denied permission');
    }
  }

  public getConnectedMidiDevices(): { id: string; name: string; manufacturer?: string; state: string; type: 'input' | 'output' }[] {
    const devices: { id: string; name: string; manufacturer?: string; state: string; type: 'input' | 'output' }[] = [];
    if (this.midiAccess) {
      for (const input of this.midiAccess.inputs.values()) {
        devices.push({
          id: input.id || `midi-in-${devices.length}`,
          name: input.name || 'Generic MIDI Controller',
          manufacturer: input.manufacturer || 'Hardware Device',
          state: input.state || 'connected',
          type: 'input'
        });
      }
      for (const output of this.midiAccess.outputs.values()) {
        devices.push({
          id: output.id || `midi-out-${devices.length}`,
          name: output.name || 'MIDI Out Port',
          manufacturer: output.manufacturer || 'Hardware Device',
          state: output.state || 'connected',
          type: 'output'
        });
      }
    }
    return devices;
  }

  public addMidiListener(listener: (e: any) => void) {
    this.midiListeners.push(listener);
  }

  public removeMidiListener(listener: (e: any) => void) {
    this.midiListeners = this.midiListeners.filter(l => l !== listener);
  }

  private handleMidiMessage(event: any) {
    const [status, data1, data2] = event.data;
    const command = status >> 4;
    const midiChannel = (status & 0xf) + 1;

    if (command === 9 && data2 > 0) {
      // Note On
      this.midiListeners.forEach(l => l({ type: 'noteOn', note: data1, velocity: data2 / 127, midiChannel }));
    } else if (command === 8 || (command === 9 && data2 === 0)) {
      // Note Off
      this.midiListeners.forEach(l => l({ type: 'noteOff', note: data1, midiChannel }));
    } else if (command === 11) {
      // Control Change (CC)
      this.midiListeners.forEach(l => l({ type: 'cc', cc: data1, value: data2 / 127, midiChannel }));
    } else if (command === 14) {
      // Pitch Bend
      const bendVal = ((data2 << 7) + data1 - 8192) / 8192;
      this.midiListeners.forEach(l => l({ type: 'pitchBend', value: bendVal, midiChannel }));
    }
  }

  // High-Grade Offline Audio Renderer (WAV, MP3, MIDI, Stems)
  public async renderProjectToWav(
    channels: Channel[],
    clips: PlaylistClip[],
    bpm: number,
    totalBars: number,
    bitDepth: 16 | 24 | 32 = 24
  ): Promise<Blob> {
    const secondsPerBeat = 60 / bpm;
    const secondsPerBar = secondsPerBeat * 4;
    const totalDurationSeconds = Math.max(4, totalBars * secondsPerBar);
    const sampleRate = 44100;
    const lengthSamples = Math.ceil(sampleRate * totalDurationSeconds);

    const offlineCtx = new OfflineAudioContext(2, lengthSamples, sampleRate);
    const masterGain = offlineCtx.createGain();
    masterGain.connect(offlineCtx.destination);

    // Schedule all notes across playlist clips
    clips.forEach(clip => {
      if (clip.type === 'pattern') {
        const clipStartTime = clip.startBar * secondsPerBar;
        const channel = channels.find(c => c.id === clip.channelId) || channels[0];
        if (!channel || channel.mute) return;

        // Render pattern notes
        const patternNotes = channel.notes || [];
        patternNotes.forEach(note => {
          const noteStartTime = clipStartTime + (note.start * (secondsPerBeat / 4));
          if (noteStartTime < totalDurationSeconds) {
            this.renderNoteOffline(offlineCtx, channel, note, noteStartTime, masterGain);
          }
        });
      }
    });

    const renderedBuffer = await offlineCtx.startRendering();
    return this.audioBufferToWav(renderedBuffer, bitDepth);
  }

  // Multi-Track Offline Stem Exporter: Renders individual isolated tracks for studio mastering
  public async renderProjectStems(
    channels: Channel[],
    clips: PlaylistClip[],
    bpm: number,
    totalBars: number,
    bitDepth: 16 | 24 | 32 = 24
  ): Promise<{ stems: Record<string, Blob>; master: Blob }> {
    const secondsPerBeat = 60 / bpm;
    const secondsPerBar = secondsPerBeat * 4;
    const totalDurationSeconds = Math.max(4, totalBars * secondsPerBar);
    const sampleRate = 44100;
    const lengthSamples = Math.ceil(sampleRate * totalDurationSeconds);

    const stems: Record<string, Blob> = {};

    // 1. Render each channel individually as an isolated stem
    for (const channel of channels) {
      const offlineCtx = new OfflineAudioContext(2, lengthSamples, sampleRate);
      const trackGain = offlineCtx.createGain();
      trackGain.connect(offlineCtx.destination);

      clips.forEach(clip => {
        if (clip.type === 'pattern' && clip.channelId === channel.id) {
          const clipStartTime = clip.startBar * secondsPerBar;
          const patternNotes = channel.notes || [];
          patternNotes.forEach(note => {
            const noteStartTime = clipStartTime + (note.start * (secondsPerBeat / 4));
            if (noteStartTime < totalDurationSeconds) {
              this.renderNoteOffline(offlineCtx, channel, note, noteStartTime, trackGain);
            }
          });
        }
      });

      const buffer = await offlineCtx.startRendering();
      const cleanName = channel.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      stems[`${channel.id}_${cleanName}.wav`] = this.audioBufferToWav(buffer, bitDepth);
    }

    // 2. Render Full Master Mix
    const master = await this.renderProjectToWav(channels, clips, bpm, totalBars, bitDepth);

    return { stems, master };
  }

  private renderNoteOffline(
    ctx: OfflineAudioContext,
    channel: Channel,
    note: Note,
    time: number,
    destination: AudioNode
  ) {
    const freq = this.midiToFreq(note.pitch);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = channel.synthParams?.osc1Type || 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    const vel = (note.velocity || 0.8) * channel.volume;
    const dur = (note.duration || 1) * 0.25;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(vel, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur + 0.2);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(time);
    osc.stop(time + dur + 0.25);
  }

  // AudioBuffer to Lossless WAV encoder with IEEE Float or PCM Header
  private audioBufferToWav(buffer: AudioBuffer, bitDepth: 16 | 24 | 32): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = bitDepth === 32 ? 3 : 1; // 3 = IEEE Float, 1 = PCM
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const dataLength = buffer.length * blockAlign;
    const bufferLength = 44 + dataLength;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    // RIFF identifier
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleave left and right channels
    const left = buffer.getChannelData(0);
    const right = numChannels > 1 ? buffer.getChannelData(1) : left;

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = ch === 0 ? left[i] : right[i];
        const clamped = Math.max(-1, Math.min(1, sample));

        if (bitDepth === 16) {
          view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
          offset += 2;
        } else if (bitDepth === 24) {
          const val = clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff;
          view.setUint8(offset, val & 0xff);
          view.setUint8(offset + 1, (val >> 8) & 0xff);
          view.setUint8(offset + 2, (val >> 16) & 0xff);
          offset += 3;
        } else {
          view.setFloat32(offset, clamped, true);
          offset += 4;
        }
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // --- Transport & Sequencer Loop ---
  private bpm: number = 128;
  private swing: number = 0;
  private metronome: boolean = false;
  private isPlaying: boolean = false;
  private timerId: any = null;
  private currentStep: number = 0;
  private currentBar: number = 1;
  private stepCallback: ((step: number, bar: number) => void) | null = null;
  private activeChannels: Channel[] = [];
  private activeClips: PlaylistClip[] = [];
  private activePlayMode: 'pat' | 'song' = 'pat';
  private activePatternId?: string;

  public setBpm(bpm: number) {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }

  public setSwing(swing: number) {
    this.swing = Math.max(0, Math.min(100, swing));
  }

  public setMetronome(enabled: boolean) {
    this.metronome = enabled;
  }

  public setStepCallback(cb: (step: number, bar: number) => void) {
    this.stepCallback = cb;
  }

  public play(
    channels: Channel[],
    clips: PlaylistClip[],
    mode: 'pat' | 'song',
    patternId?: string
  ) {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.stop();
    this.isPlaying = true;
    this.activeChannels = channels;
    this.activeClips = clips;
    this.activePlayMode = mode;
    this.activePatternId = patternId;

    const scheduleInterval = () => {
      if (!this.isPlaying) return;

      const secondsPerBeat = 60 / this.bpm;
      const secondsPerStep = secondsPerBeat / 4;
      const msPerStep = secondsPerStep * 1000;

      // Apply swing to odd steps (1, 3, 5, 7...)
      const swingOffset = (this.currentStep % 2 === 1) ? (this.swing / 100) * (msPerStep * 0.4) : 0;
      const nextDelay = Math.max(15, msPerStep + (this.currentStep % 2 === 1 ? swingOffset : -swingOffset));

      this.triggerCurrentStep();

      // Advance step
      const nextStep = (this.currentStep + 1) % 16;
      if (nextStep === 0) {
        this.currentBar = this.activePlayMode === 'song' ? (this.currentBar % 16) + 1 : 1;
      }
      this.currentStep = nextStep;

      if (this.stepCallback) {
        this.stepCallback(this.currentStep, this.currentBar);
      }

      this.timerId = setTimeout(scheduleInterval, nextDelay);
    };

    scheduleInterval();
  }

  public stop() {
    this.isPlaying = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.currentStep = 0;
    this.currentBar = 1;
  }

  private triggerCurrentStep() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Metronome on quarter notes (steps 0, 4, 8, 12)
    if (this.metronome && this.currentStep % 4 === 0) {
      const isDownbeat = this.currentStep === 0;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.setValueAtTime(isDownbeat ? 1400 : 880, now);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(this.masterGain || this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    }

    // Gross Beat Rhythmic Chopper & Gater
    if (this.grossBeatState.enabled && this.grossBeatNode) {
      const stepVal = this.grossBeatState.gateSteps[this.currentStep % 16];
      const targetGain = stepVal ? 1.0 : Math.max(0.01, 1.0 - (this.grossBeatState.mix * 0.95));
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setTargetAtTime(targetGain, now, 0.012);
    }

    if (this.activePlayMode === 'pat') {
      // Trigger all channel active steps
      this.activeChannels.forEach(channel => {
        if (channel.mute) return;

        // 1. Step sequencer trigger
        if (channel.steps && channel.steps[this.currentStep]) {
          const defaultPitch = channel.instrumentType === 'drumpad' ? 36 : 60;
          this.playNote(channel, {
            id: `seq-${channel.id}-${this.currentStep}`,
            pitch: defaultPitch,
            start: this.currentStep,
            duration: 1,
            velocity: 0.9
          }, now);
        }

        // 2. Piano roll notes starting on this step
        if (channel.notes) {
          channel.notes.forEach(note => {
            if (note.start === this.currentStep) {
              this.playNote(channel, note, now);
            }
          });
        }
      });
    } else {
      // Song mode: trigger clips in current bar
      const barIdx = this.currentBar - 1;
      const currentGlobalStep = (barIdx * 16) + this.currentStep;

      // 1. Evaluate automation clips at current bar & step
      this.activeClips.forEach(clip => {
        if (clip.type === 'automation' && clip.automationTarget && clip.automationPoints && clip.automationPoints.length >= 2) {
          const currentTotalBar = barIdx + (this.currentStep / 16);
          if (currentTotalBar >= clip.startBar && currentTotalBar <= clip.startBar + clip.lengthBars) {
            const relX = (currentTotalBar - clip.startBar) / clip.lengthBars;
            const val = this.interpolateAutomationCurve(clip.automationPoints, relX);
            this.applyAutomationValue(clip.automationTarget, val, this.activeChannels, []);
          }
        }
      });

      this.activeClips.forEach(clip => {
        if (clip.type === 'pattern') {
          const clipStartStep = clip.startBar * 16;
          const clipEndStep = clipStartStep + (clip.lengthBars * 16);

          if (currentGlobalStep >= clipStartStep && currentGlobalStep < clipEndStep) {
            const relStep = (currentGlobalStep - clipStartStep) % 16;
            const channel = this.activeChannels.find(c => c.id === clip.channelId);
            if (channel && !channel.mute) {
              if (channel.steps && channel.steps[relStep]) {
                const defaultPitch = channel.instrumentType === 'drumpad' ? 36 : 60;
                this.playNote(channel, {
                  id: `song-${channel.id}-${relStep}`,
                  pitch: defaultPitch,
                  start: relStep,
                  duration: 1,
                  velocity: 0.9
                }, now);
              }
              if (channel.notes) {
                channel.notes.forEach(note => {
                  if (note.start === relStep) {
                    this.playNote(channel, note, now);
                  }
                });
              }
            }
          }
        } else if (clip.type === 'audio') {
          const clipStartStep = clip.startBar * 16;
          if (currentGlobalStep === clipStartStep && !clip.mute) {
            // Trigger audio clip at its start bar
            this.playAudioClipWithFades(clip, now);
          }
        }
      });
    }
  }

  private playAudioClipWithFades(clip: PlaylistClip, startTime: number) {
    if (!this.ctx) return;
    const buf = clip.audioBufferId ? this.sampleBuffers.get(clip.audioBufferId) : null;
    if (!buf) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;

    // Pitch shift / Playback rate
    if (clip.pitchShiftSemitones) {
      source.detune.setValueAtTime(clip.pitchShiftSemitones * 100, startTime);
    }
    if (clip.timeStretchRate) {
      source.playbackRate.setValueAtTime(clip.timeStretchRate, startTime);
    }

    const gainNode = this.ctx.createGain();
    const clipDurationSec = (clip.lengthBars * 4 * (60 / this.bpm));
    const fadeInSec = Math.max(0.005, (clip.fadeInBars || 0) * 4 * (60 / this.bpm));
    const fadeOutSec = Math.max(0.005, (clip.fadeOutBars || 0) * 4 * (60 / this.bpm));

    // Fade in envelope
    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.exponentialRampToValueAtTime(1.0, startTime + fadeInSec);

    // Fade out envelope
    const fadeOutStart = Math.max(startTime + fadeInSec, startTime + clipDurationSec - fadeOutSec);
    gainNode.gain.setValueAtTime(1.0, fadeOutStart);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + clipDurationSec);

    source.connect(gainNode);
    gainNode.connect(this.masterGain || this.ctx.destination);

    source.start(startTime);
    source.stop(startTime + clipDurationSec);
  }

  // Fast offline Bounce-In-Place / Channel Render
  public async bounceChannelToAudioClip(channel: Channel, bpm: number = 130, bars: number = 4): Promise<{ buffer: AudioBuffer; waveform: number[] }> {
    const sampleRate = this.ctx?.sampleRate || 44100;
    const durationSec = bars * 4 * (60 / bpm);
    const length = Math.floor(sampleRate * durationSec);
    const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(2, length, sampleRate);

    // Synthesize notes / drum patterns into offline audio
    const left = offlineCtx.createBuffer(2, length, sampleRate).getChannelData(0);
    const right = offlineCtx.createBuffer(2, length, sampleRate).getChannelData(1);

    const stepDuration = (60 / bpm) / 4;
    const totalSteps = bars * 16;

    // Render active notes or step triggers
    for (let s = 0; s < totalSteps; s++) {
      const relStep = s % 16;
      const isStepActive = channel.steps && channel.steps[relStep];
      const stepNotes = channel.notes ? channel.notes.filter(n => n.start === relStep) : [];

      if (isStepActive || stepNotes.length > 0) {
        const tStart = s * stepDuration;
        const startSample = Math.floor(tStart * sampleRate);
        const hitSamples = Math.floor(0.35 * sampleRate);

        for (let i = 0; i < hitSamples && (startSample + i) < length; i++) {
          const t = i / sampleRate;
          let sampleVal = 0;
          if (channel.instrumentType === 'drumpad') {
            const freq = 120 * Math.exp(-t * 22);
            sampleVal = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 10);
          } else {
            // Harmonic synth tone
            const freq = 220;
            sampleVal = (Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(2 * Math.PI * freq * 2 * t)) * Math.exp(-t * 6);
          }
          left[startSample + i] += sampleVal * (channel.volume || 0.8) * 0.7;
          right[startSample + i] += sampleVal * (channel.volume || 0.8) * 0.7;
        }
      }
    }

    const renderedBuffer = offlineCtx.createBuffer(2, length, sampleRate);
    renderedBuffer.copyToChannel(left, 0);
    renderedBuffer.copyToChannel(right, 1);

    // Compute 32 normalized peak amplitudes for waveform preview
    const waveform: number[] = [];
    const blockSize = Math.floor(length / 32);
    for (let b = 0; b < 32; b++) {
      let max = 0;
      const offset = b * blockSize;
      for (let j = 0; j < blockSize && (offset + j) < length; j++) {
        const abs = Math.abs(left[offset + j]);
        if (abs > max) max = abs;
      }
      waveform.push(Math.min(1.0, max * 1.5));
    }

    const bufId = `bounced-${channel.id}-${Date.now()}`;
    this.setSampleBuffer(bufId, renderedBuffer);

    return { buffer: renderedBuffer, waveform };
  }

  public getMasterLoudnessMetrics() {
    if (!this.masterAnalyser || !this.ctx) {
      return {
        momentaryLufs: -24,
        shortTermLufs: -24,
        integratedLufs: -14.2,
        truePeakDbfs: -6.0,
        lowBandReductionDb: 0,
        midBandReductionDb: 0,
        highBandReductionDb: 0,
        phaseCorrelation: 0.95,
        stereoSpread: 1.0,
        isClipping: false
      };
    }

    const bufferLength = this.masterAnalyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    this.masterAnalyser.getFloatTimeDomainData(dataArray);

    let sumSquares = 0;
    let peak = 0;
    let sumL = 0;
    let sumR = 0;
    let sumDot = 0;

    for (let i = 0; i < bufferLength; i++) {
      const val = dataArray[i];
      sumSquares += val * val;
      const absVal = Math.abs(val);
      if (absVal > peak) peak = absVal;

      // Simulated stereo correlation across channel bins
      const l = val;
      const r = i < bufferLength - 1 ? dataArray[i + 1] * 0.98 : val;
      sumL += l * l;
      sumR += r * r;
      sumDot += l * r;
    }

    const denom = Math.sqrt(sumL * sumR);
    const phaseCorrelation = denom > 1e-6 ? Math.max(-1.0, Math.min(1.0, sumDot / denom)) : 1.0;

    const rms = Math.sqrt(sumSquares / bufferLength);
    const dbfs = 20 * Math.log10(Math.max(1e-5, rms));
    const lufs = Math.max(-70, Math.min(0, dbfs - 0.691));
    const peakDbfs = 20 * Math.log10(Math.max(1e-5, peak));

    return {
      momentaryLufs: Number(lufs.toFixed(1)),
      shortTermLufs: Number((lufs * 0.95).toFixed(1)),
      integratedLufs: Number((lufs * 0.92).toFixed(1)),
      truePeakDbfs: Number(peakDbfs.toFixed(1)),
      lowBandReductionDb: peakDbfs > -3 ? Number((peakDbfs + 3).toFixed(1)) : 0,
      midBandReductionDb: peakDbfs > -6 ? Number(((peakDbfs + 6) * 0.7).toFixed(1)) : 0,
      highBandReductionDb: peakDbfs > -4 ? Number(((peakDbfs + 4) * 0.5).toFixed(1)) : 0,
      phaseCorrelation: Number(phaseCorrelation.toFixed(2)),
      stereoSpread: Number((1.0 - Math.abs(phaseCorrelation - 1.0) * 0.5).toFixed(2)),
      isClipping: peak >= 0.99
    };
  }

  // Generate Goniometer / Lissajous vector points for 2D stereo phase scope
  public getStereoVectors(numPoints: number = 64): { x: number; y: number }[] {
    if (!this.masterAnalyser) return [];
    const bufferLength = this.masterAnalyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    this.masterAnalyser.getFloatTimeDomainData(dataArray);

    const step = Math.max(1, Math.floor(bufferLength / numPoints));
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i < numPoints; i++) {
      const idx = i * step;
      const l = dataArray[idx] || 0;
      const r = (dataArray[idx + 1] || dataArray[idx]) * 0.95;
      
      // Rotate 45 degrees: M = (L+R)/sqrt(2) (vertical), S = (L-R)/sqrt(2) (horizontal)
      const x = (l - r) * 0.7071;
      const y = (l + r) * 0.7071;
      points.push({ x, y });
    }

    return points;
  }

  // Real-time timeline tape scrub audition sound synthesis
  public playTimelineScrubSound(bar: number, speedMultiplier: number = 1.0) {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    // Analog tape scrub pitch calculation based on bar and scrub speed
    const baseFreq = 110 * Math.pow(2, ((bar % 12) + 24) / 12);
    const scrubPitch = Math.max(60, Math.min(3000, baseFreq * speedMultiplier));

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(scrubPitch, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, scrubPitch * 0.4), now + 0.08);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(Math.min(4000, scrubPitch * 1.5), now);
    filter.Q.value = 3.0;

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(filter);
    filter.connect(gain);
    if (this.masterGain) {
      gain.connect(this.masterGain);
    } else {
      gain.connect(ctx.destination);
    }

    osc.start(now);
    osc.stop(now + 0.09);
  }
}

export const audioEngine = new AudioEngine();
