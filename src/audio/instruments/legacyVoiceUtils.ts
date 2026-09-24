export const midiToFrequency = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

export const createNoiseBuffer = (audioContext: BaseAudioContext, durationSeconds: number): AudioBuffer => {
  const bufferSize = audioContext.sampleRate * durationSeconds;
  const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
  const output = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
  return buffer;
};
