import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutomationController } from './AutomationController';
import { AutomationLane } from './AutomationLane';

type Call =
  | { type: 'cancel'; time: number }
  | { type: 'set'; value: number; time: number }
  | { type: 'ramp'; value: number; time: number };

function createParam(): {
  calls: Call[];
  param: {
    cancelScheduledValues(startTime: number): void;
    setValueAtTime(value: number, startTime: number): void;
    linearRampToValueAtTime(value: number, endTime: number): void;
  };
} {
  const calls: Call[] = [];

  return {
    calls,
    param: {
      cancelScheduledValues(time) {
        calls.push({ type: 'cancel', time });
      },
      setValueAtTime(value, time) {
        calls.push({ type: 'set', value, time });
      },
      linearRampToValueAtTime(value, time) {
        calls.push({ type: 'ramp', value, time });
      },
    },
  };
}

describe('AutomationController', () => {
  it('binds lanes and schedules automation', () => {
    const controller = new AutomationController();
    const target = createParam();

    const lane = new AutomationLane(
      {
        id: 'volume',
        min: 0,
        max: 1,
        defaultValue: 0.5,
      },
      [
        { time: 0, value: 0.2 },
        { time: 1, value: 0.8 },
      ],
    );

    controller.addLane(lane, 'track-1.volume', target.param);
    controller.schedule(10);

    assert.equal(controller.size, 1);
    assert.deepEqual(target.calls, [
      { type: 'cancel', time: 10 },
      { type: 'set', value: 0.2, time: 10 },
      { type: 'ramp', value: 0.8, time: 11 },
    ]);
  });

  it('uses the default value for empty lanes', () => {
    const controller = new AutomationController();
    const target = createParam();

    controller.addLane(
      new AutomationLane({
        id: 'pan',
        min: -1,
        max: 1,
        defaultValue: 0.25,
      }),
      'track-1.pan',
      target.param,
    );

    controller.schedule(5);

    assert.deepEqual(target.calls, [
      { type: 'cancel', time: 5 },
      { type: 'set', value: 0.25, time: 5 },
    ]);
  });

  it('prevents duplicate lane ids and target bindings', () => {
    const controller = new AutomationController();
    const first = createParam();
    const second = createParam();

    controller.addLane(
      new AutomationLane({ id: 'volume' }),
      'track-1.volume',
      first.param,
    );

    assert.throws(
      () =>
        controller.addLane(
          new AutomationLane({ id: 'volume' }),
          'track-2.volume',
          second.param,
        ),
      /already exists/,
    );

    assert.throws(
      () =>
        controller.addLane(
          new AutomationLane({ id: 'pan' }),
          'track-1.volume',
          second.param,
        ),
      /already bound/,
    );
  });

  it('replaces and removes lanes safely', () => {
    const controller = new AutomationController();
    const target = createParam();

    controller.addLane(
      new AutomationLane(
        { id: 'volume', defaultValue: 0.5 },
        [{ time: 0, value: 0.2 }],
      ),
      'track-1.volume',
      target.param,
    );

    controller.replaceLane(
      new AutomationLane(
        { id: 'volume', defaultValue: 0.5 },
        [{ time: 0, value: 0.9 }],
      ),
    );

    assert.equal(controller.getLane('volume')?.valueAt(0), 0.9);
    assert.equal(controller.removeLane('volume'), true);
    assert.equal(controller.removeLane('volume'), false);
    assert.equal(controller.size, 0);
  });

  it('clears scheduled automation to each lane default', () => {
    const controller = new AutomationController();
    const first = createParam();
    const second = createParam();

    controller.addLane(
      new AutomationLane({
        id: 'volume',
        defaultValue: 0.5,
      }),
      'track-1.volume',
      first.param,
    );

    controller.addLane(
      new AutomationLane({
        id: 'pan',
        min: -1,
        max: 1,
        defaultValue: -0.25,
      }),
      'track-1.pan',
      second.param,
    );

    controller.clear(7);

    assert.deepEqual(first.calls, [
      { type: 'cancel', time: 7 },
      { type: 'set', value: 0.5, time: 7 },
    ]);

    assert.deepEqual(second.calls, [
      { type: 'cancel', time: 7 },
      { type: 'set', value: -0.25, time: 7 },
    ]);
  });
});