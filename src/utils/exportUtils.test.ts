import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStandardMidiFile, getProjectRenderBars } from './exportUtils';
import type { Channel, PlaylistClip } from '../types/daw';

const channel: Channel = {
  id: 'ch-1',
  name: 'Lead',
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 1 }],
  synthParams: {} as Channel['synthParams'],
};

const clips: PlaylistClip[] = [
  {
    id: 'clip-1',
    trackIndex: 0,
    startBar: 2,
    lengthBars: 8,
    type: 'pattern',
    channelId: 'ch-1',
    color: '#fff',
    name: 'Lead Pattern',
  },
  {
    id: 'clip-2',
    trackIndex: 1,
    startBar: 10,
    lengthBars: 4,
    type: 'audio',
    audioBufferId: 'audio-1',
    color: '#fff',
    name: 'Vocal',
  },
];

describe('project export helpers', () => {
  it('derives full-song render length from the playlist instead of a fixed 16 bars', () => {
    assert.equal(getProjectRenderBars(clips, 'song'), 14);
  });

  it('keeps the pattern export scope at the documented 4-bar loop', () => {
    assert.equal(getProjectRenderBars(clips, 'pattern'), 4);
  });

  it('writes a valid Standard MIDI file containing a note event', async () => {
    const blob = buildStandardMidiFile([channel], [clips[0]], { bpm: 120, timeSignature: [4, 4] });
    assert.equal(blob.type, 'audio/midi');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
    assert.equal(String.fromCharCode(...bytes.slice(14, 18)), 'MTrk');
    assert.ok(bytes.includes(0x90), 'expected MIDI note-on event');
    assert.ok(bytes.includes(0x80), 'expected MIDI note-off event');
    assert.deepEqual(Array.from(bytes.slice(-4)), [0x00, 0xff, 0x2f, 0x00]);
  });
});
