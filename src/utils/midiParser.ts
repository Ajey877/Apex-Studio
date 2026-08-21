import { Note } from '../types/daw';

// Binary Standard MIDI File (SMF) Generator & Parser
export interface ParsedMidiTrack {
  name?: string;
  notes: {
    pitch: number;
    startStep: number;
    durationSteps: number;
    velocity: number;
  }[];
}

export class MidiParser {
  // Generate Standard MIDI File (.mid) binary Blob from Notes
  public static exportNotesToMidi(notes: Note[], bpm: number = 130, trackName: string = 'Apex Studio Track'): Blob {
    const ticksPerQuarter = 480; // Standard MIDI resolution (480 ticks = 1 quarter note = 4 steps)
    const ticksPerStep = ticksPerQuarter / 4; // 120 ticks per 16th note step
    const microsecondsPerBeat = Math.round(60000000 / bpm);

    // Build MIDI Events
    interface RawMidiEvent {
      tick: number;
      type: 'noteOn' | 'noteOff' | 'tempo' | 'trackName' | 'endOfTrack';
      pitch?: number;
      velocity?: number;
      channel?: number;
      data?: Uint8Array;
    }

    const events: RawMidiEvent[] = [];

    // Header events
    events.push({
      tick: 0,
      type: 'tempo',
      data: new Uint8Array([
        (microsecondsPerBeat >> 16) & 0xff,
        (microsecondsPerBeat >> 8) & 0xff,
        microsecondsPerBeat & 0xff
      ])
    });

    const nameBytes = new TextEncoder().encode(trackName);
    events.push({
      tick: 0,
      type: 'trackName',
      data: nameBytes
    });

    // Note events
    notes.forEach(n => {
      const startTick = Math.round(n.start * ticksPerStep);
      const durationTicks = Math.max(1, Math.round(n.duration * ticksPerStep));
      const endTick = startTick + durationTicks;
      const vel = Math.max(1, Math.min(127, Math.round((n.velocity || 0.8) * 127)));

      events.push({
        tick: startTick,
        type: 'noteOn',
        pitch: Math.max(0, Math.min(127, n.pitch)),
        velocity: vel,
        channel: 0
      });

      events.push({
        tick: endTick,
        type: 'noteOff',
        pitch: Math.max(0, Math.min(127, n.pitch)),
        velocity: 0,
        channel: 0
      });
    });

    // Sort events by tick (noteOff before noteOn if at same tick)
    events.sort((a, b) => {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if (a.type === 'noteOff' && b.type === 'noteOn') return -1;
      if (a.type === 'noteOn' && b.type === 'noteOff') return 1;
      return 0;
    });

    // Encode variable length quantity helper
    const writeVarLen = (value: number): number[] => {
      const bytes: number[] = [];
      let buffer = value & 0x7f;
      while ((value >>= 7) > 0) {
        buffer <<= 8;
        buffer |= 0x80;
        buffer += (value & 0x7f);
      }
      while (true) {
        bytes.push(buffer & 0xff);
        if (buffer & 0x80) buffer >>= 8;
        else break;
      }
      return bytes;
    };

    // Serialize Track Chunk
    const trackBytes: number[] = [];
    let lastTick = 0;

    events.forEach(ev => {
      const delta = Math.max(0, ev.tick - lastTick);
      lastTick = ev.tick;
      trackBytes.push(...writeVarLen(delta));

      if (ev.type === 'tempo') {
        trackBytes.push(0xff, 0x51, 0x03, ev.data![0], ev.data![1], ev.data![2]);
      } else if (ev.type === 'trackName') {
        trackBytes.push(0xff, 0x03, ev.data!.length, ...Array.from(ev.data!));
      } else if (ev.type === 'noteOn') {
        trackBytes.push(0x90 | (ev.channel! & 0x0f), ev.pitch!, ev.velocity!);
      } else if (ev.type === 'noteOff') {
        trackBytes.push(0x80 | (ev.channel! & 0x0f), ev.pitch!, 0);
      }
    });

    // End of Track meta event
    trackBytes.push(...writeVarLen(0), 0xff, 0x2f, 0x00);

    // SMF Header Chunk: 'MThd', length 6, format 0 (single track), 1 track, ticksPerQuarter
    const headerBytes = [
      0x4d, 0x54, 0x68, 0x64, // MThd
      0x00, 0x00, 0x00, 0x06, // length 6
      0x00, 0x00,             // format 0
      0x00, 0x01,             // 1 track
      (ticksPerQuarter >> 8) & 0xff, ticksPerQuarter & 0xff // resolution
    ];

    // Track Chunk Header: 'MTrk', length of trackBytes
    const trackLen = trackBytes.length;
    const trackHeaderBytes = [
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      (trackLen >> 24) & 0xff,
      (trackLen >> 16) & 0xff,
      (trackLen >> 8) & 0xff,
      trackLen & 0xff
    ];

    const finalBuffer = new Uint8Array([...headerBytes, ...trackHeaderBytes, ...trackBytes]);
    return new Blob([finalBuffer], { type: 'audio/midi' });
  }

