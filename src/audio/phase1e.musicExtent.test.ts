/**
 * Phase 1E — Authoritative Musical Extent.
 *
 * Establishes one resolver for musical repetition extent used by Song playback,
 * Pattern playback, production offline rendering, bounce, and MIDI export.
 *
 * Core invariant: NOTE TAILS MUST NOT CHANGE MUSICAL LOOP/PATTERN EXTENT.
 *
 * These tests exercise the production functions directly. No source scanners,
 * no mocked audio, no envelope-dependent assertions.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolvePlayableContentLengthSteps,
  resolvePatternLoopLengthSteps,
} from './audioEngine';
import type { Channel, PlaylistClip } from '../types/daw';

const STEPS_PER_BAR = 16;

const mkChannel = (
  id: string,
  opts: {
    steps?: boolean[];
    notes?: Array<{ id: string; pitch: number; start: number; duration: number; velocity: number }>;
    instrumentType?: string;
  } = {},
): Channel => ({
  id,
  name: id,
  color: '#fff',
  instrumentType: (opts.instrumentType ?? 'minisynth') as Channel['instrumentType'],
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: opts.steps ?? Array(16).fill(false),
  synthParams: {} as Channel['synthParams'],
  notes: opts.notes ?? [],
});

const mkClip = (
  channelId: string,
  startBar: number,
  lengthBars: number,
  opts: Partial<PlaylistClip> = {},
): PlaylistClip => ({
  id: `clip-${channelId}-${startBar}`,
  trackIndex: 0,
  startBar,
  lengthBars,
  type: 'pattern',
  channelId,
  color: '#fff',
  name: channelId,
  ...opts,
});

// ---------------------------------------------------------------------------
// Test 1 — declared length wins over content
// ---------------------------------------------------------------------------
describe('Phase 1E — declared length wins over content', () => {
  it('content ends at step 16 but declared length is 32 → extent is 32', () => {
    const ch = mkChannel('ch', { steps: Array(16).fill(false) });
    // Pattern mode with declared 32: content ends at 16 but declared wins
    assert.equal(resolvePatternLoopLengthSteps([ch], 32), 32);
    // Song mode: content extent should also reflect onset positions only
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
  });

  it('content ends at step 10 with declared 32 → extent 32', () => {
    const ch = mkChannel('ch', {
      steps: Array(10).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 8, duration: 2, velocity: 0.9 }],
    });
    assert.equal(resolvePatternLoopLengthSteps([ch], 32), 32);
  });

  it('declared length rounds up to whole bars (odd value 40 → 48)', () => {
    const ch = mkChannel('ch');
    assert.equal(resolvePatternLoopLengthSteps([ch], 40), 48);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — note tail does NOT extend extent (THE CORE INVARIANT)
// ---------------------------------------------------------------------------
describe('Phase 1E — note tail does not extend extent', () => {
  it('note start 15.75, duration 1 (end 16.75) → extent remains 16', () => {
    const ch = mkChannel('ch', {
      steps: Array(16).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 15.75, duration: 1, velocity: 0.9 }],
    });
    // Onset at 15.75 → content extent based on onset only → ceil(15.75/16)*16 = 16
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
    // Pattern mode with declared 16 → still 16
    assert.equal(resolvePatternLoopLengthSteps([ch], 16), 16);
  });

  it('note start 0, duration 64 (end 64) → extent 16 (just onset at 0)', () => {
    const ch = mkChannel('ch', {
      steps: Array(16).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 64, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
  });

  it('notes only at onset 0, duration 32 → extent 16, not 32', () => {
    const ch = mkChannel('ch', {
      steps: Array(16).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 32, velocity: 0.9 }],
    });
    // onset at 0 → 16 (ceil(0/16)*16 = 16 for empty steps but note start 0 < 16)
    // With onset only: maxStep = max(16, 0) = 16 → 16
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
  });

  it('two notes at onset 15 and 31, with long durations → extent 32 from onset 31', () => {
    const ch = mkChannel('ch', {
      notes: [
        { id: 'n1', pitch: 60, start: 15, duration: 20, velocity: 0.9 },
        { id: 'n2', pitch: 62, start: 31, duration: 20, velocity: 0.9 },
      ],
    });
    // onset 31 → ceil(31/16)*16 = 32. Duration 20 is ignored (Phase 1E).
    assert.equal(resolvePlayableContentLengthSteps(ch), 32);
  });

  it('note at onset 48, duration 16 → extent 48 (onset rounds to 3 bars, not4)', () => {
    const ch = mkChannel('ch', {
      steps: Array(16).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 48, duration: 16, velocity: 0.9 }],
    });
    // onset 48 → ceil(48/16)*16 = 48 = 3 bars (exactly at bar boundary, rounds to itself)
    assert.equal(resolvePlayableContentLengthSteps(ch), 48);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Song and Pattern agree on the same content + declared extent
// ---------------------------------------------------------------------------
describe('Phase 1E — Song and Pattern agree', () => {
  it('pattern mode 32, song content also 32 (steps at 0..31)', () => {
    const ch = mkChannel('ch', {
      steps: Array.from({ length: 32 }, (_, i) => i < 32),
    });
    const patternExtent = resolvePatternLoopLengthSteps([ch], 32);
    const songExtent = resolvePlayableContentLengthSteps(ch);
    assert.equal(patternExtent, 32);
    assert.equal(songExtent, 32);
  });

  it('content extent and pattern declared length both reach 16 steps', () => {
    const ch = mkChannel('ch', {
      steps: Array(16).fill(false),
      notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.9 },
        { id: 'n2', pitch: 62, start: 8, duration: 1, velocity: 0.9 },
      ],
    });
    assert.equal(resolvePatternLoopLengthSteps([ch], 16), 16);
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — content-derived extent uses onsets, not tails
// ---------------------------------------------------------------------------
describe('Phase 1E — content extent from step array and note onsets', () => {
  it('step array length sets extent even with short notes', () => {
    const ch = mkChannel('ch', {
      steps: Array(32).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(ch), 32);
  });

  it('note onset beyond steps extends content extent', () => {
    const ch = mkChannel('ch', {
      steps: Array(16).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 24, duration: 1, velocity: 0.9 }],
    });
    // onset 24 → ceil(24/16)*16 = 32
    assert.equal(resolvePlayableContentLengthSteps(ch), 32);
  });

  it('step at 63 → extent 64', () => {
    const ch = mkChannel('ch', {
      steps: Array.from({ length: 64 }, (_, i) => i === 63),
    });
    assert.equal(resolvePlayableContentLengthSteps(ch), 64);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — empty and fallback cases
// ---------------------------------------------------------------------------
describe('Phase 1E — empty and fallback', () => {
  it('undefined channel → 16 steps', () => {
    assert.equal(resolvePlayableContentLengthSteps(undefined), 16);
  });

  it('empty channel (no steps, no notes) → 16 steps', () => {
    assert.equal(resolvePlayableContentLengthSteps(mkChannel('empty', { steps: [], notes: [] })), 16);
  });

  it('explicit patternLengthSteps overrides content', () => {
    const ch = mkChannel('ch', { steps: Array(16).fill(false) });
    assert.equal(resolvePlayableContentLengthSteps(ch, 64), 64);
    assert.equal(resolvePlayableContentLengthSteps(ch, 32), 32);
  });

  it('empty channel with declared length → declared length rounded to bars', () => {
    assert.equal(resolvePlayableContentLengthSteps(undefined, 32), 32);
    assert.equal(resolvePlayableContentLengthSteps(undefined, 20), 32);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — resolvePatternLoopLengthSteps uses declared length authoritatively
// ---------------------------------------------------------------------------
describe('Phase 1E — patternLoopLengthSteps uses declared length', () => {
  it('declared 16, content at step 28 → 16', () => {
    const ch = mkChannel('ch', {
      steps: Array.from({ length: 32 }, (_, i) => i === 28),
    });
    assert.equal(resolvePatternLoopLengthSteps([ch], 16), 16);
  });

  it('declared 16, note onset at 20 → 16', () => {
    const ch = mkChannel('ch', {
      notes: [{ id: 'n1', pitch: 60, start: 20, duration: 4, velocity: 0.9 }],
    });
    assert.equal(resolvePatternLoopLengthSteps([ch], 16), 16);
  });

  it('no declared length → content-derived from onsets/steps', () => {
    const ch = mkChannel('ch', {
      steps: Array.from({ length: 48 }, (_, i) => i < 48),
    });
    assert.equal(resolvePatternLoopLengthSteps([ch]), 48);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — tail-derived extent is impossible (mutations that would reintroduce it)
// ---------------------------------------------------------------------------
describe('Phase 1E — tail-derived extent mutation guard', () => {
  it('extending note duration does NOT change content extent', () => {
    const ch1 = mkChannel('ch', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.9 }],
    });
    const ch2 = mkChannel('ch', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 100, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(ch1), resolvePlayableContentLengthSteps(ch2));
  });

  it('note at start 0 duration 64 gives same extent as start 0 duration 1', () => {
    const short = mkChannel('short', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.9 }],
    });
    const long = mkChannel('long', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 64, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(short), 16);
    assert.equal(resolvePlayableContentLengthSteps(long), 16);
  });

  it('note at start 15.75 dur 4 (end 19.75) does not push extent to 32', () => {
    const ch = mkChannel('ch', {
      notes: [{ id: 'n1', pitch: 60, start: 15.75, duration: 4, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Song and Pattern produce same content loop for identical content
// ---------------------------------------------------------------------------
describe('Phase 1E — Song/Pattern loop parity for same content', () => {
  it('pattern declared 32 with content at step 0 and 16, song content extent also 32', () => {
    const ch = mkChannel('ch', {
      steps: Array.from({ length: 32 }, (_, i) => i === 0 || i === 16),
    });
    const patternLoop = resolvePatternLoopLengthSteps([ch], 32);
    const songLoop = resolvePlayableContentLengthSteps(ch);
    assert.equal(patternLoop, 32);
    assert.equal(songLoop, 32);
    assert.equal(patternLoop, songLoop);
  });

  it('pattern declared 16, content extends to 32 from step array → pattern stays 16, song goes to 32', () => {
    const ch = mkChannel('ch', {
      steps: Array.from({ length: 32 }, (_, i) => i === 0 || i === 20),
    });
    const patternLoop = resolvePatternLoopLengthSteps([ch], 16);
    const songLoop = resolvePlayableContentLengthSteps(ch);
    assert.equal(patternLoop, 16, 'declared pattern length is authoritative');
    assert.equal(songLoop, 32, 'song uses content extent from step positions');
    // They intentionally differ when content > declared. This is correct:
    // Pattern mode truncates; Song mode keeps all content.
  });
});