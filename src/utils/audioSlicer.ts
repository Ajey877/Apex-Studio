// Audio Transient & Grid Slicer Engine (Edison / Simpler Style)
export interface AudioSlice {
  id: number;
  startSec: number;
  endSec: number;
  startRatio: number; // 0 to 1
  endRatio: number; // 0 to 1
  gain: number;
  rootKey: number; // e.g. 60 (C4)
  padIndex: number; // 0 - 15
}

export class AudioSlicer {
  // Detect Transient Slices in an AudioBuffer
  public static detectTransients(
    buffer: AudioBuffer,
    sensitivity: number = 0.6, // 0.1 (fewer slices) to 1.0 (more sensitive)
    maxSlices: number = 16
  ): AudioSlice[] {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.015); // 15ms energy window
    const hopSize = Math.floor(windowSize / 2);
    const numWindows = Math.floor((rawData.length - windowSize) / hopSize);

    // Compute short-time energy
    const energies: number[] = new Float32Array(numWindows) as any;
    for (let i = 0; i < numWindows; i++) {
      let sum = 0;
      const offset = i * hopSize;
      for (let j = 0; j < windowSize; j++) {
        const val = rawData[offset + j];
        sum += val * val;
      }
      energies[i] = Math.sqrt(sum / windowSize);
    }

    // Compute spectral / energy flux (first difference)
    const flux: number[] = new Float32Array(numWindows) as any;
    for (let i = 1; i < numWindows; i++) {
      const diff = energies[i] - energies[i - 1];
      flux[i] = diff > 0 ? diff : 0;
    }

    // Calculate dynamic threshold based on sensitivity
    const sortedFlux = [...flux].sort((a, b) => b - a);
    const thresholdIndex = Math.floor(sortedFlux.length * (1 - sensitivity * 0.35));
    const threshold = Math.max(0.015, sortedFlux[thresholdIndex] || 0.05);

    // Peak picking with minimum 75ms distance between transients
    const minDistanceWindows = Math.floor((sampleRate * 0.075) / hopSize);
    const slicePoints: number[] = [0]; // always start at 0

    let lastSlice = 0;
    for (let i = 2; i < numWindows - 2; i++) {
      if (
        flux[i] > threshold &&
        flux[i] > flux[i - 1] &&
        flux[i] >= flux[i + 1] &&
        i - lastSlice >= minDistanceWindows
      ) {
        slicePoints.push(i * hopSize);
        lastSlice = i;
        if (slicePoints.length >= maxSlices) break;
      }
    }

    // Fallback: If transients are too few, divide into equal grid beats
    if (slicePoints.length < 4) {
      return this.divideIntoEqualSlices(buffer, maxSlices);
    }

    slicePoints.push(rawData.length);

    // Form slice regions
    const slices: AudioSlice[] = [];
    for (let s = 0; s < slicePoints.length - 1 && s < maxSlices; s++) {
      const startSample = slicePoints[s];
      const endSample = slicePoints[s + 1];
      slices.push({
        id: s,
        startSec: startSample / sampleRate,
        endSec: endSample / sampleRate,
        startRatio: startSample / rawData.length,
        endRatio: endSample / rawData.length,
        gain: 1.0,
        rootKey: 60 + s,
        padIndex: s % 16
      });
    }

    return slices;
  }

  // Divide into Equal Grid Beat Slices (e.g. 8, 16, 32 slices)
  public static divideIntoEqualSlices(buffer: AudioBuffer, numSlices: number = 16): AudioSlice[] {
    const totalSamples = buffer.length;
    const sampleRate = buffer.sampleRate;
    const sliceLen = Math.floor(totalSamples / numSlices);
    const slices: AudioSlice[] = [];

    for (let i = 0; i < numSlices; i++) {
      const startSample = i * sliceLen;
      const endSample = i === numSlices - 1 ? totalSamples : (i + 1) * sliceLen;
      slices.push({
        id: i,
        startSec: startSample / sampleRate,
        endSec: endSample / sampleRate,
        startRatio: startSample / totalSamples,
        endRatio: endSample / totalSamples,
        gain: 1.0,
        rootKey: 60 + i,
        padIndex: i % 16
      });
    }

    return slices;
  }
}
