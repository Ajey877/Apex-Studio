/**
 * Phase 79 — ProjectState audio-consumer registry.
 *
 * Every persisted audio-affecting field in ProjectState (and the nested
 * objects ProjectState owns: Channel, PlaylistClip, MixerTrack,
 * SidechainSettings, ProjectMetadata) must be accounted for here. The
 * purpose is to make it hard to add a new audio-affecting field to
 * ProjectState without either wiring it to a real src/audio/ consumer or
 * explicitly marking it as non-audio/metadata.
 *
 *   - 'consumed'  : a concrete consumer in src/audio/ reads this field
 *                   and affects output. Give the file + a short note.
 *   - 'metadata'  : non-audio UI/document metadata (names, ids, colors,
 *                   comments, timestamps, collaboration state, UI
 *                   preferences, etc.). Persisted but never affects DSP.
 *   - 'ui-intent' : persisted forward-compat intent for a FUTURE DSP
 *                   feature. The UI may surface these as disabled or
 *                   marked "NOT APPLIED", and they MUST be documented as
 *                   intent-only. They MUST NOT be read by any audio
 *                   consumer (if one is added, move them to 'consumed').
 *
 * To add a new audio-affecting field, you must add it to this registry
 * AND provide a consumer (or mark it non-audio metadata). The
 * phase79.projectStateConsumers test enforces that the registry covers
 * every field reachable from ProjectState; if you add a field without
 * classifying it, the test fails.
 *
 * If you REMOVE a field from the types, remove its entry here too. If
 * you add a consumer for an 'ui-intent' field, change its classification
 * to 'consumed' and cite the consumer.
 */

export type AudioFieldClassification =
  | { classification: 'consumed'; consumer: string; note: string }
  | { classification: 'metadata'; note: string }
  | { classification: 'ui-intent'; note: string };

export interface AudioFieldRegistry {
  // path is a dot-separated path relative to ProjectState; arrays use [].
  [fieldPath: string]: AudioFieldClassification;
}

