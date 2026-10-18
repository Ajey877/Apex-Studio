import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fullPatternEventsInWindow } from './fullPatternSchedule';
import { createDefaultProjectState } from '../state/projectState';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { MidiParser } from '../utils/midiParser';
import type { PlaylistClip } from '../types/daw';

it('7/8 fractional bar starts and 3.5-step trims keep step and fractional note phase in audio and MIDI', async () => {
  const state = createDefaultProjectState();
  const channel = { ...state.channels[0], steps: [true], notes: [{ id: 'n', pitch: 67, start: 4.25, duration: 1, velocity: 0.8 }] };
  const clip: PlaylistClip = { id: 'f', type: 'pattern', patternScope: 'all', patternId: 'pat-1', startBar: 0.25, lengthBars: 2, offsetSteps: 3.5, trackIndex: 0, name: 'Full', color: '#fff' };
  const all = fullPatternEventsInWindow(channel, channel, clip, 16, 14, 0, 40);
  const callbacks = Array.from({ length: 40 }, (_, step) => fullPatternEventsInWindow(channel, channel, clip, 16, 14, step, step + 1)).flat();
  assert.deepEqual(callbacks.sort((a,b) => a.step-b.step), all.sort((a,b) => a.step-b.step));
  assert.deepEqual(all.map(e => e.step), [4.25, 16, 20.25]);
  const tracks = await MidiParser.parseMidiFile(await buildStandardMidiFile([channel], [clip], { bpm: 120, timeSignature: [7,8] }, { patterns: state.patterns }).arrayBuffer());
  assert.deepEqual(tracks[0].notes.map(n => n.startStep), [4.25, 16, 20.25]);
});
