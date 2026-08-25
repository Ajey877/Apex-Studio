import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutomationLane } from './AutomationLane';

describe('AutomationLane', () => {
  it('uses the default value when empty', () => {
    const lane = new AutomationLane({ id: 'volume', min: 0, max: 1, defaultValue: 0.5 });
    assert.equal(lane.valueAt(10), 0.5);
  });

  it('sorts points and linearly interpolates', () => {
    const lane = new AutomationLane(
      { id: 'pan', min: -1, max: 1, defaultValue: 0 },
      [{ time: 2, value: 1 }, { time: 0, value: -1 }],
    );
    assert.deepEqual(lane.getPoints(), [{ time: 0, value: -1 }, { time: 2, value: 1 }]);
    assert.equal(lane.valueAt(1), 0);
  });

  it('clamps values to the configured range', () => {
    const lane = new AutomationLane(
      { id: 'gain', min: 0, max: 1, defaultValue: 0.25 },
      [{ time: 0, value: -5 }, { time: 1, value: 5 }],
    );
    assert.deepEqual(lane.getPoints(), [{ time: 0, value: 0 }, { time: 1, value: 1 }]);
  });

  it('is immutable when creating a replacement lane', () => {
    const original = new AutomationLane({ id: 'volume', min: 0, max: 1 }, [{ time: 0, value: 0.2 }]);
    const updated = original.withPoints([{ time: 0, value: 0.8 }]);
    assert.equal(original.valueAt(0), 0.2);
    assert.equal(updated.valueAt(0), 0.8);
  });

  it('rejects invalid times and ranges', () => {
    assert.throws(() => new AutomationLane({ id: 'bad' }, [{ time: -1, value: 0 }]), /non-negative/);
    assert.throws(() => new AutomationLane({ id: 'bad', min: 2, max: 1 }), /range is invalid/);
  });
});
