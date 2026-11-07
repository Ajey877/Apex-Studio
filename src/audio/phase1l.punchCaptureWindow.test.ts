/**
 * Phase 1L — the punch-out stop moment (`PunchCaptureWindow`).
 *
 * A punch take must stop on its own, so this class owns exactly one scheduled
 * instant. The checks pin the lifecycle the recorder depends on: it resolves
 * once at the right audio-clock moment, a tempo change preserves the MUSICAL
 * length instead of cutting the take short, and a cancel can never leave a
 * stale timer that stops a later take.
 *
 * A pumped fake clock keeps the assertions exact; the production host (the
 * engine's audio clock + window timers) is exercised end to end in
 * `phase1l.punchRecording.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PunchCancelledError, PunchCaptureWindow } from './punchCaptureWindow';
import { RecordingEngine } from './recordingEngine';
import { sessionBlobUrlRegistry } from '../state/sessionBlobUrlRegistry';
import { createRecordingTestRig, decodeFloatWav } from './recordingCaptureTestHarness';

interface FakeTimer { at: number; fn: () => void; cleared: boolean }

class FakeHost {
  /** AudioContext time used by PunchCaptureWindow. */
  clock = 0;
  /** Independent wall-clock time used only to deliver setTimeout callbacks. */
  wallClock = 0;
  readonly timers: FakeTimer[] = [];
  now = (): number => this.clock;
  setTimer = (fn: () => void, delayMs: number): number => {
    this.timers.push({ at: this.wallClock + delayMs / 1000, fn, cleared: false });
    return this.timers.length;
  };
  clearTimer = (handle: unknown): void => {
    const timer = this.timers[(handle as number) - 1];
    if (timer) timer.cleared = true;
  };
  private fireWallTimers(target: number, advanceAudioClock: boolean): void {
    while (this.wallClock < target - 1e-12) {
      const due = this.timers
        .filter(timer => !timer.cleared && timer.at <= target + 1e-12)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      const nextWallClock = Math.max(this.wallClock, due.at);
      if (advanceAudioClock) this.clock += nextWallClock - this.wallClock;
      this.wallClock = nextWallClock;
      due.cleared = true;
      due.fn();
    }
    if (advanceAudioClock) this.clock += target - this.wallClock;
    this.wallClock = target;
  }
  /** Advances audio and wall clocks together, firing due timers. */
  advance(seconds: number): void {
    this.fireWallTimers(this.wallClock + seconds, true);
  }
  /** Advances only the AudioContext clock (for tempo retimes). */
  advanceAudio(seconds: number): void { this.clock += seconds; }
  /** Advances only wall time, delivering callbacks while AudioContext is stalled. */
  advanceWall(seconds: number): void {
    this.fireWallTimers(this.wallClock + seconds, false);
  }
  get liveTimers(): FakeTimer[] {
    return this.timers.filter(timer => !timer.cleared);
  }
}

const r = (value: number): number => Math.round(value * 1e6) / 1e6;
let nextTestUrl = 0;

