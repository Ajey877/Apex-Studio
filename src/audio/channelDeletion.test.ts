import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { createDefaultProjectState, deleteChannelFromProjectState } from '../state/projectState';
import { audioEngine } from './audioEngine';
import type { ProjectState, Channel } from '../types/daw';

class MockAudioNode {
  readonly connections: unknown[] = [];
  disconnect(): void {
    this.connections.length = 0;
  }
  connect(target: unknown): void {
    this.connections.push(target);
  }
}

type TestEngine = {
  ctx: AudioContext | null;
  mixerChannels: Map<number, {
    input: AudioNode;
    output: AudioNode;
    duckingGain: AudioNode;
    panner: AudioNode;
    analyser: AudioNode;
    fxNodes: AudioNode[];
  }>;
  activeVoices: Map<string, { stop: (time?: number) => void }>;
  hasMixerChannel: (trackId: number) => boolean;
  removeMixerChannel: (trackId: number) => void;
  stopChannelVoices: (channelId: string) => void;
};

const engine = audioEngine as unknown as TestEngine;

const originalEngineState = {
  ctx: engine.ctx,
  mixerChannels: engine.mixerChannels,
  activeVoices: engine.activeVoices,
};

describe('Channel deletion lifecycle — ProjectState', () => {
  it('prevents deleting the final channel (minimum 1 channel constraint)', () => {
    const project = createDefaultProjectState();
    // Keep only 1 channel
    project.channels = [project.channels[0]];

    const result = deleteChannelFromProjectState(project, project.channels[0].id);
    assert.equal(result.deletedChannel, null);
    assert.equal(result.removedMixerTrackId, null);
    assert.equal(result.state.channels.length, 1);
    assert.equal(result.state.channels[0].id, project.channels[0].id);
  });

  it('removes the channel from channels and removes orphaned MixerTrack when unshared', () => {
    const project = createDefaultProjectState();
    // Default project has ch-1 (mixerTrackId: 1) and ch-2 (mixerTrackId: 2)
    assert.equal(project.channels.length, 2);
    assert.ok(project.mixerTracks.some(t => t.id === 2));

    const result = deleteChannelFromProjectState(project, 'ch-2');
    assert.ok(result.deletedChannel);
    assert.equal(result.deletedChannel.id, 'ch-2');
    assert.equal(result.removedMixerTrackId, 2);

    // Channel removed
    assert.equal(result.state.channels.length, 1);
    assert.equal(result.state.channels[0].id, 'ch-1');

    // Mixer track 2 removed since no other channel uses it
    assert.equal(result.state.mixerTracks.some(t => t.id === 2), false);
    // Mixer track 1 preserved for ch-1
    assert.equal(result.state.mixerTracks.some(t => t.id === 1), true);
    // Master track 0 preserved
    assert.equal(result.state.mixerTracks.some(t => t.id === 0), true);
  });

  it('preserves MixerTrack when another surviving channel shares the same mixerTrackId', () => {
    const project = createDefaultProjectState();
    // Add ch-3 that also routes to mixerTrackId: 2
    const sharedChannel: Channel = {
      ...project.channels[1],
      id: 'ch-3',
      name: 'Layered Snare',
      mixerTrackId: 2,
    };
    project.channels.push(sharedChannel);

    const result = deleteChannelFromProjectState(project, 'ch-2');
    assert.ok(result.deletedChannel);
    assert.equal(result.deletedChannel.id, 'ch-2');
    // Because ch-3 still uses mixerTrackId 2, the track is NOT orphaned
    assert.equal(result.removedMixerTrackId, null);

    // Channel ch-2 removed, ch-1 and ch-3 remain
    assert.equal(result.state.channels.length, 2);
    assert.equal(result.state.channels.some(c => c.id === 'ch-2'), false);
    assert.equal(result.state.channels.some(c => c.id === 'ch-3'), true);

    // Mixer track 2 is preserved
    assert.equal(result.state.mixerTracks.some(t => t.id === 2), true);
  });

  it('never removes Master track 0 even if a channel was routed to Master', () => {
    const project = createDefaultProjectState();
    // Set ch-2 to route to Master (0)
    project.channels[1].mixerTrackId = 0;

    const result = deleteChannelFromProjectState(project, 'ch-2');
    assert.ok(result.deletedChannel);
    assert.equal(result.removedMixerTrackId, null);
    assert.equal(result.state.mixerTracks.some(t => t.id === 0), true);
  });

  it('switches selectedChannelId to a surviving channel when the selected channel is deleted', () => {
    const project = createDefaultProjectState();
    project.selectedChannelId = 'ch-1';

    const result = deleteChannelFromProjectState(project, 'ch-1');
    assert.ok(result.deletedChannel);
    // Must select surviving channel (ch-2), not the deleted ch-1
    assert.equal(result.state.selectedChannelId, 'ch-2');
  });

  it('resets selectedMixerTrackId to 0 when the selected mixer track is removed', () => {
    const project = createDefaultProjectState();
    project.selectedMixerTrackId = 2;

    const result = deleteChannelFromProjectState(project, 'ch-2');
    assert.equal(result.removedMixerTrackId, 2);
    assert.equal(result.state.selectedMixerTrackId, 0);
  });

  it('handles non-existent channel ID safely as a no-op', () => {
    const project = createDefaultProjectState();
    const result = deleteChannelFromProjectState(project, 'non-existent-id');
    assert.equal(result.deletedChannel, null);
    assert.equal(result.removedMixerTrackId, null);
    assert.equal(result.state.channels.length, project.channels.length);
  });
});

