import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrackRegistry } from './trackRegistry';

void describe('TrackRegistry', () => {
  void it('creates deterministic unique track IDs', () => {
    const registry = new TrackRegistry();
    const first = registry.create('Drums');
    const second = registry.create('Bass');

    assert.equal(first.id, 0);
    assert.equal(second.id, 1);
    assert.equal(registry.size, 2);
  });

  void it('does not reuse an ID after removal', () => {
    const registry = new TrackRegistry();
    const first = registry.create('Track A');
    registry.remove(first.id);
    const next = registry.create('Track B');

    assert.equal(next.id, 1);
  });

  void it('rejects duplicate IDs', () => {
    const registry = new TrackRegistry();
    registry.create('Track A');

    assert.throws(
      () => registry.add({ id: 0, name: 'Duplicate', volumeDb: 0, pan: 0, muted: false, soloed: false }),
      /already exists/,
    );
  });

  void it('updates state without exposing internal references', () => {
    const registry = new TrackRegistry();
    const created = registry.create('Vocal');
    const renamed = registry.rename(created.id, 'Lead Vocal');

    assert.equal(renamed.name, 'Lead Vocal');
    const fetched = registry.get(created.id)!;
    assert.equal(fetched.name, 'Lead Vocal');
    assert.notEqual(fetched, renamed);
  });

  void it('clamps supported mixer values through the existing channel contract', () => {
    const registry = new TrackRegistry();
    const track = registry.create('Keys');

    assert.equal(registry.setVolume(track.id, 99).volumeDb, 12);
    assert.equal(registry.setPan(track.id, -99).pan, -1);
  });

  void it('rejects empty names and missing tracks', () => {
    const registry = new TrackRegistry();
    const track = registry.create('Guitar');

    assert.throws(() => registry.rename(track.id, '   '), /cannot be empty/);
    assert.throws(() => registry.rename(999, 'Missing'), /does not exist/);
  });

  void it('returns isolated snapshots', () => {
    const registry = new TrackRegistry();
    registry.create('Pad');
    const snapshot = registry.snapshot();
    const track = snapshot.tracks[0] as { name: string };
    track.name = 'Mutated outside registry';

    assert.equal(registry.get(0)?.name, 'Pad');
  });
});
