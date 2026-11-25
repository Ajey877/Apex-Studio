import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Browser fake device WAV, not an application-injected source. */
export function writeLiveInputFixture() {
  const file = path.resolve('build/live-input-440hz.wav');
  if (existsSync(file)) return file;
  const rate = 48000, frames = rate * 4;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(0.15 * 32767 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, wav);
  return file;
}