describe('Channel deletion lifecycle — AudioEngine', () => {
  let disconnectedNodes: string[] = [];

  const createTrackNodes = (id: number) => {
    const trackDisconnect = (name: string) => () => { disconnectedNodes.push(`${id}:${name}`); };
    const input = Object.assign(new MockAudioNode(), { disconnect: trackDisconnect('input') });
    const output = Object.assign(new MockAudioNode(), { disconnect: trackDisconnect('output') });
    const duckingGain = Object.assign(new MockAudioNode(), { disconnect: trackDisconnect('duckingGain') });
    const panner = Object.assign(new MockAudioNode(), { disconnect: trackDisconnect('panner') });
    const analyser = Object.assign(new MockAudioNode(), { disconnect: trackDisconnect('analyser') });
    const fx1 = Object.assign(new MockAudioNode(), { disconnect: trackDisconnect('fx1') });
    return { input, output, duckingGain, panner, analyser, fxNodes: [fx1] };
  };

  beforeEach(() => {
    disconnectedNodes = [];
    engine.mixerChannels = new Map([
      [0, createTrackNodes(0)],
      [1, createTrackNodes(1)],
      [2, createTrackNodes(2)],
    ]) as unknown as TestEngine['mixerChannels'];
    engine.activeVoices = new Map();
  });

  afterEach(() => {
    engine.ctx = originalEngineState.ctx;
    engine.mixerChannels = originalEngineState.mixerChannels;
    engine.activeVoices = originalEngineState.activeVoices;
  });

  it('disconnects all nodes for the specified mixer track and removes it from mixerChannels map', () => {
    assert.equal(engine.hasMixerChannel(2), true);
    assert.equal(engine.hasMixerChannel(1), true);

    audioEngine.removeMixerChannel(2);

    assert.equal(engine.hasMixerChannel(2), false);
    assert.equal(engine.hasMixerChannel(1), true);
    assert.equal(engine.hasMixerChannel(0), true);

    // Verify all nodes for track 2 were disconnected
    assert.ok(disconnectedNodes.includes('2:input'));
    assert.ok(disconnectedNodes.includes('2:fx1'));
    assert.ok(disconnectedNodes.includes('2:panner'));
    assert.ok(disconnectedNodes.includes('2:duckingGain'));
    assert.ok(disconnectedNodes.includes('2:output'));
    assert.ok(disconnectedNodes.includes('2:analyser'));

    // Track 1 and 0 nodes were NOT disconnected
    assert.equal(disconnectedNodes.some(n => n.startsWith('1:')), false);
    assert.equal(disconnectedNodes.some(n => n.startsWith('0:')), false);
  });

  it('never removes or disconnects Master track 0', () => {
    assert.equal(engine.hasMixerChannel(0), true);

    audioEngine.removeMixerChannel(0);

    assert.equal(engine.hasMixerChannel(0), true);
    assert.equal(disconnectedNodes.length, 0);
  });

  it('is idempotent when removing non-existent or already removed track', () => {
    assert.doesNotThrow(() => audioEngine.removeMixerChannel(999));
    audioEngine.removeMixerChannel(1);
    assert.doesNotThrow(() => audioEngine.removeMixerChannel(1));
  });

  it('stops active voices for the deleted channel while preserving other channels voices', () => {
    const stopped: string[] = [];
    engine.activeVoices = new Map([
      ['ch-1-60-0.123', { stop: () => stopped.push('ch-1-60') }],
      ['ch-2-38-0.456', { stop: () => stopped.push('ch-2-38') }],
      ['ch-2-42-0.789', { stop: () => stopped.push('ch-2-42') }],
      ['ch-3-64-0.999', { stop: () => stopped.push('ch-3-64') }],
    ]);

    audioEngine.stopChannelVoices('ch-2');

    assert.deepEqual(stopped.sort(), ['ch-2-38', 'ch-2-42'].sort());
    assert.equal(engine.activeVoices.has('ch-1-60-0.123'), true);
    assert.equal(engine.activeVoices.has('ch-3-64-0.999'), true);
    assert.equal(engine.activeVoices.has('ch-2-38-0.456'), false);
    assert.equal(engine.activeVoices.has('ch-2-42-0.789'), false);
  });
});
