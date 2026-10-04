/**
 * Phase 66 — F3-A: the Piano Roll's MIDI export writes the project tempo.
 *
 * `ProjectMetadata.bpm` is the single source of truth for tempo: the project
 * export dialog hands `meta.bpm` to `buildStandardMidiFile`, the offline
 * renderer receives it as the render tempo, and the tempo is persisted with the
 * project document. The Piano Roll's per-channel MIDI export ignored all of that
 * and called `MidiParser.exportNotesToMidi(notes, 130, ...)` with a hardcoded
 * 130 BPM, so the same project exported two different tempos depending on which
 * button was used (`/tmp/probes/p5c_tempo.ts`: dialog → 90 BPM, Piano Roll → 130).
 *
 * The tests below decode the real bytes the production writers emit, and assert
 * the production wiring that chooses the tempo. The tsx suite has no DOM, so the
 * component's own click handler is pinned structurally against the seam it uses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { MidiParser } from '../utils/midiParser';
import type { Channel, Note, ProjectMetadata } from '../types/daw';

const MICROSECONDS_PER_MINUTE = 60_000_000;

/** Reads the tempo meta event (`FF 51 03 tt tt tt`) out of a Standard MIDI file. */
const readTempoMicrosecondsPerBeat = (bytes: Uint8Array): number => {
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd', 'missing MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  const trackCount = view.getUint16(10);
  let cursor = 8 + headerLength;

  for (let track = 0; track < trackCount; track += 1) {
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    while (index < end - 2) {
      // Meta events only: the two writers place the tempo event first, before any
      // channel event, so a small structural scan is enough to find it.
      if (bytes[index] === 0xff && bytes[index + 1] === 0x51 && bytes[index + 2] === 0x03) {
        return (bytes[index + 3] << 16) | (bytes[index + 4] << 8) | bytes[index + 5];
      }
      index += 1;
    }
    cursor = end;
  }
  throw new Error('no tempo meta event in the file');
};

const makeNote = (id: string, pitch: number, start: number): Note => ({
  id,
  pitch,
  start,
  duration: 1,
  velocity: 0.9,
});

const asBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

const PROBE_BPM = 90;

describe('Phase 66 F3-A — the Piano Roll MIDI export uses the project tempo', () => {
  it('the channel export writer honours the tempo it is handed', async () => {
    const bytes = await asBytes(MidiParser.exportNotesToMidi([makeNote('n-1', 60, 0)], PROBE_BPM, 'Lead'));

    assert.equal(
      readTempoMicrosecondsPerBeat(bytes),
      Math.round(MICROSECONDS_PER_MINUTE / PROBE_BPM),
      'the file must state the tempo the caller passed',
    );
    assert.notEqual(
      readTempoMicrosecondsPerBeat(bytes),
      Math.round(MICROSECONDS_PER_MINUTE / 130),
      'and must not be the historical hardcoded 130 BPM',
    );
  });

  it('the project export and the channel export state the same tempo for the same project', async () => {
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
      steps: new Array(16).fill(false),
      notes: [makeNote('n-1', 60, 0)],
      synthParams: {} as Channel['synthParams'],
    };
    const meta: Pick<ProjectMetadata, 'bpm' | 'timeSignature'> = { bpm: PROBE_BPM, timeSignature: [4, 4] };

    const projectTempo = readTempoMicrosecondsPerBeat(await asBytes(buildStandardMidiFile([channel], [], meta, { scope: 'pattern', patternLengthSteps: 16 })));
    const channelExport = await import('./PianoRoll');
    const channelTempo = readTempoMicrosecondsPerBeat(
      await asBytes(channelExport.buildPianoRollMidiExport([makeNote('n-1', 60, 0)], PROBE_BPM, 'Lead')),
    );

    assert.equal(projectTempo, Math.round(MICROSECONDS_PER_MINUTE / PROBE_BPM));
    assert.equal(channelTempo, projectTempo, 'both export buttons must describe one project');
  });

  it('never hardcodes the exported tempo in the Piano Roll', () => {
    const source = readFileSync(new URL('./PianoRoll.tsx', import.meta.url), 'utf8');
    const callSites = source.match(/exportNotesToMidi\([^)]*\)/g) ?? [];

    assert.ok(callSites.length > 0, 'the Piano Roll still exports MIDI');
    for (const callSite of callSites) {
      assert.doesNotMatch(
        callSite,
        /,\s*\d+(\.\d+)?\s*,/,
        `a numeric tempo literal in "${callSite}" is a second tempo source beside ProjectMetadata.bpm`,
      );
    }
  });

  it('takes the authoritative tempo from the project document', () => {
    const pianoRoll = readFileSync(new URL('./PianoRoll.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(
      pianoRoll,
      /interface PianoRollProps \{[\s\S]*?\bbpm: number;[\s\S]*?\n\}/,
      'the project tempo is threaded in as a prop, not read from a global or a second store',
    );
    assert.match(app, /<PianoRoll[\s\S]*?bpm=\{projectState\.meta\.bpm\}/, 'App passes the project document tempo');
  });
});
