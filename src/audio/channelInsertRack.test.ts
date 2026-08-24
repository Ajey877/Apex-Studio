import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelInsertRack } from './channelInsertRack';

describe('ChannelInsertRack', () => {
  it('keeps inserts in deterministic slot order', () => {
    const rack = new ChannelInsertRack<string>(3);
    rack.set(1, 'compressor');
    rack.set(0, 'eq');

    assert.equal(rack.size, 2);
    assert.equal(rack.get(0)?.processor, 'eq');
    assert.equal(rack.get(1)?.processor, 'compressor');
    assert.equal(rack.get(2), null);
  });

  it('prevents accidental overwrite and supports explicit replacement', () => {
    const rack = new ChannelInsertRack<string>(2);
    rack.set(0, 'eq');

    assert.throws(() => rack.set(0, 'compressor'), /already occupied/);
    assert.equal(rack.replace(0, 'compressor'), 'eq');
    assert.equal(rack.get(0)?.processor, 'compressor');
  });

  it('tracks bypass without losing the processor', () => {
    const rack = new ChannelInsertRack<string>(2);
    rack.set(0, 'compressor');
    rack.setBypassed(0, true);

    assert.equal(rack.get(0)?.processor, 'compressor');
    assert.equal(rack.get(0)?.bypassed, true);
  });

  it('removes and clears inserts deterministically', () => {
    const rack = new ChannelInsertRack<string>(3);
    rack.set(0, 'eq');
    rack.set(2, 'limiter');

    assert.equal(rack.remove(0), 'eq');
    assert.equal(rack.get(0), null);
    assert.deepEqual(rack.clear(), ['limiter']);
    assert.equal(rack.size, 0);
  });

  it('rejects invalid capacity and slot indexes', () => {
    assert.throws(() => new ChannelInsertRack(0), /positive integer/);
    const rack = new ChannelInsertRack<string>(2);
    assert.throws(() => rack.get(-1), /out of range/);
    assert.throws(() => rack.get(2), /out of range/);
  });
});