export const PROJECT_STATE_AUDIO_FIELDS: AudioFieldRegistry = {
  // ---- ProjectMetadata ----
  'meta.bpm':              { classification: 'consumed', consumer: 'audioEngine.ts:setBpm / transport', note: 'Drives transport tempo.' },
  'meta.swing':            { classification: 'consumed', consumer: 'audioEngine.ts:setSwing / swingOffsetSecondsForStep', note: 'Shifts every off-step.' },
  'meta.masterVolume':     { classification: 'consumed', consumer: 'audioEngine.ts:setMasterVolume (Phase 79 wire)', note: 'Master bus gain at project load/undo.' },
  'meta.masterPitch':      { classification: 'metadata', note: 'Reserved for future master pitch; not consumed today.' },
  'meta.name':             { classification: 'metadata', note: 'Display only.' },
  'meta.author':           { classification: 'metadata', note: 'Display only.' },
  'meta.id':               { classification: 'metadata', note: 'Document id.' },
  'meta.timeSignature':    { classification: 'metadata', note: 'UI display; transport runs 4/4 internally.' },
  'meta.created':          { classification: 'metadata', note: 'Timestamp.' },
  'meta.updated':          { classification: 'metadata', note: 'Timestamp.' },
  'meta.version':          { classification: 'metadata', note: 'Display string.' },
  'meta.offlineReady':     { classification: 'metadata', note: 'UI cache hint.' },
  'meta.totalEditTimeSeconds': { classification: 'metadata', note: 'Telemetry.' },

  // ---- Top-level arrays / scalars ----
  'patterns':              { classification: 'consumed', consumer: 'audioEngine transport / patternLength', note: 'Sequencer pattern data.' },
  'selectedPatternId':     { classification: 'metadata', note: 'UI selection.' },
  'sampleLibrary':         { classification: 'consumed', consumer: 'audioEngine.sampleBuffer map', note: 'Sample persistence; engine reads buffers by id.' },
  'samplePacks':           { classification: 'metadata', note: 'Sample-pack catalog metadata.' },
  'channels':              { classification: 'consumed', consumer: 'audioEngine channel graph', note: 'Channel voices/parameters drive the mixer.' },
  'selectedChannelId':     { classification: 'metadata', note: 'UI selection.' },
  'playlistTracks':        { classification: 'consumed', consumer: 'audioEngine playlist scheduler', note: 'Lanes for clip placement + lane mute.' },
  'playlistClips':         { classification: 'consumed', consumer: 'audioEngine playlist scheduler', note: 'Clip triggers drive playback.' },
  'mixerTracks':           { classification: 'consumed', consumer: 'audioEngine mixer graph', note: 'Mixer volumes/pan/routing/FX/sends.' },
  'selectedMixerTrackId':  { classification: 'metadata', note: 'UI selection.' },
  'nextMixerTrackId':      { classification: 'metadata', note: 'Identity allocator.' },
  'recordings':            { classification: 'consumed', consumer: 'audioEngine recording playback / hydration', note: 'Recorded-take buffers.' },
  'comments':              { classification: 'metadata', note: 'Collaboration comments.' },
  'collaborators':         { classification: 'metadata', note: 'Collaboration presence.' },
  'midiMappings':          { classification: 'consumed', consumer: 'midiMappingRuntime.ts', note: 'CC → parameter bridge.' },
  'connectedMidiDevices':  { classification: 'metadata', note: 'Hardware device list for reconnect.' },
  'markers':               { classification: 'metadata', note: 'Arrangement markers.' },
  'totalBars':             { classification: 'consumed', consumer: 'playlistTimeline (render window + export)', note: 'Phase 54 timeline length authority.' },
  'vocalTuner':            { classification: 'ui-intent', note: 'Disabled "NOT APPLIED" panel; persisted for future phase. No consumer in src/audio/.' },
  'grossBeatState':        { classification: 'consumed', consumer: 'audioEngine master gate (grossBeatGate.resolveGrossBeatGateGain)', note: 'Phase 79 master-bus amplitude gate; applied live AND in offline export.' },
  'macroKnobs':            { classification: 'consumed', consumer: 'macroMappings.ts:resolveMacroRack', note: 'Phase 51 macro-rack resolution drives mapped params at mutation time.' },
  'dismissedMissingAudioSignature': { classification: 'metadata', note: 'UI-only ack flag.' },

  // ---- Channel fields (selected audio-relevant ones; see .channels[] consumer) ----
  // We don't enumerate every leaf of Channel here; the registry instead
  // asserts that any channel.synthParams sub-key that matches an audio
  // parameter is either consumed or on the ui-intent allowlist. Tests
  // below do the leaf-level check by explicitly disallowing known-bad
  // legacy field names.

  // ---- MixerTrack fields (mixerTracks[] is consumed; per-leaf enforcement
  // is in the test — it rejects any non-allowlisted keys that look like
  // audio DSP state.) ----
};

/**
 * Explicit list of audio-affecting field names that have been stripped in
 * Phase 79 and MUST NOT return on the persisted types without moving to
 * 'consumed' (with a real src/audio/ consumer). Any re-addition of these
 * names anywhere under ProjectState/Channel/MixerTrack/PlaylistClip will
 * fail the consumer-invariant test.
 */
export const STRIPPED_INERT_FIELDS: ReadonlyArray<string> = [
  // Sidechain UI ghosts (Phase 79)
  'threshold',       // on SidechainSettings — was UI-only slider, no level detector
  'lowFreqOnly',     // on SidechainSettings — UI-only toggle, no crossover DSP
  'highPassFilterHz',// on SidechainSettings — UI-only slider, no detector filter
  'gainReductionDb', // on SidechainSettings — phantom readout, zero writers
  // Channel/synth ghosts
  'unisonSpread',    // on Channel.synthParams — UI-only wavetable preview control
  // Mixer-track ghost
  'stereoWidth',     // on MixerTrack — no StereoPanner width automation
  // Clip ghost
  'spatialAudio',    // on PlaylistClip — no binaural/panner/spatializer DSP
];