  // Parse Standard MIDI File (.mid) binary data
  public static async parseMidiFile(file: File | ArrayBuffer): Promise<ParsedMidiTrack[]> {
    const arrayBuffer = file instanceof File ? await file.arrayBuffer() : file;
    const view = new DataView(arrayBuffer);
    let offset = 0;

    // Check MThd
    const readString = (len: number) => {
      let str = '';
      for (let i = 0; i < len; i++) {
        str += String.fromCharCode(view.getUint8(offset++));
      }
      return str;
    };

    const header = readString(4);
    if (header !== 'MThd') {
      throw new Error('Invalid MIDI file: Missing MThd header');
    }

    const headerLen = view.getUint32(offset);
    offset += 4;
    const format = view.getUint16(offset);
    offset += 2;
    const numTracks = view.getUint16(offset);
    offset += 2;
    const division = view.getUint16(offset);
    offset += 2;

    const ticksPerQuarter = (division & 0x8000) === 0 ? division : 480;
    const ticksPerStep = ticksPerQuarter / 4;

    const tracks: ParsedMidiTrack[] = [];

    // Parse each track
    for (let t = 0; t < numTracks && offset < view.byteLength; t++) {
      if (offset + 8 > view.byteLength) break;
      const trackId = readString(4);
      if (trackId !== 'MTrk') break;
      const trackLength = view.getUint32(offset);
      offset += 4;

      const trackEnd = offset + trackLength;
      let currentTick = 0;
      let trackName = `Track ${t + 1}`;
      let runningStatus = 0;

      const activeNotes = new Map<number, { startTick: number; velocity: number }>();
      const parsedNotes: ParsedMidiTrack['notes'] = [];

      while (offset < trackEnd && offset < view.byteLength) {
        // Read delta time
        let delta = 0;
        let b = 0;
        do {
          b = view.getUint8(offset++);
          delta = (delta << 7) | (b & 0x7f);
        } while (b & 0x80);

        currentTick += delta;

        // Read event byte
        let statusByte = view.getUint8(offset);
        if (statusByte & 0x80) {
          runningStatus = statusByte;
          offset++;
        } else {
          statusByte = runningStatus;
        }

        const eventType = statusByte >> 4;
        const channel = statusByte & 0x0f;

        if (statusByte === 0xff) {
          // Meta event
          const metaType = view.getUint8(offset++);
          let metaLen = 0;
          let mb = 0;
          do {
            mb = view.getUint8(offset++);
            metaLen = (metaLen << 7) | (mb & 0x7f);
          } while (mb & 0x80);

          if (metaType === 0x03 && metaLen > 0) {
            // Track Name
            let name = '';
            for (let i = 0; i < metaLen; i++) {
              name += String.fromCharCode(view.getUint8(offset + i));
            }
            trackName = name;
          }
          offset += metaLen;
        } else if (statusByte === 0xf0 || statusByte === 0xf7) {
          // Sysex
          let sysexLen = 0;
          let sb = 0;
          do {
            sb = view.getUint8(offset++);
            sysexLen = (sysexLen << 7) | (sb & 0x7f);
          } while (sb & 0x80);
          offset += sysexLen;
        } else if (eventType === 0x9) {
          // Note On
          const notePitch = view.getUint8(offset++);
          const velocity = view.getUint8(offset++);
          if (velocity > 0) {
            activeNotes.set(notePitch, { startTick: currentTick, velocity });
          } else {
            // Note On with 0 vel is Note Off
            const active = activeNotes.get(notePitch);
            if (active) {
              const durTicks = Math.max(ticksPerStep / 2, currentTick - active.startTick);
              parsedNotes.push({
                pitch: notePitch,
                startStep: Math.round((active.startTick / ticksPerStep) * 4) / 4,
                durationSteps: Math.max(0.5, Math.round((durTicks / ticksPerStep) * 4) / 4),
                velocity: active.velocity / 127
              });
              activeNotes.delete(notePitch);
            }
          }
        } else if (eventType === 0x8) {
          // Note Off
          const notePitch = view.getUint8(offset++);
          const _vel = view.getUint8(offset++);
          const active = activeNotes.get(notePitch);
          if (active) {
            const durTicks = Math.max(ticksPerStep / 2, currentTick - active.startTick);
            parsedNotes.push({
              pitch: notePitch,
              startStep: Math.round((active.startTick / ticksPerStep) * 4) / 4,
              durationSteps: Math.max(0.5, Math.round((durTicks / ticksPerStep) * 4) / 4),
              velocity: active.velocity / 127
            });
            activeNotes.delete(notePitch);
          }
        } else if (eventType === 0xa || eventType === 0xb || eventType === 0xe) {
          // Poly pressure, CC, Pitch bend (2 bytes)
          offset += 2;
        } else if (eventType === 0xc || eventType === 0xd) {
          // Program change, Channel pressure (1 byte)
          offset += 1;
        }
      }

      // Close any remaining active notes
      activeNotes.forEach((active, notePitch) => {
        parsedNotes.push({
          pitch: notePitch,
          startStep: Math.round((active.startTick / ticksPerStep) * 4) / 4,
          durationSteps: 2,
          velocity: active.velocity / 127
        });
      });

      if (parsedNotes.length > 0) {
        tracks.push({
          name: trackName,
          notes: parsedNotes
        });
      }
    }

    return tracks;
  }
}
