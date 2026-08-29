import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('recording to playlist integration', () => {
  it('loads recorded audio into the AudioEngine before creating the clip', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(source, /await audioEngine\.loadAudioFile\(recording\.audioBlob, audioBufferId\)/);
    assert.match(source, /audioBufferId,/);
    assert.match(source, /audioWaveform: loaded\.peaks/);
  });

  it('sizes recorded clips from the current project BPM', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(source, /const secondsPerBar = 240 \/ Math\.max\(20, projectState\.meta\.bpm\)/);
    assert.match(source, /Math\.ceil\(recording\.durationSeconds \/ secondsPerBar\)/);
  });

  it('cancels an active recording when the recorder modal closes', () => {
    const source = readFileSync(new URL('../components/AudioRecorderModal.tsx', import.meta.url), 'utf8');
    assert.match(source, /engineRef\.current\?\.cancel\(\)/);
  });
});
