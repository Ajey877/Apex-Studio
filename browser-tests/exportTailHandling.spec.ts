import { test, expect } from '@playwright/test';

/**
 * Phase 6C (issue #56) — Song-master export tail handling in REAL Chromium.
 *
 * Pre-fix defect (reproduced byte-for-byte on main 033dc29 with the
 * web-audio-engine harness in src/audio/offlineExportTail.test.ts):
 * `renderTimelineOffline` sized the render window to exactly the song end, so
 * the release/reverb remainder of the final events was HARD-TRUNCATED at the
 * boundary — the exported WAV's last samples sat at sustain level (|0.495|),
 * an audible click/abrupt ending, even though the ExportModal copy promises
 * exports carry "the FX tails that the deterministic impulse guarantees".
 *
 * The fix renders a bounded tail past the song end (4 s cap) and trims it back
 * to where the audio actually decayed below −80 dBFS. This spec proves the
 * acoustic outcome against the REAL browser OfflineAudioContext, including the
 * real ConvolverNode reverb tail that the Node polyfill cannot render
 * (web-audio-engine's ConvolverNode is a pass-through).
 *
 * Mastering is disabled for measurement cleanliness (same fidelity policy as
 * liveExportParity.insertFx.test.ts / liveExportReverbEnvelope.spec.ts); the
 * mastering-preroll + tail combination is exercised by the existing
 * realOfflineRender.spec.ts production tests, which run with engine defaults.
 */

const SR = 44100;
const SILENCE = 1e-4; // mirrors OFFLINE_TAIL_SILENCE_THRESHOLD