const withObjectUrlMock = async <T>(run: () => Promise<T>): Promise<T> => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:punch-retime-test-${++nextTestUrl}`;
  URL.revokeObjectURL = () => undefined;
  try {
    return await run();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
};

describe('Phase 1L — the punch window resolves at the punch-out moment', () => {
  it('resolves exactly captureTime + the musical length at the active tempo', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    // 16 quarter beats at 120 BPM = 8 s of capture, starting at audio time 2.
    const armed = punchWindow.arm({ captureTime: 2, durationBeats: 16, bpm: 120 });
    assert.equal(r(punchWindow.stopTime as number), 10);
    assert.equal(punchWindow.isActive, true);
    host.advance(9.9);
    assert.equal(punchWindow.isActive, true, 'capture must still be running just before punch-out');
    host.advance(0.2);
    const result = await armed;
    assert.equal(r(result.stopTime), 10);
    assert.equal(result.durationBeats, 16);
    assert.equal(punchWindow.isActive, false);
  });

  it('re-arms when a wall-clock callback arrives before the audio clock reaches punch-out', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 2, durationBeats: 4, bpm: 120 });
    const earlyTimer = host.timers[0];
    assert.ok(earlyTimer);
    earlyTimer.cleared = true;
    earlyTimer.fn();
    assert.equal(punchWindow.isActive, true, 'an early timer cannot stop the take');
    assert.equal(host.liveTimers.length, 1, 'punch-out is re-armed against the remaining audio-clock time');
    host.advance(4.1);
    const result = await armed;
    assert.equal(r(result.stopTime), 4);
    assert.equal(punchWindow.isActive, false);
  });

  it('resolves only once — a second advance does not resolve anything new', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    let resolutions = 0;
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    void armed.then(() => { resolutions += 1; });
    host.advance(10);
    await armed;
    assert.equal(resolutions, 1);
    assert.equal(host.liveTimers.length, 0, 'the stop timer is consumed, never re-armed');
  });

  it('throws instead of arming two stop moments for one take', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const first = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    const settled = first.catch(() => undefined);
    assert.throws(() => punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 }), /already armed/);
    assert.equal(r(punchWindow.stopTime as number), 2, 'the first take keeps its own punch-out');
    punchWindow.cancel();
    await settled;
  });

  it('a zero-length window resolves immediately instead of hanging', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 0, bpm: 120 });
    host.advance(0.001);
    await armed;
    assert.equal(punchWindow.isActive, false);
  });
});

describe('Phase 1L — a tempo change preserves the punched length', () => {
  it('anchors delayed-arm tempo retiming to the planned punch-in (six beats total, four remaining)', async () => {
    const host = new FakeHost();
    host.clock = 2.12;
    host.wallClock = 2.12;
    const punchWindow = new PunchCaptureWindow(host);
    let settled = false;
    const armed = punchWindow.arm({ captureTime: 2, durationBeats: 6, bpm: 120 });
    void armed.then(() => { settled = true; }, () => { settled = true; });

    assert.equal(punchWindow.captureTime, 2, 'the original planned punch-in is immutable');
    host.advance(0.88); // callback at 2.120; audio clock reaches the tempo change at 3.000
    punchWindow.retime(60);

    assert.equal(punchWindow.captureTime, 2, 'retiming cannot move the capture anchor');
    assert.equal(punchWindow.durationBeats, 4, 'two beats elapsed since 2.000, leaving four');
    assert.equal(r(punchWindow.stopTime as number), 7, 'four beats at 60 BPM end at 7.000 seconds');
    host.advance(3.999);
    assert.equal(settled, false, 'the punch operation must not resolve before the planned stop');
    assert.equal(punchWindow.isActive, true);
    host.advance(0.001);
    const result = await armed;
    assert.equal(r(result.stopTime), 7);
    assert.equal(result.durationBeats, 4);
    assert.equal(settled, true);
  });

  it('keeps one capture anchor and no accumulated drift through repeated tempo changes', async () => {
    const host = new FakeHost();
    host.clock = 2.12;
    host.wallClock = 2.12;
    const punchWindow = new PunchCaptureWindow(host);
    let resolutions = 0;
    const armed = punchWindow.arm({ captureTime: 2, durationBeats: 6, bpm: 120 });
    void armed.then(() => { resolutions += 1; });

    const retimeAt = (time: number, bpm: number, expectedRemaining: number, expectedStop: number) => {
      host.advance(time - host.clock);
      const staleTimer = host.liveTimers[0];
      assert.ok(staleTimer);
      punchWindow.retime(bpm);
      assert.equal(punchWindow.captureTime, 2, 'the first capture frame remains fixed across every tempo segment');
      assert.equal(r(punchWindow.durationBeats as number), expectedRemaining);
      assert.ok(Math.abs((punchWindow.stopTime as number) - expectedStop) < 1e-9,
        `expected stop ${expectedStop}, got ${punchWindow.stopTime}`);
      // Model a callback already dequeued when clearTimeout ran. Its generation
      // must be stale: it cannot settle early or install a duplicate timer.
      staleTimer.fn();
      assert.equal(resolutions, 0);
      assert.equal(host.liveTimers.length, 1);
    };

    retimeAt(3, 60, 4, 7);
    retimeAt(4, 120, 3, 5.5);
    retimeAt(4.5, 90, 2, 4.5 + 2 * 60 / 90);
    retimeAt(5, 60, 1.25, 6.25);
    host.advance(1.25);
    const result = await armed;
    assert.equal(r(result.stopTime), 6.25);
    assert.equal(result.durationBeats, 1.25);
    assert.equal(resolutions, 1, 'stale and current timers can resolve the take only once');
    assert.equal(host.liveTimers.length, 0);
  });

  it('does not resolve a delayed punch-out timer until the audio clock reaches its retimed boundary', async () => {
    const host = new FakeHost();
    host.clock = 2.12;
    host.wallClock = 2.12;
    const punchWindow = new PunchCaptureWindow(host);
    let resolutions = 0;
    const armed = punchWindow.arm({ captureTime: 2, durationBeats: 6, bpm: 120 });
    void armed.then(() => { resolutions += 1; });

    // The wall timer reaches its initial 5.000 stop while the audio clock is
    // still 2.120 (e.g. a suspended/lagging context). It must re-arm, not settle.
    host.advanceWall(2.88);
    assert.equal(host.wallClock, 5);
    assert.equal(host.clock, 2.12);
    assert.equal(resolutions, 0);
    assert.equal(punchWindow.stopTime, 5);
    assert.equal(host.liveTimers.length, 1);

    host.advanceAudio(0.88);
    punchWindow.retime(60);
    assert.equal(punchWindow.stopTime, 7);
    host.advanceWall(4);
    assert.equal(host.wallClock, 9);
    assert.equal(host.clock, 3);
    assert.equal(resolutions, 0, 'a second early callback still cannot settle punch-out');
    assert.equal(host.liveTimers.length, 1);

    host.advanceAudio(4);
    host.advanceWall(4);
    const result = await armed;
    assert.equal(host.clock, 7);
    assert.equal(r(result.stopTime), 7);
    assert.equal(resolutions, 1);
    assert.equal(host.liveTimers.length, 0);
  });

  it('halving the tempo stretches the remaining beats instead of cutting the take short', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    // 8 quarter beats at 120 BPM = 4 s, captured from audio time 0.
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 });
    host.advance(1);
    // 1 s at 120 BPM is 2 beats captured, so 6 beats are still owed.
    punchWindow.retime(60);
    assert.equal(r(punchWindow.stopTime as number), 7, 'the remaining 6 beats now take 6 s at 60 BPM');
    host.advance(5.9);
    assert.equal(punchWindow.isActive, true, 'the take must not be cut short by the tempo change');
    host.advance(0.2);
    const result = await armed;
    assert.equal(r(result.stopTime), 7);
    assert.equal(result.durationBeats, 6, 'the musical length that was left when the tempo changed');
  });

  it('doubling the tempo shortens the remaining wall-clock time but not the beats', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 });
    host.advance(1);
    punchWindow.retime(240);
    assert.equal(r(punchWindow.stopTime as number), 2.5, 'the remaining 6 beats take 1.5 s at 240 BPM');
    host.advance(2);
    const result = await armed;
    assert.equal(result.durationBeats, 6);
  });

  it('re-arming clears the previous stop timer, so no stale timer fires early', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 });
    host.advance(1);
    const beforeRetime = host.timers.length;
    punchWindow.retime(240);
    const stale = host.timers.slice(0, beforeRetime);
    assert.ok(stale.every(timer => timer.cleared), 'the pre-retime timer must be cleared');
    host.advance(2);
    await armed;
    assert.equal(punchWindow.isActive, false);
  });

  it('an invalid tempo is ignored rather than stopping the take', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    host.advance(0.5);
    punchWindow.retime(Number.NaN);
    assert.equal(r(punchWindow.stopTime as number), 2);
    host.advance(2);
    await armed;
  });
});

describe('Phase 1L — delayed punch-in callback still selects the original PCM frame', () => {
  it('preserves the punch-in frame and retimed punch-out through production RecordingEngine capture', async () => {
    await withObjectUrlMock(async () => {
      const rig = createRecordingTestRig({ sampleRate: 1000 });
      const engine = new RecordingEngine(() => rig.context as unknown as AudioContext, rig.engineOptions);
      const preparing = engine.prepare();
      const node = await rig.context.captureNodeReady;
      rig.context.advanceToFrame(2048, frame => frame / 10_000);
      await preparing;

      // The scheduled punch-in was frame 2000. Input keeps flowing and the JS
      // completion callback is delivered only after the clock reaches frame 2176.
      rig.context.advanceToFrame(2176, frame => frame / 10_000);
      const callbackTime = rig.context.currentTime;
      assert.ok(callbackTime > 2, 'the callback is after the planned punch-in');
      const host = new FakeHost();
      host.clock = callbackTime;
      host.wallClock = callbackTime;
      const punchWindow = new PunchCaptureWindow(host);
      const armed = punchWindow.arm({ captureTime: 2, durationBeats: 6, bpm: 120 });
      host.advance(3 - host.clock);
      punchWindow.retime(60);
      assert.equal(punchWindow.captureTime, 2);
      assert.equal(punchWindow.stopTime, 7);

      await engine.start(punchWindow.captureTime!);
      assert.equal(
        node.commands.find(command => command.direction === 'main-to-processor' && command.type === 'start')?.startFrame,
        2000,
        'RecordingEngine must select the original inclusive punch-in frame from retained pre-roll',
      );
      rig.context.advanceToFrame(7040, frame => frame / 10_000);
      let resultUrl = '';
      try {
        const take = await engine.stop(punchWindow.stopTime!);
        resultUrl = take.url;
        const wav = await decodeFloatWav(take.blob);
        assert.equal(take.captureStartFrame, 2000);
        assert.equal(take.captureEndFrame, 7000, 'the retimed punch-out is the exclusive stop frame');
        assert.equal(take.capturedFrames, 5000);
        assert.equal(wav.frameCount, 5000);
        assert.equal(wav.samples[0], Math.fround(0.2));
        assert.equal(wav.samples.at(-1), Math.fround(0.6999));
        assert.equal(wav.samples.includes(Math.fround(0.7)), false, 'no PCM at or after punch-out is saved');

        host.advance(4);
        const punchResult = await armed;
        assert.equal(punchResult.stopTime, 7);
        assert.equal(punchResult.durationBeats, 4);
        sessionBlobUrlRegistry.release(take.url);
        resultUrl = '';
      } finally {
        if (resultUrl) sessionBlobUrlRegistry.release(resultUrl);
        await engine.dispose();
      }
    });
  });
});

describe('Phase 1L — cancelling a punch take leaves nothing behind', () => {
  it('clears the timer and rejects with PunchCancelledError', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 16, bpm: 120 });
    host.advance(1);
    punchWindow.cancel();
    await assert.rejects(armed, PunchCancelledError);
    assert.equal(host.liveTimers.length, 0, 'no stop timer may survive a cancel');
    assert.equal(punchWindow.isActive, false);
    assert.equal(punchWindow.stopTime, null);
  });

  it('is idempotent and safe when nothing is armed', () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    assert.doesNotThrow(() => punchWindow.cancel());
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    punchWindow.cancel();
    assert.doesNotThrow(() => punchWindow.cancel());
    return assert.rejects(armed, PunchCancelledError);
  });

  it('a cancelled take can be followed by a fresh one with its own punch-out', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const first = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    punchWindow.cancel();
    await assert.rejects(first, PunchCancelledError);
    const second = punchWindow.arm({ captureTime: 10, durationBeats: 4, bpm: 120 });
    assert.equal(r(punchWindow.stopTime as number), 12);
    host.advance(12);
    const result = await second;
    assert.equal(r(result.stopTime), 12);
  });

  it('cancelling after the take resolved does not resurrect it', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    host.advance(3);
    const result = await armed;
    assert.equal(r(result.stopTime), 2);
    assert.doesNotThrow(() => punchWindow.cancel());
    assert.equal(punchWindow.isActive, false);
  });
});
