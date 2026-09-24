import type { CustomSampleData } from '../types/daw';

export interface SampleSlice {
  id: string;
  start: number;
  end: number;
  peak: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const detectTransientSlices = (
  sample: Pick<CustomSampleData, 'waveformPeaks'>,
  maxSlices = 16
): SampleSlice[] => {
  const peaks = sample.waveformPeaks || [];
  if (peaks.length < 2) return [{ id: 'slice-1', start: 0, end: 1, peak: peaks[0] || 0 }];

  const limit = Math.max(1, Math.min(64, Math.floor(maxSlices)));
  const energy = peaks.map(value => Math.abs(Number(value) || 0));
  const onsets: Array<{ index: number; score: number }> = [];

  for (let i = 1; i < energy.length - 1; i++) {
    const score = Math.max(0, energy[i] - energy[i - 1]) + Math.max(0, energy[i] - energy[i + 1]) * 0.25;
    const left = energy[i - 1];
    const right = energy[i + 1];
    if (score > 0.08 && energy[i] >= left && energy[i] >= right) onsets.push({ index: i, score });
  }

  const minDistance = Math.max(1, Math.floor(peaks.length / (limit * 1.5)));
  onsets.sort((a, b) => b.score - a.score);
  const selected: number[] = [];
  for (const onset of onsets) {
    if (selected.every(index => Math.abs(index - onset.index) >= minDistance)) {
      selected.push(onset.index);
      if (selected.length >= limit - 1) break;
    }
  }

  const boundaries = [0, ...selected.sort((a, b) => a - b), peaks.length - 1]
    .map(index => index / Math.max(1, peaks.length - 1));
  const unique = boundaries.filter((value, index, values) => index === 0 || value > values[index - 1]);

  return unique.slice(0, -1).map((start, index) => {
    const end = unique[index + 1];
    const peakIndex = Math.min(peaks.length - 1, Math.round(start * (peaks.length - 1)));
    return { id: `slice-${index + 1}`, start: clamp01(start), end: clamp01(end), peak: energy[peakIndex] || 0 };
  });
};

export const createEvenSlices = (count: number): SampleSlice[] => {
  const safeCount = Math.max(1, Math.min(64, Math.floor(count)));
  return Array.from({ length: safeCount }, (_, index) => ({
    id: `slice-${index + 1}`,
    start: index / safeCount,
    end: (index + 1) / safeCount,
    peak: 0
  }));
};
