/**
 * Phase 66 — F3-B: a multi-track (Format 1) MIDI file is imported track by track.
 *
 * `MidiParser.parseMidiFile` returns every track of the file — Apex's own export
 * writes one track per channel, named after the channel — but the Piano Roll's
 * import consumed `parsedTracks[0]` and nothing else. Worse, it rejected the file
 * outright when track 0 carried no notes (`parsedTracks[0].notes.length === 0`),
 * which is exactly what a Format-1 file with a tempo/track-name-only first track
 * looks like. Two note-bearing tracks were parsed and one was silently dropped
 * (`/tmp/probes/p5b_bytes.ts`).
 *
 * The confirmed contract: the Piano Roll is a single-channel editor, so the first
 * note-bearing track lands in the channel being edited — and every additional
 * note-bearing track becomes a channel of its own, created through the app's
 * existing channel-creation path. Unrelated parts are never merged, nothing is
 * dropped, track names carry the identity, and empty tracks are reported rather
 * than silently ignored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { MidiParser, type ParsedMidiTrack } from '../utils/midiParser';
import { planMidiImport } from './pianoRollMidiImport';
import type { Channel, ProjectMetadata } from '../types/daw';

const track = (name: string | undefined, notes: ParsedMidiTrack['notes']): ParsedMidiTrack => ({
  ...(name === undefined ? {} : { name }),
  notes,
});

const note = (pitch: number, startStep: number, durationSteps = 1, velocity = 0.8) => ({
  pitch,
  startStep,
  durationSteps,
  velocity,
});

const makeChannel = (id: string, name: string): Channel => ({
  id,
  name,
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {} as Channel['synthParams'],
});

describe('Phase 66 F3-B — a multi-track MIDI file is planned track by track', () => {
  it('sends the first note-bearing track to the edited channel and every other one to its own channel', () => {
    const plan = planMidiImport(
      [
        track('Tempo & Names', []),
        track('Lead', [note(72, 0)]),
        track('Bass', [note(36, 4)]),
        track('Drums', [note(40, 8)]),
      ],
      { noteIdSeed: 'seed' },
    );

    assert.deepEqual(
      plan.destinations.map(destination => [destination.kind, destination.name]),
      [
        ['current', 'Lead'],
        ['new', 'Bass'],
        ['new', 'Drums'],
      ],
      'the edited channel takes the first note-bearing track; the rest become channels',
    );
  });

  it('never merges the notes of one track into another', () => {
    const plan = planMidiImport(
      [track('Lead', [note(72, 0), note(74, 2)]), track('Bass', [note(36, 4)])],
      { noteIdSeed: 'seed' },
    );

    assert.deepEqual(plan.destinations[0].notes.map(entry => entry.pitch), [72, 74]);
    assert.deepEqual(plan.destinations[1].notes.map(entry => entry.pitch), [36]);
  });

  it('keeps the parser positions and dynamics unchanged, including sub-step onsets', () => {
    const plan = planMidiImport(
      [track('Lead', [note(72, 4.25, 2.5, 0.6), note(74, 15.75, 0.5, 0.9)])],
      { noteIdSeed: 'seed' },
    );

    assert.deepEqual(
      plan.destinations[0].notes.map(entry => [entry.pitch, entry.start, entry.duration, entry.velocity]),
      [
        [72, 4.25, 2.5, 0.6],
        [74, 15.75, 0.5, 0.9],
      ],
      'imported notes must keep the exact positions the file states',
    );
  });

  it('generates unique note ids across every destination', () => {
    const plan = planMidiImport(
      [track('Lead', [note(72, 0), note(74, 1)]), track('Bass', [note(36, 4), note(38, 5)])],
      { noteIdSeed: 'seed' },
    );

    const ids = plan.destinations.flatMap(destination => destination.notes.map(entry => entry.id));
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, 'a repeated id would break selection, undo and note edits');
    assert.deepEqual(planMidiImport(
      [track('Lead', [note(72, 0), note(74, 1)]), track('Bass', [note(36, 4), note(38, 5)])],
      { noteIdSeed: 'seed' },
    ).destinations, plan.destinations, 'the plan is deterministic for one seed');
  });

  it('names unnamed tracks the way the parser does and reports empty tracks', () => {
    const plan = planMidiImport(
      [track(undefined, []), track(undefined, [note(60, 0)]), track('Pad', [])],
      { noteIdSeed: 'seed' },
    );

    assert.deepEqual(plan.destinations.map(destination => destination.name), ['Track 2']);
    assert.deepEqual(plan.skippedEmptyTrackNames, ['Track 1', 'Pad'], 'empty tracks are reported, never invented as channels');
  });

  it('plans nothing when no track carries notes', () => {
    const plan = planMidiImport([track('Tempo', []), track('Marker', [])], { noteIdSeed: 'seed' });

    assert.deepEqual(plan.destinations, []);
    assert.deepEqual(plan.skippedEmptyTrackNames, ['Tempo', 'Marker']);
  });
});

describe('Phase 66 F3-B — the plan agrees with the real MIDI bytes', () => {
  it('distributes every note of a real Format-1 file the project exporter wrote', async () => {
    const lead = { ...makeChannel('ch-1', 'Lead'), notes: [{ id: 'n-1', pitch: 72, start: 0, duration: 2, velocity: 0.8 }] };
    const bass = { ...makeChannel('ch-2', 'Bass'), notes: [{ id: 'n-2', pitch: 36, start: 4, duration: 2, velocity: 0.9 }] };
    const meta: Pick<ProjectMetadata, 'bpm' | 'timeSignature'> = { bpm: 90, timeSignature: [4, 4] };

    const blob = buildStandardMidiFile([lead, bass], [], meta, { scope: 'pattern', patternLengthSteps: 16 });
    const parsed = await MidiParser.parseMidiFile(await blob.arrayBuffer());

    assert.equal(parsed.filter(entry => entry.notes.length > 0).length, 2, 'the file really has two note-bearing tracks');

    const plan = planMidiImport(parsed, { noteIdSeed: 'roundtrip' });

    assert.equal(plan.destinations.length, 2, 'both tracks survive the import');
    assert.deepEqual(plan.destinations.map(destination => destination.name), ['Lead', 'Bass']);
    assert.deepEqual(
      plan.destinations.map(destination => Array.from(new Set(destination.notes.map(entry => entry.pitch)))),
      [[72], [36]],
      'each track keeps its own pitches: the second track is not folded into the first',
    );
    // The pattern-scope window is four bars of a one-bar loop, so every track
    // repeats its note; the plan must carry every repetition of both tracks.
    assert.deepEqual(plan.destinations.map(destination => destination.notes.length), [4, 4]);
    assert.deepEqual(plan.destinations.map(destination => destination.notes[0].start), [0, 4]);
  });
});

describe('Phase 66 F3-B — production wiring', () => {
  const pianoRoll = readFileSync(new URL('./PianoRoll.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

  it('the Piano Roll imports through the plan and creates channels through the project state', () => {
    assert.match(pianoRoll, /planMidiImport\(parsedTracks/, 'the import must consume the whole file, not parsedTracks[0]');
    assert.doesNotMatch(pianoRoll, /parsedTracks\[0\]/, 'track 0 is not a special case any more');
    assert.match(pianoRoll, /onCreateChannelFromMidiImport\(/, 'additional tracks create channels through the app path');
    assert.match(
      pianoRoll,
      /onCreateChannelFromMidiImport: \(name: string, notes: Note\[\]\) => string;/,
      'the callback returns the new channel id so its notes are written in one publication',
    );
  });

  it('App creates the imported channels with the existing channel model', () => {
    assert.match(app, /onCreateChannelFromMidiImport=\{/, 'App must supply the channel-creation path');
    assert.match(
      app,
      /appendChannelWithAllocatedMixerTrackId\(/,
      'an imported channel gets an allocated mixer track id like every other channel',
    );
  });
});
