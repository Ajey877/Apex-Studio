import type { Channel, PlaylistClip, ProjectMetadata } from '../types/daw';

export type ExportScope = 'song' | 'pattern';

export function getProjectRenderBars(clips: PlaylistClip[], scope: ExportScope): number {
  if (scope === 'pattern') return 4;
  const endBars = clips
    .filter(clip => Number.isFinite(clip.startBar) && Number.isFinite(clip.lengthBars) && clip.lengthBars > 0)
    .map(clip => clip.startBar + clip.lengthBars);
  return Math.max(1, ...endBars);
}

const clampMidi = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));

const writeVlq = (value: number): number[] => {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
};

const pushString = (target: number[], value: string): void => {
  for (let i = 0; i < value.length; i += 1) target.push(value.charCodeAt(i));
};

const pushUint16 = (target: number[], value: number): void => {
  target.push((value >> 8) & 0xff, value & 0xff);
};

const pushUint32 = (target: number[], value: number): void => {
  target.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
};

interface MidiEvent {
  tick: number;
  order: number;
  data: number[];
}

function buildMidiTrack(
  channel: Channel,
  channelIndex: number,
  clips: PlaylistClip[],
  bpm: number,
): number[] {
  const midiChannel = channelIndex % 16;
  const events: MidiEvent[] = [];
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;

  const name = channel.name || `Channel ${channelIndex + 1}`;
  const nameBytes = Array.from(new TextEncoder().encode(name));
  events.push({ tick: 0, order: 0, data: [0xff, 0x03, ...writeVlq(nameBytes.length), ...nameBytes] });

  if (channelIndex === 0) {
    const microsPerQuarter = Math.max(1, Math.round(60_000_000 / safeBpm));
    events.push({
      tick: 0,
      order: 0,
      data: [0xff, 0x51, 0x03, (microsPerQuarter >> 16) & 0xff, (microsPerQuarter >> 8) & 0xff, microsPerQuarter & 0xff],
    });
  }

  for (const clip of clips) {
    if (clip.type !== 'pattern' || clip.mute || clip.channelId !== channel.id) continue;
    const clipStartTick = Math.max(0, Math.round(clip.startBar * 1920));
    for (const note of channel.notes ?? []) {
      if (note.muted) continue;
      const startTick = clipStartTick + Math.max(0, Math.round(note.start * 120));
      const durationTick = Math.max(1, Math.round(Math.max(0.01, note.duration) * 120));
      const velocity = Math.max(1, Math.min(127, Math.round((note.velocity ?? 0.8) * 127)));
      events.push({ tick: startTick, order: 2, data: [0x90 | midiChannel, clampMidi(note.pitch), velocity] });
      events.push({ tick: startTick + durationTick, order: 1, data: [0x80 | midiChannel, clampMidi(note.pitch), 0] });
    }
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const trackData: number[] = [];
  let previousTick = 0;
  for (const event of events) {
    trackData.push(...writeVlq(Math.max(0, event.tick - previousTick)), ...event.data);
    previousTick = event.tick;
  }
  trackData.push(0x00, 0xff, 0x2f, 0x00);

  const track: number[] = [];
  pushString(track, 'MTrk');
  pushUint32(track, trackData.length);
  track.push(...trackData);
  return track;
}

export function buildStandardMidiFile(
  channels: Channel[],
  clips: PlaylistClip[],
  meta: Pick<ProjectMetadata, 'bpm' | 'timeSignature'>,
): Blob {
  const tracks = channels.map((channel, index) => buildMidiTrack(channel, index, clips, meta.bpm));
  if (tracks.length === 0) tracks.push(buildMidiTrack({ id: 'empty', name: 'Apex Studio', notes: [] } as Channel, 0, [], meta.bpm));

  const header: number[] = [];
  pushString(header, 'MThd');
  pushUint32(header, 6);
  pushUint16(header, tracks.length > 1 ? 1 : 0);
  pushUint16(header, tracks.length);
  pushUint16(header, 480);

  const bytes = new Uint8Array([...header, ...tracks.flat()]);
  return new Blob([bytes], { type: 'audio/midi' });
}