test.describe('Phase 6C: export tail handling (real OfflineAudioContext)', () => {
  test('a note released at the song end rings past the boundary and the export ends in silence', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async ({ SR }) => {
      // @ts-ignore — browser-side import of a Vite-served module (same convention as realOfflineRender.spec.ts)
      const mod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const ms: any = await import('/src/audio/masteringState.ts');
      const engine = mod.audioEngine;
      engine.setMasteringState({ ...ms.DEFAULT_MASTERING_SUITE_STATE, enabled: false });

      const channel = {
        id: 'ch-pad',
        name: 'Pad',
        color: '#10b981',
        instrumentType: 'minisynth' as const,
        mixerTrackId: 1,
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: Array(16).fill(false),
        // Clip spans only bar 3: step 14 + 2-step gate ⇒ note-off at exactly 8.0 s,
        // 2 s release ⇒ envelope should decay to silence at ~10.05 s.
        notes: [{ id: 'n-pad', pitch: 60, start: 14, duration: 2, velocity: 0.9 }],
        synthParams: { ...engine.getDefaultSynthParams(), attack: 0.01, decay: 0.1, sustain: 0.8, release: 2.0 },
      };
      const clip = {
        id: 'c-pad', trackIndex: 0, startBar: 3, lengthBars: 1, type: 'pattern' as const,
        channelId: 'ch-pad', color: '#10b981', name: 'Pad Bar',
      };
      const tracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
        { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
      ];

      const measure = (data: Float32Array) => {
        const rms = (fromSec: number, toSec: number) => {
          const a = Math.floor(fromSec * SR);
          const b = Math.min(data.length, Math.floor(toSec * SR));
          let sum = 0;
          for (let i = a; i < b; i += 1) sum += data[i] * data[i];
          return Math.sqrt(sum / Math.max(1, b - a));
        };
        let finalMax = 0;
        for (let i = Math.max(0, data.length - 512); i < data.length; i += 1) finalMax = Math.max(finalMax, Math.abs(data[i]));
        return { rms, finalMax };
      };

      const rendered: AudioBuffer = await engine.renderTimelineOffline(
        [channel], [clip], tracks, 120, 4, SR, false, 'song',
      );
      const data = rendered.getChannelData(0);
      const m = measure(data);

      // Pinned-window reference render of the same project (explicit duration floor).
      const pinned: AudioBuffer = await engine.renderTimelineOffline(
        [channel], [clip], tracks, 120, 4, SR, false, 'song', undefined, undefined, undefined, 12,
      );
      const songFrames = Math.ceil(8 * SR);
      let songDiff = 0;
      const pinnedData = pinned.getChannelData(0);
      for (let i = 0; i < songFrames; i += 1) songDiff = Math.max(songDiff, Math.abs(data[i] - pinnedData[i]));

      return {
        length: rendered.length,
        duration: rendered.duration,
        pinnedLength: pinned.length,
        songFrames,
        rmsTail: m.rms(8.0, 8.5),
        rmsSongEnd: m.rms(7.5, 8.0),
        finalMax: m.finalMax,
        songDiff,
      };
    }, { SR });

    const songFrames = Math.ceil(8 * SR);
    // Pre-fix this was exactly songFrames with |final sample| ≈ 0.495.
    expect(result.length, 'export must extend past the song boundary with the release tail').toBeGreaterThan(songFrames);
    expect(result.length, 'tail is bounded by the 4 s cap').toBeLessThanOrEqual(songFrames + Math.ceil(4 * SR));
    expect(Math.abs(result.duration - 10.05), 'trim lands at the actual decay point (~10.05 s)').toBeLessThan(0.25);
    expect(result.rmsTail, 'release tail audible just past the song end').toBeGreaterThan(1e-3);
    expect(result.rmsSongEnd, 'song region still audible up to the boundary (non-vacuous)').toBeGreaterThan(0.05);
    expect(result.finalMax, 'the file must END in silence, not mid-envelope').toBeLessThanOrEqual(SILENCE);
    expect(result.pinnedLength, 'explicitly pinned window keeps its exact duration').toBe(Math.ceil(12 * SR));
    expect(result.songDiff, 'song-region content unchanged by the tail render').toBeLessThanOrEqual(1e-6);
  });

  test('a real convolution reverb tail past the song end is rendered instead of truncated', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async ({ SR }) => {
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const ms: any = await import('/src/audio/masteringState.ts');
      const engine = mod.audioEngine;
      engine.setMasteringState({ ...ms.DEFAULT_MASTERING_SUITE_STATE, enabled: false });

      // Deterministic 20 ms broadband burst (same construction as
      // liveExportReverbEnvelope.spec.ts), played through a REAL ConvolverNode
      // reverb (seeded impulse, 2.5 s) starting at bar 1 of a 2-bar song:
      // the reverb remainder necessarily crosses the 4 s song boundary.
      const burstLen = Math.round(SR * 0.02);
      const burstData = new Float32Array(burstLen);
      let a = 7 >>> 0;
      const rng = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let i = 0; i < burstLen; i += 1) burstData[i] = (rng() * 2 - 1) * 0.5;
      const burst = new AudioBuffer({ length: burstLen, sampleRate: SR, numberOfChannels: 1 });
      burst.copyToChannel(burstData, 0);
      engine.sampleBuffers = new Map([['burst-tail', burst]]);

      const clip = {
        id: 'burst-clip', trackIndex: 0, startBar: 1, lengthBars: 0.25, type: 'audio' as const,
        audioBufferId: 'burst-tail', color: '#10b981', name: 'Burst', mute: false,
      };
      const tracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
        {
          id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, peakL: 0, peakR: 0,
          fxSlots: [{ id: 'fx-verb', type: 'reverb', name: 'Reverb', enabled: true, mix: 1.0, params: {} }],
        },
      ];

      const rendered: AudioBuffer = await engine.renderTimelineOffline(
        [], [clip], tracks, 120, 2, SR, true, 'song',
      );
      const data = rendered.getChannelData(0);
      const songFrames = Math.ceil(4 * SR); // max(4 s floor, 2 bars × 2 s)
      let finalMax = 0;
      for (let i = Math.max(0, data.length - 512); i < data.length; i += 1) finalMax = Math.max(finalMax, Math.abs(data[i]));
      let burstRms = 0;
      const from = Math.floor(2.0 * SR);
      const to = Math.floor(2.1 * SR);
      for (let i = from; i < to; i += 1) burstRms += data[i] * data[i];
      burstRms = Math.sqrt(burstRms / (to - from));
      return { length: rendered.length, songFrames, finalMax, burstRms };
    }, { SR });

    // Trim only keeps frames whose |sample| exceeded −80 dBFS, so a length
    // beyond song+margin is direct proof the reverb tail rang past the song
    // end — pre-fix those frames did not exist in the export at all.
    expect(result.length, 'reverb remainder past the song end must be rendered').toBeGreaterThan(result.songFrames + 1000);
    expect(result.length, 'bounded by the 4 s tail cap').toBeLessThanOrEqual(result.songFrames + Math.ceil(4 * SR));
    expect(result.finalMax, 'export ends in silence after the reverb decay').toBeLessThanOrEqual(SILENCE);
    expect(result.burstRms, 'the burst itself rendered (non-vacuous reverb source)').toBeGreaterThan(1e-3);
  });

  test('a song that already decays before its end keeps the exact historical export duration', async ({ page }) => {
    await page.goto('http://localhost:3000');
    const result = await page.evaluate(async ({ SR }) => {
      // @ts-ignore
      const mod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const ms: any = await import('/src/audio/masteringState.ts');
      const engine = mod.audioEngine;
      engine.setMasteringState({ ...ms.DEFAULT_MASTERING_SUITE_STATE, enabled: false });
      const channel = {
        id: 'ch-early',
        name: 'Early',
        color: '#10b981',
        instrumentType: 'minisynth' as const,
        mixerTrackId: 1,
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: Array(16).fill(false),
        notes: [{ id: 'n-early', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
        synthParams: { ...engine.getDefaultSynthParams(), attack: 0.01, decay: 0.1, sustain: 0.8, release: 2.0 },
      };
      const clip = {
        id: 'c-early', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern' as const,
        channelId: 'ch-early', color: '#10b981', name: 'Early Bar',
      };
      const tracks = [
        { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
        { id: 1, name: 'Ch1', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
      ];
      const song: AudioBuffer = await engine.renderTimelineOffline(
        [channel], [clip], tracks, 120, 4, SR, false, 'song',
      );
      const pattern: AudioBuffer = await engine.renderTimelineOffline(
        [channel], [clip], tracks, 120, 4, SR, false, 'pattern', undefined, 16,
      );
      return { songLength: song.length, patternLength: pattern.length, songFrames: Math.ceil(8 * SR) };
    }, { SR });

    // Note decays by ~2.3 s inside the 8 s window: no dead air is added.
    expect(result.songLength, 'silent tail trims back to the exact song window').toBe(result.songFrames);
    // Pattern-scope loop material stays exactly bar-aligned (seamless loops).
    expect(result.patternLength, 'pattern scope renders no tail').toBe(result.songFrames);
  });
});
