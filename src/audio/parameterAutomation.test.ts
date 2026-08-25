import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationCurve, clampAutomationPoints, type AutomationParam } from './parameterAutomation';

describe('AutomationCurve', () => {
  it('rejects empty and malformed curves', () => {
    assert.throws(() => new AutomationCurve([]), /at least one point/);
    assert.throws(() => new AutomationCurve([{ time: -1, value: 0 }]), /invalid time/);
    assert.throws(() => new AutomationCurve([{ time: 0, value: 0 }, { time: 0, value: 1 }]), /strictly increasing/);
    assert.throws(() => new AutomationCurve([{ time: 0, value: Number.NaN }]), /invalid value/);
  });

  it('interpolates linearly and clamps outside the curve', () => {
    const curve = new AutomationCurve([
      { time: 0, value: 0 },
      { time: 2, value: 10 },
      { time: 4, value: 0 },
    ]);

    assert.equal(curve.duration, 4);
    assert.equal(curve.valueAt(-1), 0);
    assert.equal(curve.valueAt(1), 5);
    assert.equal(curve.valueAt(3), 5);
    assert.equal(curve.valueAt(99), 0);
  });

  it('schedules a deterministic replacement on an AudioParam', () => {
    const calls: string[] = [];
    const param: AutomationParam = {
      cancelScheduledValues: time => calls.push(`cancel:${time}`),
      setValueAtTime: (value, time) => calls.push(`set:${value}:${time}`),
      linearRampToValueAtTime: (value, time) => calls.push(`ramp:${value}:${time}`),
    };

    new AutomationCurve([
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0.25 },
    ]).schedule(param, 10);

    assert.deepEqual(calls, [
      'cancel:10',
      'set:0:10',
      'ramp:1:10.5',
      'ramp:0.25:11',
    ]);
  });
});

describe('clampAutomationPoints', () => {
  it('clamps values without changing timestamps', () => {
    assert.deepEqual(
      clampAutomationPoints(
        [{ time: 0, value: -2 }, { time: 1, value: 0.5 }, { time: 2, value: 3 }],
        -1,
        1,
      ),
      [{ time: 0, value: -1 }, { time: 1, value: 0.5 }, { time: 2, value: 1 }],
    );
  });
});
