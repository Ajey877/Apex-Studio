import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createInstrumentRegistry } from './instrumentRegistry';

test('instrument registry resolves registered renderer', () => {
  const renderer = () => {};
  const fallback = () => {};
  const registry = createInstrumentRegistry({ minisynth: renderer }, fallback);

  assert.equal(registry.get('minisynth'), renderer);
  assert.equal(registry.has('minisynth'), true);
});

test('instrument registry uses fallback for an unregistered instrument', () => {
  const fallback = () => {};
  const registry = createInstrumentRegistry({}, fallback);

  assert.equal(registry.get('fmsynth'), fallback);
  assert.equal(registry.has('fmsynth'), false);
});
