const sanitizeFloat32Sample = (value: number): number => {
  const floatValue = Math.fround(value);
  return Number.isFinite(floatValue) ? floatValue : 0;
};

const clampPcmSample = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Math.max(-1, Math.min(1, value));
};

export function audioBufferToWav(buffer: AudioBuffer, bitDepth: 16 | 24 | 32): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = bitDepth === 32 ? 3 : 1;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const channels = Array.from({ length: numChannels }, (_, channel) => buffer.getChannelData(channel));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const rawSample = channels[channel][i];
      if (bitDepth === 32) {
        view.setFloat32(offset, sanitizeFloat32Sample(rawSample), true);
        offset += 4;
      } else if (bitDepth === 24) {
        const sample = clampPcmSample(rawSample);
        const value = sample < 0 ? sample * 0x800000 : sample * 0x7fffff;
        const intValue = Math.round(value);
        view.setUint8(offset, intValue & 0xff);
        view.setUint8(offset + 1, (intValue >> 8) & 0xff);
        view.setUint8(offset + 2, (intValue >> 16) & 0xff);
        offset += 3;
      } else {
        const sample = clampPcmSample(rawSample);
        const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, Math.round(value), true);
        offset += 2;
      }
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
