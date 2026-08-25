import { describe, expect, it } from 'vitest';
import { AutomationLane } from './AutomationLane';

describe('AutomationLane', () => {
  it('uses the default value when empty', () => {
    const lane = new AutomationLane({ id: 'volume', min: 0, max: 1, defaultValue: 0.5 });
    expect(lane.valueAt(10)).toBe(0.5);
  });

  it('sorts points and linearly interpolates', () => {
    const lane = new AutomationLane(
      { id: 'pan', min: -1, max: 1, defaultValue: 0 },
      [{ time: 2, value: 1 }, { time: 0, value: -1 }],
    );
    expect(lane.getPoints()).toEqual([{ time: 0, value: -1 }, { time: 2, value: 1 }]);
    expect(lane.valueAt(1)).toBe(0);
  });

  it('clamps values to the configured range', () => {
    const lane = new AutomationLane(
      { id: 'gain', min: 0, max: 1, defaultValue: 0.25 },
      [{ time: 0, value: -5 }, { time: 1, value: 5 }],
    );
    expect(lane.getPoints()).toEqual([{ time: 0, value: 0 }, { time: 1, value: 1 }]);
  });

  it('is immutable when creating a replacement lane', () => {
    const original = new AutomationLane({ id: 'volume', min: 0, max: 1 }, [{ time: 0, value: 0.2 }]);
    const updated = original.withPoints([{ time: 0, value: 0.8 }]);
    expect(original.valueAt(0)).toBe(0.2);
    expect(updated.valueAt(0)).toBe(0.8);
  });

  it('rejects invalid times and ranges', () => {
    expect(() => new AutomationLane({ id: 'bad' }, [{ time: -1, value: 0 }])).toThrow();
    expect(() => new AutomationLane({ id: 'bad', min: 2, max: 1 })).toThrow();
  });
});
